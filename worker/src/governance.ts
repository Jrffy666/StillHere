import { DurableObject } from 'cloudflare:workers';
import { AiBudgetLedger } from './ai-budget';
import { z } from 'zod';
import { digest, safeEqual } from './accounts';
import { fail, ok, type Outcome, type WorkerEnv } from './types';

const DAY = 86400000;
export const GOVERNANCE_NAME = 'governance-v1';
export const AUDIT_RETENTION_MS = 90 * DAY;
export const reportCategory = z.enum(['harassment','unsafe-conduct','spam','reward-abuse','privacy']);
export const moderationReason = z.enum(['safety','abuse','fraud','spam','appeal','administrative']);
export const reportSchema = z.object({
  tripId:z.uuid(),subjectId:z.uuid(),category:reportCategory,idempotencyKey:z.uuid(),
}).strict();
export type ReportInput = z.infer<typeof reportSchema>;
export interface ModerationReport {
  id:string; reporterId:string; subjectId:string; tripId:string; category:z.infer<typeof reportCategory>;
  createdAt:number; status:'open'|'dismissed'|'actioned'; resolvedAt:number|null;
}
export interface AccountStatus { suspended:boolean; deleted:boolean }
export interface DeletionJournal { userId:string; tripIds:string[]; startedAt:number; completedAt:number|null }
const deletionSchema = z.object({userId:z.uuid(),tripIds:z.array(z.uuid()).max(100000),startedAt:z.number().int().nonnegative(),completedAt:z.number().int().nonnegative().nullable()}).strict();
const walletSchema=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const stateSchema = z.object({
  schemaVersion:z.literal(1),
  users:z.array(z.object({id:z.uuid(),suspended:z.boolean(),deleted:z.boolean()}).strict()).max(100000),
  resources:z.array(z.object({kind:z.enum(['user','trip']),id:z.uuid(),createdAt:z.number().int().nonnegative()}).strict()).max(200000),
  deletions:z.array(deletionSchema).max(100000),
  purgedTrips:z.array(z.object({id:z.uuid(),at:z.number().int().nonnegative()}).strict()).max(100000),
  wallets:z.array(z.object({wallet:walletSchema,accountId:z.uuid(),createdAt:z.number().int().nonnegative()}).strict()).max(100000).default([]),
}).strict();
export type GovernanceExport = z.infer<typeof stateSchema>;
export const backupManifestSchema = z.object({
  id:z.uuid(),schemaVersion:z.literal(1),createdAt:z.number().int().nonnegative(),
  environment:z.enum(['development','staging','production']),sha256:z.string().regex(/^[0-9a-f]{64}$/),
  resources:z.object({users:z.number().int().nonnegative(),trips:z.number().int().nonnegative(),auth:z.number().int().nonnegative(),chain:z.number().int().nonnegative().default(0)}).strict(),
}).strict();
export type BackupManifest = z.infer<typeof backupManifestSchema>;

/** Hash both strings to fixed-length values before constant-time comparison. No credential is logged. */
export async function operatorAuthorized(request:Request, secret:string|undefined):Promise<boolean> {
  if (!secret || secret.length < 32) return false;
  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ') || header.length > 4096) return false;
  return safeEqual(await digest(header.slice(7)),await digest(secret));
}

/** Low-volume moderation and recovery metadata only; private journey content remains in TripRoom. */
export class GovernanceStore extends DurableObject<WorkerEnv> {
  reserveAiBudget(id:string,reservedTokens:number) { return new AiBudgetLedger(this.ctx.storage).reserve(id,reservedTokens); }
  constructor(ctx:DurableObjectState,env:WorkerEnv) {
    super(ctx,env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, reporter TEXT NOT NULL, idem TEXT NOT NULL, fingerprint TEXT NOT NULL, created INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(reporter,idem))');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS status (id TEXT PRIMARY KEY, suspended INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS report_limits (id TEXT PRIMARY KEY, start INTEGER NOT NULL, count INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, reason TEXT)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS resources (kind TEXT NOT NULL, id TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(kind,id))');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS deletions (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS purged_trips (id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS backups (id TEXT PRIMARY KEY, created INTEGER NOT NULL, data TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS restores (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, started INTEGER NOT NULL, completed INTEGER)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS wallets (wallet TEXT PRIMARY KEY, account_id TEXT NOT NULL, created INTEGER NOT NULL)');
  }
  private audit(action:string,target:string,reason:string|null=null):void {
    this.ctx.storage.sql.exec('INSERT INTO audit VALUES (?,?,?,?,?)',crypto.randomUUID(),Date.now(),action,target,reason);
  }
  private async schedule():Promise<void> {
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now()+DAY);
  }
  status(userId:string):AccountStatus {
    z.uuid().parse(userId);
    const row=this.ctx.storage.sql.exec<{suspended:number;deleted:number}>('SELECT suspended,deleted FROM status WHERE id = ?',userId).toArray()[0];
    return {suspended:Boolean(row?.suspended),deleted:Boolean(row?.deleted)};
  }
  async submitReport(reporterId:string,value:ReportInput):Promise<Outcome<ModerationReport>> {
    z.uuid().parse(reporterId);
    const parsed=reportSchema.safeParse(value);
    if (!parsed.success) return fail(400,'Invalid report.');
    const input=parsed.data;
    if (reporterId===input.subjectId) return fail(400,'You cannot report yourself.');
    if (this.status(reporterId).deleted) return fail(403,'This account has been deleted.');
    const read=await this.env.TRIPS.getByName(input.tripId).read(reporterId);
    if (!read.ok || !('rider' in read.value)) return fail(403,'Only a current participant with private trip access can report this journey.');
    const trip=read.value;
    if (trip.demo) return fail(400,'Demo participants cannot be reported.');
    const subjects=[trip.rider.id,trip.guardian?.id,...trip.contributions.map(item=>item.guardian.id)];
    if (!subjects.includes(input.subjectId)) return fail(400,'The reported account did not participate in this journey.');
    const fingerprint=JSON.stringify([input.tripId,input.subjectId,input.category]);
    const outcome=this.ctx.storage.transactionSync(():Outcome<ModerationReport>=>{
      if(this.status(reporterId).deleted)return fail(403,'This account has been deleted.');
      const prior=this.ctx.storage.sql.exec<{fingerprint:string;data:string}>('SELECT fingerprint,data FROM reports WHERE reporter = ? AND idem = ?',reporterId,input.idempotencyKey).toArray()[0];
      if (prior) return prior.fingerprint===fingerprint ? ok(JSON.parse(prior.data) as ModerationReport) : fail(409,'This idempotency key was used for a different report.');
      const now=Date.now();
      const rate=this.ctx.storage.sql.exec<{start:number;count:number}>('SELECT start,count FROM report_limits WHERE id = ?',reporterId).toArray()[0];
      if (rate && now-rate.start<DAY && rate.count>=5) return fail(429,'The daily reporting limit has been reached.');
      const record:ModerationReport={id:crypto.randomUUID(),reporterId,subjectId:input.subjectId,tripId:input.tripId,category:input.category,createdAt:now,status:'open',resolvedAt:null};
      this.ctx.storage.sql.exec('INSERT INTO reports VALUES (?,?,?,?,?,?)',record.id,reporterId,input.idempotencyKey,fingerprint,now,JSON.stringify(record));
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO report_limits VALUES (?,?,?)',reporterId,rate && now-rate.start<DAY?rate.start:now,rate && now-rate.start<DAY?rate.count+1:1);
      this.audit('report-created',record.id,input.category);
      return ok(record);
    });
    await this.schedule();
    return outcome;
  }
  listReports(options:{status?:ModerationReport['status'];before?:number;beforeId?:string;limit?:number}={}):ModerationReport[] {
    const input=z.object({status:z.enum(['open','dismissed','actioned']).optional(),before:z.number().int().positive().optional(),beforeId:z.uuid().optional(),limit:z.number().int().min(1).max(100).default(50)}).strict().refine(value=>!value.beforeId||value.before!==undefined,{message:'A report ID cursor requires its timestamp.'}).parse(options);
    const before=input.before??Number.MAX_SAFE_INTEGER;
    const rows=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM reports WHERE created > ? AND (created < ? OR (created = ? AND id < ?)) AND (? IS NULL OR json_extract(data, '$.status') = ?) ORDER BY created DESC, id DESC LIMIT ?",Date.now()-AUDIT_RETENTION_MS,before,before,input.beforeId??'',input.status??null,input.status??null,input.limit).toArray();
    return rows.map(row=>JSON.parse(row.data) as ModerationReport);
  }
  async resolveReport(id:string,resolution:'dismissed'|'actioned'):Promise<Outcome<ModerationReport>> {
    z.uuid().parse(id);z.enum(['dismissed','actioned']).parse(resolution);
    const outcome=this.ctx.storage.transactionSync(():Outcome<ModerationReport>=>{
      const row=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM reports WHERE id = ?',id).toArray()[0];
      if (!row) return fail(404,'Report not found.');
      const report=JSON.parse(row.data) as ModerationReport;
      if (report.status!=='open') return report.status===resolution?ok(report):fail(409,'The report already has a different resolution.');
      report.status=resolution;report.resolvedAt=Date.now();
      this.ctx.storage.sql.exec('UPDATE reports SET data = ? WHERE id = ?',JSON.stringify(report),id);
      this.audit('report-resolved',id,resolution);
      return ok(report);
    });
    await this.schedule();return outcome;
  }
  async setSuspended(userId:string,suspended:boolean,reason:z.infer<typeof moderationReason>):Promise<AccountStatus> {
    z.uuid().parse(userId);z.boolean().parse(suspended);moderationReason.parse(reason);
    this.ctx.storage.transactionSync(()=>{
      this.ctx.storage.sql.exec('INSERT INTO status (id,suspended,deleted) VALUES (?,?,0) ON CONFLICT(id) DO UPDATE SET suspended=excluded.suspended',userId,suspended?1:0);
      this.audit(suspended?'account-suspended':'account-restored',userId,reason);
    });
    await this.schedule();return this.status(userId);
  }
  auditList(limit=100):Array<{id:string;at:number;action:string;target:string;reason:string|null}> {
    z.number().int().min(1).max(500).parse(limit);
    return this.ctx.storage.sql.exec<{id:string;at:number;action:string;target:string;reason:string|null}>('SELECT id,at,action,target,reason FROM audit WHERE at > ? ORDER BY at DESC LIMIT ?',Date.now()-AUDIT_RETENTION_MS,limit).toArray();
  }
  async recordCommunityOperation(action:'community-correction-prepare'|'community-correction-submit'|'community-publication-retry',journeyId:string):Promise<void> {
    z.enum(['community-correction-prepare','community-correction-submit','community-publication-retry']).parse(action);
    z.string().regex(/^[a-f0-9]{64}$/).parse(journeyId);
    this.audit(action,journeyId);await this.schedule();
  }
  registerUser(id:string):boolean {return this.register('user',id);}
  registerTrip(id:string):boolean {return this.register('trip',id);}
  registerWallet(wallet:string,accountId:string):Outcome<{registered:true}> {
    walletSchema.parse(wallet);z.uuid().parse(accountId);
    return this.ctx.storage.transactionSync(()=>{
      const existing=this.walletOwner(wallet);
      if(existing&&existing!==accountId)return fail(409,'This wallet is reserved for a different account.');
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO wallets VALUES (?,?,?)',wallet,accountId,Date.now());
      return ok({registered:true as const});
    });
  }
  walletOwner(wallet:string):string|null {
    walletSchema.parse(wallet);
    return this.ctx.storage.sql.exec<{accountId:string}>('SELECT account_id AS accountId FROM wallets WHERE wallet = ?',wallet).toArray()[0]?.accountId??null;
  }
  walletIds(cursor?:string,limit=100):{ids:string[];nextCursor:string|null} {
    if(cursor)walletSchema.parse(cursor);z.number().int().min(1).max(1000).parse(limit);
    const rows=this.ctx.storage.sql.exec<{wallet:string}>('SELECT wallet FROM wallets WHERE wallet > ? ORDER BY wallet LIMIT ?',cursor??'',limit+1).toArray();
    const ids=rows.slice(0,limit).map(row=>row.wallet);
    return {ids,nextCursor:rows.length>limit?ids.at(-1)!:null};
  }
  private register(kind:'user'|'trip',id:string):boolean {
    z.uuid().parse(id);
    if (kind==='user'?this.status(id).deleted:this.isTripPurged(id)) return false;
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO resources VALUES (?,?,?)',kind,id,Date.now());return true;
  }
  resourceIds(kind:'user'|'trip',cursor?:string,limit=100):{ids:string[];nextCursor:string|null} {
    z.enum(['user','trip']).parse(kind);if(cursor)z.uuid().parse(cursor);z.number().int().min(1).max(1000).parse(limit);
    const rows=this.ctx.storage.sql.exec<{id:string}>('SELECT id FROM resources WHERE kind = ? AND id > ? ORDER BY id LIMIT ?',kind,cursor??'',limit+1).toArray();
    const ids=rows.slice(0,limit).map(row=>row.id);
    return {ids,nextCursor:rows.length>limit?ids.at(-1)!:null};
  }
  async beginDeletion(userId:string,tripIds:string[]):Promise<DeletionJournal> {
    const input=deletionSchema.parse({userId,tripIds:[...new Set(tripIds)],startedAt:Date.now(),completedAt:null});
    const record=this.ctx.storage.transactionSync(()=>{
      const prior=this.deletionStatus(userId);
      if(prior)return prior;
      this.ctx.storage.sql.exec('INSERT INTO deletions VALUES (?,?)',userId,JSON.stringify(input));
      this.ctx.storage.sql.exec('INSERT INTO status (id,suspended,deleted) VALUES (?,0,1) ON CONFLICT(id) DO UPDATE SET deleted=1',userId);
      this.audit('account-deletion-started',userId);return input;
    });
    await this.schedule();return record;
  }
  deletionStatus(userId:string):DeletionJournal|null {
    z.uuid().parse(userId);
    const row=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM deletions WHERE id = ?',userId).toArray()[0];
    return row?deletionSchema.parse(JSON.parse(row.data)):null;
  }
  pendingDeletions(limit=25):DeletionJournal[] {
    z.number().int().min(1).max(100).parse(limit);
    return this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM deletions WHERE json_extract(data, '$.completedAt') IS NULL ORDER BY json_extract(data, '$.startedAt'), id LIMIT ?",limit).toArray().map(row=>deletionSchema.parse(JSON.parse(row.data)));
  }
  async completeDeletion(userId:string):Promise<Outcome<DeletionJournal>> {
    z.uuid().parse(userId);
    const record=this.deletionStatus(userId);
    if(!record)return fail(404,'Deletion request not found.');
    if(record.completedAt!==null)return ok(record);
    record.completedAt=Date.now();
    record.tripIds=[];
    this.ctx.storage.transactionSync(()=>{
      this.ctx.storage.sql.exec('UPDATE deletions SET data = ? WHERE id = ?',JSON.stringify(record),userId);
      this.ctx.storage.sql.exec("DELETE FROM resources WHERE kind = 'user' AND id = ?",userId);
      this.ctx.storage.sql.exec('DELETE FROM reports WHERE reporter = ? OR json_extract(data, \'$.subjectId\') = ?',userId,userId);
      this.ctx.storage.sql.exec('DELETE FROM report_limits WHERE id = ?',userId);
      this.audit('account-deletion-completed',userId);
    });
    await this.schedule();return ok(record);
  }
  async recordDeletedTrip(tripId:string):Promise<void> {
    z.uuid().parse(tripId);
    this.ctx.storage.transactionSync(()=>{
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO purged_trips VALUES (?,?)',tripId,Date.now());
      this.ctx.storage.sql.exec("DELETE FROM resources WHERE kind = 'trip' AND id = ?",tripId);
      this.audit('trip-private-data-purged',tripId);
    });
    await this.schedule();
  }
  isTripPurged(tripId:string):boolean {
    z.uuid().parse(tripId);return this.ctx.storage.sql.exec('SELECT id FROM purged_trips WHERE id = ?',tripId).toArray().length>0;
  }
  exportState():GovernanceExport {
    return {
      schemaVersion:1,
      users:this.ctx.storage.sql.exec<{id:string;suspended:number;deleted:number}>('SELECT id,suspended,deleted FROM status ORDER BY id').toArray().map(row=>({id:row.id,suspended:Boolean(row.suspended),deleted:Boolean(row.deleted)})),
      resources:this.ctx.storage.sql.exec<{kind:'user'|'trip';id:string;createdAt:number}>('SELECT kind,id,created AS createdAt FROM resources ORDER BY kind,id').toArray(),
      deletions:this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM deletions ORDER BY id').toArray().map(row=>deletionSchema.parse(JSON.parse(row.data))),
      purgedTrips:this.ctx.storage.sql.exec<{id:string;at:number}>('SELECT id,at FROM purged_trips ORDER BY id').toArray(),
      wallets:this.ctx.storage.sql.exec<{wallet:string;accountId:string;createdAt:number}>('SELECT wallet,account_id AS accountId,created AS createdAt FROM wallets ORDER BY wallet').toArray(),
    };
  }
  private validatedState(value:unknown):GovernanceExport|null {
    const parsed=stateSchema.safeParse(value);if(!parsed.success)return null;
    const owners=new Map(this.ctx.storage.sql.exec<{wallet:string;accountId:string}>('SELECT wallet,account_id AS accountId FROM wallets').toArray().map(row=>[row.wallet,row.accountId]));
    const seen=new Set<string>();
    for(const row of parsed.data.wallets){if(seen.has(row.wallet))return null;seen.add(row.wallet);const existing=owners.get(row.wallet);if(existing&&existing!==row.accountId)return null;owners.set(row.wallet,row.accountId);}
    return parsed.data;
  }
  validateState(value:unknown):boolean {return this.validatedState(value)!==null;}
  async restoreState(value:unknown):Promise<Outcome<{merged:true}>> {
    const data=this.validatedState(value);if(!data)return fail(400,'Invalid governance snapshot or conflicting wallet ownership.');
    this.ctx.storage.transactionSync(()=>{
      // Merge protections before resources. Restoring an older backup can never undelete or unsuspend.
      for(const row of data.users)this.ctx.storage.sql.exec('INSERT INTO status VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET suspended=MAX(status.suspended,excluded.suspended),deleted=MAX(status.deleted,excluded.deleted)',row.id,row.suspended?1:0,row.deleted?1:0);
      for(const row of data.purgedTrips)this.ctx.storage.sql.exec('INSERT OR IGNORE INTO purged_trips VALUES (?,?)',row.id,row.at);
      for(const row of data.wallets)this.ctx.storage.sql.exec('INSERT OR IGNORE INTO wallets VALUES (?,?,?)',row.wallet,row.accountId,row.createdAt);
      for(const row of data.deletions){
        this.ctx.storage.sql.exec('INSERT OR IGNORE INTO deletions VALUES (?,?)',row.userId,JSON.stringify(row));
        this.ctx.storage.sql.exec('INSERT INTO status VALUES (?,0,1) ON CONFLICT(id) DO UPDATE SET deleted=1',row.userId);
      }
      for(const row of data.resources)if(row.kind==='user'?!this.status(row.id).deleted:!this.isTripPurged(row.id))this.ctx.storage.sql.exec('INSERT OR IGNORE INTO resources VALUES (?,?,?)',row.kind,row.id,row.createdAt);
      this.ctx.storage.sql.exec("DELETE FROM resources WHERE kind = 'user' AND id IN (SELECT id FROM status WHERE deleted=1)");
      this.ctx.storage.sql.exec("DELETE FROM resources WHERE kind = 'trip' AND id IN (SELECT id FROM purged_trips)");
      this.audit('governance-restored','governance-v1');
    });
    await this.schedule();return ok({merged:true});
  }
  async recordBackup(value:BackupManifest):Promise<Outcome<BackupManifest>> {
    const parsed=backupManifestSchema.safeParse(value);if(!parsed.success)return fail(400,'Invalid backup manifest.');
    const prior=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM backups WHERE id = ?',parsed.data.id).toArray()[0];
    if(prior)return JSON.stringify(JSON.parse(prior.data))===JSON.stringify(parsed.data)?ok(parsed.data):fail(409,'Backup identifier already exists.');
    this.ctx.storage.transactionSync(()=>{
      this.ctx.storage.sql.exec('INSERT INTO backups VALUES (?,?,?)',parsed.data.id,parsed.data.createdAt,JSON.stringify(parsed.data));
      this.audit('backup-created',parsed.data.id);
    });
    await this.schedule();return ok(parsed.data);
  }
  backupManifests():BackupManifest[] {
    return this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM backups ORDER BY created DESC LIMIT 100').toArray().map(row=>backupManifestSchema.parse(JSON.parse(row.data)));
  }
  async beginRestore(id:string,checksum:string):Promise<Outcome<{completed:boolean}>> {
    z.uuid().parse(id);z.string().regex(/^[0-9a-f]{64}$/).parse(checksum);
    const outcome=this.ctx.storage.transactionSync(():Outcome<{completed:boolean}>=>{
      const row=this.ctx.storage.sql.exec<{checksum:string;completed:number|null}>('SELECT checksum,completed FROM restores WHERE id = ?',id).toArray()[0];
      if(row)return row.checksum===checksum?ok({completed:row.completed!==null}):fail(409,'Restore identifier already belongs to another backup.');
      this.ctx.storage.sql.exec('INSERT INTO restores VALUES (?,?,?,NULL)',id,checksum,Date.now());
      this.audit('restore-started',id);return ok({completed:false});
    });
    await this.schedule();return outcome;
  }
  async completeRestore(id:string):Promise<Outcome<{completed:true}>> {
    z.uuid().parse(id);
    const row=this.ctx.storage.sql.exec<{completed:number|null}>('SELECT completed FROM restores WHERE id = ?',id).toArray()[0];
    if(!row)return fail(404,'Restore job not found.');
    if(row.completed===null)this.ctx.storage.transactionSync(()=>{
      this.ctx.storage.sql.exec('UPDATE restores SET completed = ? WHERE id = ?',Date.now(),id);this.audit('restore-completed',id);
    });
    await this.schedule();return ok({completed:true});
  }
  async alarm():Promise<void> {
    this.ctx.storage.transactionSync(()=>{
      this.ctx.storage.sql.exec('DELETE FROM reports WHERE created <= ?',Date.now()-AUDIT_RETENTION_MS);
      this.ctx.storage.sql.exec('DELETE FROM audit WHERE at <= ?',Date.now()-AUDIT_RETENTION_MS);
      this.ctx.storage.sql.exec('DELETE FROM report_limits WHERE start <= ?',Date.now()-DAY);
      this.ctx.storage.sql.exec('DELETE FROM backups WHERE created <= ?',Date.now()-AUDIT_RETENTION_MS);
    });
    // Deletion, purge and restore tombstones deliberately survive backup retention.
    await this.ctx.storage.setAlarm(Date.now()+DAY);
  }
}
