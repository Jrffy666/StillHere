import { DurableObject } from 'cloudflare:workers';
import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { z } from 'zod';
import {
  SafetyGuardV2Client, decodeJourneyV2, deriveJourneyAddress,
  randomJourneyReference, journeyReferenceFromHex, journeyReferenceToHex,
} from '../../chain/src/v2';
import { boundedJson } from './integrations';
import { chainSnapshotSchema } from './snapshots';
import { fail, ok, type Outcome, type Person, type User, type WorkerEnv } from './types';
import type { ChainBinding, ChainIntent, ChainOperation, ChainSnapshot, ChainView } from './chain-types';

const zero = PublicKey.default.toBase58();
const devnetGenesis='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const publicGenesis=new Set([devnetGenesis,'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d','4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY']);
export const operationSchema = z.enum(['create','propose','cancel-proposal','accept','check-in','complete','cancel','claim']);
const keySchema = z.string().min(32).max(44).refine(value => { try { return new PublicKey(value).toBase58() === value; } catch { return false; } });
const terminal = (intent:ChainIntent) => ['confirmed','failed','expired'].includes(intent.status);
const messageBytes = (transaction:Transaction) => transaction.serializeMessage().toString('base64');
function acceptsSnapshot(previous:ChainSnapshot,next:ChainSnapshot):boolean {
  if(next.slot<previous.slot||next.sequence<previous.sequence||next.revision<previous.revision)return false;
  if(['completed','cancelled'].includes(previous.state)&&next.state!==previous.state)return false;
  if(previous.state==='active'&&next.state==='open')return false;
  if(previous.state!=='uncreated'&&Math.floor(previous.deadline/1000)!==Math.floor(next.deadline/1000))return false;
  if(previous.state==='active'&&next.state==='active'&&next.sequence===previous.sequence&&next.currentGuardian!==previous.currentGuardian)return false;
  if(new Set(next.contributions.map(item=>item.wallet)).size!==next.contributions.length)return false;
  if(next.contributions.reduce((sum,item)=>sum+item.points,0)>25||next.contributions.reduce((sum,item)=>sum+item.reputation,0)>10)return false;
  return previous.contributions.every(prior=>{
    const current=next.contributions.find(item=>item.wallet===prior.wallet);
    return current&&current.checkIns>=prior.checkIns&&(!prior.claimed||current.claimed)
      &&(previous.state!=='completed'||current.points===prior.points&&current.reputation===prior.reputation);
  });
}

export function chainConfigured(env:WorkerEnv):boolean {
  return Boolean(keySchema.safeParse(env.SOLANA_V2_PROGRAM_ID).success && env.SOLANA_V2_PROGRAM_ID !== zero);
}
function network(env:WorkerEnv):'devnet'|'localnet' {
  if (env.SOLANA_NETWORK === 'localnet' && env.APP_ENV === 'development') return 'localnet';
  if (env.SOLANA_NETWORK === 'devnet') return 'devnet';
  throw new Error('Only configured Devnet or local development chains are supported.');
}
class RpcServiceError extends Error {}
function rpcEndpoint(env:WorkerEnv):URL {
  let url:URL;
  try { url=new URL(env.SOLANA_PRIVATE_RPC_URL?.trim()||env.SOLANA_RPC_URL); }
  catch { throw new Error('Invalid RPC configuration.'); }
  if (url.username || url.password) throw new Error('Invalid RPC configuration.');
  const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  const cluster = network(env);
  if ((cluster === 'localnet' && !local) || (cluster === 'devnet' && (local || url.protocol !== 'https:'))) throw new Error('RPC network configuration is invalid.');
  return url;
}
async function connection(env:WorkerEnv):Promise<Connection> {
  const url=rpcEndpoint(env),cluster=network(env);
  // One deadline bounds the entire reconciliation/preparation, rather than each RPC.
  const signal=AbortSignal.timeout(8000);
  const rpc = new Connection(url.toString(), {commitment:'finalized',disableRetryOnRateLimit:true,
    fetch:async(input,init) => {
      try {
        const response = await fetch(input,{...init,redirect:'manual',signal});
        // Never follow a redirect carrying a server API key in its query or headers.
        if (!response.ok) { await response.body?.cancel(); throw new RpcServiceError(`The chain service is unavailable (HTTP ${response.status}).`); }
        const data=await boundedJson(response,512000);
        // Provider error messages may echo authenticated URLs or request bodies.
        if(data&&typeof data==='object'&&'error'in data)throw new RpcServiceError('The chain service rejected the RPC request.');
        return Response.json(data);
      } catch(error) {
        if(error instanceof RpcServiceError)throw error;
        throw new RpcServiceError('The chain service is temporarily unavailable.');
      }
    }});
  const genesis = await rpc.getGenesisHash();
  if (cluster === 'devnet' && genesis!==devnetGenesis) throw new Error('The RPC is not connected to Devnet.');
  if(cluster==='localnet'&&publicGenesis.has(genesis))throw new Error('Local development cannot proxy a public blockchain.');
  return rpc;
}

/** One durable transaction outbox per application journey. No private key is ever held here. */
export class ChainJourney extends DurableObject<WorkerEnv> {
  private synchronization:Promise<void>|null=null;
  constructor(ctx:DurableObjectState,env:WorkerEnv) {
    super(ctx,env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS erased (id INTEGER PRIMARY KEY CHECK(id=1))');
  }
  private load():ChainBinding|null { const row=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM binding WHERE id=1').toArray()[0];return row?JSON.parse(row.data) as ChainBinding:null; }
  private save(value:ChainBinding):void {
    if(this.ctx.storage.sql.exec('SELECT id FROM erased').toArray().length)throw new Error('Journey record was erased.');
    value.updatedAt=Math.max(Date.now(),(this.load()?.updatedAt??0)+1);
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO binding VALUES (1,?)',JSON.stringify(value));
  }
  private configured(state:ChainBinding):boolean {
    try{return state.programId===this.env.SOLANA_V2_PROGRAM_ID&&state.network===network(this.env);}catch{return false;}
  }
  private transactionFor(state:ChainBinding,operation:ChainOperation,signer:string):Transaction {
    const sdk=new SafetyGuardV2Client(new Connection(rpcEndpoint(this.env).toString()),new PublicKey(state.programId));
    const input={rider:new PublicKey(state.rider.wallet),reference:journeyReferenceFromHex(state.reference),expectedRevision:state.snapshot.revision};
    return operation==='create'?sdk.createJourney({...input,deadline:Math.floor(state.snapshot.deadline/1000)}):
      operation==='propose'?sdk.proposeGuardian({...input,guardian:new PublicKey(state.proposal!.member.wallet)}):
      operation==='cancel-proposal'?sdk.cancelProposal(input):
      operation==='accept'?sdk.acceptGuardian({...input,guardian:new PublicKey(signer)}):
      operation==='check-in'?sdk.checkIn({...input,guardian:new PublicKey(signer),expectedSequence:state.snapshot.sequence}):
      operation==='complete'?sdk.completeJourney(input):operation==='cancel'?sdk.cancelJourney(input):
      sdk.claimReward({...input,guardian:new PublicKey(signer),payer:new PublicKey(signer)});
  }
  private async schedule():Promise<void> {
    const state=this.load(); if (!state) return;
    const waiting=state.intents.some(intent=>!terminal(intent));
    const active=['open','active'].includes(state.snapshot.state) && state.snapshot.deadline>Date.now();
    if (waiting || active) await this.ctx.storage.setAlarm(Date.now()+(waiting?10000:30000));
    else await this.ctx.storage.deleteAlarm();
  }
  initialize(tripId:string,rider:Person):Outcome<ChainView> {
    if (this.ctx.storage.sql.exec('SELECT id FROM erased').toArray().length) return fail(410,'This journey record was erased.');
    const prior=this.load();if(prior) return prior.tripId===tripId&&prior.rider.person.id===rider.id?ok(this.present(prior,rider.id)):fail(409,'Journey already linked.');
    if (!rider.wallet || !chainConfigured(this.env)) return fail(409,'A verified wallet and V2 deployment are required.');
    const reference=journeyReferenceToHex(randomJourneyReference());
    const address=deriveJourneyAddress(new PublicKey(rider.wallet),journeyReferenceFromHex(reference),new PublicKey(this.env.SOLANA_V2_PROGRAM_ID)).toBase58();
    const member={person:{id:rider.id,name:rider.name,wallet:rider.wallet},wallet:rider.wallet};
    const state:ChainBinding={tripId,reference,programId:this.env.SOLANA_V2_PROGRAM_ID,network:network(this.env),rider:member,members:[member],proposal:null,
      snapshot:{address,state:'uncreated',currentGuardian:null,proposedGuardian:null,proposalExpiresAt:0,revision:0,sequence:0,deadline:Date.now()+6*3600000,slot:0,contributions:[]},
      intents:[],updatedAt:Date.now(),lastError:null};
    this.save(state);return ok(this.present(state,rider.id));
  }
  private present(state:ChainBinding,userId:string):ChainView {
    const member=state.members.find(item=>item.person.id===userId);
    const contribution=state.snapshot.contributions.find(item=>item.wallet===member?.wallet);
    return {version:2,reference:state.reference,programId:state.programId,network:state.network,riderWallet:state.rider.wallet,
      snapshot:state.snapshot,updatedAt:state.updatedAt,lastError:state.lastError,wallet:member?.wallet??null,
      canAccept:Boolean(member && state.proposal?.member.person.id===userId && state.snapshot.proposedGuardian===member.wallet && state.snapshot.proposalExpiresAt>Date.now()),
      canClaim:Boolean(contribution && state.snapshot.state==='completed' && contribution.checkIns>0 && !contribution.claimed),
      intents:state.intents.filter(item=>item.actorId===userId).slice(-8).map(({id,operation,status,signature,error,createdAt})=>({id,operation,status,signature,error,createdAt}))};
  }
  async view(userId:string):Promise<Outcome<ChainView>> {
    const state=this.load();if(!state)return fail(404,'This trip has no linked chain journey.');
    const access=await this.env.TRIPS.getByName(state.tripId).read(userId);
    if(!access.ok && !state.members.some(item=>item.person.id===userId))return fail(403,'Journey access is required.');
    const latest=this.load();return latest?ok(this.present(latest,userId)):fail(410,'Journey record erased.');
  }
  private async authorize(state:ChainBinding,userId:string,operation:ChainOperation,applicationId?:string,submitting=false):Promise<Outcome<{signer:string;proposal:ChainBinding['proposal']}>> {
    if(!this.configured(state))return fail(409,'This journey belongs to another program or network configuration.');
    const restriction=await this.env.GOVERNANCE.getByName('governance-v1').status(userId);
    if(restriction.deleted || (restriction.suspended && !['cancel','cancel-proposal'].includes(operation)))return fail(403,'This account cannot perform chain operations.');
    const context=await this.env.TRIPS.getByName(state.tripId).chainContext();
    if(!context)return fail(410,'The private journey has expired or was erased.');
    const rider=userId===state.rider.person.id,member=state.members.find(item=>item.person.id===userId);
    const signer=rider?state.rider.wallet:member?.wallet;
    if(!signer)return fail(403,'A participant wallet is required.');
    if(['create','propose','cancel-proposal','complete','cancel'].includes(operation)&&!rider)return fail(403,'Only the rider may authorize this transaction.');
    if(['create','propose','accept','check-in'].includes(operation)&&['arrived','cancelled'].includes(context.status))return fail(409,'The application journey has ended.');
    if(operation==='complete'&&context.status!=='arrived')return fail(409,'Confirm arrival in the application before chain settlement.');
    if(operation==='cancel'&&context.status!=='cancelled')return fail(409,'Cancel monitoring in the application before cancelling the chain commitment.');
    if(operation==='check-in' && (context.guardian?.id!==userId || state.snapshot.currentGuardian!==signer))return fail(403,'Only the current approved guardian may sign a contribution.');
    if(operation==='accept' && (!this.present(state,userId).canAccept || !state.proposal
      || !await this.env.TRIPS.getByName(state.tripId).chainApplicationAvailable(state.proposal.applicationId,userId)))return fail(409,'This approved proposal is no longer available.');
    if(operation==='claim'&&!this.present(state,userId).canClaim)return fail(409,'No unclaimed contribution is available.');
    if(operation==='create'&&state.snapshot.state!=='uncreated')return fail(409,'This journey already exists on chain.');
    let proposal=state.proposal;
    if(operation==='propose') {
      const request=context.guardianRequests.find(item=>item.id===applicationId&&item.expiresAt>Date.now());
      const candidate=submitting&&proposal&&proposal.applicationId===applicationId?proposal.member.person:request?.candidate;
      if(!applicationId||!candidate?.wallet)return fail(409,'An unexpired application with a verified wallet is required.');
      if(submitting&&!await this.env.TRIPS.getByName(state.tripId).chainApplicationAvailable(applicationId,candidate.id))return fail(409,'This application was withdrawn or rejected.');
      const status=await this.env.GOVERNANCE.getByName('governance-v1').status(candidate.id);
      const account=await this.env.USERS.getByName(candidate.id).getPublic();
      if(status.deleted||status.suspended||!account||account.status!=='active')return fail(403,'This applicant is unavailable.');
      if(account.wallet!==candidate.wallet)return fail(409,'The applicant changed wallets. Ask them to submit a fresh application.');
      const existing=state.members.find(item=>item.person.id===candidate.id);
      if(existing&&existing.wallet!==candidate.wallet)return fail(409,'A returning guardian must use their original journey wallet.');
      if(!state.snapshot.contributions.some(item=>item.wallet===candidate.wallet)&&state.snapshot.contributions.length>=16)return fail(409,'This journey has reached its sixteen-guardian limit.');
      if(state.members.some(item=>item.wallet===candidate.wallet&&item.person.id!==candidate.id))return fail(409,'This wallet is already associated with a different participant.');
      if(!existing&&state.members.length>=100)return fail(409,'This journey has reached its participant limit.');
      proposal={applicationId,member:{person:candidate,wallet:candidate.wallet}};
    }
    return ok({signer,proposal});
  }
  async prepare(user:User,operation:ChainOperation,applicationId?:string):Promise<Outcome<{intentId:string;transaction:string;wallet:string;view:ChainView}>> {
    let state=this.load();if(!state)return fail(404,'Chain journey is not linked.');
    if(state.preparingUntil && state.preparingUntil>Date.now())return fail(409,'Another transaction is being prepared.');
    const prior=state.intents.find(intent=>intent.status==='submitted'||intent.status==='prepared'&&intent.expiresAt>Date.now());
    if(prior)return fail(409,'Resolve or discard the pending transaction first.');
    const authorized=await this.authorize(state,user.id,operation,applicationId);if(!authorized.ok)return authorized;
    const {signer}=authorized.value;
    if(operation==='propose'&&authorized.value.proposal){
      const reserved=await this.env.TRIPS.getByName(state.tripId).reserveChainApplication(authorized.value.proposal.applicationId,authorized.value.proposal.member.person.id);
      if(!reserved.ok)return reserved;
      state.proposal=authorized.value.proposal;
      if(!state.members.some(item=>item.person.id===state!.proposal!.member.person.id))state.members.push(state.proposal.member);
    }
    if(this.load()?.updatedAt!==state.updatedAt)return fail(409,'The journey changed. Refresh and retry.');
    const lease=Date.now()+45000;state.preparingUntil=lease;this.save(state);
    try {
      const rpc=await connection(this.env);const sdk=new SafetyGuardV2Client(rpc,new PublicKey(state.programId));
      if(!await sdk.isProgramDeployed())throw new Error('The V2 program is not deployed on this network.');
      const tx=this.transactionFor(state,operation,signer);
      const prepared=await sdk.prepareTransaction(tx,new PublicKey(signer),'finalized');
      const checked=await this.authorize(state,user.id,operation,applicationId,true);if(!checked.ok)throw new Error(checked.error);
      const fresh=this.load();if(!fresh || fresh.preparingUntil!==lease || fresh.snapshot.revision!==state.snapshot.revision || fresh.snapshot.sequence!==state.snapshot.sequence
        || fresh.snapshot.state!==state.snapshot.state || fresh.proposal?.applicationId!==state.proposal?.applicationId)throw new Error('Journey changed while preparing. Refresh and retry.');
      const intent:ChainIntent={id:crypto.randomUUID(),actorId:user.id,wallet:signer,operation,status:'prepared',createdAt:Date.now(),expiresAt:Date.now()+120000,
        transaction:tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64'),message:messageBytes(tx),blockhash:prepared.blockhash,lastValidBlockHeight:prepared.lastValidBlockHeight,
        signature:null,signedTransaction:null,error:null};
      for(const previous of fresh.intents)if(previous.status==='prepared'&&previous.expiresAt<=Date.now()){previous.status='expired';previous.error='The unsigned transaction expired.';}
      fresh.preparingUntil=0;fresh.intents=fresh.intents.filter(item=>!terminal(item)).concat(fresh.intents.filter(terminal).slice(-15),intent);fresh.lastError=null;
      this.save(fresh);await this.schedule();return ok({intentId:intent.id,transaction:intent.transaction,wallet:signer,view:this.present(fresh,user.id)});
    } catch(error) {
      state=this.load()!;if(state&&state.preparingUntil===lease){state.preparingUntil=0;state.lastError=error instanceof Error?error.message:'The chain service is unavailable.';this.save(state);}
      return fail(503,'The chain transaction could not be prepared. Monitoring remains available; refresh and retry.');
    }
  }
  async submit(userId:string,intentId:string,encoded:string):Promise<Outcome<ChainView>> {
    const state=this.load();if(!state)return fail(404,'Chain journey not found.');
    const intent=state.intents.find(item=>item.id===intentId&&item.actorId===userId);
    if(!intent)return fail(403,'This transaction does not belong to your account.');
    if(intent.status!=='prepared')return ok(this.present(state,userId));
    if(intent.expiresAt<=Date.now())return fail(409,'This unsigned transaction has expired. Prepare a new one.');
    if(encoded.length>5000)return fail(400,'Signed transaction is too large.');
    let tx:Transaction;
    try{
      if(!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw new Error('Invalid encoding.');
      tx=Transaction.from(Buffer.from(encoded,'base64'));
      if(messageBytes(tx)!==intent.message || !tx.feePayer?.equals(new PublicKey(intent.wallet)) || !tx.verifySignatures() || !tx.signature)throw new Error('Invalid signature.');
    }catch{return fail(400,'The signed transaction does not match the authorized operation.');}
    const authorized=await this.authorize(state,userId,intent.operation,state.proposal?.applicationId,true);if(!authorized.ok)return authorized;
    const fresh=this.load(),current=fresh?.intents.find(item=>item.id===intentId&&item.actorId===userId);
    if(!fresh||!current)return fail(410,'This journey or transaction was erased.');
    if(current.status!=='prepared')return ok(this.present(fresh,userId));
    if(fresh.updatedAt!==state.updatedAt||current.expiresAt<=Date.now())return fail(409,'Journey authorization changed. Refresh and prepare again.');
    const expected=this.transactionFor(fresh,current.operation,authorized.value.signer);
    expected.feePayer=new PublicKey(current.wallet);expected.recentBlockhash=current.blockhash;
    if(messageBytes(expected)!==current.message)return fail(409,'The journey changed after this transaction was prepared. Discard it and prepare again.');
    current.signedTransaction=encoded;current.signature=bs58.encode(tx.signature!);current.status='submitted';current.expiresAt=Date.now()+300000;
    this.save(fresh);await this.schedule();
    // Persist before broadcasting; callers get a pending receipt even if RPC is down.
    this.ctx.waitUntil(this.synchronize());return ok(this.present(fresh,userId));
  }
  async discard(userId:string,intentId:string):Promise<Outcome<ChainView>> {
    const state=this.load();if(!state)return fail(404,'Chain journey not found.');
    const intent=state.intents.find(item=>item.id===intentId&&item.actorId===userId);
    if(!intent)return fail(403,'Transaction access denied.');
    if(intent.status==='submitted')return fail(409,'A broadcast transaction cannot be discarded. Refresh its status.');
    if(intent.status==='prepared'){intent.status='expired';intent.error='Unsigned transaction discarded.';this.save(state);await this.schedule();}
    return ok(this.present(state,userId));
  }
  async refresh(userId:string):Promise<Outcome<ChainView>> {
    const access=await this.view(userId);if(!access.ok)return access;
    await this.synchronize();return this.view(userId);
  }
  private synchronize():Promise<void> {
    if(this.synchronization)return this.synchronization;
    this.synchronization=this.reconcile().finally(()=>{this.synchronization=null;});return this.synchronization;
  }
  private async reconcile():Promise<void> {
    let state=this.load();if(!state)return;
    try {
      if(!this.configured(state))throw new Error('Journey network configuration changed.');
      for(const intent of state.intents)if(intent.status==='prepared'&&intent.expiresAt<=Date.now()){intent.status='expired';intent.error='The unsigned transaction expired.';}
      this.save(state);
      const rpc=await connection(this.env);
      for(const previous of state.intents.filter(item=>!terminal(item))) {
        const current=this.load();const intent=current?.intents.find(item=>item.id===previous.id);if(!current||!intent||terminal(intent))continue;
        if(intent.status==='prepared') {if(intent.expiresAt<=Date.now()){intent.status='expired';intent.error='The unsigned transaction expired.';this.save(current);}continue;}
        const status=(await rpc.getSignatureStatuses([intent.signature!],{searchTransactionHistory:true})).value[0];
        const latest=this.load();const item=latest?.intents.find(value=>value.id===intent.id);if(!latest||!item||terminal(item))continue;
        if(status?.confirmationStatus==='finalized'){
          item.status=status.err?'failed':'confirmed';item.error=status.err?'The program rejected this transaction. Refresh and prepare a new operation.':null;this.save(latest);
        } else if(await rpc.getBlockHeight('finalized')>item.lastValidBlockHeight){
          // A processed signature can disappear with a fork. Only a finalized
          // receipt survives after the finalized block height passes its expiry.
          const receipt=await rpc.getTransaction(item.signature!,{commitment:'finalized',maxSupportedTransactionVersion:0});
          const fresh=this.load(),pending=fresh?.intents.find(value=>value.id===item.id);if(!fresh||!pending||terminal(pending))continue;
          pending.status=receipt?(receipt.meta?.err?'failed':'confirmed'):'expired';
          pending.error=pending.status==='confirmed'?null:pending.status==='failed'?'The program rejected this transaction.':'The transaction expired without a finalized receipt.';this.save(fresh);
        } else if(!status && item.signedTransaction) {
          const restriction=await this.env.GOVERNANCE.getByName('governance-v1').status(item.actorId);
          const fresh=this.load(),pending=fresh?.intents.find(value=>value.id===item.id);
          if(!fresh||!pending?.signedTransaction||terminal(pending)||restriction.deleted||(restriction.suspended&&!['cancel','cancel-proposal'].includes(pending.operation)))continue;
          try{await rpc.sendRawTransaction(Buffer.from(pending.signedTransaction,'base64'),{skipPreflight:false,maxRetries:0});}
          catch{ /* Keep the same signed bytes and signature; the next alarm checks before rebroadcasting. */ }
        }
      }
      state=this.load();if(!state)return;
      const account=await rpc.getAccountInfoAndContext(new PublicKey(state.snapshot.address),{commitment:'finalized',minContextSlot:state.snapshot.slot});
      if(account.value) {
        if(!account.value.owner.equals(new PublicKey(state.programId)))throw new Error('Unexpected chain account owner.');
        const decoded=decodeJourneyV2(account.value.data);
        if(decoded.rider.toBase58()!==state.rider.wallet || journeyReferenceToHex(decoded.reference)!==state.reference)throw new Error('Chain journey identity mismatch.');
        const snapshot:ChainSnapshot={address:state.snapshot.address,state:decoded.state,currentGuardian:decoded.currentGuardian.toBase58()===zero?null:decoded.currentGuardian.toBase58(),
          proposedGuardian:decoded.proposedGuardian.toBase58()===zero?null:decoded.proposedGuardian.toBase58(),proposalExpiresAt:decoded.proposalExpiresAt*1000,
          revision:decoded.assignmentRevision,sequence:decoded.sequence,deadline:decoded.deadline*1000,slot:account.context.slot,
          contributions:decoded.contributions.map(item=>({wallet:item.guardian.toBase58(),checkIns:item.checkIns,startedAt:item.startedAt*1000,endedAt:item.endedAt*1000,
            points:Number(item.points),reputation:Number(item.reputation),claimed:item.claimed}))};
        const latest=this.load();if(!latest)return;
        if(!chainSnapshotSchema.shape.snapshot.safeParse(snapshot).success)throw new Error('Invalid chain snapshot.');
        if(acceptsSnapshot(latest.snapshot,snapshot)) {
          latest.snapshot=snapshot;latest.lastError=null;this.save(latest);
          const applied=await this.env.TRIPS.getByName(latest.tripId).applyChainSnapshot(snapshot,latest.members,latest.proposal?.applicationId??null);
          if(!applied.ok){const fresh=this.load();if(fresh){fresh.lastError=applied.error;this.save(fresh);}}
        }
      }
    } catch {
      state=this.load();if(state){state.lastError='Chain confirmation is temporarily unavailable. Monitoring and help are still available.';this.save(state);}
    } finally {await this.schedule();}
  }
  async alarm():Promise<void> {await this.synchronize();}
  exportSnapshot():ChainBinding|null {return this.load();}
  validateSnapshot(value:unknown,expectedId:string):boolean {
    const parsed=chainSnapshotSchema.safeParse(value);if(!parsed.success||parsed.data.tripId!==expectedId)return false;
    try{
      const state=parsed.data;
      if(new Set(state.members.map(item=>item.person.id)).size!==state.members.length||new Set(state.members.map(item=>item.wallet)).size!==state.members.length
        ||new Set(state.intents.map(item=>item.id)).size!==state.intents.length||new Set(state.snapshot.contributions.map(item=>item.wallet)).size!==state.snapshot.contributions.length)return false;
      if(!state.members.some(item=>item.person.id===state.rider.person.id&&item.wallet===state.rider.wallet)
        ||state.members.some(item=>item.person.wallet!==item.wallet)||state.rider.person.wallet!==state.rider.wallet)return false;
      if(state.proposal&&!state.members.some(item=>item.person.id===state.proposal!.member.person.id&&item.wallet===state.proposal!.member.wallet))return false;
      if(state.intents.some(item=>!state.members.some(member=>member.person.id===item.actorId&&member.wallet===item.wallet)
        ||item.signature!==null&&bs58.decode(item.signature).length!==64||item.status==='submitted'&&!item.signature))return false;
      if(state.snapshot.contributions.reduce((sum,item)=>sum+item.points,0)>25||state.snapshot.contributions.reduce((sum,item)=>sum+item.reputation,0)>10)return false;
      return deriveJourneyAddress(new PublicKey(state.rider.wallet),journeyReferenceFromHex(state.reference),new PublicKey(state.programId)).toBase58()===state.snapshot.address;
    }catch{return false;}
  }
  async purge():Promise<void> {this.ctx.storage.sql.exec('DELETE FROM binding');this.ctx.storage.sql.exec('INSERT OR IGNORE INTO erased VALUES (1)');await this.ctx.storage.deleteAlarm();}
  async scrubUser(userId:string):Promise<void> {
    const state=this.load();if(!state)return;
    if(state.rider.person.id===userId){await this.purge();return;}
    for(const member of state.members)if(member.person.id===userId)member.person={id:userId,name:'Deleted account',wallet:member.wallet};
    if(state.proposal?.member.person.id===userId){state.proposal=null;state.preparingUntil=0;}
    for(const intent of state.intents)if(intent.actorId===userId){
      intent.signedTransaction=null;intent.transaction='';intent.message='';
      if(intent.status==='prepared'){intent.status='expired';intent.error='Account access was removed.';}
    }
    this.save(state);await this.schedule();
  }
  async restoreSnapshot(value:ChainBinding):Promise<boolean> {
    if(this.load()||this.ctx.storage.sql.exec('SELECT id FROM erased').toArray().length)return false;
    if(!this.validateSnapshot(value,value?.tripId))return false;
    value=chainSnapshotSchema.parse(value);
    const governance=this.env.GOVERNANCE.getByName('governance-v1');
    if(await governance.isTripPurged(value.tripId)||(await governance.status(value.rider.person.id)).deleted)return false;
    for(const member of value.members)if((await governance.status(member.person.id)).deleted){
      member.person={id:member.person.id,name:'Deleted account',wallet:member.wallet};
      if(value.proposal?.member.person.id===member.person.id)value.proposal=null;
    }
    // Restore reconciles signatures against finalized history only. Backup bytes
    // can never authorize a new broadcast, including a once-valid old transaction.
    value.intents=value.intents.filter(item=>item.status==='submitted'||terminal(item)).map(item=>({...item,transaction:'',message:'',signedTransaction:null}));value.preparingUntil=0;
    if(this.load()||this.ctx.storage.sql.exec('SELECT id FROM erased').toArray().length)return false;
    this.save(value);await this.schedule();return true;
  }
}
