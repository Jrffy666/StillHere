import { env, SELF, reset, runInDurableObject, runDurableObjectAlarm, evictDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'buffer';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { deriveCommunityConfigAddress, deriveCommunityRecordAddress, deriveCommunityJourneyAddress, deriveCommunityWithdrawalAddress, COMMUNITY_KINDS } from '../../chain/src/community';
import { acceptCommunityCorrection, communityConfiguration } from '../src/community-chain';
import type { WorkerEnv } from '../src/types';
import type { CommunityEventInput, CommunityStoredRecord, CommunityCorrectionView } from '../src/community-types';

const journeyId='ab'.repeat(32),rider='11'.repeat(32),guardian='22'.repeat(32),second='33'.repeat(32);
const programId=new PublicKey(new Uint8Array(32).fill(17));
const issuer=Keypair.fromSeed(new Uint8Array(32).fill(18)),sponsor=Keypair.fromSeed(new Uint8Array(32).fill(19)),admin=Keypair.fromSeed(new Uint8Array(32).fill(20));
const blockhash=new PublicKey(new Uint8Array(32).fill(21)).toBase58();
const journal=()=>env.COMMUNITY.getByName(`journey:${journeyId}`);
const member=(id=guardian)=>env.COMMUNITY.getByName(`member:${id}`);
let accounts:Map<string,{data:string;owner:string}>;
let sends:string[];
let loseAcknowledgement:boolean;
let genesis:string;
let networkCalls:number;
let onSend:(transaction:Transaction)=>void;
function event(sequence:number,kind:CommunityEventInput['kind'],actorId=rider,subjectId=rider,assignment=0,value=0):CommunityEventInput {
  return {journeyId,sequence,kind,actorId,subjectId,assignment,value,observedAt:1_780_000_000+sequence};
}
function completed():CommunityEventInput[]{return [event(0,'created'),event(1,'assigned',rider,guardian,1),event(2,'check_in',guardian,guardian,1),event(3,'closed',rider,rider,1,1),event(4,'contribution',guardian,guardian,1)];}
function configuration(){
  const bytes=Buffer.alloc(109);bytes.set([110,210,240,20,146,183,120,59]);bytes[8]=1;bytes.set(admin.publicKey.toBytes(),9);bytes.set(issuer.publicKey.toBytes(),41);bytes.set(sponsor.publicKey.toBytes(),73);
  accounts.set(deriveCommunityConfigAddress(programId).toBase58(),{data:bytes.toString('base64'),owner:programId.toBase58()});
}
function recordBytes(input:CommunityEventInput,points=0,reputation=0,withdrawal?:CommunityCorrectionView):string{
  const bytes=Buffer.alloc(173),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);bytes.set([211,49,8,242,56,112,96,207]);bytes[8]=1;bytes[9]=1;bytes[10]=1;
  bytes.set(Buffer.from(input.journeyId,'hex'),11);view.setUint32(43,withdrawal?.sequence??input.sequence,true);bytes[47]=withdrawal?8:COMMUNITY_KINDS.indexOf(input.kind)+1;
  bytes.set(Buffer.from(input.actorId,'hex'),48);bytes.set(Buffer.from(input.subjectId,'hex'),80);view.setUint32(112,input.assignment,true);view.setBigInt64(116,BigInt(withdrawal?.observedAt??input.observedAt),true);bytes[124]=withdrawal?.reason??input.value;
  bytes.set((withdrawal?admin:issuer).publicKey.toBytes(),125);view.setBigInt64(157,1_780_000_100n,true);view.setUint16(165,points,true);view.setUint16(167,reputation,true);view.setUint32(169,withdrawal?.targetSequence??0,true);return bytes.toString('base64');
}
function receipt(input:CommunityEventInput,points=0,reputation=0,owner=programId.toBase58()){
  accounts.set(deriveCommunityRecordAddress(input.journeyId,input.sequence,programId).toBase58(),{data:recordBytes(input,points,reputation),owner});
}
function withdrawnReceipt(view:CommunityCorrectionView,nextSequence:number){
  const bytes=Buffer.alloc(796),data=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);bytes.set([93,94,183,178,6,70,89,0]);bytes[8]=1;
  bytes.set(Buffer.from(journeyId,'hex'),9);bytes.set(Buffer.from(rider,'hex'),41);data.setUint32(73,nextSequence,true);bytes[113]=1;bytes[114]=1;
  accounts.set(deriveCommunityJourneyAddress(journeyId,programId).toBase58(),{data:bytes.toString('base64'),owner:programId.toBase58()});
  accounts.set(deriveCommunityWithdrawalAddress(journeyId,programId).toBase58(),{data:recordBytes(event(0,'created'),0,0,view),owner:programId.toBase58()});
}
async function configure(){await runInDurableObject(journal(),async instance=>{
  const runtime=instance as unknown as {env:WorkerEnv};runtime.env={...runtime.env,COMMUNITY_ENABLED:'true',COMMUNITY_PROGRAM_ID:programId.toBase58(),COMMUNITY_ISSUER_SECRET_KEY:JSON.stringify([...issuer.secretKey]),COMMUNITY_SPONSOR_SECRET_KEY:JSON.stringify([...sponsor.secretKey]),SOLANA_RPC_URL:'https://rpc.test',SOLANA_PRIVATE_RPC_URL:undefined};
});}
async function due(){await runInDurableObject(journal(),async(_instance,state)=>{
  for(const row of state.storage.sql.exec<{data:string}>('SELECT data FROM records').toArray()){
    const record=JSON.parse(row.data) as CommunityStoredRecord;record.nextAttemptAt=Date.now()-1;record.leaseUntil=0;
    state.storage.sql.exec('UPDATE records SET data=?,next_attempt=?,lease=0 WHERE id=?',JSON.stringify(record),record.nextAttemptAt,record.id);
  }
  await state.storage.setAlarm(Date.now()+10);
});}
async function records(){const result=await journal().journey(journeyId);if(!result.ok)throw new Error(result.error);return result.value.records;}
async function profile(id=guardian){const result=await member(id).member(id);if(!result.ok)throw new Error(result.error);return result.value;}
async function finishPublication(){
  // Automatic alarms may interleave with the explicit alarm helper in a full suite.
  // Assert durable convergence rather than assuming exactly one handler per call.
  for(let i=0;i<20;i++){
    await due();await runDurableObjectAlarm(journal());
    const remaining=await runInDurableObject(journal(),(_instance,state)=>state.storage.sql.exec<{count:number}>("SELECT COUNT(*) count FROM records WHERE status!='finalized' OR indexed_revision<revision").one().count);
    if(remaining===0)return;
  }
  throw new Error('Community publication did not converge within twenty bounded alarm passes.');
}

beforeEach(async()=>{
  await reset();accounts=new Map();sends=[];loseAcknowledgement=false;genesis='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';networkCalls=0;onSend=()=>{};configuration();
  vi.stubGlobal('fetch',vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>{
    networkCalls++;const body=JSON.parse(String(init?.body)) as {id:number;method:string;params:unknown[]};let result:unknown;
    switch(body.method){
      case 'getGenesisHash':result=genesis;break;
      case 'getAccountInfo':{const entry=accounts.get(String(body.params[0]));result={context:{slot:200},value:entry?{data:[entry.data,'base64'],owner:entry.owner,executable:false,lamports:1,rentEpoch:0}:null};break;}
      case 'getLatestBlockhash':result={context:{slot:200},value:{blockhash,lastValidBlockHeight:250}};break;
      case 'getBlockHeight':result=200;break;
      case 'sendTransaction':{
        const encoded=String(body.params[0]),transaction=Transaction.from(Buffer.from(encoded,'base64'));sends.push(encoded);onSend(transaction);
        if(loseAcknowledgement){loseAcknowledgement=false;throw new Error('Synthetic acknowledgement lost with private URL secret.');}
        result=bs58.encode(transaction.signature!);break;
      }
      default:throw new Error(`Unexpected RPC: ${body.method}`);
    }
    return Response.json({jsonrpc:'2.0',id:body.id,result});
  }));
});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('Durable community ledger',()=>{
  it('retains all three record families pending without pretending the unconfigured chain is finalized',async()=>{
    const batch=[...completed(),event(5,'gratitude',rider,guardian,1,1)];expect((await journal().append(batch)).ok).toBe(true);
    await runDurableObjectAlarm(journal());const view=await profile();
    expect(view.finalized).toEqual({points:0,reputation:0,contributions:0,banners:0,history:0});
    expect(view.pending).toMatchObject({points:25,reputation:10,contributions:1,banners:1});
    expect(view.records.every(record=>record.evidence==='platform_attested'&&record.status==='pending')).toBe(true);
    expect(networkCalls).toBe(0);expect(JSON.stringify(view)).not.toContain('transaction');
  });
  it('retries identical source IDs after eviction and rejects conflicting evidence, ordering gaps, and private fields atomically',async()=>{
    const batch=completed();expect((await journal().append(batch)).ok).toBe(true);await evictDurableObject(journal());
    expect((await journal().append(batch)).ok).toBe(true);expect(await records()).toHaveLength(5);
    expect((await journal().append([{...batch[2],observedAt:batch[2].observedAt+1}])).ok).toBe(false);
    expect((await journal().append([event(6,'gratitude',rider,guardian,1,1)])).ok).toBe(false);
    expect((await journal().append([{...event(5,'gratitude',rider,guardian,1,1),route:'private'} as CommunityEventInput])).ok).toBe(false);
    expect((await journal().append([event(5,'gratitude',rider,guardian,1,1),event(6,'gratitude',rider,guardian,1,2)])).ok).toBe(false);
    expect(await records()).toHaveLength(5);expect((await profile()).pending.banners).toBe(0);
  });
  it('preserves A-to-B-to-A assignments, original check-ins and canonical one-pool allocation',async()=>{
    const batch=[event(0,'created'),event(1,'assigned',rider,guardian,1),event(2,'check_in',guardian,guardian,1),event(3,'relay_requested',guardian,guardian,1),event(4,'assigned',rider,second,2),event(5,'check_in',second,second,2),event(6,'assigned',rider,guardian,3),event(7,'closed',rider,rider,3,1),event(8,'contribution',guardian,guardian,3),event(9,'contribution',second,second,2)];
    expect((await journal().append(batch)).ok).toBe(true);
    expect((await records()).filter(record=>record.event.kind==='assigned').map(record=>record.event.assignment)).toEqual([1,2,3]);
    expect((await profile()).pending.points).toBe(13);expect((await profile(second)).pending.points).toBe(12);
    expect((await journal().append([event(10,'contribution',guardian,guardian,3)])).ok).toBe(false);
  });
  it('records cancelled participation and former guardian gratitude without arrival credit',async()=>{
    const batch=[event(0,'created'),event(1,'assigned',rider,guardian,1),event(2,'check_in',guardian,guardian,1),event(3,'assigned',rider,second,2),event(4,'closed',rider,rider,2,2),event(5,'gratitude',rider,guardian,1,3)];
    expect((await journal().append(batch)).ok).toBe(true);expect((await profile()).pending).toMatchObject({points:0,reputation:0,contributions:0,banners:1});
    expect((await journal().append([event(6,'contribution',guardian,guardian,1)])).ok).toBe(false);
    expect((await journal().append([event(6,'gratitude',rider,second,2,1)])).ok).toBe(false);
  });
  it('distinguishes automated relay observations from falsely attributed human requests',async()=>{
    const batch=completed().slice(0,3);expect((await journal().append(batch)).ok).toBe(true);
    expect((await journal().append([event(3,'relay_requested','0'.repeat(64),guardian,1,1)])).ok).toBe(true);
    expect((await journal().append([event(4,'check_in','0'.repeat(64),guardian,1)])).ok).toBe(false);
    expect((await journal().append([event(4,'relay_requested',guardian,guardian,1,1)])).ok).toBe(false);
  });
  it('keeps a recoverable journal when a member index acknowledgement is lost',async()=>{
    const original=env.COMMUNITY;let failed=false;
    await runInDurableObject(journal(),async instance=>{
      const runtime=instance as unknown as {env:WorkerEnv};runtime.env={...runtime.env,COMMUNITY:{getByName:(name:string)=>{
        const target=original.getByName(name);return {mirror:async(...args:Parameters<typeof target.mirror>)=>{const result=await target.mirror(...args);if(!failed){failed=true;throw new Error('Synthetic index acknowledgement lost.');}return result;}} as ReturnType<typeof original.getByName>;
      }} as WorkerEnv['COMMUNITY']};
    });
    expect((await journal().append(completed())).ok).toBe(true);await evictDurableObject(journal());
    await runInDurableObject(journal(),(_instance,state)=>state.storage.sql.exec('INSERT OR REPLACE INTO metadata VALUES (?,?)','indexNext','0'));
    await runDurableObjectAlarm(journal());
    expect((await profile()).pending.points).toBe(25);expect((await profile()).pending.contributions).toBe(1);
  });
  it('isolates journal/member roles and exposes no unauthenticated ingestion endpoint',async()=>{
    expect((await journal().append([event(0,'created')])).ok).toBe(true);
    expect((await journal().member(guardian)).ok).toBe(false);
    const response=await SELF.fetch('https://guard.test/api/community/append',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(completed())});
    expect([401,404]).toContain(response.status);
  });
  it('does not hammer the next unpublishable record while later records are due',async()=>{
    await journal().append(completed());await runDurableObjectAlarm(journal());
    const alarm=await runInDurableObject(journal(),(_instance,state)=>state.storage.getAlarm());expect(alarm!-Date.now()).toBeGreaterThan(29*60_000);
  });
  it('persists signed bytes before broadcasting and only finalizes after matching account readback',async()=>{
    await configure();await journal().append([event(0,'created')]);await runDurableObjectAlarm(journal());
    expect(sends).toHaveLength(1);expect((await records())[0].status).toBe('submitted');
    const stored=await runInDurableObject(journal(),(_instance,state)=>JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM records').one().data) as CommunityStoredRecord);
    expect(stored.submission?.transaction).toBe(sends[0]);expect(stored.signature).toBe(bs58.encode(Transaction.from(Buffer.from(sends[0],'base64')).signature!));
    receipt(event(0,'created'));await due();await runDurableObjectAlarm(journal());
    expect(sends).toHaveLength(1);expect((await records())[0].status).toBe('finalized');expect((await records())[0].issuer).toBe(issuer.publicKey.toBase58());
  });
  it('reconciles a landed transaction after acknowledgement loss and eviction without double publication',async()=>{
    await configure();await journal().append([event(0,'created')]);loseAcknowledgement=true;onSend=()=>receipt(event(0,'created'));
    await runDurableObjectAlarm(journal());expect((await records())[0].status).toBe('retry');expect(sends).toHaveLength(1);
    await evictDurableObject(journal());await configure();await due();await runDurableObjectAlarm(journal());
    expect((await records())[0].status).toBe('finalized');expect(sends).toHaveLength(1);
    expect(JSON.stringify(await records())).not.toContain('private URL secret');
  },40_000);
  it('rejects wrong genesis and forged owners rather than turning a signature into finalized evidence',async()=>{
    await configure();await journal().append([event(0,'created')]);genesis='wrong-network';await runDurableObjectAlarm(journal());
    expect(sends).toHaveLength(0);expect((await records())[0].status).toBe('retry');
    genesis='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';receipt(event(0,'created'),0,0,PublicKey.default.toBase58());await due();await runDurableObjectAlarm(journal());
    expect((await records())[0].status).toBe('retry');expect(sends).toHaveLength(0);
  });
  it('finalized publication changes the same contribution verification without crediting it twice',async()=>{
    await configure();await journal().append(completed());for(const e of completed())receipt(e,e.kind==='contribution'?25:0,e.kind==='contribution'?10:0);
    await finishPublication();
    const view=await profile();expect(view.finalized.points).toBe(25);expect(view.pending.points).toBe(0);expect(view.finalized.contributions).toBe(1);
    await journal().append(completed());expect((await profile()).finalized.points).toBe(25);expect(sends).toHaveLength(0);
  });
  it('requires separate issuer and sponsor and refuses production mainnet publication',()=>{
    const base={...env,COMMUNITY_ENABLED:'true',COMMUNITY_PROGRAM_ID:programId.toBase58(),COMMUNITY_ISSUER_SECRET_KEY:JSON.stringify([...issuer.secretKey]),COMMUNITY_SPONSOR_SECRET_KEY:JSON.stringify([...issuer.secretKey])} as WorkerEnv;
    expect(communityConfiguration(base).configured).toBe(false);
    expect(communityConfiguration({...base,COMMUNITY_SPONSOR_SECRET_KEY:JSON.stringify([...sponsor.secretKey]),SOLANA_NETWORK:'mainnet-beta',APP_ENV:'production'}).configured).toBe(false);
  });
  it('refreshes an external withdrawal and preserves originals while excluding their recognition',async()=>{
    await configure();await journal().append(completed());for(const e of completed())receipt(e,e.kind==='contribution'?25:0,e.kind==='contribution'?10:0);
    await finishPublication();
    const withdrawal:CommunityCorrectionView={journeyId,targetSequence:4,reason:1,sequence:5,observedAt:1_780_000_020,status:'finalized',recordAddress:null,signature:null,finalizedAt:null,error:null,authority:admin.publicKey.toBase58()};
    withdrawnReceipt(withdrawal,5);await journal().retry();await runDurableObjectAlarm(journal());
    expect((await profile()).finalized.points).toBe(0);expect((await profile()).withdrawn).toBeGreaterThan(0);
    expect((await records())[4]).toMatchObject({points:25,status:'finalized',withdrawn:true,withdrawal:{reason:1,targetSequence:4}});
    // An already authorized gratitude intent can arrive after the withdrawal, using the unchanged source sequence.
    expect((await journal().append([event(5,'gratitude',rider,guardian,1,1)])).ok).toBe(true);
    expect((await records())[5].withdrawn).toBe(true);expect((await profile()).pending.banners).toBe(0);
  });
  it('keeps unsigned correction preparation from freezing records and requires the exact external admin signature',async()=>{
    await configure();await journal().append(completed());for(const e of completed())receipt(e,e.kind==='contribution'?25:0,e.kind==='contribution'?10:0);
    await finishPublication();
    const prepared=await journal().prepareCorrection({journeyId,targetSequence:4,reason:4});expect(prepared.ok).toBe(true);if(!prepared.ok)return;
    expect(()=>acceptCommunityCorrection(prepared.value.transaction,prepared.value.transaction,prepared.value.expiresAt)).toThrow();
    const signed=Transaction.from(Buffer.from(prepared.value.transaction,'base64'));signed.partialSign(admin);
    expect(acceptCommunityCorrection(prepared.value.transaction,signed.serialize().toString('base64'),prepared.value.expiresAt).signature).toBeTruthy();
    const tampered=Transaction.from(Buffer.from(prepared.value.transaction,'base64'));tampered.instructions[0].data[0]^=1;tampered.sign(sponsor,admin);
    expect(()=>acceptCommunityCorrection(prepared.value.transaction,tampered.serialize().toString('base64'),prepared.value.expiresAt)).toThrow();
    expect((await journal().append([event(5,'gratitude',rider,guardian,1,1)])).ok).toBe(true);
    expect((await journal().submitCorrection(signed.serialize().toString('base64'))).ok).toBe(false);
  });
  it('reconciles an authorized withdrawal after admin rotation without overwriting its original records',async()=>{
    await configure();await journal().append(completed());for(const e of completed())receipt(e,e.kind==='contribution'?25:0,e.kind==='contribution'?10:0);
    await finishPublication();
    const prepared=await journal().prepareCorrection({journeyId,targetSequence:4,reason:1});expect(prepared.ok).toBe(true);if(!prepared.ok)return;
    const transaction=Transaction.from(Buffer.from(prepared.value.transaction,'base64'));transaction.partialSign(admin);
    expect((await journal().submitCorrection(transaction.serialize().toString('base64'))).ok).toBe(true);
    const configKey=deriveCommunityConfigAddress(programId).toBase58(),rotated=Buffer.from(accounts.get(configKey)!.data,'base64');
    rotated.set(Keypair.fromSeed(new Uint8Array(32).fill(44)).publicKey.toBytes(),9);accounts.set(configKey,{data:rotated.toString('base64'),owner:programId.toBase58()});
    withdrawnReceipt(prepared.value.correction,5);await runDurableObjectAlarm(journal());
    const view=await profile();expect(view.finalized.points).toBe(0);expect(view.records.filter(record=>record.event.kind==='contribution')[0]).toMatchObject({points:25,withdrawn:true,withdrawal:{authority:admin.publicKey.toBase58(),reason:1,status:'finalized'}});
    expect(sends).toHaveLength(0);
  });
  it('can verify external withdrawal after publication secrets are removed for rotation',async()=>{
    await configure();await journal().append(completed());for(const e of completed())receipt(e,e.kind==='contribution'?25:0,e.kind==='contribution'?10:0);await finishPublication();
    withdrawnReceipt({journeyId,targetSequence:4,reason:2,sequence:5,observedAt:1_780_000_020,status:'finalized',recordAddress:null,signature:null,finalizedAt:null,error:null,authority:admin.publicKey.toBase58()},5);
    await runInDurableObject(journal(),instance=>{const runtime=instance as unknown as {env:WorkerEnv};runtime.env={...runtime.env,COMMUNITY_ISSUER_SECRET_KEY:undefined,COMMUNITY_SPONSOR_SECRET_KEY:undefined};});
    await journal().retry();await runDurableObjectAlarm(journal());expect((await profile()).finalized.points).toBe(0);expect((await records())[4].withdrawn).toBe(true);
  });
});
