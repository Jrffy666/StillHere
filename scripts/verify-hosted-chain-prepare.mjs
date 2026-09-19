import { webcrypto } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

// This test signs account messages only. It never signs or submits a blockchain
// transaction, requests funding, or persists generated credentials.
const require=createRequire(new URL('../chain/package.json',import.meta.url));
const {Transaction}=require('@solana/web3.js');
const args=process.argv.slice(2),option=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
function origin(value){const url=new URL(value);if(url.protocol!=='https:'||url.origin!==value)throw new Error('Provide an exact HTTPS origin.');return value;}
const api=origin(option('--api')),site=origin(option('--origin')),evidencePath=option('--evidence');
if(evidencePath)await mkdir(dirname(resolve(evidencePath)),{recursive:true});
const programId='23f7UAfNbQCGdfQbJV3Tois98dETDfXnAXgjE5qTH5gb';
const results=[],startedAt=new Date().toISOString();
let session,tripId,closed=false,deleted=false,success=false,failure,diagnostic;
async function request(label,path,expected,body){
  const response=await fetch(`${api}${path}`,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{'Content-Type':'application/json',Origin:site,...(session?{Authorization:`Bearer ${session.token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  results.push({check:label,status:response.status,passed:response.status===expected});
  if(response.status!==expected){await response.body?.cancel();throw new Error(`${label}: expected HTTP ${expected}, received ${response.status}.`);}
  return response.json();
}
function assert(label,value){results.push({check:label,passed:Boolean(value)});if(!value)throw new Error(`${label} failed.`);}
try{
  const readiness=await request('Hosted readiness','/api/ready',200);assert('Production ready',readiness.ready===true&&readiness.environment==='production');
  const keys=await webcrypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);
  const raw=new Uint8Array(await webcrypto.subtle.exportKey('raw',keys.publicKey)),alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let number=0n;for(const byte of raw)number=number*256n+BigInt(byte);
  let address='';while(number){address=alphabet[Number(number%58n)]+address;number/=58n;}for(const byte of raw){if(byte)break;address='1'+address;}
  session=await request('Create synthetic account','/api/session',201,{name:'Hosted RPC verification'});
  const challenge=await request('Request wallet binding','/api/auth/challenge',200,{intent:'bind',wallet:address});
  assert('Canonical signing origin',challenge.domain===site&&challenge.message.includes(`Domain: ${site}\n`));
  const signature=Buffer.from(await webcrypto.subtle.sign('Ed25519',keys.privateKey,new TextEncoder().encode(challenge.message))).toString('base64');
  session=await request('Verify wallet binding','/api/auth/verify',200,{challengeId:challenge.id,signature});
  const created=await request('Create synthetic chain-enabled journey','/api/trips',201,{chainEnabled:true,
    origin:{label:'Synthetic RPC check pickup',lat:0,lng:0},destination:{label:'Synthetic RPC check destination',lat:0.001,lng:0.001},checkInIntervalSeconds:60,notificationConsent:false});
  tripId=created.trip.id;
  const prepared=await request('Prepare unsigned Devnet create transaction',`/api/trips/${tripId}/chain/prepare`,200,{operation:'create'});
  const transaction=Transaction.from(Buffer.from(prepared.transaction,'base64'));
  assert('Transaction has no signatures',transaction.signatures.length>0&&transaction.signatures.every(item=>item.signature===null));
  assert('Expected rider pays test-network fees',prepared.wallet===address&&transaction.feePayer?.toBase58()===address);
  assert('Expected V2 Devnet program',prepared.view.network==='devnet'&&prepared.view.programId===programId&&transaction.instructions.length===1&&transaction.instructions[0].programId.toBase58()===programId);
  assert('Create instruction and current blockhash',Buffer.from(transaction.instructions[0].data.subarray(0,8)).equals(Buffer.from([215,98,167,155,7,17,154,8]))&&Boolean(transaction.recentBlockhash));
  const intent=prepared.view.intents.find(item=>item.id===prepared.intentId);
  assert('Durable outbox contains only prepared state',intent?.status==='prepared'&&intent.signature===null&&prepared.view.snapshot.state==='uncreated');
  const discarded=await request('Discard unsigned transaction',`/api/trips/${tripId}/chain/discard`,200,{intentId:prepared.intentId});
  assert('Unsigned intent discarded',discarded.chain.intents.find(item=>item.id===prepared.intentId)?.status==='expired');
  success=true;
}catch(error){
  failure=error instanceof Error?error.message:'Hosted chain preparation failed.';
  if(session&&tripId){
    try{
      const current=await request('Read failed preparation state',`/api/trips/${tripId}/chain`,200);
      diagnostic=typeof current.chain?.lastError==='string'?current.chain.lastError.replace(/https?:\/\/\S+/g,'[RPC endpoint]').slice(0,250):undefined;
    }catch{}
  }
}finally{
  if(session&&tripId){
    try{const cancelled=await request('Cancel synthetic monitoring',`/api/trips/${tripId}/actions`,200,{action:'cancel'});closed=cancelled.trip.status==='cancelled';}
    catch{results.push({check:'Synthetic journey cleanup requires follow-up',passed:false});}
  }
  if(session){
    try{const removed=await request('Delete synthetic account and journey','/api/account/delete',200,{confirmation:'DELETE MY ACCOUNT'});deleted=removed.deleted===true;}
    catch{results.push({check:'Synthetic account cleanup requires follow-up',passed:false});}
  }
  const evidence={startedAt,finishedAt:new Date().toISOString(),apiOrigin:api,signingOrigin:site,programId,success,
    syntheticMonitoringCancelled:closed,syntheticAccountDeleted:deleted,blockchainTransactions:0,credentialsPersisted:false,checks:results,...(failure?{failure}:{}),...(diagnostic?{diagnostic}:{})};
  process.stdout.write(`${JSON.stringify(evidence,null,2)}\n`);
  if(evidencePath)await writeFile(resolve(evidencePath),`${JSON.stringify(evidence,null,2)}\n`,'utf8');
  if(!success||!closed||!deleted)process.exitCode=1;
}
