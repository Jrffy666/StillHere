import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { digest, type AccountPublic } from './accounts';
import { boundedJson } from './integrations';
import type { WorkerEnv } from './types';

export type IdentityEnv = WorkerEnv & { AUTH: DurableObjectNamespace<IdentityRegistry> };
export class IdentityError extends Error { constructor(public status:number,message:string) {super(message);} }
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const intents=['bind','login','rotate','recover','recovery-code','revoke-sessions'] as const;
export type IdentityIntent=typeof intents[number];
interface Challenge { id:string;message:string;domain:string;intent:IdentityIntent;wallet:string;accountId:string;authVersion:number;oldWallet:string|null;expiresAt:number;used:boolean }
interface WalletClaim { kind:'wallet';accountId:string;operation:string;committed:boolean }
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function encodeWallet(bytes:Uint8Array):string {
  let n=0n; for(const byte of bytes)n=n*256n+BigInt(byte);
  let result='';while(n>0n){result=alphabet[Number(n%58n)]+result;n/=58n;}
  for(const byte of bytes){if(byte!==0)break;result='1'+result;}return result;
}
export function decodeWallet(value:string):Uint8Array {
  if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))throw new IdentityError(400,'Invalid Solana wallet address.');
  let n=0n;for(const char of value)n=n*58n+BigInt(alphabet.indexOf(char));
  const values:number[]=[];while(n>0n){values.unshift(Number(n%256n));n/=256n;}
  for(const char of value){if(char!=='1')break;values.unshift(0);}
  const bytes=new Uint8Array(values);
  if(bytes.length!==32||encodeWallet(bytes)!==value)throw new IdentityError(400,'Invalid Solana wallet address.');return bytes;
}
function randomHex():string {return Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');}
function tokenFrom(request:Request):string {
  const value=request.headers.get('Authorization')?.replace(/^Bearer /,'')??'';
  const split=value.split('.');
  if(split.length!==2||!uuid.test(split[0])||!/^[a-f0-9]{64}$/.test(split[1]))throw new IdentityError(401,'Create a session or sign in to continue.');return value;
}
function domainFor(request:Request,env:IdentityEnv):string {
  if(env.APP_ENV!=='development'){
    let site:URL;try{site=new URL(env.SITE_ORIGIN);}catch{throw new IdentityError(503,'The account signing domain is not configured.');}
    if(site.origin!==env.SITE_ORIGIN||site.protocol!=='https:'||site.host!==env.AUTH_DOMAIN
      ||['localhost','127.0.0.1','[::1]'].includes(site.hostname))throw new IdentityError(503,'The account signing domain is not configured.');
    const supplied=request.headers.get('Origin');
    if(supplied!==null&&supplied!==site.origin)throw new IdentityError(403,'Signing origin is not allowed.');
    return site.origin;
  }
  const server=new URL(request.url).origin,origin=request.headers.get('Origin')??server;
  let parsed:URL;try{parsed=new URL(origin);}catch{throw new IdentityError(403,'Invalid signing origin.');}
  if(parsed.origin!==origin||!['http:','https:'].includes(parsed.protocol))throw new IdentityError(403,'Invalid signing origin.');
  if(origin!==server&&!env.ALLOWED_ORIGINS.split(',').map(s=>s.trim()).includes(origin))throw new IdentityError(403,'Signing origin is not allowed.');return origin;
}
async function verifySignature(wallet:string,message:string,signature:string):Promise<boolean> {
  if(!/^[A-Za-z0-9+/]{86}==$/.test(signature))return false;
  try{
    const bytes=Uint8Array.from(atob(signature),char=>char.charCodeAt(0));
    const key=await crypto.subtle.importKey('raw',decodeWallet(wallet),{name:'Ed25519'},false,['verify']);
    return bytes.length===64&&await crypto.subtle.verify('Ed25519',key,bytes,new TextEncoder().encode(message));
  }catch{return false;}
}

/** One object per wallet, challenge, or rate key. All mutations are synchronous SQL transactions. */
export class IdentityRegistry extends DurableObject<IdentityEnv> {
  constructor(ctx:DurableObjectState,env:IdentityEnv){
    super(ctx,env);ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS record(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY,start INTEGER NOT NULL,count INTEGER NOT NULL)');
  }
  private load<T>():T|null {const row=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM record WHERE id=1').toArray()[0];return row?JSON.parse(row.data) as T:null;}
  private save(value:unknown):void{this.ctx.storage.sql.exec('INSERT OR REPLACE INTO record VALUES(1,?)',JSON.stringify(value));}
  async putChallenge(challenge:Challenge):Promise<void>{if(this.load())throw new Error('Challenge already exists');this.save(challenge);await this.ctx.storage.setAlarm(challenge.expiresAt+60000);}
  consumeChallenge(domain:string):Challenge|null{
    return this.ctx.storage.transactionSync(()=>{
      const challenge=this.load<Challenge>();if(!challenge||!challenge.id||challenge.used)return null;
      this.save({...challenge,used:true});
      return challenge.expiresAt>Date.now()&&challenge.domain===domain?challenge:null;
    });
  }
  owner():string|null{const value=this.load<WalletClaim>();return value?.kind==='wallet'?value.accountId:null;}
  reserve(accountId:string,operation:string):boolean{
    const existing=this.load<WalletClaim>();
    if(existing)return existing.kind==='wallet'&&existing.accountId===accountId;
    this.save({kind:'wallet',accountId,operation,committed:false} satisfies WalletClaim);return true;
  }
  commit(accountId:string):boolean{const value=this.load<WalletClaim>();if(!value||value.kind!=='wallet'||value.accountId!==accountId)return false;this.save({...value,committed:true});return true;}
  allow(key:string,max:number,windowMs:number):boolean{
    const now=Date.now(),row=this.ctx.storage.sql.exec<{start:number;count:number}>('SELECT start,count FROM limits WHERE key=?',key).toArray()[0];
    if(!row||now-row.start>=windowMs){this.ctx.storage.sql.exec('INSERT OR REPLACE INTO limits VALUES(?,?,1)',key,now);return true;}
    if(row.count>=max)return false;this.ctx.storage.sql.exec('UPDATE limits SET count=count+1 WHERE key=?',key);return true;
  }
  async alarm():Promise<void>{const record=this.load<Challenge>();if(record?.expiresAt&&record.expiresAt<=Date.now())this.ctx.storage.sql.exec('DELETE FROM record');}
  exportSnapshot():{version:1;accountId:string}|null{const value=this.load<WalletClaim>();return value?.kind==='wallet'?{version:1,accountId:value.accountId}:null;}
  restoreSnapshot(snapshot:{version:1;accountId:string}):boolean{
    if(this.load()||snapshot?.version!==1||!uuid.test(snapshot.accountId))return false;
    this.save({kind:'wallet',accountId:snapshot.accountId,operation:'restore',committed:true} satisfies WalletClaim);return true;
  }
}

export async function authenticate(request:Request,env:IdentityEnv):Promise<AccountPublic>{
  const token=tokenFrom(request),user=await env.USERS.getByName(token.split('.')[0]).authenticate(await digest(token));
  if(!user)throw new IdentityError(401,'Session expired or revoked. Sign in again.');return user;
}
export async function createGuestSession(env:IdentityEnv,name:string):Promise<{user:AccountPublic;token:string}>{
  const clean=z.string().trim().min(1).max(60).parse(name),id=crypto.randomUUID(),token=`${id}.${randomHex()}`;
  const user=await env.USERS.getByName(id).initialize({id,name:clean,points:0,reputation:0,completedGuards:0},await digest(token));return{user,token};
}
async function issueSession(env:IdentityEnv,user:AccountPublic):Promise<{user:AccountPublic;token:string}>{
  const token=`${user.id}.${randomHex()}`,current=await env.USERS.getByName(user.id).issueSession(await digest(token),user.authVersion);
  if(!current)throw new IdentityError(409,'Account access changed. Start a new sign-in request.');return{user:current,token};
}
async function limited(request:Request,env:IdentityEnv,key:string,max=20):Promise<void>{
  const address=await digest(request.headers.get('CF-Connecting-IP')??'local');
  if(!await env.AUTH.getByName(`rate:${address}`).allow(key,max,60000))throw new IdentityError(429,'Too many identity requests. Try again in a minute.');
}

async function createChallenge(request:Request,env:IdentityEnv,input:unknown):Promise<Response>{
  const parsed=z.object({intent:z.enum(intents),wallet:z.string(),accountId:z.string().uuid().optional()}).strict().parse(input);
  decodeWallet(parsed.wallet);
  const domain=domainFor(request,env);await limited(request,env,'challenge',20);
  let user:AccountPublic|null;
  if(parsed.intent==='login'){
    const owner=await env.AUTH.getByName(`wallet:${parsed.wallet}`).owner();
    user=owner?await env.USERS.getByName(owner).getPublic():null;
    if(!user||user.status!=='active'||user.wallet!==parsed.wallet)throw new IdentityError(401,'This wallet cannot sign in to an active account.');
  }else if(parsed.intent==='recover'){
    if(!parsed.accountId)throw new IdentityError(400,'Recovery requires the account ID from your recovery code.');
    user=await env.USERS.getByName(parsed.accountId).getPublic();
    if(!user||user.status!=='active'||!user.recoveryConfigured)throw new IdentityError(401,'Account recovery is unavailable.');
  }else{
    user=await authenticate(request,env);
    if(parsed.intent==='bind'&&user.wallet)throw new IdentityError(409,'This account already has a wallet. Use wallet rotation.');
    if(parsed.intent==='rotate'&&!user.wallet)throw new IdentityError(409,'Bind your first wallet before rotating it.');
    if(['recovery-code','revoke-sessions'].includes(parsed.intent)&&user.wallet!==parsed.wallet)throw new IdentityError(400,'Sign with the currently bound wallet.');
  }
  if((await env.GOVERNANCE.getByName('governance-v1').status(user.id)).deleted)throw new IdentityError(401,'Account access has been removed.');
  if(!await env.USERS.getByName(user.id).allow('identity-challenge',12,60000))throw new IdentityError(429,'Too many account challenges. Try again in a minute.');
  const id=crypto.randomUUID(),nonce=randomHex(),issuedAt=Date.now(),expiresAt=issuedAt+5*60000;
  const message=['StillHere account authorization',`Domain: ${domain}`,`Intent: ${parsed.intent}`,`Wallet: ${parsed.wallet}`,`Account: ${user.id}`,
    `Current wallet: ${user.wallet??'none'}`,`Auth version: ${user.authVersion}`,`Nonce: ${nonce}`,`Issued at: ${new Date(issuedAt).toISOString()}`,
    `Expires at: ${new Date(expiresAt).toISOString()}`,'This signature authorizes only this account operation. It is not a blockchain transaction.'].join('\n');
  const challenge:Challenge={id,message,domain,intent:parsed.intent,wallet:parsed.wallet,accountId:user.id,oldWallet:user.wallet,authVersion:user.authVersion,expiresAt,used:false};
  await env.AUTH.getByName(`challenge:${id}`).putChallenge(challenge);
  return Response.json({id,message,domain,intent:parsed.intent,wallet:parsed.wallet,expiresAt});
}
async function verifyChallenge(request:Request,env:IdentityEnv,input:unknown):Promise<Response>{
  const parsed=z.object({challengeId:z.string().uuid(),signature:z.string().max(128),oldSignature:z.string().max(128).optional(),recoveryCode:z.string().max(200).optional()}).strict().parse(input);
  await limited(request,env,'verify',30);
  const challenge=await env.AUTH.getByName(`challenge:${parsed.challengeId}`).consumeChallenge(domainFor(request,env));
  if(!challenge)throw new IdentityError(409,'Challenge expired, was already used, or belongs to another origin.');
  if(!await verifySignature(challenge.wallet,challenge.message,parsed.signature))throw new IdentityError(401,'Wallet signature verification failed.');
  const account=env.USERS.getByName(challenge.accountId),user=await account.getPublic();
  if(!user||user.status!=='active'||user.authVersion!==challenge.authVersion||user.wallet!==challenge.oldWallet)throw new IdentityError(409,'Account changed. Start a fresh challenge.');
  if((await env.GOVERNANCE.getByName('governance-v1').status(user.id)).deleted)throw new IdentityError(401,'Account access has been removed.');
  if(challenge.intent==='login'){
    if(user.wallet!==challenge.wallet||await env.AUTH.getByName(`wallet:${challenge.wallet}`).owner()!==user.id)throw new IdentityError(401,'Wallet access changed.');
    const registered=await env.GOVERNANCE.getByName('governance-v1').registerWallet(challenge.wallet,user.id);
    if(!registered.ok)throw new IdentityError(409,'Wallet ownership records do not match this account.');
    return Response.json(await issueSession(env,user));
  }
  let actorDigest:string|undefined,recoveryDigest:string|undefined;
  if(challenge.intent==='recover'){
    if(!parsed.recoveryCode||!parsed.recoveryCode.startsWith(`sg-recovery.${user.id}.`))throw new IdentityError(401,'Recovery proof is invalid.');
    recoveryDigest=await digest(parsed.recoveryCode);
    if(!await account.recoveryMatches(recoveryDigest))throw new IdentityError(401,'Recovery proof is invalid.');
  }else{
    const actor=await authenticate(request,env);
    if(actor.id!==user.id)throw new IdentityError(403,'This challenge belongs to another account.');
    actorDigest=await digest(tokenFrom(request));
    if(challenge.intent==='rotate'){
      const oldProof=Boolean(challenge.oldWallet&&parsed.oldSignature&&await verifySignature(challenge.oldWallet,challenge.message,parsed.oldSignature));
      if(!oldProof){
        if(!parsed.recoveryCode||!await account.recoveryMatches(await digest(parsed.recoveryCode)))throw new IdentityError(401,'Wallet rotation requires proof from the old wallet or your recovery code.');
        recoveryDigest=await digest(parsed.recoveryCode);
      }
    }
  }
  const changesWallet=['bind','rotate','recover'].includes(challenge.intent);
  // Reservations are permanently bound to the account that proved wallet ownership.
  // A concurrent failed identity update can retry with the same account, but cannot
  // release a reservation while another request is committing that wallet.
  if(changesWallet){
    const owner=await env.GOVERNANCE.getByName('governance-v1').walletOwner(challenge.wallet);
    if(owner&&owner!==user.id)throw new IdentityError(409,'This wallet already belongs to another account.');
    if(!await env.AUTH.getByName(`wallet:${challenge.wallet}`).reserve(user.id,challenge.id))throw new IdentityError(409,'This wallet already belongs to another account.');
  }
  if(changesWallet){
    const governance=env.GOVERNANCE.getByName('governance-v1');
    for(const wallet of new Set([user.wallet,challenge.wallet].filter((value):value is string=>Boolean(value)))){
      const registered=await governance.registerWallet(wallet,user.id);
      if(!registered.ok)throw new IdentityError(409,'Wallet ownership records do not match this account.');
    }
  }
  const recoveryCode=challenge.intent!=='revoke-sessions'?`sg-recovery.${user.id}.${randomHex()}`:undefined;
  const changed=await account.changeIdentity({expectedVersion:challenge.authVersion,actorDigest,recoveryDigest,
    ...(changesWallet?{wallet:challenge.wallet}:{}),...(recoveryCode?{newRecoveryDigest:await digest(recoveryCode)}:{})});
  if(!changed)throw new IdentityError(409,'Identity changed or credentials expired. Start a fresh challenge.');
  if(changesWallet)await env.AUTH.getByName(`wallet:${challenge.wallet}`).commit(user.id);
  const session=await issueSession(env,changed);
  return Response.json({...session,...(recoveryCode?{recoveryCode}:{})});
}
async function readBody(request:Request):Promise<unknown>{
  if(!request.headers.get('Content-Type')?.toLowerCase().includes('application/json'))throw new IdentityError(415,'Use Content-Type: application/json.');
  try{return await boundedJson(new Response(request.body),4096);}catch{throw new IdentityError(400,'Invalid or oversized JSON.');}
}
export async function handleIdentity(request:Request,env:IdentityEnv):Promise<Response|null>{
  const path=new URL(request.url).pathname;if(!path.startsWith('/api/auth/'))return null;
  try{
    domainFor(request,env);
    if(request.method!=='POST')throw new IdentityError(405,'Use POST for identity operations.');
    if(path==='/api/auth/challenge')return await createChallenge(request,env,await readBody(request));
    if(path==='/api/auth/verify')return await verifyChallenge(request,env,await readBody(request));
    if(path==='/api/auth/logout'){
      const user=await authenticate(request,env);await env.USERS.getByName(user.id).logout(await digest(tokenFrom(request)));return Response.json({ok:true});
    }
    if(path==='/api/auth/recovery'||path==='/api/auth/revoke-sessions'){
      const user=await authenticate(request,env);await limited(request,env,'session-control',12);
      if(user.wallet)throw new IdentityError(409,'A fresh wallet-signed challenge is required for this operation.');
      const recoveryCode=path.endsWith('/recovery')?`sg-recovery.${user.id}.${randomHex()}`:undefined;
      const changed=await env.USERS.getByName(user.id).changeIdentity({expectedVersion:user.authVersion,actorDigest:await digest(tokenFrom(request)),...(recoveryCode?{newRecoveryDigest:await digest(recoveryCode)}:{})});
      if(!changed)throw new IdentityError(409,'Account access changed.');
      return Response.json({...await issueSession(env,changed),...(recoveryCode?{recoveryCode}:{})});
    }
    throw new IdentityError(404,'Identity endpoint not found.');
  }catch(error){
    if(error instanceof IdentityError)return Response.json({error:error.message},{status:error.status});
    if(error instanceof z.ZodError)return Response.json({error:'Invalid identity input.'},{status:400});
    throw error;
  }
}
