import { env, runInDurableObject, runDurableObjectAlarm, evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'buffer';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { digest, type AccountPublic } from '../src/accounts';
import type { ChainBinding } from '../src/chain-types';
import type { ChainJourney } from '../src/chain-sync';
import type { TripSummary, WorkerEnv } from '../src/types';
import { JOURNEY_V2_ACCOUNT_SIZE, JOURNEY_V2_DISCRIMINATOR } from '../../chain/src/v2';

type Actor={user:AccountPublic;keypair:Keypair};
type SignatureStatus={slot:number;confirmations:number|null;err:unknown;confirmationStatus:'processed'|'confirmed'|'finalized'};
let chainAccount:ChainBinding|null;
let status:SignatureStatus|null;
let blockHeight:number;
let sent:string[];
let offline:boolean;
let rpcCalls:string[];
let genesis:string;
const blockhash=new PublicKey(new Uint8Array(32).fill(5)).toBase58();
const programId=new PublicKey(new Uint8Array(32).fill(7)).toBase58();

function accountBytes(state:ChainBinding):string {
  const bytes=Buffer.alloc(JOURNEY_V2_ACCOUNT_SIZE),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),snapshot=state.snapshot;
  bytes.set(JOURNEY_V2_DISCRIMINATOR);bytes[8]=2;
  bytes.set(new PublicKey(state.rider.wallet).toBytes(),9);bytes.set(Buffer.from(state.reference,'hex'),41);
  bytes.set(new PublicKey(snapshot.currentGuardian??PublicKey.default).toBytes(),73);
  bytes.set(new PublicKey(snapshot.proposedGuardian??PublicKey.default).toBytes(),105);
  view.setBigInt64(137,BigInt(Math.floor((Date.now()-1000)/1000)),true);
  view.setBigInt64(145,BigInt(Math.floor(snapshot.deadline/1000)),true);
  view.setBigInt64(153,BigInt(Math.floor(snapshot.proposalExpiresAt/1000)),true);
  view.setUint32(169,snapshot.revision,true);view.setUint32(173,snapshot.sequence,true);
  bytes[177]=(['open','active','completed','cancelled'] as string[]).indexOf(snapshot.state);bytes[178]=snapshot.contributions.length;
  for(const [index,item] of snapshot.contributions.entries()){
    const offset=180+index*77;bytes.set(new PublicKey(item.wallet).toBytes(),offset);view.setUint32(offset+32,item.checkIns,true);
    view.setBigInt64(offset+44,BigInt(Math.floor(item.startedAt/1000)),true);view.setBigInt64(offset+52,BigInt(Math.floor(item.endedAt/1000)),true);
    view.setBigUint64(offset+60,BigInt(item.points),true);view.setBigUint64(offset+68,BigInt(item.reputation),true);bytes[offset+76]=item.claimed?1:0;
  }
  return bytes.toString('base64');
}
beforeEach(async()=>{
  await reset();chainAccount=null;status=null;blockHeight=100;sent=[];offline=false;rpcCalls=[];genesis='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
  vi.stubGlobal('fetch',vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>{
    if(offline)throw new Error('RPC offline');
    const body=JSON.parse(String(init?.body)) as {id:string;method:string;params?:unknown[]};rpcCalls.push(body.method);
    let result:unknown;
    switch(body.method){
      case 'getGenesisHash':result=genesis;break;
      case 'getLatestBlockhash':result={context:{slot:100},value:{blockhash,lastValidBlockHeight:150}};break;
      case 'getBlockHeight':result=blockHeight;break;
      case 'getSignatureStatuses':result={context:{slot:200},value:[status]};break;
      case 'getTransaction':result=null;break;
      case 'getAccountInfo':{
        const isProgram=body.params?.[0]===programId;
        result={context:{slot:chainAccount?.snapshot.slot??100},value:isProgram?{data:['','base64'],executable:true,lamports:1,owner:PublicKey.default.toBase58(),rentEpoch:0}:
          chainAccount?{data:[accountBytes(chainAccount),'base64'],executable:false,lamports:1,owner:programId,rentEpoch:0}:null};break;
      }
      case 'sendTransaction':{
        const encoded=String(body.params?.[0]);sent.push(encoded);result=bs58.encode(Transaction.from(Buffer.from(encoded,'base64')).signature!);break;
      }
      default:throw new Error(`Unexpected RPC method: ${body.method}`);
    }
    return Response.json({jsonrpc:'2.0',id:body.id,result});
  }));
});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

async function actor(name:string):Promise<Actor>{
  const id=crypto.randomUUID(),keypair=Keypair.generate(),tokenDigest=await digest(crypto.randomUUID()),stub=env.USERS.getByName(id);
  await stub.initialize({id,name,points:0,reputation:0,completedGuards:0},tokenDigest);
  const user=await stub.changeIdentity({expectedVersion:1,actorDigest:tokenDigest,wallet:keypair.publicKey.toBase58()});
  return {user:user!,keypair};
}
async function configure(id:string):Promise<void>{
  await runInDurableObject(env.CHAIN.getByName(id),async(instance)=>{
    // Isolate tests from configured real deployments and never send a real packet.
    const runtime=instance as unknown as {env:WorkerEnv};
    runtime.env={...runtime.env,SOLANA_V2_PROGRAM_ID:programId,SOLANA_NETWORK:'devnet',APP_ENV:'development',SOLANA_RPC_URL:'https://rpc.test',SOLANA_PRIVATE_RPC_URL:undefined};
  });
}
async function linked(){
  const rider=await actor('Rider'),id=crypto.randomUUID(),trip=env.TRIPS.getByName(id),chain=env.CHAIN.getByName(id);await configure(id);
  const created=await trip.initialize(id,rider.user,{chainEnabled:true,origin:{label:'Private pickup',lat:1,lng:1},destination:{label:'Private destination',lat:2,lng:2},notificationConsent:false,checkInIntervalSeconds:30},false);
  expect(created.ok).toBe(true);expect((await chain.initialize(id,rider.user)).ok).toBe(true);
  return {id,rider,trip,chain};
}
async function signed(chain:ReturnType<typeof env.CHAIN.getByName>,actor:Actor,operation:'create'|'propose'|'accept'|'check-in'|'claim',applicationId?:string){
  const prepared=await chain.prepare(actor.user,operation,applicationId);expect(prepared.ok).toBe(true);
  if(!prepared.ok)throw new Error(prepared.error);
  const transaction=Transaction.from(Buffer.from(prepared.value.transaction,'base64'));transaction.sign(actor.keypair);
  return {id:prepared.value.intentId,encoded:transaction.serialize().toString('base64')};
}
async function openChain(fixture:Awaited<ReturnType<typeof linked>>){
  chainAccount=(await fixture.chain.exportSnapshot())!;chainAccount.snapshot={...chainAccount.snapshot,state:'open',slot:101};
  expect((await fixture.chain.refresh(fixture.rider.user.id)).ok).toBe(true);
}
async function applicant(fixture:Awaited<ReturnType<typeof linked>>,name='Guardian'){
  const candidate=await actor(name),context=await fixture.trip.chainContext();
  const result=await fixture.trip.act(candidate.user,{action:'accept',requestId:context!.relay?.id??fixture.id});expect(result.ok).toBe(true);
  return {candidate,applicationId:(result.ok?result.value as TripSummary:null)!.application!.id};
}
async function activate(fixture:Awaited<ReturnType<typeof linked>>){
  await openChain(fixture);const {candidate,applicationId}=await applicant(fixture);
  const proposal=await signed(fixture.chain,fixture.rider,'propose',applicationId);await fixture.chain.discard(fixture.rider.user.id,proposal.id);
  chainAccount=(await fixture.chain.exportSnapshot())!;chainAccount.snapshot={...chainAccount.snapshot,state:'active',slot:110,revision:2,sequence:1,currentGuardian:candidate.user.wallet!,proposedGuardian:null,
    contributions:[{wallet:candidate.user.wallet!,checkIns:0,startedAt:Date.now(),endedAt:0,points:0,reputation:0,claimed:false}]};
  expect((await fixture.chain.refresh(fixture.rider.user.id)).ok).toBe(true);
  expect((await fixture.trip.chainContext())?.guardian?.id).toBe(candidate.user.id);
  return {candidate,applicationId};
}

describe('Durable chain transaction synchronization',()=>{
  it('uses the private server RPC for preparation while keeping endpoint credentials out of persisted and client state',async()=>{
    const fixture=await linked(),privateRpc='https://private-rpc.example.test/?api-key=test-secret-value',original=globalThis.fetch;
    const requested:string[]=[];
    await runInDurableObject(fixture.chain,async(instance)=>{
      const runtime=instance as unknown as {env:WorkerEnv};runtime.env={...runtime.env,SOLANA_PRIVATE_RPC_URL:privateRpc};
      vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
        const outgoing=new Request(input,init);expect(outgoing.redirect).toBe('manual');requested.push(outgoing.url);
        return original(input,init);
      }));
    });
    const prepared=await fixture.chain.prepare(fixture.rider.user,'create');expect(prepared.ok).toBe(true);
    expect(requested.length).toBeGreaterThan(0);expect(requested.every(url=>url===privateRpc)).toBe(true);
    expect(JSON.stringify(prepared)).not.toContain('test-secret-value');expect(JSON.stringify(await fixture.chain.exportSnapshot())).not.toContain('private-rpc.example.test');
    if(!prepared.ok)return;await fixture.chain.discard(fixture.rider.user.id,prepared.value.intentId);
    await runInDurableObject(fixture.chain,async(instance)=>{const runtime=instance as unknown as {env:WorkerEnv};runtime.env={...runtime.env,SOLANA_PRIVATE_RPC_URL:''};});
    requested.length=0;expect((await fixture.chain.prepare(fixture.rider.user,'create')).ok).toBe(true);
    expect(requested.every(url=>url==='https://rpc.test/')).toBe(true);
  });

  it('reports only HTTP status for rejected RPC requests and never follows credential-bearing redirects',async()=>{
    const fixture=await linked(),privateRpc='https://private-rpc.example.test/?api-key=test-secret-value';
    await runInDurableObject(fixture.chain,async(instance)=>{const runtime=instance as unknown as {env:WorkerEnv};runtime.env={...runtime.env,SOLANA_PRIVATE_RPC_URL:privateRpc};});
    for(const statusCode of [403,429,503,307]){
      const network=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
        const outgoing=new Request(input,init);expect(outgoing.redirect).toBe('manual');expect(outgoing.url).toBe(privateRpc);
        return new Response(`Provider private detail: ${privateRpc}`,{status:statusCode,headers:{Location:'https://untrusted.example.test/collect'}});
      });vi.stubGlobal('fetch',network);
      const prepared=await fixture.chain.prepare(fixture.rider.user,'create');expect(prepared.ok).toBe(false);
      const state=await fixture.chain.exportSnapshot();expect(state!.lastError).toContain(`HTTP ${statusCode}`);
      expect(JSON.stringify(state)).not.toContain('test-secret-value');expect(JSON.stringify(state)).not.toContain('Provider private detail');
      expect(network).toHaveBeenCalledTimes(1);
    }
  });

  it('does not expose private RPC URLs echoed by network exceptions or JSON-RPC error payloads',async()=>{
    const fixture=await linked(),privateRpc='https://private-rpc.example.test/?api-key=test-secret-value';
    await runInDurableObject(fixture.chain,async(instance)=>{const runtime=instance as unknown as {env:WorkerEnv};runtime.env={...runtime.env,SOLANA_PRIVATE_RPC_URL:privateRpc};});
    const failures=[async()=>{throw new TypeError(`Cannot reach ${privateRpc}`);},async()=>Response.json({jsonrpc:'2.0',id:1,error:{code:-32000,message:`Rejected request to ${privateRpc}`}})];
    for(const fetcher of failures){
      vi.stubGlobal('fetch',vi.fn(fetcher));expect((await fixture.chain.prepare(fixture.rider.user,'create')).ok).toBe(false);
      const state=await fixture.chain.exportSnapshot();expect(state!.lastError).toContain('chain service');expect(JSON.stringify(state)).not.toContain('test-secret-value');
    }
  });

  it('rejects tampered messages and signatures before accepting an outbox entry',async()=>{
    const fixture=await linked(),prepared=await fixture.chain.prepare(fixture.rider.user,'create');expect(prepared.ok).toBe(true);if(!prepared.ok)return;
    const tampered=Transaction.from(Buffer.from(prepared.value.transaction,'base64'));tampered.instructions[0].data[8]^=1;tampered.sign(fixture.rider.keypair);
    expect((await fixture.chain.submit(fixture.rider.user.id,prepared.value.intentId,tampered.serialize().toString('base64'))).ok).toBe(false);
    expect((await fixture.chain.submit(fixture.rider.user.id,prepared.value.intentId,prepared.value.transaction)).ok).toBe(false);
    expect(sent).toHaveLength(0);expect((await fixture.chain.exportSnapshot())?.intents[0].status).toBe('prepared');
  });

  it('persists a signature before broadcast and retries identical bytes after eviction until finalized',async()=>{
    const fixture=await linked(),packet=await signed(fixture.chain,fixture.rider,'create');
    const submitted=await fixture.chain.submit(fixture.rider.user.id,packet.id,packet.encoded);expect(submitted.ok).toBe(true);
    if(submitted.ok)expect(submitted.value.intents[0].status).toBe('submitted');
    await runDurableObjectAlarm(fixture.chain);expect(sent.length).toBeGreaterThan(0);
    expect((await fixture.chain.discard(fixture.rider.user.id,packet.id)).ok).toBe(false);
    const before=sent.length;await evictDurableObject(fixture.chain);await configure(fixture.id);await runDurableObjectAlarm(fixture.chain);
    expect(sent.length).toBeGreaterThan(before);expect(sent.every(value=>value===packet.encoded)).toBe(true);
    status={slot:120,confirmations:null,err:null,confirmationStatus:'finalized'};chainAccount=(await fixture.chain.exportSnapshot())!;
    chainAccount.snapshot={...chainAccount.snapshot,state:'open',slot:120};const broadcasts=sent.length;
    await fixture.chain.refresh(fixture.rider.user.id);expect(sent).toHaveLength(broadcasts);
    expect((await fixture.chain.exportSnapshot())?.intents[0].status).toBe('confirmed');
    expect((await fixture.chain.exportSnapshot())?.snapshot.state).toBe('open');
  });

  it('expires an orphaned processed signature only after finalized height and receipt lookup',async()=>{
    const fixture=await linked(),packet=await signed(fixture.chain,fixture.rider,'create');
    status={slot:120,confirmations:0,err:null,confirmationStatus:'processed'};
    await fixture.chain.submit(fixture.rider.user.id,packet.id,packet.encoded);await runDurableObjectAlarm(fixture.chain);
    expect((await fixture.chain.exportSnapshot())?.intents[0].status).toBe('submitted');
    blockHeight=151;await fixture.chain.refresh(fixture.rider.user.id);
    expect(rpcCalls).toContain('getTransaction');expect((await fixture.chain.exportSnapshot())?.intents[0].status).toBe('expired');
  });

  it('checks fresh moderation and application closure after a transaction was prepared',async()=>{
    const fixture=await linked(),packet=await signed(fixture.chain,fixture.rider,'create');
    await env.GOVERNANCE.getByName('governance-v1').setSuspended(fixture.rider.user.id,true,'abuse');
    const suspended=await fixture.chain.submit(fixture.rider.user.id,packet.id,packet.encoded);expect(suspended.ok).toBe(false);
    if(!suspended.ok)expect(suspended.status).toBe(403);
    await env.GOVERNANCE.getByName('governance-v1').setSuspended(fixture.rider.user.id,false,'appeal');
    await fixture.trip.act(fixture.rider.user,{action:'cancel'});
    const ended=await fixture.chain.submit(fixture.rider.user.id,packet.id,packet.encoded);expect(ended.ok).toBe(false);
    if(!ended.ok)expect(ended.status).toBe(409);expect(sent).toHaveLength(0);
  });

  it('serializes concurrent preparation and refuses a chain with only a matching genesis prefix',async()=>{
    const fixture=await linked();
    const results=await Promise.all([fixture.chain.prepare(fixture.rider.user,'create'),fixture.chain.prepare(fixture.rider.user,'create')]);
    expect(results.filter(result=>result.ok)).toHaveLength(1);expect(results.filter(result=>!result.ok&&result.status===409)).toHaveLength(1);
    const accepted=results.find(result=>result.ok)!;if(!accepted.ok)return;await fixture.chain.discard(fixture.rider.user.id,accepted.value.intentId);
    genesis='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wrongNetwork';
    expect((await fixture.chain.prepare(fixture.rider.user,'create')).ok).toBe(false);expect(sent).toHaveLength(0);
  });

  it('does not treat a localhost proxy to a public chain as localnet',async()=>{
    const fixture=await linked();
    await runInDurableObject(fixture.chain,async(instance,state)=>{
      const runtime=instance as unknown as {env:WorkerEnv};runtime.env={...runtime.env,SOLANA_NETWORK:'localnet',SOLANA_RPC_URL:'http://127.0.0.1:8899'};
      const row=state.storage.sql.exec<{data:string}>('SELECT data FROM binding').one(),value=JSON.parse(row.data) as ChainBinding;
      value.network='localnet';state.storage.sql.exec('UPDATE binding SET data=?',JSON.stringify(value));
    });
    for(const hash of ['EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG','5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d','4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY']){
      genesis=hash;const result=await fixture.chain.prepare(fixture.rider.user,'create');expect(result.ok).toBe(false);if(!result.ok)expect(result.status).toBe(503);
    }
    expect(sent).toHaveLength(0);
  });

  it('rejects a previously signed contribution after the guardian or sequence changes',async()=>{
    const fixture=await linked(),{candidate}=await activate(fixture),packet=await signed(fixture.chain,candidate,'check-in');
    await runInDurableObject(fixture.chain,async(_instance,state)=>{
      const row=state.storage.sql.exec<{data:string}>('SELECT data FROM binding').one(),value=JSON.parse(row.data) as ChainBinding;
      value.snapshot.sequence+=1;value.updatedAt+=1;state.storage.sql.exec('UPDATE binding SET data=?',JSON.stringify(value));
    });
    const result=await fixture.chain.submit(candidate.user.id,packet.id,packet.encoded);expect(result.ok).toBe(false);
    if(!result.ok)expect(result.status).toBe(409);expect(sent).toHaveLength(0);
  });

  it('preserves approved consent after automatic expiry but rejects an explicit withdrawal',async()=>{
    const fixture=await linked();await openChain(fixture);const {candidate,applicationId}=await applicant(fixture);
    const proposal=await signed(fixture.chain,fixture.rider,'propose',applicationId);await fixture.chain.discard(fixture.rider.user.id,proposal.id);
    await runInDurableObject(fixture.trip,async(_instance,state)=>{
      const row=state.storage.sql.exec<{data:string}>('SELECT data FROM trip_state').one(),value=JSON.parse(row.data);
      value.trip.guardianRequests[0].expiresAt=Date.now()-1;state.storage.sql.exec('UPDATE trip_state SET data=?',JSON.stringify(value));
    });
    await fixture.trip.read(fixture.rider.user.id);
    chainAccount=(await fixture.chain.exportSnapshot())!;chainAccount.snapshot={...chainAccount.snapshot,slot:105,revision:1,proposedGuardian:candidate.user.wallet!,proposalExpiresAt:Date.now()+60000};
    await fixture.chain.refresh(candidate.user.id);
    expect((await fixture.chain.prepare(candidate.user,'accept')).ok).toBe(true);
    await runInDurableObject(fixture.trip,async(_instance,state)=>{
      const row=state.storage.sql.exec<{data:string}>('SELECT data FROM trip_state').one(),value=JSON.parse(row.data);
      value.chainApplications[applicationId].revoked=true;state.storage.sql.exec('UPDATE trip_state SET data=?',JSON.stringify(value));
    });
    const prepared=(await fixture.chain.exportSnapshot())!.intents.find(item=>item.operation==='accept')!;
    const tx=Transaction.from(Buffer.from(prepared.transaction,'base64'));tx.sign(candidate.keypair);
    const withdrawn=await fixture.chain.submit(candidate.user.id,prepared.id,tx.serialize().toString('base64'));expect(withdrawn.ok).toBe(false);
    if(!withdrawn.ok)expect(withdrawn.status).toBe(409);expect(sent).toHaveLength(0);
  });

  it('refuses stale applicant wallet bindings and keeps finalized snapshots monotonic',async()=>{
    const fixture=await linked();await openChain(fixture);const {candidate,applicationId}=await applicant(fixture),other=Keypair.generate();
    await runInDurableObject(env.USERS.getByName(candidate.user.id),async(_instance,state)=>{
      state.storage.sql.exec('UPDATE identity SET wallet=?',other.publicKey.toBase58());
    });
    const changed=await fixture.chain.prepare(fixture.rider.user,'propose',applicationId);expect(changed.ok).toBe(false);
    if(!changed.ok)expect(changed.status).toBe(409);
    chainAccount=(await fixture.chain.exportSnapshot())!;chainAccount.snapshot={...chainAccount.snapshot,revision:4,slot:200};await fixture.chain.refresh(fixture.rider.user.id);
    chainAccount.snapshot={...chainAccount.snapshot,revision:3,slot:201};await fixture.chain.refresh(fixture.rider.user.id);
    expect((await fixture.chain.exportSnapshot())?.snapshot.revision).toBe(4);
  });

  it('keeps help and private journey actions available while RPC is offline',async()=>{
    const fixture=await linked();offline=true;
    const prepared=await fixture.chain.prepare(fixture.rider.user,'create');expect(prepared.ok).toBe(false);
    if(!prepared.ok)expect(prepared.status).toBe(503);
    expect((await fixture.trip.act(fixture.rider.user,{action:'help'})).ok).toBe(true);
    expect((await fixture.trip.act(fixture.rider.user,{action:'cancel'})).ok).toBe(true);
    expect((await fixture.chain.exportSnapshot())?.intents).toHaveLength(0);
  });

  it('restores submitted signatures read-only, rejects malformed state and never resurrects purged data',async()=>{
    const fixture=await linked(),packet=await signed(fixture.chain,fixture.rider,'create');
    const snapshot=(await fixture.chain.exportSnapshot())!;
    snapshot.intents[0]={...snapshot.intents[0],status:'submitted',signature:bs58.encode(Transaction.from(Buffer.from(packet.encoded,'base64')).signature!),signedTransaction:packet.encoded};
    const malformed={...snapshot,members:[...snapshot.members,...snapshot.members]};expect(await fixture.chain.validateSnapshot(malformed,fixture.id)).toBe(false);
    const restore=env.CHAIN.getByName(`isolated-restore:${fixture.id}`);await configure(`isolated-restore:${fixture.id}`);
    expect(await restore.restoreSnapshot(malformed)).toBe(false);expect(await restore.exportSnapshot()).toBeNull();
    expect(await restore.restoreSnapshot(snapshot)).toBe(true);await restore.refresh(fixture.rider.user.id);
    const restored=(await restore.exportSnapshot())!;expect(restored.intents[0].signedTransaction).toBeNull();expect(restored.intents[0].transaction).toBe('');expect(sent).toHaveLength(0);
    await restore.purge();expect(await restore.restoreSnapshot(snapshot)).toBe(false);expect((await restore.initialize(fixture.id,fixture.rider.user)).ok).toBe(false);
  });

  it('erases guardian names and unsigned packets without changing public contribution wallets',async()=>{
    const fixture=await linked(),{candidate}=await activate(fixture);await signed(fixture.chain,candidate,'check-in');
    await fixture.chain.scrubUser(candidate.user.id);const scrubbed=(await fixture.chain.exportSnapshot())!;
    expect(scrubbed.members.find(item=>item.person.id===candidate.user.id)?.person.name).toBe('Deleted account');
    expect(scrubbed.snapshot.currentGuardian).toBe(candidate.user.wallet);
    const intent=scrubbed.intents.find(item=>item.actorId===candidate.user.id)!;expect(intent.status).toBe('expired');expect(intent.transaction).toBe('');expect(intent.signedTransaction).toBeNull();
    expect(await fixture.chain.validateSnapshot(scrubbed,fixture.id)).toBe(true);
  });

  it('projects one shared reward pool once and rejects claim or contribution rollback',async()=>{
    const fixture=await linked(),first=await activate(fixture);
    chainAccount!.snapshot.contributions[0].checkIns=1;chainAccount!.snapshot.slot=111;await fixture.chain.refresh(fixture.rider.user.id);
    expect((await fixture.trip.act(fixture.rider.user,{action:'request-relay'})).ok).toBe(true);
    const second=await applicant(fixture,'Replacement');
    const proposal=await signed(fixture.chain,fixture.rider,'propose',second.applicationId);await fixture.chain.discard(fixture.rider.user.id,proposal.id);
    chainAccount=(await fixture.chain.exportSnapshot())!;
    chainAccount.snapshot={...chainAccount.snapshot,slot:120,revision:4,sequence:2,currentGuardian:second.candidate.user.wallet!,
      contributions:[{...chainAccount.snapshot.contributions[0],endedAt:Date.now()},
        {wallet:second.candidate.user.wallet!,checkIns:1,startedAt:Date.now(),endedAt:0,points:0,reputation:0,claimed:false}]};
    await fixture.chain.refresh(fixture.rider.user.id);
    expect((await fixture.trip.act(fixture.rider.user,{action:'arrive'})).ok).toBe(true);
    expect((await env.USERS.getByName(first.candidate.user.id).getPublic())?.points).toBe(0);
    chainAccount.snapshot={...chainAccount.snapshot,state:'completed',slot:130,revision:5,
      contributions:chainAccount.snapshot.contributions.map((item,index)=>({...item,points:index===0?13:12,reputation:5,endedAt:Date.now()}))};
    await fixture.chain.refresh(fixture.rider.user.id);
    expect((await env.USERS.getByName(second.candidate.user.id).getPublic())?.points).toBe(0);
    chainAccount.snapshot.slot=131;chainAccount.snapshot.contributions.forEach(item=>{item.claimed=true;});
    await fixture.chain.refresh(fixture.rider.user.id);await fixture.chain.refresh(fixture.rider.user.id);
    const users=await Promise.all([env.USERS.getByName(first.candidate.user.id).getPublic(),env.USERS.getByName(second.candidate.user.id).getPublic()]);
    expect(users.map(user=>user!.points).sort()).toEqual([12,13]);expect(users.reduce((sum,user)=>sum+user!.reputation,0)).toBe(10);
    expect(users.every(user=>user!.completedGuards===1)).toBe(true);
    chainAccount.snapshot.slot=132;chainAccount.snapshot.contributions[0].claimed=false;await fixture.chain.refresh(fixture.rider.user.id);
    expect((await fixture.chain.exportSnapshot())?.snapshot.contributions[0].claimed).toBe(true);
    chainAccount.snapshot.contributions[0].claimed=true;chainAccount.snapshot.contributions[0].checkIns=0;chainAccount.snapshot.slot=133;
    await fixture.chain.refresh(fixture.rider.user.id);expect((await fixture.chain.exportSnapshot())?.snapshot.contributions[0].checkIns).toBe(1);
    chainAccount.snapshot.state='active';chainAccount.snapshot.slot=134;await fixture.chain.refresh(fixture.rider.user.id);
    expect((await fixture.chain.exportSnapshot())?.snapshot.state).toBe('completed');
  });

  it('does not recreate private state when preparation completes after purge',async()=>{
    const fixture=await linked(),original=globalThis.fetch;
    await runInDurableObject(fixture.chain,async(instance)=>{
      const journey=instance as ChainJourney;
      vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
        if(JSON.parse(String(init?.body)).method==='getLatestBlockhash')await journey.purge();
        return original(input,init);
      }));
      expect((await journey.prepare(fixture.rider.user,'create')).ok).toBe(false);
      expect(journey.exportSnapshot()).toBeNull();
    });
    expect(await fixture.chain.exportSnapshot()).toBeNull();
    expect((await fixture.chain.initialize(fixture.id,fixture.rider.user)).ok).toBe(false);
  });
});
