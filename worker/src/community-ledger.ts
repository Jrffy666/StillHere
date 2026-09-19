import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { fail, ok, type Outcome, type WorkerEnv } from './types';
import {
  communityEventSchema, communityRecordId, communityRef, correctionSchema,
  type CommunityEventInput, type CommunityRecordView, type CommunityStoredRecord,
  type CommunityMemberLedger, type CommunityCorrectionInput, type CommunityCorrectionView,
  type CommunityCorrectionPreparation, type CommunitySignedSubmission, type CommunityTotals, emptyCommunityTotals,
} from './community-types';
import {
  communityConfiguration, communityReadConfigured, prepareCommunityRecord, sendCommunityRecord,
  prepareCommunityCorrection, acceptCommunityCorrection, reconcileCommunityCorrection, readCommunityWithdrawal,
} from './community-chain';

interface JournalState {rider:string;assignment:number;guardian:string|null;outcome:number;lastObservedAt:number;guardians:{id:string;checks:number;lastAssignment:number}[];credited:string[];banners:string[]}
interface StoredCorrection {view:CommunityCorrectionView;transaction:string;admin:string;expiresAt:number;submission:CommunitySignedSubmission|null;attempts:number;nextAttemptAt:number;leaseUntil:number}
const zero='0'.repeat(64);
const retryDelay=(attempts:number)=>Math.min(30*60_000,5_000*2**Math.min(attempts,9));
const pageSchema=z.string().regex(/^\d{1,12}$/).transform(Number).optional();
export function emptyCommunityLedger(env:WorkerEnv,memberId:string|null=null):CommunityMemberLedger {
  const configuration=communityConfiguration(env);
  return {memberId,evidence:'platform_attested',network:configuration.network,programId:configuration.programId,configured:configuration.configured,finalized:emptyCommunityTotals(),pending:emptyCommunityTotals(),withdrawn:0,records:[],nextCursor:null};
}
function publicRecord(record:CommunityStoredRecord):CommunityRecordView {
  const {id,event,points,reputation,status,evidence,network,programId,issuer,recordAddress,signature,finalizedAt,error,withdrawn,withdrawal}=record;
  return {id,event,points,reputation,status,evidence,network,programId,issuer,recordAddress,signature,finalizedAt,error,withdrawn,withdrawal};
}
function sameEvent(a:CommunityEventInput,b:CommunityEventInput):boolean {return JSON.stringify(a)===JSON.stringify(b);}
function applyEvent(state:JournalState|null,event:CommunityEventInput):{state:JournalState;points:number;reputation:number} {
  let points=0,reputation=0;
  if(!state){
    if(event.sequence!==0||event.kind!=='created'||event.actorId!==event.subjectId||event.assignment!==0||event.value!==0)throw new Error('Begin with a rider-created journey record.');
    return {state:{rider:event.actorId,assignment:0,guardian:null,outcome:0,lastObservedAt:event.observedAt,guardians:[],credited:[],banners:[]},points,reputation};
  }
  if(event.observedAt<state.lastObservedAt)throw new Error('Observed event times must preserve journey order.');
  if(event.kind==='created')throw new Error('A journey can only be created once.');
  if(event.kind==='assigned'){
    if(state.outcome||event.actorId!==state.rider||event.subjectId===state.rider||event.subjectId===state.guardian||event.assignment!==state.assignment+1||event.value!==0)throw new Error('Invalid guardian assignment.');
    state.assignment=event.assignment;state.guardian=event.subjectId;
    if(!state.guardians.some(item=>item.id===event.subjectId)){
      if(state.guardians.length>=16)throw new Error('A journey supports at most sixteen unique guardians.');
      state.guardians.push({id:event.subjectId,checks:0,lastAssignment:event.assignment});
    }
    state.guardians.find(item=>item.id===event.subjectId)!.lastAssignment=event.assignment;
  } else if(event.kind==='check_in'){
    if(state.outcome||event.actorId!==state.guardian||event.subjectId!==state.guardian||event.assignment!==state.assignment||event.value!==0)throw new Error('Only the current guardian can check in.');
    state.guardians.find(item=>item.id===event.subjectId)!.checks++;
  } else if(event.kind==='relay_requested'){
    if(state.outcome||!state.guardian||event.subjectId!==state.guardian||event.assignment!==state.assignment||!((event.actorId===state.rider||event.actorId===state.guardian)&&event.value===0||event.actorId===zero&&event.value===1))throw new Error('Invalid relay request.');
  } else if(event.kind==='closed'){
    if(state.outcome||event.actorId!==state.rider||event.subjectId!==state.rider||event.assignment!==state.assignment||![1,2,3].includes(event.value))throw new Error('Invalid journey closure.');
    state.outcome=event.value;
  } else if(event.kind==='contribution'||event.kind==='gratitude'){
    const guardian=state.guardians.find(item=>item.id===event.subjectId);
    if(!state.outcome||!guardian?.checks||event.assignment!==guardian.lastAssignment||event.actorId!==(event.kind==='contribution'?event.subjectId:state.rider))throw new Error('Recognition requires an eligible guardian in a closed journey.');
    if(event.kind==='contribution'){
      if(state.outcome!==1||event.value!==0||state.credited.includes(event.subjectId))throw new Error('Only one contribution per eligible completed journey.');
      const eligible=state.guardians.filter(item=>item.checks>0).map(item=>item.id).sort(),rank=eligible.indexOf(event.subjectId);
      points=Math.floor(25/eligible.length)+(rank<25%eligible.length?1:0);
      reputation=Math.floor(10/eligible.length)+(rank<10%eligible.length?1:0);state.credited.push(event.subjectId);
    } else {
      if(![1,2,3].includes(event.value)||state.banners.includes(event.subjectId))throw new Error('Only one predefined banner per journey and guardian.');
      state.banners.push(event.subjectId);
    }
  }
  state.lastObservedAt=event.observedAt;return {state,points,reputation};
}

/** A journal per public journey and a derived index per member, never private TripRoom data. */
export class CommunityLedger extends DurableObject<WorkerEnv> {
  private work:Promise<void>|null=null;
  constructor(ctx:DurableObjectState,env:WorkerEnv){
    super(ctx,env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,data TEXT NOT NULL)');
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,sequence INTEGER NOT NULL,subject TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,
      points INTEGER NOT NULL,reputation INTEGER NOT NULL,withdrawn INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL,indexed_revision INTEGER NOT NULL,next_attempt INTEGER NOT NULL,lease INTEGER NOT NULL,data TEXT NOT NULL)`);
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS records_due ON records(status,next_attempt)');
  }
  private meta<T>(key:string):T|null {const row=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM metadata WHERE key=?',key).toArray()[0];return row?JSON.parse(row.data) as T:null;}
  private putMeta(key:string,value:unknown){this.ctx.storage.sql.exec('INSERT OR REPLACE INTO metadata VALUES (?,?)',key,JSON.stringify(value));}
  private role(kind:'journey'|'member',id:string):boolean {
    const identity=this.meta<{kind:string;id:string}>('identity');
    if(identity)return identity.kind===kind&&identity.id===id;
    this.putMeta('identity',{kind,id});return true;
  }
  private load(id:string):CommunityStoredRecord|null {const row=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM records WHERE id=?',id).toArray()[0];return row?JSON.parse(row.data) as CommunityStoredRecord:null;}
  private save(record:CommunityStoredRecord){
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO records(id,sequence,subject,kind,status,points,reputation,withdrawn,revision,indexed_revision,next_attempt,lease,data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      record.id,record.event.sequence,record.event.subjectId,record.event.kind,record.status,record.points,record.reputation,record.withdrawn?1:0,record.revision,record.indexedRevision,record.nextAttemptAt,record.leaseUntil,JSON.stringify(record));
  }
  private rows(query:string,...bindings:(string|number)[]):CommunityStoredRecord[]{return this.ctx.storage.sql.exec<{data:string}>(query,...bindings).toArray().map(row=>JSON.parse(row.data) as CommunityStoredRecord);}
  async append(input:CommunityEventInput[]):Promise<Outcome<CommunityRecordView[]>>{
    const parsed=z.array(communityEventSchema).min(1).max(64).safeParse(input);
    if(!parsed.success)return fail(400,'Use a bounded batch of minimal community events.');
    const events=parsed.data,journeyId=events[0]!.journeyId;
    if(events.some(event=>event.journeyId!==journeyId)||!this.role('journey',journeyId))return fail(409,'The journal belongs to a different journey.');
    const accepted:CommunityRecordView[]=[];
    try{
      this.ctx.storage.transactionSync(()=>{
        let state=this.meta<JournalState>('journey');
        let next=this.meta<number>('next')??0;
        for(const event of events){
          const id=communityRecordId(event),existing=this.load(id);
          if(existing){if(!sameEvent(existing.event,event))throw new Error('A record identity cannot be reused for different evidence.');accepted.push(publicRecord(existing));continue;}
          if(event.sequence!==next)throw new Error('Community events must be appended in sequence.');
          const projected=applyEvent(state,event);state=projected.state;
          const configuration=communityConfiguration(this.env);
          const record:CommunityStoredRecord={id,event,points:projected.points,reputation:projected.reputation,status:'pending',evidence:'platform_attested',network:configuration.network,programId:configuration.programId,
            issuer:null,recordAddress:null,signature:null,finalizedAt:null,error:configuration.configured?null:'Publication is awaiting community-chain configuration.',withdrawn:this.meta<StoredCorrection>('correction')?.view.status==='finalized',withdrawal:this.meta<StoredCorrection>('correction')?.view.status==='finalized'?this.meta<StoredCorrection>('correction')!.view:null,
            attempts:0,nextAttemptAt:Date.now(),leaseUntil:0,revision:1,indexedRevision:0,submission:null};
          this.save(record);accepted.push(publicRecord(record));next++;
        }
        this.putMeta('journey',state);this.putMeta('next',next);
      });
    }catch(error){return fail(409,error instanceof Error?error.message:'The community event could not be appended.');}
    await this.schedule();
    // Index delivery is best effort after the durable journal and retry alarm exist.
    await this.flushIndex();
    return ok(accepted);
  }
  /** Internal binding-only projection delivery. No HTTP route exposes this method. */
  async mirror(memberId:string,record:CommunityStoredRecord):Promise<Outcome<null>>{
    if(!communityRef.safeParse(memberId).success||!this.role('member',memberId))return fail(409,'Invalid member index.');
    const existing=this.load(record.id);
    if(existing&&(!sameEvent(existing.event,record.event)||existing.revision>record.revision))return existing&&sameEvent(existing.event,record.event)?ok(null):fail(409,'Conflicting evidence cannot replace an indexed record.');
    if(existing?.status==='finalized'&&record.status!=='finalized')return fail(409,'Finalized evidence cannot be downgraded.');
    this.save({...record,submission:null,indexedRevision:record.revision,leaseUntil:0,nextAttemptAt:0});return ok(null);
  }
  private async indexDirty(limit:number){
    const state=this.meta<JournalState>('journey');if(!state)return;
    const records=this.rows('SELECT data FROM records WHERE indexed_revision<revision ORDER BY sequence LIMIT ?',limit);
    for(const record of records){
      const recipients=new Set([state.rider,record.event.actorId,record.event.subjectId,...(record.event.kind==='closed'?state.guardians.map(item=>item.id):[])]);recipients.delete(zero);
      for(const memberId of recipients){
        const result=await this.env.COMMUNITY.getByName(`member:${memberId}`).mirror(memberId,record);
        if(!result.ok)throw new Error('The member index is temporarily unavailable.');
      }
      const current=this.load(record.id);if(current&&current.revision===record.revision){current.indexedRevision=record.revision;this.save(current);}
    }
  }
  private async flushIndex(){
    if((this.meta<number>('indexNext')??0)>Date.now())return;
    try{await this.indexDirty(20);this.putMeta('indexAttempts',0);this.putMeta('indexNext',0);}
    catch{const attempts=(this.meta<number>('indexAttempts')??0)+1;this.putMeta('indexAttempts',attempts);this.putMeta('indexNext',Date.now()+retryDelay(attempts));}
  }
  async member(memberId:string,cursor?:string):Promise<Outcome<CommunityMemberLedger>>{
    const parsed=pageSchema.safeParse(cursor);if(!communityRef.safeParse(memberId).success||!parsed.success)return fail(400,'Invalid community member or page.');
    if(!this.role('member',memberId))return fail(409,'This object is not a member index.');
    const offset=parsed.data??0,records=this.rows('SELECT data FROM records ORDER BY rowid DESC LIMIT 51 OFFSET ?',offset),hasMore=records.length>50;
    // Reads nudge at most five journals; reconciliation runs in their own alarms.
    for(const journeyId of [...new Set(records.map(record=>record.event.journeyId))].slice(0,5)){
      try{await this.env.COMMUNITY.getByName(`journey:${journeyId}`).requestAudit();}catch{/* An explicit operator retry remains available. */}
    }
    const totals=(finalized:boolean):CommunityTotals=>this.ctx.storage.sql.exec<{points:number;reputation:number;contributions:number;banners:number;history:number}>(
      `SELECT COALESCE(SUM(CASE WHEN kind='contribution' AND subject=? THEN points ELSE 0 END),0) points,
      COALESCE(SUM(CASE WHEN kind='contribution' AND subject=? THEN reputation ELSE 0 END),0) reputation,
      COALESCE(SUM(CASE WHEN kind='contribution' AND subject=? THEN 1 ELSE 0 END),0) contributions,
      COALESCE(SUM(CASE WHEN kind='gratitude' AND subject=? THEN 1 ELSE 0 END),0) banners,
      COALESCE(SUM(CASE WHEN kind NOT IN ('contribution','gratitude') THEN 1 ELSE 0 END),0) history
      FROM records WHERE withdrawn=0 AND ${finalized?"status='finalized'":"status!='finalized'"}`,memberId,memberId,memberId,memberId).one();
    const configuration=communityConfiguration(this.env);
    return ok({memberId,evidence:'platform_attested',network:configuration.network,programId:configuration.programId,configured:configuration.configured,
      finalized:totals(true),pending:totals(false),withdrawn:this.ctx.storage.sql.exec<{count:number}>('SELECT COUNT(*) count FROM records WHERE withdrawn=1').one().count,
      records:records.slice(0,50).map(publicRecord),nextCursor:hasMore?String(offset+50):null});
  }
  async journey(journeyId:string,cursor?:string):Promise<Outcome<{records:CommunityRecordView[];nextCursor:string|null;correction:CommunityCorrectionView|null}>>{
    const parsed=pageSchema.safeParse(cursor);if(!communityRef.safeParse(journeyId).success||!parsed.success)return fail(400,'Invalid journey or page.');
    if(!this.role('journey',journeyId))return fail(409,'This object is not the requested journey journal.');
    const offset=parsed.data??0,records=this.rows('SELECT data FROM records ORDER BY sequence LIMIT 51 OFFSET ?',offset);
    await this.requestAudit();
    return ok({records:records.slice(0,50).map(publicRecord),nextCursor:records.length>50?String(offset+50):null,correction:this.meta<StoredCorrection>('correction')?.view??null});
  }
  async retry():Promise<Outcome<null>>{
    if(this.meta<{kind:string}>('identity')?.kind!=='journey')return fail(409,'Only a journey journal can publish.');
    for(const record of this.rows("SELECT data FROM records WHERE status!='finalized' ORDER BY sequence LIMIT 64")){record.nextAttemptAt=Date.now();this.save(record);}
    this.putMeta('auditRequested',true);this.putMeta('auditNext',Date.now());
    await this.schedule();return ok(null);
  }
  async requestAudit():Promise<void>{
    if(this.meta<{kind:string}>('identity')?.kind!=='journey'||!communityReadConfigured(this.env))return;
    if(Date.now()-(this.meta<number>('auditedAt')??0)<5*60_000||this.meta<boolean>('auditRequested'))return;
    this.putMeta('auditRequested',true);this.putMeta('auditNext',Date.now());await this.schedule();
  }
  private async schedule(){
    const pending=this.ctx.storage.sql.exec<{at:number}>("SELECT MAX(next_attempt,lease) at FROM records WHERE status!='finalized' ORDER BY sequence LIMIT 1").toArray()[0]?.at??null;
    const dirty=this.ctx.storage.sql.exec<{count:number}>('SELECT COUNT(*) count FROM records WHERE indexed_revision<revision').one().count;
    const correction=this.meta<StoredCorrection>('correction');
    const times=[pending,dirty?Math.max(Date.now()+5_000,this.meta<number>('indexNext')??0):null,this.meta<boolean>('auditRequested')?this.meta<number>('auditNext')??Date.now()+5_000:null,correction&&correction.submission&&correction.view.status!=='finalized'?Math.max(correction.nextAttemptAt,correction.leaseUntil):null].filter((value):value is number=>value!==null);
    if(times.length)await this.ctx.storage.setAlarm(Math.max(Date.now()+1_000,Math.min(...times)));else await this.ctx.storage.deleteAlarm();
  }
  async alarm(){if(this.work)return this.work;this.work=this.process().finally(()=>{this.work=null;});return this.work;}
  private async process(){
    try{
      await this.flushIndex();
      const record=this.rows("SELECT data FROM records WHERE status!='finalized' ORDER BY sequence LIMIT 1")[0];
      if(record&&record.nextAttemptAt<=Date.now()&&record.leaseUntil<=Date.now())await this.publish(record);
      if(this.meta<boolean>('auditRequested')&&(this.meta<number>('auditNext')??0)<=Date.now())await this.auditWithdrawal();
      await this.processCorrection();
      await this.flushIndex();
    }finally{await this.schedule();}
  }
  private async publish(record:CommunityStoredRecord){
    if(!communityConfiguration(this.env).configured){record.status='pending';record.error='Publication is awaiting community-chain configuration.';record.nextAttemptAt=Date.now()+30*60_000;record.leaseUntil=0;record.revision++;this.save(record);return;}
    record.leaseUntil=Date.now()+30_000;record.attempts++;this.save(record);
    try{
      const prepared=await prepareCommunityRecord(this.env,record);
      if('submission' in prepared){
        record.submission=prepared.submission;record.programId=prepared.programId;record.issuer=prepared.issuer;record.recordAddress=prepared.recordAddress;
        record.signature=prepared.submission.signature;record.status='submitted';record.error=null;record.revision++;this.save(record);
        const result=await sendCommunityRecord(this.env,record);Object.assign(record,result);
      }else Object.assign(record,prepared);
      record.error=null;record.leaseUntil=0;record.nextAttemptAt=record.status==='finalized'?0:Date.now()+5_000;record.revision++;this.save(record);
    }catch{
      record.status='retry';record.error='The chain record is awaiting a verified retry.';record.leaseUntil=0;record.nextAttemptAt=Date.now()+retryDelay(record.attempts);record.revision++;this.save(record);
    }
  }
  /** Called only after operator authentication in the Worker; admin signature stays external. */
  async prepareCorrection(input:CommunityCorrectionInput):Promise<Outcome<CommunityCorrectionPreparation>>{
    const parsed=correctionSchema.safeParse(input);if(!parsed.success)return fail(400,'Invalid correction request.');
    if(!this.role('journey',input.journeyId))return fail(409,'Incorrect journey journal.');
    if(!this.load(`${input.journeyId}:${input.targetSequence}`))return fail(404,'The correction target does not exist.');
    if(!this.meta<JournalState>('journey')?.outcome)return fail(409,'Close the journey before requesting a correction.');
    if(this.rows("SELECT data FROM records WHERE status!='finalized' LIMIT 1").length)return fail(409,'Publish the original journey records before correcting them.');
    const prior=this.meta<StoredCorrection>('correction');
    if(prior&&(prior.view.targetSequence!==input.targetSequence||prior.view.reason!==input.reason))return fail(409,'A different correction is already recorded.');
    if(prior?.view.status==='finalized')return fail(409,'This journey has already been withdrawn.');
    if(prior&&prior.expiresAt>Date.now()&&prior.view.sequence===(this.meta<number>('next')??0))return ok({correction:prior.view,transaction:prior.transaction,admin:prior.admin,expiresAt:prior.expiresAt});
    try{
      const first=this.rows('SELECT data FROM records ORDER BY sequence LIMIT 1')[0],configuration=communityConfiguration(this.env);
      if(first&&(first.programId!==configuration.programId||first.network!==configuration.network))return fail(409,'The journal belongs to a different deployed community program.');
      const expectedNext=this.meta<number>('next')??0;
      const view:CommunityCorrectionView={...input,sequence:expectedNext,observedAt:Math.max(this.meta<JournalState>('journey')?.lastObservedAt??0,Math.floor(Date.now()/1000)),status:'pending',recordAddress:null,signature:null,finalizedAt:null,error:null,authority:null};
      const prepared=await prepareCommunityCorrection(this.env,view);
      const current=this.meta<StoredCorrection>('correction');if(current&&current.view.status==='finalized')return fail(409,'This journey has already been withdrawn.');
      if((this.meta<number>('next')??0)!==expectedNext)return fail(409,'New records arrived; publish them before preparing another correction.');
      const updated={...view,recordAddress:prepared.recordAddress,authority:prepared.admin};
      this.putMeta('correction',{view:updated,transaction:prepared.transaction,admin:prepared.admin,expiresAt:prepared.expiresAt,submission:null,attempts:0,nextAttemptAt:Date.now(),leaseUntil:0} satisfies StoredCorrection);
      return ok({correction:updated,transaction:prepared.transaction,admin:prepared.admin,expiresAt:prepared.expiresAt});
    }catch{return fail(503,'Correction signing is awaiting valid chain configuration.');}
  }
  async submitCorrection(transaction:string):Promise<Outcome<CommunityCorrectionView>>{
    const correction=this.meta<StoredCorrection>('correction');if(!correction)return fail(404,'Prepare an operator correction first.');
    if(correction.view.status==='finalized')return ok(correction.view);
    if(correction.view.sequence!==(this.meta<number>('next')??0))return fail(409,'New records arrived; prepare a fresh correction after publication.');
    try{
      const submission=acceptCommunityCorrection(correction.transaction,transaction,correction.expiresAt);
      correction.submission=submission;correction.view.signature=submission.signature;correction.view.status='submitted';correction.nextAttemptAt=Date.now();this.putMeta('correction',correction);await this.schedule();return ok(correction.view);
    }catch{return fail(400,'The transaction must match the prepared correction and contain both required signatures.');}
  }
  private async processCorrection(){
    const correction=this.meta<StoredCorrection>('correction');
    if(!correction?.submission||correction.view.status==='finalized'||correction.nextAttemptAt>Date.now()||correction.leaseUntil>Date.now())return;
    correction.attempts++;correction.leaseUntil=Date.now()+30_000;this.putMeta('correction',correction);
    try{
      const result=await reconcileCommunityCorrection(this.env,correction.view,correction.submission,correction.admin);
      correction.view={...correction.view,...result,error:null};correction.leaseUntil=0;correction.nextAttemptAt=Date.now()+5_000;
      this.ctx.storage.transactionSync(()=>{
        this.putMeta('correction',correction);
        if(result.status==='finalized')for(const record of this.rows('SELECT data FROM records')){record.withdrawn=true;record.withdrawal=correction.view;record.revision++;this.save(record);}
      });
    }catch{correction.view.status='retry';correction.view.error='The correction is awaiting a verified retry.';correction.leaseUntil=0;correction.nextAttemptAt=Date.now()+retryDelay(correction.attempts);this.putMeta('correction',correction);}
  }
  private async auditWithdrawal(){
    if(!communityReadConfigured(this.env)){this.putMeta('auditRequested',false);return;}
    const identity=this.meta<{kind:string;id:string}>('identity');if(!identity||identity.kind!=='journey')return;
    try{
      const first=this.rows('SELECT data FROM records ORDER BY sequence LIMIT 1')[0];
      const view=await readCommunityWithdrawal(this.env,identity.id,first?.programId??undefined);
      const existing=this.meta<StoredCorrection>('correction');
      if(view&&existing?.view.status==='finalized'&&existing.view.recordAddress===view.recordAddress){this.putMeta('auditRequested',false);this.putMeta('auditedAt',Date.now());return;}
      if(view)this.ctx.storage.transactionSync(()=>{
        this.putMeta('correction',{view,transaction:'',admin:view.authority??'',expiresAt:0,submission:null,attempts:0,nextAttemptAt:0,leaseUntil:0} satisfies StoredCorrection);
        for(const record of this.rows('SELECT data FROM records')){record.withdrawn=true;record.withdrawal=view;record.revision++;this.save(record);}
      });
      this.putMeta('auditRequested',false);this.putMeta('auditedAt',Date.now());
    }catch{this.putMeta('auditNext',Date.now()+5*60_000);}
  }
}
