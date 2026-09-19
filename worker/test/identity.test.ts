import { env, SELF, runInDurableObject, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { digest, type AccountPublic } from '../src/accounts';
import { encodeWallet, handleIdentity, type IdentityEnv } from '../src/identity';

interface Session {token:string;user:AccountPublic;recoveryCode?:string}
interface Wallet {address:string;privateKey:CryptoKey}
interface Challenge {id:string;message:string;domain:string;expiresAt:number}
beforeEach(async()=>{await reset();});

async function wallet():Promise<Wallet> {
  const pair=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']) as CryptoKeyPair;
  return {address:encodeWallet(new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey) as ArrayBuffer)),privateKey:pair.privateKey};
}
async function sign(account:Wallet,message:string):Promise<string> {
  const bytes=new Uint8Array(await crypto.subtle.sign('Ed25519',account.privateKey,new TextEncoder().encode(message)));
  return btoa(String.fromCharCode(...bytes));
}
function request(path:string,token?:string,body?:unknown,origin?:string):Promise<Response> {
  return SELF.fetch(`https://guard.test${path}`,{method:body===undefined?'GET':'POST',
    headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{ }),...(origin?{Origin:origin}:{})},
    body:body===undefined?undefined:JSON.stringify(body)});
}
async function guest():Promise<Session> {
  const response=await request('/api/session',undefined,{name:'Recoverable guardian'});
  expect(response.status).toBe(201);return response.json();
}
async function challenge(intent:string,address:string,session?:Session,accountId?:string,origin?:string):Promise<Challenge> {
  const response=await request('/api/auth/challenge',session?.token,{intent,wallet:address,...(accountId?{accountId}:{})},origin);
  expect(response.status).toBe(200);return response.json();
}
async function verify(value:Challenge,account:Wallet,session?:Session,extra:Record<string,string>={},origin?:string):Promise<Response> {
  return request('/api/auth/verify',session?.token,{challengeId:value.id,signature:await sign(account,value.message),...extra},origin);
}
async function bind(session:Session,account:Wallet):Promise<Session> {
  const response=await verify(await challenge('bind',account.address,session),account,session);
  expect(response.status).toBe(200);return response.json();
}
async function login(account:Wallet):Promise<Session> {
  const response=await verify(await challenge('login',account.address),account);
  expect(response.status).toBe(200);return response.json();
}

describe('Recoverable wallet identity',()=>{
  it('binds a wallet using a real Ed25519 proof and signs in to the same account',async()=>{
    const initial=await guest(),account=await wallet(),bound=await bind(initial,account);
    expect(bound.user.wallet).toBe(account.address);expect(bound.user.recoveryConfigured).toBe(true);
    expect(bound.recoveryCode).toMatch(new RegExp(`^sg-recovery\\.${initial.user.id}\\.[a-f0-9]{64}$`));
    expect((await request('/api/me',initial.token)).status).toBe(401);
    const signedIn=await login(account);expect(signedIn.user.id).toBe(initial.user.id);
    expect(signedIn.token).not.toBe(bound.token);expect((await request('/api/me',bound.token)).status).toBe(200);
    const snapshot=await env.USERS.getByName(initial.user.id).exportSnapshot();
    expect(JSON.stringify(snapshot)).not.toContain(bound.token);expect(JSON.stringify(snapshot)).not.toContain(bound.recoveryCode!);
  });

  it('consumes a challenge exactly once, including concurrent submissions',async()=>{
    const session=await guest(),account=await wallet(),value=await challenge('bind',account.address,session);
    const signature=await sign(account,value.message),body={challengeId:value.id,signature};
    const replies=await Promise.all([request('/api/auth/verify',session.token,body),request('/api/auth/verify',session.token,body)]);
    expect(replies.map(reply=>reply.status).sort()).toEqual([200,409]);
    expect((await request('/api/auth/verify',session.token,body)).status).toBe(409);
  });

  it('rejects wrong signatures, cross-origin verification and expired challenges',async()=>{
    const session=await guest(),account=await wallet(),wrong=await wallet();
    const bad=await challenge('bind',account.address,session);
    expect((await verify(bad,wrong,session)).status).toBe(401);
    expect((await verify(bad,account,session)).status).toBe(409);
    const otherOrigin=await challenge('bind',account.address,session);
    expect((await verify(otherOrigin,account,session,{},'http://localhost:5173')).status).toBe(409);
    const expired=await challenge('bind',account.address,session);
    await runInDurableObject(env.AUTH.getByName(`challenge:${expired.id}`),async(_instance,state)=>{
      const row=state.storage.sql.exec<{data:string}>('SELECT data FROM record').one();
      state.storage.sql.exec('UPDATE record SET data=?',JSON.stringify({...JSON.parse(row.data),expiresAt:Date.now()-1}));
    });
    expect((await verify(expired,account,session)).status).toBe(409);
  });

  it('binds hosted signatures to configured SITE_ORIGIN and validates AUTH_DOMAIN',async()=>{
    const session=await guest(),account=await wallet();
    const hosted={...env,APP_ENV:'production',SITE_ORIGIN:'https://guard.example',AUTH_DOMAIN:'guard.example',ALLOWED_ORIGINS:'https://guard.example,https://other.example'} as IdentityEnv;
    const invoke=(origin?:string,override=hosted)=>handleIdentity(new Request('https://api.example/api/auth/challenge',{method:'POST',
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.token}`,...(origin?{Origin:origin}:{})},
      body:JSON.stringify({intent:'bind',wallet:account.address})}),override);
    const valid=await invoke('https://guard.example');expect(valid?.status).toBe(200);
    expect((await valid!.json<Challenge>()).domain).toBe('https://guard.example');
    const serverClient=await invoke();expect((await serverClient!.json<Challenge>()).domain).toBe('https://guard.example');
    expect((await invoke('https://other.example'))?.status).toBe(403);
    expect((await invoke('https://guard.example',{...hosted,AUTH_DOMAIN:'wrong.example'}))?.status).toBe(503);
  });

  it('does not let two accounts concurrently own one wallet',async()=>{
    const [a,b]=await Promise.all([guest(),guest()]),account=await wallet();
    const [ca,cb]=await Promise.all([challenge('bind',account.address,a),challenge('bind',account.address,b)]);
    const replies=await Promise.all([verify(ca,account,a),verify(cb,account,b)]);
    expect(replies.map(reply=>reply.status).sort()).toEqual([200,409]);
    const winner=await replies.find(reply=>reply.status===200)!.json<Session>();
    expect(await env.AUTH.getByName(`wallet:${account.address}`).owner()).toBe(winner.user.id);
    expect((await login(account)).user.id).toBe(winner.user.id);
  });

  it('allows only one of two concurrent account changes to commit',async()=>{
    const session=await guest(),[a,b]=await Promise.all([wallet(),wallet()]);
    const [ca,cb]=await Promise.all([challenge('bind',a.address,session),challenge('bind',b.address,session)]);
    const replies=await Promise.all([verify(ca,a,session),verify(cb,b,session)]);
    expect(replies.filter(reply=>reply.status===200)).toHaveLength(1);
    expect(replies.filter(reply=>[401,409].includes(reply.status))).toHaveLength(1);
    const user=await env.USERS.getByName(session.user.id).getPublic();expect(user?.authVersion).toBe(2);
  });

  it('requires old-wallet proof or recovery proof for rotation and revokes old sessions',async()=>{
    const old=await wallet(),next=await wallet(),session=await bind(await guest(),old);
    const denied=await challenge('rotate',next.address,session);
    expect((await verify(denied,next,session)).status).toBe(401);
    const value=await challenge('rotate',next.address,session);
    const response=await verify(value,next,session,{oldSignature:await sign(old,value.message)});
    expect(response.status).toBe(200);const rotated=await response.json<Session>();
    expect(rotated.user.wallet).toBe(next.address);expect(rotated.recoveryCode).not.toBe(session.recoveryCode);
    expect((await request('/api/me',session.token)).status).toBe(401);
    expect((await request('/api/auth/challenge',undefined,{intent:'login',wallet:old.address})).status).toBe(401);
    expect((await login(next)).user.id).toBe(session.user.id);
    expect(await env.GOVERNANCE.getByName('governance-v1').walletOwner(old.address)).toBe(session.user.id);
    expect(await env.GOVERNANCE.getByName('governance-v1').walletOwner(next.address)).toBe(session.user.id);
    const outsider=await guest();
    expect((await verify(await challenge('bind',old.address,outsider),old,outsider)).status).toBe(409);
  });

  it('requires both current-session and recovery proof when both are supplied',async()=>{
    const old=await wallet(),next=await wallet(),session=await bind(await guest(),old),account=env.USERS.getByName(session.user.id);
    const rejected=await account.changeIdentity({expectedVersion:session.user.authVersion,actorDigest:await digest('revoked-session'),recoveryDigest:await digest(session.recoveryCode!),wallet:next.address});
    expect(rejected).toBeNull();expect((await account.getPublic())?.authVersion).toBe(session.user.authVersion);
    const accepted=await verify(await challenge('rotate',next.address,session),next,session,{recoveryCode:session.recoveryCode!});
    expect(accepted.status).toBe(200);
  });

  it('recovers with a one-use code and new-wallet proof while preserving the credit ledger',async()=>{
    const old=await wallet(),next=await wallet(),third=await wallet(),session=await bind(await guest(),old);
    const tripId=crypto.randomUUID();expect(await env.USERS.getByName(session.user.id).credit(tripId,25,10)).toBe(true);
    const value=await challenge('recover',next.address,undefined,session.user.id);
    const response=await verify(value,next,undefined,{recoveryCode:session.recoveryCode!});expect(response.status).toBe(200);
    const recovered=await response.json<Session>();expect(recovered.user.id).toBe(session.user.id);
    expect(recovered.user.points).toBe(25);expect(recovered.user.completedGuards).toBe(1);
    expect((await request('/api/me',session.token)).status).toBe(401);
    const replay=await challenge('recover',third.address,undefined,session.user.id);
    expect((await verify(replay,third,undefined,{recoveryCode:session.recoveryCode!})).status).toBe(401);
    expect(await env.USERS.getByName(session.user.id).credit(tripId,25,10)).toBe(false);
  });

  it('requires a fresh signature to replace a bound recovery code or revoke sessions',async()=>{
    const account=await wallet(),session=await bind(await guest(),account),other=await login(account);
    expect((await request('/api/auth/recovery',session.token,{})).status).toBe(409);
    const response=await verify(await challenge('recovery-code',account.address,session),account,session);
    expect(response.status).toBe(200);const updated=await response.json<Session>();
    expect(updated.recoveryCode).not.toBe(session.recoveryCode);expect((await request('/api/me',other.token)).status).toBe(401);
    const another=await login(account);
    const revoke=await verify(await challenge('revoke-sessions',account.address,updated),account,updated);
    expect(revoke.status).toBe(200);const fresh=await revoke.json<Session>();expect(fresh.recoveryCode).toBeUndefined();
    expect((await request('/api/me',updated.token)).status).toBe(401);expect((await request('/api/me',another.token)).status).toBe(401);
    expect((await request('/api/me',fresh.token)).status).toBe(200);
    expect((await request('/api/auth/logout',fresh.token,{})).status).toBe(200);expect((await request('/api/me',fresh.token)).status).toBe(401);
  });

  it('supports guest recovery setup and prevents legacy-token resurrection after session eviction',async()=>{
    const session=await guest(),stub=env.USERS.getByName(session.user.id);
    expect((await request('/api/me',session.token)).status).toBe(200);
    for(let i=0;i<11;i++)expect(await stub.issueSession(await digest(`temporary-${i}`),1)).not.toBeNull();
    expect((await request('/api/me',session.token)).status).toBe(401);
    const fresh=await guest(),response=await request('/api/auth/recovery',fresh.token,{});
    expect(response.status).toBe(200);const setup=await response.json<Session>();expect(setup.recoveryCode).toBeDefined();
    const replacement=await wallet(),recover=await challenge('recover',replacement.address,undefined,fresh.user.id);
    expect((await verify(recover,replacement,undefined,{recoveryCode:setup.recoveryCode!})).status).toBe(200);
  });
});

describe('Account backup validation and deletion protection',()=>{
  it('validates the complete snapshot, IDs, unique credits and ledger totals before restoring',async()=>{
    const account=await wallet(),session=await bind(await guest(),account),stub=env.USERS.getByName(session.user.id),tripId=crypto.randomUUID();
    await stub.addTrip(tripId);await stub.credit(tripId,25,10);const snapshot=(await stub.exportSnapshot())!;
    expect(await stub.validateSnapshot(snapshot,session.user.id)).toBe(true);
    const malformed:unknown[]=[null,{...snapshot,token:'credential'}, {...snapshot,user:{...snapshot.user,points:99}},
      {...snapshot,user:{...snapshot.user,recoveryCode:'secret'}}, {...snapshot,credits:[...snapshot.credits,...snapshot.credits]},
      {...snapshot,trips:[...snapshot.trips,...snapshot.trips]}, {...snapshot,wallet:'z'.repeat(44)}, {...snapshot,authVersion:Number.MAX_SAFE_INTEGER}];
    for(const value of malformed)expect(await stub.validateSnapshot(value,session.user.id)).toBe(false);
    expect(await stub.validateSnapshot(snapshot,crypto.randomUUID())).toBe(false);
    const restore=env.USERS.getByName(`isolated-restore:${session.user.id}`);
    expect(await restore.restoreSnapshot(malformed[2])).toBe(false);expect(await restore.getPublic()).toBeNull();
    expect(await restore.restoreSnapshot(snapshot)).toBe(true);expect(await restore.restoreSnapshot(snapshot)).toBe(false);
    const restored=await restore.getPublic();expect(restored?.authVersion).toBe(snapshot.authVersion+1);
    expect(restored?.recoveryConfigured).toBe(false);expect(restored?.points).toBe(25);
    expect(await restore.authenticate(await digest(session.token))).toBeNull();
    expect(await restore.recoveryMatches(await digest(session.recoveryCode!))).toBe(false);
    expect(await restore.credit(tripId,25,10)).toBe(false);
  });

  it('cannot reactivate a deleted account from a wallet, recovery code or older snapshot',async()=>{
    const account=await wallet(),session=await bind(await guest(),account),stub=env.USERS.getByName(session.user.id),snapshot=await stub.exportSnapshot();
    const response=await request('/api/account/delete',session.token,{confirmation:'DELETE MY ACCOUNT'});expect(response.status).toBe(200);
    expect((await request('/api/me',session.token)).status).toBe(401);
    expect((await request('/api/auth/challenge',undefined,{intent:'login',wallet:account.address})).status).toBe(401);
    expect((await request('/api/auth/challenge',undefined,{intent:'recover',wallet:account.address,accountId:session.user.id})).status).toBe(401);
    expect(await stub.restoreSnapshot(snapshot)).toBe(false);expect(await stub.recoveryMatches(await digest(session.recoveryCode!))).toBe(false);
    expect(await stub.exportSnapshot()).toBeNull();expect((await stub.getPublic())?.name).toBe('Deleted account');
    expect((await env.GOVERNANCE.getByName('governance-v1').status(session.user.id)).deleted).toBe(true);
  });

  it('honors deletion journals and wallet tombstones before account or registry cleanup completes',async()=>{
    const account=await wallet(),session=await bind(await guest(),account);
    await env.GOVERNANCE.getByName('governance-v1').beginDeletion(session.user.id,[]);
    expect((await request('/api/auth/challenge',undefined,{intent:'login',wallet:account.address})).status).toBe(401);
    const historical=await wallet(),former=crypto.randomUUID();
    expect((await env.GOVERNANCE.getByName('governance-v1').registerWallet(historical.address,former)).ok).toBe(true);
    const outsider=await guest();expect((await verify(await challenge('bind',historical.address,outsider),historical,outsider)).status).toBe(409);
    expect(await env.AUTH.getByName(`wallet:${historical.address}`).owner()).toBeNull();
  });
});
