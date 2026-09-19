import { webcrypto } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// Explicitly invoked maintenance smoke test. Creates one synthetic account,
// performs wallet-message signatures only, then deletes that account. No wallet
// private key, bearer token, signature, recovery code or account ID is logged.
const args=process.argv.slice(2);
function option(name){const index=args.indexOf(name);return index<0?undefined:args[index+1];}
function origin(value,label){
  let parsed;try{parsed=new URL(value);}catch{throw new Error(`Provide a valid ${label} HTTPS origin.`);}
  if(parsed.protocol!=='https:'||parsed.origin!==value)throw new Error(`Provide an exact ${label} HTTPS origin without a path or trailing slash.`);
  return parsed.origin;
}
const api=origin(option('--api'),'API'),site=origin(option('--origin'),'frontend');
const evidencePath=option('--evidence');
if(evidencePath)await mkdir(dirname(resolve(evidencePath)),{recursive:true});
const results=[];
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function encode(bytes){
  let value=0n;for(const byte of bytes)value=value*256n+BigInt(byte);
  let text='';while(value){text=alphabet[Number(value%58n)]+text;value/=58n;}
  for(const byte of bytes){if(byte)break;text='1'+text;}return text;
}
async function wallet(){
  const keys=await webcrypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);
  const address=encode(new Uint8Array(await webcrypto.subtle.exportKey('raw',keys.publicKey)));
  return {address,sign:async message=>Buffer.from(await webcrypto.subtle.sign('Ed25519',keys.privateKey,new TextEncoder().encode(message))).toString('base64')};
}
async function request(label,path,expected,{body,token,origin:signingOrigin=site}={}){
  const response=await fetch(`${api}${path}`,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{'Content-Type':'application/json',...(signingOrigin===null?{}:{Origin:signingOrigin}),...(token?{Authorization:`Bearer ${token}`}:{})},
    body:body===undefined?undefined:JSON.stringify(body)});
  results.push({check:label,status:response.status,passed:response.status===expected});
  if(response.status!==expected){await response.body?.cancel();throw new Error(`${label}: expected HTTP ${expected}, received ${response.status}.`);}
  return response.json();
}
function assert(label,condition){results.push({check:label,passed:Boolean(condition)});if(!condition)throw new Error(`${label} failed.`);}
async function challenge(intent,account,token,accountId,signingOrigin=site){
  const result=await request(`${intent} challenge`,'/api/auth/challenge',200,{token,origin:signingOrigin,body:{intent,wallet:account.address,...(accountId?{accountId}:{})}});
  assert(`${intent} canonical signing origin`,result.domain===site&&result.message.includes(`Domain: ${site}\n`));
  assert(`${intent} wallet and expiry`,result.wallet===account.address&&result.expiresAt>Date.now()&&result.expiresAt<=Date.now()+301000);
  return result;
}

let currentSession,deleted=false,success=false,failure;
const startedAt=new Date().toISOString();
try{
  const readiness=await request('Hosted readiness','/api/ready',200);assert('Production readiness',readiness.ready===true&&readiness.environment==='production');
  const original=await wallet(),replacement=await wallet();
  currentSession=await request('Create synthetic guest','/api/session',201,{body:{name:'Hosted identity verification'}});
  const originalId=currentSession.user.id,guestToken=currentSession.token;
  const bind=await challenge('bind',original,currentSession.token,undefined,null);
  const bindingProof={challengeId:bind.id,signature:await original.sign(bind.message)};
  currentSession=await request('Verify wallet binding','/api/auth/verify',200,{token:currentSession.token,body:bindingProof});
  assert('Wallet bound to original account',currentSession.user.id===originalId&&currentSession.user.wallet===original.address&&currentSession.user.recoveryConfigured===true);
  const originalCode=currentSession.recoveryCode;
  assert('Recovery code issued privately',typeof originalCode==='string'&&originalCode.startsWith(`sg-recovery.${originalId}.`));
  await request('Reject consumed challenge replay','/api/auth/verify',409,{token:guestToken,body:bindingProof});
  await request('Reject cross-origin challenge','/api/auth/challenge',403,{origin:'https://untrusted.invalid',body:{intent:'login',wallet:original.address}});
  const login=await challenge('login',original),loginProof={challengeId:login.id,signature:await original.sign(login.message)};
  await request('Reject cross-origin signature submission','/api/auth/verify',403,{origin:'https://untrusted.invalid',body:loginProof});
  const previousSession=currentSession;
  currentSession=await request('Sign in from canonical origin','/api/auth/verify',200,{body:loginProof});
  assert('Sign-in preserves account identity',currentSession.user.id===originalId&&currentSession.token!==previousSession.token);
  const recovery=await challenge('recover',replacement,undefined,originalId);
  currentSession=await request('Recover with new wallet and recovery code','/api/auth/verify',200,{body:{challengeId:recovery.id,signature:await replacement.sign(recovery.message),recoveryCode:originalCode}});
  assert('Recovery preserves identity and replaces credentials',currentSession.user.id===originalId&&currentSession.user.wallet===replacement.address&&currentSession.recoveryCode!==originalCode);
  await request('Recovery revokes previous sessions','/api/me',401,{token:previousSession.token});
  await request('Old wallet no longer signs in','/api/auth/challenge',401,{body:{intent:'login',wallet:original.address}});
  const oldCode=await challenge('recover',original,undefined,originalId);
  await request('Old recovery code is invalid','/api/auth/verify',401,{body:{challengeId:oldCode.id,signature:await original.sign(oldCode.message),recoveryCode:originalCode}});
  const finalLogin=await challenge('login',replacement);
  currentSession=await request('Recovered wallet signs in','/api/auth/verify',200,{body:{challengeId:finalLogin.id,signature:await replacement.sign(finalLogin.message)}});
  const removed=await request('Delete synthetic account','/api/account/delete',200,{token:currentSession.token,body:{confirmation:'DELETE MY ACCOUNT'}});
  deleted=removed.deleted===true;assert('Synthetic private account deleted',deleted);
  await request('Deleted session rejected','/api/me',401,{token:currentSession.token});
  await request('Deleted wallet login rejected','/api/auth/challenge',401,{body:{intent:'login',wallet:replacement.address}});
  success=true;
}catch(error){failure=error instanceof Error?error.message:'Hosted identity verification failed.';}
finally{
  if(currentSession&&!deleted){
    try{
      const cleanup=await request('Cleanup synthetic account after failure','/api/account/delete',200,{token:currentSession.token,body:{confirmation:'DELETE MY ACCOUNT'}});
      deleted=cleanup.deleted===true;
    }catch{results.push({check:'Synthetic cleanup requires follow-up',passed:false});}
  }
  const evidence={startedAt,finishedAt:new Date().toISOString(),apiOrigin:api,signingOrigin:site,success,syntheticAccountDeleted:deleted,
    blockchainTransactions:0,credentialsPersisted:false,checks:results,...(failure?{failure}:{})};
  if(evidencePath)await writeFile(resolve(evidencePath),`${JSON.stringify(evidence,null,2)}\n`,'utf8');
  process.stdout.write(`${JSON.stringify(evidence,null,2)}\n`);
  if(!success||!deleted)process.exitCode=1;
}
