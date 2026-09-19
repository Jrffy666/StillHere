import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { Connection, Keypair, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { confirmSignatureHttp, validateTestGenesis } from './verify.ts';

// Explicit local endpoints and fresh in-memory wallets. Never connects to Devnet or reads a user key.
const origin='http://127.0.0.1:8788';
const connection=new Connection('http://127.0.0.1:8899','finalized');
validateTestGenesis('localnet',await connection.getGenesisHash(),false);
interface Session {token:string;user:{id:string;name:string;wallet?:string;points:number;reputation:number;completedGuards:number}}
interface Actor {session:Session;key:Keypair}
interface View {snapshot:{state:string;sequence:number;currentGuardian:string|null;contributions:{wallet:string;checkIns:number;claimed:boolean}[]};intents:{id:string;status:string;error:string|null}[];lastError:string|null;canClaim:boolean}
const traces:{operation:string;status:string}[]=[];
async function request<T>(path:string,actor?:Actor,body?:unknown,expected=200):Promise<T>{
  const response=await fetch(origin+'/api'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(actor?{Authorization:`Bearer ${actor.session.token}`}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
  const data=await response.json();assert.equal(response.status,expected,`${path}: ${JSON.stringify(data)}`);return data as T;
}
const config=await request<{chainV2:{network:string;configured:boolean;programId:string}}>('/config');
assert.equal(config.chainV2.network,'localnet');assert.equal(config.chainV2.configured,true);
async function actor(name:string):Promise<Actor>{
  const key=Keypair.generate(),guest=await request<Session>('/session',undefined,{name},201),value={key,session:guest};
  const challenge=await request<{id:string;message:string}>('/auth/challenge',value,{intent:'bind',wallet:key.publicKey.toBase58()});
  const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(key.secretKey.slice(0,32))]),format:'der',type:'pkcs8'});
  value.session=await request<Session>('/auth/verify',value,{challengeId:challenge.id,signature:sign(null,Buffer.from(challenge.message),privateKey).toString('base64')});
  assert.equal(value.session.user.id,guest.user.id);
  const signature=await connection.requestAirdrop(key.publicKey,LAMPORTS_PER_SOL/4);await confirmSignatureHttp(connection,signature,{pollIntervalMs:200});
  return value;
}
const rider=await actor('Integration rider'),a=await actor('Integration guardian A'),b=await actor('Integration guardian B');
const created=await request<{trip:{id:string}}>('/trips',rider,{origin:{label:'Synthetic start',lat:43,lng:-80},destination:{label:'Synthetic end',lat:44,lng:-81},checkInIntervalSeconds:300,chainEnabled:true},201);
const id=created.trip.id;
const act=(who:Actor,action:string,extra:Record<string,unknown>={})=>request<{trip:Record<string,unknown>}>(`/trips/${id}/actions`,who,{action,...extra});
async function chain(who:Actor,operation:string,applicationId?:string){
  const prepared=await request<{intentId:string;transaction:string;wallet:string}>(`/trips/${id}/chain/prepare`,who,{operation,...(applicationId?{applicationId}:{})});
  assert.equal(prepared.wallet,who.key.publicKey.toBase58());const transaction=Transaction.from(Buffer.from(prepared.transaction,'base64'));transaction.sign(who.key);
  const accepted=await request<{chain:View}>(`/trips/${id}/chain/submit`,who,{intentId:prepared.intentId,transaction:transaction.serialize().toString('base64')});
  assert.ok(['submitted','confirmed'].includes(accepted.chain.intents.find(item=>item.id===prepared.intentId)!.status));
  for(let count=0;count<45;count++){
    await new Promise(resolve=>setTimeout(resolve,2000));
    const view=(await request<{chain:View}>(`/trips/${id}/chain/refresh`,who,{})).chain;
    const pending=view.intents.find(item=>item.id===prepared.intentId)!;
    if(['failed','expired'].includes(pending.status))throw new Error(`${operation}: ${pending.status} ${pending.error}`);
    if(pending.status==='confirmed'&&!view.lastError){traces.push({operation,status:'finalized'});console.log(`Verified ${operation}`);return view;}
  }
  throw new Error(`Timed out waiting for ${operation}`);
}
await chain(rider,'create');
const first=await act(a,'accept',{requestId:id});const firstId=(first.trip.application as {id:string}).id;
await chain(rider,'propose',firstId);await chain(a,'accept');
assert.equal((await request<{trip:{guardian:{id:string}}}>(`/trips/${id}`,a)).trip.guardian.id,a.session.user.id);
await act(a,'check-in');await chain(a,'check-in');
const relay=await act(a,'request-relay');const relayId=(relay.trip.relay as {id:string}).id;
const second=await act(b,'accept',{requestId:relayId});await chain(rider,'propose',(second.trip.application as {id:string}).id);await chain(b,'accept');
await request(`/trips/${id}`,a,undefined,403);await request(`/trips/${id}/actions`,a,{action:'message',text:'Former guardian cannot send'},403);
await act(b,'check-in');await chain(b,'check-in');await act(rider,'arrive');
assert.equal((await request<{user:Session['user']}>('/me',a)).user.points,0,'App arrival must not mint an extra pool');
await chain(rider,'complete');await chain(a,'claim');await chain(b,'claim');
await request(`/trips/${id}/chain/prepare`,a,{operation:'claim'},409);
const profiles=await Promise.all([request<{user:Session['user']}>('/me',a),request<{user:Session['user']}>('/me',b)]);
assert.equal(profiles.reduce((sum,item)=>sum+item.user.points,0),25);assert.equal(profiles.reduce((sum,item)=>sum+item.user.reputation,0),10);assert.ok(profiles.every(item=>item.user.completedGuards===1));
const commitments=await request<{journeys:{id:string}[]}>('/commitments',a);assert.ok(commitments.journeys.some(item=>item.id===id));
const report={verifiedAt:new Date().toISOString(),cluster:'localnet',programId:config.chainV2.programId,tripId:id,checks:['wallet binding preserves identity','signed handoff grants private access','former guardian access revoked','app arrival does not double credit','finalized claims share one 25/10 pool','duplicate claim rejected','former guardian can access receipt'],transactions:traces,points:profiles.map(item=>item.user.points),reputation:profiles.map(item=>item.user.reputation)};
await mkdir(new URL('../../docs/deployment/',import.meta.url),{recursive:true});await writeFile(new URL('../../docs/deployment/application.v2.localnet.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({ok:true,transactions:traces.length,points:report.points,reputation:report.reputation}));
