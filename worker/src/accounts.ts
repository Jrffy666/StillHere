import { DurableObject } from 'cloudflare:workers';
import bs58 from 'bs58';
import { z } from 'zod';
import { type WorkerEnv, type User, type TripSummary, type CommunityMember, type GratitudeKind } from './types';
import { COMMUNITY_NOTICE_VERSION, communityReference, randomCommunityReference } from './community-events';
import { hashPassword, usernameSchema, validPasswordVerifier, verifyPassword } from './password-auth';

export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function safeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a), right = new TextEncoder().encode(b);
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right);
}
type IdentityRow = { wallet: string | null; recovery_digest: string | null; auth_version: number; status: string; legacy_revoked: number };
export type AccountPublic = User & { wallet: string | null; username: string | null; recoveryConfigured: boolean; authVersion: number; status: 'active' | 'deactivated' };
type CredentialRow={username:string;verifier:string|null;operation:string;expected_version:number;expires:number};
export interface AccountSnapshot {
  version: 1; user: User; wallet: string | null; authVersion: number;
  trips: { id: string; created: number }[];
  credits: { trip_id: string; points: number; reputation: number }[];
  gratitude?: {id:string;kind:GratitudeKind;createdAt:number}[];
  community?:{memberId:string;noticeVersion:typeof COMMUNITY_NOTICE_VERSION;acceptedAt:number;credits:string[];gratitude:string[]};
}
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const wallet = z.string().min(32).max(44).refine(value => {
  try { const bytes=bs58.decode(value);return bytes.length===32 && bs58.encode(bytes)===value; } catch { return false; }
});
const accountSnapshotSchema = z.object({
  version:z.literal(1),
  user:z.object({id:z.uuid(),name:z.string().trim().min(1).max(60),bio:z.string().max(280).optional(),points:count,reputation:count,completedGuards:count}).strict(),
  wallet:wallet.nullable(),authVersion:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER-1),
  trips:z.array(z.object({id:z.uuid(),created:count}).strict()).max(10000),
  credits:z.array(z.object({trip_id:z.string().min(1).max(200),points:z.number().int().min(0).max(25),reputation:z.number().int().min(0).max(10)}).strict()).max(10000),
  gratitude:z.array(z.object({id:z.uuid(),kind:z.enum(['companionship','thoughtfulness','relay']),createdAt:count}).strict()).max(10000).optional(),
  community:z.object({memberId:communityReference,noticeVersion:z.literal(COMMUNITY_NOTICE_VERSION),acceptedAt:count,credits:z.array(z.string().max(200)).max(10000),gratitude:z.array(z.uuid()).max(10000)}).strict().optional(),
}).strict().refine(value => {
  const points=value.credits.reduce((sum,credit)=>sum+credit.points,0);
  const reputation=value.credits.reduce((sum,credit)=>sum+credit.reputation,0);
  return new Set(value.trips.map(trip=>trip.id)).size===value.trips.length
    && new Set(value.credits.map(credit=>credit.trip_id)).size===value.credits.length
    && new Set((value.gratitude??[]).map(item=>item.id)).size===(value.gratitude??[]).length
    && (!value.community||new Set(value.community.credits).size===value.community.credits.length
      && new Set(value.community.gratitude).size===value.community.gratitude.length
      && value.community.credits.every(id=>value.credits.some(credit=>credit.trip_id===id))
      && value.community.gratitude.every(id=>(value.gratitude??[]).some(receipt=>receipt.id===id)))
    && value.user.points===points && value.user.reputation===reputation
    && value.user.completedGuards===value.credits.length;
},'Account totals must match the unique contribution ledger.');
export class UserAccount extends DurableObject<WorkerEnv> {
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL, digest TEXT NOT NULL, expires INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS trips (id TEXT PRIMARY KEY, created INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS credits (trip_id TEXT PRIMARY KEY, points INTEGER NOT NULL, reputation INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, start INTEGER NOT NULL, count INTEGER NOT NULL)');
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1),wallet TEXT,recovery_digest TEXT,auth_version INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'active',legacy_revoked INTEGER NOT NULL DEFAULT 0)");
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY,created INTEGER NOT NULL,expires INTEGER NOT NULL,auth_version INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS credentials (id INTEGER PRIMARY KEY CHECK(id=1),username TEXT NOT NULL UNIQUE,verifier TEXT,operation TEXT NOT NULL,expected_version INTEGER NOT NULL,expires INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS gratitude (id TEXT PRIMARY KEY,kind TEXT NOT NULL,created INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS community_identity (id INTEGER PRIMARY KEY CHECK(id=1),member_id TEXT NOT NULL,notice_version TEXT NOT NULL,accepted_at INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS community_credits (trip_id TEXT PRIMARY KEY)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS community_gratitude (id TEXT PRIMARY KEY)');
  }
  private metadata(): IdentityRow {
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO identity(id) VALUES(1)');
    return this.ctx.storage.sql.exec<IdentityRow>('SELECT wallet,recovery_digest,auth_version,status,legacy_revoked FROM identity WHERE id=1').one();
  }
  getPublic(): AccountPublic | null {
    const row=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM account WHERE id=1').toArray()[0];
    if (!row) return null;
    const meta=this.metadata(), user=JSON.parse(row.data) as User;
    return {id:user.id,name:user.name,bio:user.bio??'',points:user.points,reputation:user.reputation,completedGuards:user.completedGuards,
      wallet:meta.wallet,username:this.credential()?.verifier?this.credential()!.username:null,recoveryConfigured:Boolean(meta.recovery_digest),authVersion:meta.auth_version,status:meta.status==='active'?'active':'deactivated',communityNoticeVersion:this.communityIdentity()?.noticeVersion??null};
  }
  private credential():CredentialRow|null {
    return this.ctx.storage.sql.exec<CredentialRow>('SELECT username,verifier,operation,expected_version,expires FROM credentials WHERE id=1').toArray()[0]??null;
  }
  /** Serialize an account upgrade before claiming a globally unique username. */
  beginPasswordRegistration(username:string,operation:string,expectedVersion:number,actorDigest:string):boolean {
    usernameSchema.parse(username);z.uuid().parse(operation);
    return this.ctx.storage.transactionSync(()=>{
      const user=this.authenticate(actorDigest),credential=this.credential();
      if(!user||user.authVersion!==expectedVersion||credential?.verifier||credential&&credential.expires>Date.now())return false;
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO credentials VALUES(1,?,NULL,?,?,?)',username,operation,expectedVersion,Date.now()+5*60_000);
      return true;
    });
  }
  cancelPasswordRegistration(operation:string):void {
    this.ctx.storage.sql.exec('DELETE FROM credentials WHERE operation=? AND verifier IS NULL',operation);
  }
  finishPasswordRegistration(input:{operation:string;actorDigest:string;verifier:string;tokenDigest:string}):AccountPublic|null {
    if(!validPasswordVerifier(input.verifier))return null;
    return this.ctx.storage.transactionSync(()=>{
      const user=this.authenticate(input.actorDigest),credential=this.credential();
      if(!user||!credential||credential.verifier||credential.operation!==input.operation||credential.expected_version!==user.authVersion||credential.expires<=Date.now())return null;
      this.ctx.storage.sql.exec('UPDATE credentials SET verifier=?,expires=0 WHERE id=1',input.verifier);
      return this.rotatePasswordSession(input.tokenDigest);
    });
  }
  private rotatePasswordSession(tokenDigest:string):AccountPublic {
    this.ctx.storage.sql.exec('UPDATE identity SET auth_version=auth_version+1,legacy_revoked=1 WHERE id=1');
    this.ctx.storage.sql.exec('DELETE FROM sessions');
    const user=this.getPublic()!;this.storeSession(tokenDigest,Date.now()+30*86400000,user.authVersion);return user;
  }
  /** KDF work can yield; recheck the exact credential and identity version before issuing access. */
  async loginPassword(username:string,password:string,tokenDigest:string):Promise<AccountPublic|null> {
    const credential=this.credential(),user=this.getPublic();
    const eligible=Boolean(user?.status==='active'&&credential?.username===username&&credential.verifier);
    const matches=await verifyPassword(password,eligible?credential!.verifier:null);
    if(!matches||!user||!credential)return null;
    return this.ctx.storage.transactionSync(()=>{
      const current=this.getPublic(),latest=this.credential();
      if(!current||current.status!=='active'||current.authVersion!==user.authVersion||latest?.username!==username||latest.verifier!==credential.verifier)return null;
      this.storeSession(tokenDigest,Date.now()+30*86400000,current.authVersion);return current;
    });
  }
  async changePassword(input:{actorDigest:string;expectedVersion:number;currentPassword:string;newPassword:string;tokenDigest:string}):Promise<AccountPublic|null> {
    const user=this.authenticate(input.actorDigest),credential=this.credential();
    if(!user||user.authVersion!==input.expectedVersion||!credential?.verifier)return null;
    if(!await verifyPassword(input.currentPassword,credential.verifier))return null;
    const verifier=await hashPassword(input.newPassword);
    return this.ctx.storage.transactionSync(()=>{
      const current=this.authenticate(input.actorDigest),latest=this.credential();
      if(!current||current.authVersion!==input.expectedVersion||latest?.verifier!==credential.verifier)return null;
      this.ctx.storage.sql.exec('UPDATE credentials SET verifier=? WHERE id=1',verifier);
      return this.rotatePasswordSession(input.tokenDigest);
    });
  }
  /** Private account-to-pseudonym mapping. Never derive this from a UUID or wallet. */
  communityIdentity():{memberId:string;noticeVersion:typeof COMMUNITY_NOTICE_VERSION;acceptedAt:number}|null {
    return this.ctx.storage.sql.exec<{memberId:string;noticeVersion:typeof COMMUNITY_NOTICE_VERSION;acceptedAt:number}>('SELECT member_id AS memberId,notice_version AS noticeVersion,accepted_at AS acceptedAt FROM community_identity WHERE id=1').toArray()[0]??null;
  }
  acceptCommunityNotice(version:string):AccountPublic|null {
    z.literal(COMMUNITY_NOTICE_VERSION).parse(version);
    const user=this.getPublic();if(!user||user.status!=='active')return null;
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO community_identity VALUES(1,?,?,?)',randomCommunityReference(),version,Date.now());
    return this.getPublic();
  }
  communityLegacy():{points:number;reputation:number;contributions:number;banners:number} {
    const credits=this.ctx.storage.sql.exec<{points:number;reputation:number;contributions:number}>('SELECT COALESCE(SUM(points),0) AS points,COALESCE(SUM(reputation),0) AS reputation,COUNT(*) AS contributions FROM credits WHERE trip_id NOT IN (SELECT trip_id FROM community_credits)').one();
    const banners=this.ctx.storage.sql.exec<{count:number}>('SELECT COUNT(*) AS count FROM gratitude WHERE id NOT IN (SELECT id FROM community_gratitude)').one().count;
    return {...credits,banners};
  }
  /** Deliberately separate from account/auth projections: always visible to community members. */
  communityProfile(): CommunityMember | null {
    const user=this.getPublic();if(!user||user.status!=='active')return null;
    const gratitude={total:0,companionship:0,thoughtfulness:0,relay:0};
    for(const row of this.ctx.storage.sql.exec<{kind:GratitudeKind;count:number}>('SELECT kind,COUNT(*) AS count FROM gratitude GROUP BY kind').toArray()) {
      if(row.kind==='companionship'||row.kind==='thoughtfulness'||row.kind==='relay'){gratitude[row.kind]=row.count;gratitude.total+=row.count;}
    }
    return {id:user.id,name:user.name,bio:user.bio??'',points:user.points,reputation:user.reputation,completedGuards:user.completedGuards,
      contributions:this.ctx.storage.sql.exec<{points:number;reputation:number}>('SELECT points,reputation FROM credits ORDER BY rowid DESC LIMIT 20').toArray().map(row=>({points:row.points,reputation:row.reputation})),gratitude};
  }
  updateProfile(bio:string): CommunityMember | null {
    const valid=z.string().trim().max(280).parse(bio),user=this.getPublic();if(!user||user.status!=='active')return null;
    this.ctx.storage.sql.exec('UPDATE account SET data=? WHERE id=1',JSON.stringify({...user,bio:valid}));
    return this.communityProfile();
  }
  /** Internal TripRoom RPC only. No HTTP route accepts receipt IDs or account credit events. */
  recordGratitude(id:string,kind:GratitudeKind,createdAt:number,community=false): boolean {
    z.uuid().parse(id);z.enum(['companionship','thoughtfulness','relay']).parse(kind);count.parse(createdAt);
    const user=this.getPublic();if(!user||user.status!=='active')return false;
    const prior=this.ctx.storage.sql.exec<{kind:string}>('SELECT kind FROM gratitude WHERE id=?',id).toArray()[0];
    if(prior){if(community&&prior.kind===kind)this.ctx.storage.sql.exec('INSERT OR IGNORE INTO community_gratitude VALUES(?)',id);return prior.kind===kind;}
    this.ctx.storage.transactionSync(()=>{this.ctx.storage.sql.exec('INSERT INTO gratitude VALUES(?,?,?)',id,kind,createdAt);if(community)this.ctx.storage.sql.exec('INSERT OR IGNORE INTO community_gratitude VALUES(?)',id);});return true;
  }
  initialize(user: User, tokenDigest: string): AccountPublic {
    if (this.getPublic()) throw new Error('Account already exists');
    this.ctx.storage.sql.exec('INSERT INTO account(id,data,digest,expires) VALUES(1,?,?,?)',JSON.stringify(user),tokenDigest,Date.now()+30*86400000);
    this.metadata();
    return this.getPublic()!;
  }
  authenticate(tokenDigest: string): AccountPublic | null {
    const user=this.getPublic(); if (!user || user.status!=='active') return null;
    const meta=this.metadata(), now=Date.now();
    this.ctx.storage.sql.exec('DELETE FROM sessions WHERE expires<=?',now);
    const session=this.ctx.storage.sql.exec<{expires:number;auth_version:number}>('SELECT expires,auth_version FROM sessions WHERE digest=?',tokenDigest).toArray()[0];
    if (session && session.expires>now && session.auth_version===meta.auth_version) return user;
    // Preserve pre-upgrade guest tokens until their original expiry or explicit revocation.
    const legacy=this.ctx.storage.sql.exec<{digest:string;expires:number}>('SELECT digest,expires FROM account WHERE id=1').one();
    if (!meta.legacy_revoked && legacy.expires>now && safeEqual(legacy.digest,tokenDigest)) {
      this.storeSession(tokenDigest,legacy.expires,meta.auth_version);
      this.ctx.storage.sql.exec('UPDATE identity SET legacy_revoked=1 WHERE id=1');
      return user;
    }
    return null;
  }
  private storeSession(tokenDigest:string, expires:number, version:number): void {
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO sessions VALUES(?,?,?,?)',tokenDigest,Date.now(),expires,version);
    this.ctx.storage.sql.exec('DELETE FROM sessions WHERE digest IN (SELECT digest FROM sessions ORDER BY created DESC,rowid DESC LIMIT -1 OFFSET 10)');
  }
  issueSession(tokenDigest:string, expectedVersion:number): AccountPublic | null {
    const user=this.getPublic();
    if (!user || user.status!=='active' || user.authVersion!==expectedVersion) return null;
    this.storeSession(tokenDigest,Date.now()+30*86400000,expectedVersion); return user;
  }
  logout(tokenDigest:string): void {
    this.ctx.storage.sql.exec('DELETE FROM sessions WHERE digest=?',tokenDigest);
    const legacy=this.ctx.storage.sql.exec<{digest:string}>('SELECT digest FROM account WHERE id=1').toArray()[0];
    if (legacy && safeEqual(legacy.digest,tokenDigest)) this.ctx.storage.sql.exec('UPDATE identity SET legacy_revoked=1 WHERE id=1');
  }
  recoveryMatches(recoveryDigest:string): boolean {
    const user=this.getPublic(),meta=this.metadata();
    return Boolean(user?.status==='active' && meta.recovery_digest && safeEqual(meta.recovery_digest,recoveryDigest));
  }
  changeIdentity(input:{expectedVersion:number;actorDigest?:string;recoveryDigest?:string;wallet?:string;newRecoveryDigest?:string;clearPassword?:boolean}): AccountPublic | null {
    return this.ctx.storage.transactionSync(()=>{
      const user=this.getPublic(),meta=this.metadata();
      if (!user || user.status!=='active' || user.authVersion!==input.expectedVersion) return null;
      const authorized=Boolean(input.actorDigest || input.recoveryDigest)
        && (!input.actorDigest || Boolean(this.authenticate(input.actorDigest)))
        && (!input.recoveryDigest || Boolean(meta.recovery_digest && safeEqual(meta.recovery_digest,input.recoveryDigest)));
      if (!authorized) return null;
      this.ctx.storage.sql.exec('UPDATE identity SET wallet=?,recovery_digest=?,auth_version=auth_version+1,legacy_revoked=1 WHERE id=1',input.wallet??meta.wallet,input.newRecoveryDigest??meta.recovery_digest);
      this.ctx.storage.sql.exec('DELETE FROM sessions');
      if(input.clearPassword)this.ctx.storage.sql.exec('DELETE FROM credentials');
      return this.getPublic();
    });
  }
  addTrip(id: string): void { this.ctx.storage.sql.exec('INSERT OR IGNORE INTO trips(id,created) VALUES(?,?)',id,Date.now()); }
  tripIds(): string[] { return this.ctx.storage.sql.exec<{id:string}>('SELECT id FROM trips ORDER BY created DESC LIMIT 50').toArray().map(row=>row.id); }
  allow(key:string,max:number,windowMs:number): boolean {
    const now=Date.now(),row=this.ctx.storage.sql.exec<{start:number;count:number}>('SELECT start,count FROM limits WHERE key=?',key).toArray()[0];
    if (!row || now-row.start>=windowMs) { this.ctx.storage.sql.exec('INSERT OR REPLACE INTO limits VALUES(?,?,1)',key,now);return true; }
    if (row.count>=max) return false;
    this.ctx.storage.sql.exec('UPDATE limits SET count=count+1 WHERE key=?',key);return true;
  }
  credit(tripId:string,points:number,reputation:number,community=false): boolean {
    if (!Number.isInteger(points)||points<0||points>25||!Number.isInteger(reputation)||reputation<0||reputation>10) throw new Error('Invalid contribution allocation');
    return this.ctx.storage.transactionSync(()=>{
      const user=this.getPublic(); if (!user || user.status!=='active') return false;
      const inserted=this.ctx.storage.sql.exec('INSERT OR IGNORE INTO credits VALUES(?,?,?)',tripId,points,reputation);
      if(community)this.ctx.storage.sql.exec('INSERT OR IGNORE INTO community_credits VALUES(?)',tripId);
      if (inserted.rowsWritten===0) return false;
      user.points+=points;user.reputation+=reputation;user.completedGuards+=1;
      this.ctx.storage.sql.exec('UPDATE account SET data=? WHERE id=1',JSON.stringify(user));return true;
    });
  }
  exportData(): {user:AccountPublic|null;trips:{id:string;created:number}[];credits:{trip_id:string;points:number;reputation:number}[];gratitude:{id:string;kind:GratitudeKind;createdAt:number}[];community:ReturnType<UserAccount['communityIdentity']>} {
    return {user:this.getPublic(),trips:this.ctx.storage.sql.exec<{id:string;created:number}>('SELECT id,created FROM trips ORDER BY created').toArray(),credits:this.ctx.storage.sql.exec<{trip_id:string;points:number;reputation:number}>('SELECT trip_id,points,reputation FROM credits').toArray(),
      gratitude:this.ctx.storage.sql.exec<{id:string;kind:GratitudeKind;createdAt:number}>('SELECT id,kind,created AS createdAt FROM gratitude ORDER BY created').toArray(),community:this.communityIdentity()};
  }
  deactivate(): void {
    this.metadata();
    this.ctx.storage.sql.exec("UPDATE identity SET status='deactivated',auth_version=auth_version+1,legacy_revoked=1,recovery_digest=NULL WHERE id=1");
    this.ctx.storage.sql.exec('DELETE FROM sessions');
    this.ctx.storage.sql.exec('DELETE FROM credentials');
    this.ctx.storage.sql.exec("UPDATE account SET digest='',expires=0 WHERE id=1");
  }
  purgePrivate(): void {
    this.deactivate();
    const user=this.getPublic();
    if(user) this.ctx.storage.sql.exec('UPDATE account SET data=? WHERE id=1',JSON.stringify({id:user.id,name:'Deleted account',points:0,reputation:0,completedGuards:0}));
    this.ctx.storage.sql.exec('DELETE FROM trips'); this.ctx.storage.sql.exec('DELETE FROM limits');
    this.ctx.storage.sql.exec('DELETE FROM gratitude');
    this.ctx.storage.sql.exec('DELETE FROM community_identity');this.ctx.storage.sql.exec('DELETE FROM community_gratitude');
    // Wallet ownership and credit tombstones prevent reactivation or duplicate issuance.
  }
  exportSnapshot(): AccountSnapshot | null {
    const data=this.exportData(); if (!data.user || data.user.status!=='active') return null;
    const {id,name,bio,points,reputation,completedGuards,wallet,authVersion}=data.user;
    const identity=this.communityIdentity();
    return {version:1,user:{id,name,bio:bio??'',points,reputation,completedGuards},wallet,authVersion,trips:data.trips,credits:data.credits,gratitude:data.gratitude,
      ...(identity?{community:{...identity,credits:this.ctx.storage.sql.exec<{id:string}>('SELECT trip_id AS id FROM community_credits').toArray().map(row=>row.id),gratitude:this.ctx.storage.sql.exec<{id:string}>('SELECT id FROM community_gratitude').toArray().map(row=>row.id)}}:{})};
  }
  validateSnapshot(snapshot:unknown,expectedId:string): boolean {
    const parsed=accountSnapshotSchema.safeParse(snapshot);
    return parsed.success && parsed.data.user.id===expectedId;
  }
  restoreSnapshot(value:unknown): boolean {
    if (this.getPublic() || this.ctx.storage.sql.exec('SELECT id FROM identity').toArray().length) return false;
    const parsed=accountSnapshotSchema.safeParse(value);if(!parsed.success)return false;
    const snapshot=parsed.data;
    this.ctx.storage.transactionSync(()=>{
      const u=snapshot.user;
      this.ctx.storage.sql.exec("INSERT INTO account VALUES(1,?,'',0)",JSON.stringify({id:u.id,name:u.name,bio:u.bio??'',points:u.points,reputation:u.reputation,completedGuards:u.completedGuards}));
      this.ctx.storage.sql.exec("INSERT INTO identity VALUES(1,?,NULL,?,'active',1)",snapshot.wallet,snapshot.authVersion+1);
      for(const trip of snapshot.trips)this.ctx.storage.sql.exec('INSERT OR IGNORE INTO trips VALUES(?,?)',trip.id,trip.created);
      for(const credit of snapshot.credits)this.ctx.storage.sql.exec('INSERT OR IGNORE INTO credits VALUES(?,?,?)',credit.trip_id,credit.points,credit.reputation);
      for(const item of snapshot.gratitude??[])this.ctx.storage.sql.exec('INSERT OR IGNORE INTO gratitude VALUES(?,?,?)',item.id,item.kind,item.createdAt);
      if(snapshot.community){const community=snapshot.community;this.ctx.storage.sql.exec('INSERT INTO community_identity VALUES(1,?,?,?)',community.memberId,community.noticeVersion,community.acceptedAt);
        for(const id of community.credits)this.ctx.storage.sql.exec('INSERT OR IGNORE INTO community_credits VALUES(?)',id);
        for(const id of community.gratitude)this.ctx.storage.sql.exec('INSERT OR IGNORE INTO community_gratitude VALUES(?)',id);}
    });return true;
  }
}

// Sixteen directory shards contain only public metadata. Trips and sessions have separate objects.
export class TripDirectory extends DurableObject<WorkerEnv> {
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS lobby (id TEXT PRIMARY KEY, created INTEGER NOT NULL, data TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS lobby_versions (id TEXT PRIMARY KEY, version INTEGER NOT NULL)');
  }
  update(trip: TripSummary, version = 0): void {
    this.ctx.storage.transactionSync(() => {
      const previous = this.ctx.storage.sql.exec<{version:number}>('SELECT version FROM lobby_versions WHERE id = ?',trip.id).toArray()[0];
      if (previous && previous.version > version) return;
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO lobby_versions VALUES (?,?)',trip.id,version);
      const record = this.redacted(trip);
      if (!record.requestKind || !record.requestExpiresAt || record.requestExpiresAt <= Date.now() || record.demo) this.ctx.storage.sql.exec('DELETE FROM lobby WHERE id = ?',trip.id);
      else this.ctx.storage.sql.exec('INSERT OR REPLACE INTO lobby VALUES (?,?,?)',trip.id,trip.createdAt,JSON.stringify(record));
      this.ctx.storage.sql.exec("DELETE FROM lobby WHERE COALESCE(json_extract(data, '$.requestExpiresAt'), created + 86400000) <= ?",Date.now());
    });
  }
  private redacted(trip: TripSummary): TripSummary {
    // Explicit fields protect the public directory even if an internal caller supplies extra properties.
    const legacyInitial = trip.requestKind === undefined && trip.status === 'open' && !trip.demo;
    return {id:trip.id,demo:trip.demo,chainEnabled:Boolean(trip.chainEnabled),status:trip.status,createdAt:trip.createdAt,
      riderProfile:trip.riderProfile?{id:trip.riderProfile.id,name:trip.riderProfile.name}:null,
      checkInIntervalSeconds:trip.checkInIntervalSeconds,rewardPoints:trip.rewardPoints,
      requestKind:legacyInitial ? 'initial' : trip.requestKind ?? null,
      requestId:legacyInitial ? trip.id : trip.requestId ?? null,
      requestExpiresAt:legacyInitial ? trip.createdAt + 86400000 : trip.requestExpiresAt ?? null,
      application:null};
  }
  list(): TripSummary[] {
    this.ctx.storage.sql.exec("DELETE FROM lobby WHERE COALESCE(json_extract(data, '$.requestExpiresAt'), created + 86400000) <= ?",Date.now());
    return this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM lobby ORDER BY created DESC LIMIT 20').toArray()
      .map(row => this.redacted(JSON.parse(row.data) as TripSummary))
      .filter(trip => !trip.demo && Boolean(trip.requestKind) && (trip.requestExpiresAt ?? 0) > Date.now());
  }
}
export const directoryName = (tripId: string) => `lobby-${tripId[0]}`;
