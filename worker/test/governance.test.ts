import { env, SELF, reset, evictDurableObject, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { GOVERNANCE_NAME, operatorAuthorized, AUDIT_RETENTION_MS, type BackupManifest } from '../src/governance';
import type { Trip, TripSummary, User } from '../src/types';
import worker from '../src/index';

beforeEach(async()=>{await reset();});
const governance=()=>env.GOVERNANCE.getByName(GOVERNANCE_NAME);
interface Session {token:string;user:User}
async function request(path:string,token?:string,body?:unknown) {
  return SELF.fetch('https://guard.test'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
}
async function session(name:string):Promise<Session> {
  const response=await request('/api/session',undefined,{name});
  expect(response.status).toBe(201);const value=await response.json<Session>();await env.USERS.getByName(value.user.id).acceptCommunityNotice('community-v1');return value;
}
async function fixture() {
  const rider=await session('Private rider'),guardian=await session('Private guardian'),outsider=await session('Private outsider');
  const response=await request('/api/trips',rider.token,{origin:{label:'Private pickup',lat:43,lng:-80},destination:{label:'Private destination',lat:44,lng:-81},checkInIntervalSeconds:60});
  expect(response.status).toBe(201);
  const trip=(await response.json<{trip:Trip}>()).trip;
  const applied=await request('/api/trips/'+trip.id+'/actions',guardian.token,{action:'accept',requestId:trip.id});
  const pending=(await applied.json<{trip:TripSummary}>()).trip;
  const approved=await request('/api/trips/'+trip.id+'/actions',rider.token,{action:'approve-guardian',requestId:pending.application!.id});
  expect(approved.status).toBe(200);return {rider,guardian,outsider,trip};
}

describe('Persistent governance and recovery protections',()=>{
  it('authenticates operator credentials with fixed-length digest comparison and fails closed',async()=>{
    const secret='a'.repeat(48);
    const req=(value:string)=>new Request('https://guard.test/api/admin/reports',{headers:{Authorization:value}});
    expect(await operatorAuthorized(req('Bearer '+secret),secret)).toBe(true);
    expect(await operatorAuthorized(req('Bearer '+'b'.repeat(48)),secret)).toBe(false);
    expect(await operatorAuthorized(req('Bearer '+secret),undefined)).toBe(false);
    expect(await operatorAuthorized(req('Bearer short'),'short')).toBe(false);
    expect(await operatorAuthorized(req('bearer '+secret),secret)).toBe(false);
    expect(await operatorAuthorized(req('Bearer '+'a'.repeat(5000)),secret)).toBe(false);
  });
  it('checks participant access, stores only categorical metadata, and survives eviction',async()=>{
    const {rider,guardian,outsider,trip}=await fixture();
    const input={tripId:trip.id,subjectId:guardian.user.id,category:'unsafe-conduct' as const,idempotencyKey:crypto.randomUUID()};
    expect(await governance().submitReport(outsider.user.id,input)).toMatchObject({ok:false,status:403});
    expect(await governance().submitReport(rider.user.id,{...input,subjectId:rider.user.id})).toMatchObject({ok:false,status:400});
    expect(await governance().submitReport(rider.user.id,{...input,subjectId:outsider.user.id})).toMatchObject({ok:false,status:400});
    const report=await governance().submitReport(rider.user.id,input);
    expect(report.ok).toBe(true);
    await evictDurableObject(governance());
    const records=await governance().listReports();
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain('Private');
    expect(JSON.stringify(await governance().auditList())).not.toContain('Private');
    const resolved=await governance().resolveReport(records[0].id,'actioned');
    expect(resolved).toMatchObject({ok:true,value:{status:'actioned'}});
    expect(await governance().resolveReport(records[0].id,'actioned')).toEqual(resolved);
    expect(await governance().resolveReport(records[0].id,'dismissed')).toMatchObject({ok:false,status:409});
  });
  it('makes reports idempotent, detects key reuse, and persists the daily rate limit',async()=>{
    const {rider,guardian,trip}=await fixture();
    const input={tripId:trip.id,subjectId:guardian.user.id,category:'spam' as const,idempotencyKey:crypto.randomUUID()};
    const first=await governance().submitReport(rider.user.id,input);
    expect(await governance().submitReport(rider.user.id,input)).toEqual(first);
    expect(await governance().submitReport(rider.user.id,{...input,category:'privacy'})).toMatchObject({ok:false,status:409});
    for(let i=0;i<4;i++)expect((await governance().submitReport(rider.user.id,{...input,idempotencyKey:crypto.randomUUID()})).ok).toBe(true);
    await evictDurableObject(governance());
    expect(await governance().submitReport(rider.user.id,{...input,idempotencyKey:crypto.randomUUID()})).toMatchObject({ok:false,status:429});
    expect(await governance().submitReport(rider.user.id,input)).toEqual(first);
  });
  it('retains suspension and deletion protections when older snapshots are restored',async()=>{
    const id=crypto.randomUUID(),tripId=crypto.randomUUID();
    await governance().registerUser(id);await governance().registerTrip(tripId);
    const old=await governance().exportState();
    expect(await governance().setSuspended(id,true,'abuse')).toEqual({suspended:true,deleted:false});
    const pending=await governance().beginDeletion(id,[tripId,tripId]);
    expect(pending.tripIds).toEqual([tripId]);
    expect(await governance().beginDeletion(id,[])).toEqual(pending);
    expect(await governance().pendingDeletions()).toEqual([pending]);
    await evictDurableObject(governance());
    expect(await governance().pendingDeletions(1)).toEqual([pending]);
    await governance().recordDeletedTrip(tripId);
    expect((await governance().completeDeletion(id)).ok).toBe(true);
    expect(await governance().pendingDeletions()).toEqual([]);
    await governance().restoreState(old);
    await evictDurableObject(governance());
    expect(await governance().status(id)).toEqual({suspended:true,deleted:true});
    expect(await governance().isTripPurged(tripId)).toBe(true);
    expect(await governance().registerUser(id)).toBe(false);
    expect(await governance().registerTrip(tripId)).toBe(false);
    expect((await governance().resourceIds('user')).ids).not.toContain(id);
    expect((await governance().resourceIds('trip')).ids).not.toContain(tripId);
    expect(await governance().setSuspended(id,false,'appeal')).toEqual({suspended:false,deleted:true});
  });
  it('paginates the complete registry without relying on the public lobby',async()=>{
    const ids=Array.from({length:7},()=>crypto.randomUUID()).sort();
    for(const id of ids)await governance().registerTrip(id);
    const first=await governance().resourceIds('trip',undefined,3);
    const second=await governance().resourceIds('trip',first.nextCursor!,3);
    const third=await governance().resourceIds('trip',second.nextCursor!,3);
    expect([...first.ids,...second.ids,...third.ids]).toEqual(ids);
    expect(third.nextCursor).toBeNull();
    expect((await governance().resourceIds('user')).ids).toEqual([]);
  });
  it('paginates reports sharing the same millisecond without skipping cases',async()=>{
    const {rider,guardian,trip}=await fixture();
    for(let index=0;index<3;index++)await governance().submitReport(rider.user.id,{tripId:trip.id,subjectId:guardian.user.id,category:'spam',idempotencyKey:crypto.randomUUID()});
    const at=Date.now();
    await runInDurableObject(governance(),async(_,state)=>{state.storage.sql.exec("UPDATE reports SET created = ?, data = json_set(data, '$.createdAt', ?)",at,at);});
    const all=await governance().listReports({status:'open'});
    const first=await governance().listReports({status:'open',limit:2});
    const second=await governance().listReports({status:'open',before:first[1].createdAt,beforeId:first[1].id,limit:2});
    expect([...first,...second].map(item=>item.id)).toEqual(all.map(item=>item.id));
    expect(new Set([...first,...second].map(item=>item.id)).size).toBe(3);
  });
  it('keeps historical wallet ownership after rotation/deletion and rejects conflicting recovery snapshots',async()=>{
    const accountId=crypto.randomUUID(),other=crypto.randomUUID();
    const wallets=['23f7UAfNbQCGdfQbJV3Tois98dETDfXnAXgjE5qTH5gb','6QoP3pGGBpCDdpCzK8DZhx5rZa99D4RZwkbNteSwY6kK'].sort();
    for(const wallet of wallets)expect(await governance().registerWallet(wallet,accountId)).toEqual({ok:true,value:{registered:true}});
    expect(await governance().registerWallet(wallets[0],accountId)).toMatchObject({ok:true});
    expect(await governance().registerWallet(wallets[0],other)).toMatchObject({ok:false,status:409});
    const first=await governance().walletIds(undefined,1),second=await governance().walletIds(first.nextCursor!,1);
    expect([...first.ids,...second.ids]).toEqual(wallets);expect(second.nextCursor).toBeNull();
    await governance().beginDeletion(accountId,[]);await governance().completeDeletion(accountId);
    const archive=await governance().exportState();expect(archive.wallets).toHaveLength(2);
    await reset();
    expect(await governance().restoreState(archive)).toMatchObject({ok:true});
    expect(await governance().walletOwner(wallets[0])).toBe(accountId);expect((await governance().status(accountId)).deleted).toBe(true);
    expect(await governance().registerWallet(wallets[0],other)).toMatchObject({ok:false,status:409});
    expect(await governance().validateState({...archive,wallets:[archive.wallets[0],archive.wallets[0]]})).toBe(false);
    expect(await governance().restoreState({...archive,wallets:[{...archive.wallets[0],accountId:other}]})).toMatchObject({ok:false,status:400});
    const legacy={...archive};delete (legacy as Partial<typeof legacy>).wallets;
    expect(await governance().validateState(legacy)).toBe(true);expect(await governance().restoreState(legacy)).toMatchObject({ok:true});
    expect(await governance().walletOwner(wallets[1])).toBe(accountId);
  });
  it('prunes 90-day moderation records but never removes erasure tombstones',async()=>{
    const {rider,guardian,trip}=await fixture();
    await governance().submitReport(rider.user.id,{tripId:trip.id,subjectId:guardian.user.id,category:'privacy',idempotencyKey:crypto.randomUUID()});
    await governance().recordDeletedTrip(trip.id);
    await runInDurableObject(governance(),async(_instance,state)=>{
      state.storage.sql.exec('UPDATE reports SET created = ?',Date.now()-AUDIT_RETENTION_MS-1000);
      state.storage.sql.exec('UPDATE audit SET at = ?',Date.now()-AUDIT_RETENTION_MS-1000);
    });
    await runDurableObjectAlarm(governance());
    expect(await governance().listReports()).toEqual([]);
    expect(await governance().auditList()).toEqual([]);
    expect(await governance().isTripPurged(trip.id)).toBe(true);
  });
  it('validates recovery metadata and rejects replay with a different checksum',async()=>{
    const id=crypto.randomUUID(),sha='a'.repeat(64);
    expect(await governance().beginRestore(id,sha)).toEqual({ok:true,value:{completed:false}});
    expect(await governance().beginRestore(id,'b'.repeat(64))).toMatchObject({ok:false,status:409});
    expect(await governance().completeRestore(id)).toEqual({ok:true,value:{completed:true}});
    await evictDurableObject(governance());
    expect(await governance().beginRestore(id,sha)).toEqual({ok:true,value:{completed:true}});
    expect(await governance().restoreState({schemaVersion:99})).toMatchObject({ok:false,status:400});
    expect(await governance().validateState(await governance().exportState())).toBe(true);
  });
  it('stores public backup manifests without secret content and rejects ID collisions',async()=>{
    const manifest:BackupManifest={id:crypto.randomUUID(),schemaVersion:1,createdAt:Date.now(),environment:'staging',sha256:'a'.repeat(64),resources:{users:2,trips:1,auth:2,chain:1}};
    expect(await governance().recordBackup(manifest)).toEqual({ok:true,value:manifest});
    expect(await governance().recordBackup(manifest)).toEqual({ok:true,value:manifest});
    expect(await governance().recordBackup({...manifest,sha256:'b'.repeat(64)})).toMatchObject({ok:false,status:409});
    expect(await governance().backupManifests()).toEqual([manifest]);
  });
});

interface BackupWire {
  schemaVersion:1;environment:'development';createdAt:number;
  resources:{users:Array<{id:string;snapshot:Record<string,unknown>}>;trips:Array<{id:string;snapshot:unknown}>;auth:Array<{id:string;snapshot:unknown}>;chain:Array<{id:string;snapshot:unknown}>;governance:unknown};
}
const operatorSecret='operator-test-secret-with-more-than-thirty-two-characters';
async function operator(path:string,body?:unknown,options:{secret?:string;environment?:'development'|'production';restore?:string}={}) {
  return worker.fetch(new Request('https://guard.test/api/admin/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+(options.secret??operatorSecret)},body:body===undefined?undefined:JSON.stringify(body)}),{...env,OPERATOR_SECRET:operatorSecret,APP_ENV:options.environment??'development',RESTORE_ALLOWED:options.restore??'true',AUTH_DOMAIN:'guard.test',SITE_ORIGIN:'https://guard.test',ALLOWED_ORIGINS:'https://guard.test',SOLANA_NETWORK:'devnet',SOLANA_V2_PROGRAM_ID:'23f7UAfNbQCGdfQbJV3Tois98dETDfXnAXgjE5qTH5gb'});
}

describe('Operator export and isolated recovery API',()=>{
  it('requires the operator credential and forbids production or disabled restores',async()=>{
    const {rider}=await fixture();
    expect((await operator('reports',undefined,{secret:rider.token})).status).toBe(401);
    expect((await operator('backups/restore',{}, {environment:'production',restore:'false'})).status).toBe(403);
    expect((await operator('backups/restore',{}, {restore:'false'})).status).toBe(403);
    expect((await operator('reports')).status).toBe(200);
  });
  it('exports credential-free state and validates every resource before writing, then resumes idempotently',async()=>{
    const {rider,guardian,trip}=await fixture();
    const exported=await operator('backups/export',{});expect(exported.status).toBe(200);
    const archive=await exported.json<BackupWire>();
    expect(archive.resources.users).toHaveLength(3);expect(archive.resources.trips).toHaveLength(1);
    expect(JSON.stringify(archive)).not.toContain(rider.token);expect(JSON.stringify(archive)).not.toContain(guardian.token);
    expect((await governance().backupManifests())[0].resources).toEqual({users:3,trips:1,auth:0,chain:0});
    await reset();
    const malformed=structuredClone(archive);malformed.resources.users.at(-1)!.snapshot.unexpected='not allowed';
    expect((await operator('backups/restore',{snapshot:malformed,idempotencyKey:crypto.randomUUID()})).status).toBe(400);
    expect(await env.USERS.getByName(rider.user.id).getPublic()).toBeNull();
    expect(await env.TRIPS.getByName(trip.id).exportSnapshot()).toBeNull();
    const idempotencyKey=crypto.randomUUID();
    const restored=await operator('backups/restore',{snapshot:archive,idempotencyKey});expect(restored.status).toBe(200);expect(await restored.json()).toEqual({completed:true});
    expect((await env.USERS.getByName(rider.user.id).getPublic())?.name).toBe(rider.user.name);
    expect((await env.TRIPS.getByName(trip.id).chainContext())?.status).toBe('cancelled');
    expect((await request('/api/me',rider.token)).status).toBe(401);
    expect((await operator('backups/restore',{snapshot:archive,idempotencyKey})).status).toBe(200);
    expect((await operator('backups/restore',{snapshot:{...archive,createdAt:archive.createdAt+1},idempotencyKey})).status).toBe(409);
  });
  it('merges a newer erasure journal before old private data can be restored into an empty destination',async()=>{
    const {rider,trip}=await fixture();
    const archive=await (await operator('backups/export',{})).json<BackupWire>();
    expect((await request('/api/account/delete',rider.token,{confirmation:'DELETE MY ACCOUNT'})).status).toBe(200);
    archive.resources.governance=await governance().exportState();
    await reset();
    expect((await operator('backups/restore',{snapshot:archive,idempotencyKey:crypto.randomUUID()})).status).toBe(200);
    expect((await governance().status(rider.user.id)).deleted).toBe(true);
    expect(await env.USERS.getByName(rider.user.id).getPublic()).toBeNull();
    expect(await env.TRIPS.getByName(trip.id).exportSnapshot()).toBeNull();
    expect(await governance().isTripPurged(trip.id)).toBe(true);
  });
  it('exports and restores historical wallet reservations belonging to an erased account',async()=>{
    const {guardian}=await fixture();
    const wallets=['23f7UAfNbQCGdfQbJV3Tois98dETDfXnAXgjE5qTH5gb','6QoP3pGGBpCDdpCzK8DZhx5rZa99D4RZwkbNteSwY6kK'];
    for(const wallet of wallets){
      expect(await env.AUTH.getByName(`wallet:${wallet}`).reserve(guardian.user.id,crypto.randomUUID())).toBe(true);
      await env.AUTH.getByName(`wallet:${wallet}`).commit(guardian.user.id);
      expect(await governance().registerWallet(wallet,guardian.user.id)).toMatchObject({ok:true});
    }
    expect((await request('/api/account/delete',guardian.token,{confirmation:'DELETE MY ACCOUNT'})).status).toBe(200);
    const archive=await (await operator('backups/export',{})).json<BackupWire>();
    expect(archive.resources.users.some(item=>item.id===guardian.user.id)).toBe(false);
    expect(archive.resources.auth).toHaveLength(2);
    await reset();
    expect((await operator('backups/restore',{snapshot:archive,idempotencyKey:crypto.randomUUID()})).status).toBe(200);
    expect(await env.USERS.getByName(guardian.user.id).getPublic()).toBeNull();
    for(const wallet of wallets){
      expect(await env.AUTH.getByName(`wallet:${wallet}`).owner()).toBe(guardian.user.id);
      expect(await env.AUTH.getByName(`wallet:${wallet}`).reserve(crypto.randomUUID(),crypto.randomUUID())).toBe(false);
    }
  });
});
