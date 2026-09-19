import { env, SELF, reset, evictDurableObject, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { tripSnapshotSchema } from '../src/snapshots';
import type { Trip, TripSummary, User, WorkerEnv } from '../src/types';

interface Session { token:string; user:User }
interface Member {
  id:string; name:string; bio:string; points:number; reputation:number; completedGuards:number;
  contributions:{points:number;reputation:number}[];
  gratitude:{total:number;companionship:number;thoughtfulness:number;relay:number};
}
type BannerKind='companionship'|'thoughtfulness'|'relay';
interface Gratitude {
  eligibleGuardians:{id:string;name:string}[];
  banners:{guardianId:string;kind:BannerKind;createdAt:number;status:'pending'|'recorded'}[];
}
const input={
  origin:{label:'Private pickup marker',lat:43.472,lng:-80.54},
  destination:{label:'Private destination marker',lat:43.464,lng:-80.52},
  shareUrl:'https://trip.uber.com/private-share-marker',
  emergencyContact:{name:'Private contact marker',contact:'test-only-contact-marker'},
  notificationConsent:true,checkInIntervalSeconds:60,
};

beforeEach(async()=>{await reset();});

async function request(path:string,user?:Session,body?:unknown) {
  return SELF.fetch(`https://guard.test${path}`,{
    method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(user?{Authorization:`Bearer ${user.token}`}:{})},
    body:body===undefined?undefined:JSON.stringify(body),
  });
}
async function session(name:string):Promise<Session> {
  const response=await request('/api/session',undefined,{name});
  expect(response.status).toBe(201);const value=await response.json<Session>();await env.USERS.getByName(value.user.id).acceptCommunityNotice('community-v1');return value;
}
async function create(rider:Session,demo=false):Promise<Trip> {
  const response=await request(demo?'/api/demo/start':'/api/trips',rider,demo?{}:input);
  expect(response.status).toBe(201);return (await response.json<{trip:Trip}>()).trip;
}
const action=(trip:Trip,user:Session,action:string,extra:Record<string,unknown>={})=>request(`/api/trips/${trip.id}/actions`,user,{action,...extra});
async function apply(trip:Trip,guardian:Session,requestId=trip.id):Promise<TripSummary> {
  const response=await action(trip,guardian,'accept',{requestId});expect(response.status).toBe(200);
  return (await response.json<{trip:TripSummary}>()).trip;
}
async function approve(trip:Trip,rider:Session,guardian:Session,requestId=trip.id):Promise<Trip> {
  const application=await apply(trip,guardian,requestId);
  const response=await action(trip,rider,'approve-guardian',{requestId:application.application!.id});
  expect(response.status).toBe(200);return (await response.json<{trip:Trip}>()).trip;
}
async function fixture(checkIn=true) {
  const rider=await session('Rider'),guardian=await session('Guardian'),trip=await create(rider);
  await approve(trip,rider,guardian);
  if(checkIn)expect((await action(trip,guardian,'check-in')).status).toBe(200);
  return {rider,guardian,trip};
}
async function member(target:Session,viewer:Session):Promise<Member> {
  const response=await request(`/api/members/${target.user.id}`,viewer);expect(response.status).toBe(200);
  return (await response.json<{member:Member}>()).member;
}
async function gratitude(trip:Trip,rider:Session):Promise<Gratitude> {
  const response=await request(`/api/trips/${trip.id}/gratitude`,rider);expect(response.status).toBe(200);
  return (await response.json<{gratitude:Gratitude}>()).gratitude;
}
const give=(trip:Trip,rider:Session,guardian:Session,kind:BannerKind='companionship')=>request(`/api/trips/${trip.id}/gratitude`,rider,{guardianId:guardian.user.id,kind});
async function makeGratitudeRetryDue(trip:Trip) {
  await runInDurableObject(env.TRIPS.getByName(trip.id),async(_instance,state)=>{
    const stored=JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM trip_state').one().data);
    for(const entry of stored.gratitude??[])if(entry.status==='pending'){entry.nextAttemptAt=Date.now()-1;entry.inFlightUntil=0;}
    state.storage.sql.exec('UPDATE trip_state SET data=?',JSON.stringify(stored));
    await state.storage.setAlarm(Date.now()+60000);
  });
}
async function failNextGratitudeWrite(trip:Trip,afterCommit=false) {
  await runInDurableObject(env.TRIPS.getByName(trip.id),async instance=>{
    const runtime=instance as unknown as {env:WorkerEnv},bindings=runtime.env,accounts=bindings.USERS;
    let failed=false;
    // Inject at the caller boundary: throwing from a test RPC receiver itself is a
    // workerd test-harness uncaught exception rather than a transport rejection.
    runtime.env={...bindings,USERS:{getByName:(name:string)=>{
      const account=accounts.getByName(name);
      return {
        communityProfile:()=>account.communityProfile(),
        credit:(...args:Parameters<typeof account.credit>)=>account.credit(...args),
        recordGratitude:async(...args:Parameters<typeof account.recordGratitude>)=>{
          if(!failed){
            failed=true;
            if(afterCommit)await account.recordGratitude(...args);
            throw new Error(afterCommit?'Synthetic reply lost after commit':'Synthetic account write unavailable');
          }
          return account.recordGratitude(...args);
        },
      } as unknown as ReturnType<typeof accounts.getByName>;
    }} as WorkerEnv['USERS']};
  });
}

describe('Public community profiles',()=>{
  it('makes every active member profile visible to another member without wallet or visibility setup',async()=>{
    const person=await session('New volunteer'),viewer=await session('Another member');
    expect((await request(`/api/members/${person.user.id}`)).status).toBe(401);
    expect(await member(person,viewer)).toEqual({
      id:person.user.id,name:'New volunteer',bio:'',points:0,reputation:0,completedGuards:0,contributions:[],
      gratitude:{total:0,companionship:0,thoughtfulness:0,relay:0},
    });
  });

  it('updates only the authenticated member bio and rejects score, identity, or visibility edits',async()=>{
    const person=await session('Volunteer'),viewer=await session('Viewer');
    expect((await request('/api/me/profile',undefined,{bio:'Public introduction'})).status).toBe(401);
    const updated=await request('/api/me/profile',person,{bio:'Available to accompany a journey.'});
    expect(updated.status).toBe(200);
    expect((await updated.json<{member:Member}>()).member.bio).toBe('Available to accompany a journey.');
    expect((await member(person,viewer)).bio).toBe('Available to accompany a journey.');
    expect((await member(viewer,person)).bio).toBe('');
    for(const body of [{bio:'a'.repeat(281)},{bio:'x',private:true},{bio:'x',points:1000},{bio:'x',userId:viewer.user.id},{bio:42}]) {
      expect((await request('/api/me/profile',person,body)).status).toBe(400);
    }
    expect((await request('/api/me/profile',person,{bio:''})).status).toBe(200);
    expect((await member(person,viewer)).bio).toBe('');
  });

  it('exposes bounded contribution amounts without wallet, credentials, private journey IDs, or arbitrary account fields',async()=>{
    const person=await session('Volunteer'),viewer=await session('Viewer'),account=env.USERS.getByName(person.user.id);
    const journeyIds=Array.from({length:23},()=>crypto.randomUUID());
    for(const id of journeyIds)await account.credit(id,25,10);
    await runInDurableObject(account,async(_instance,state)=>{
      const stored=JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM account').one().data);
      stored.privateMarker='private-account-marker';
      state.storage.sql.exec('UPDATE account SET data=?',JSON.stringify(stored));
      state.storage.sql.exec('UPDATE identity SET wallet=?,recovery_digest=?','11111111111111111111111111111111','private-recovery-marker');
    });
    const value=await member(person,viewer),serialized=JSON.stringify(value);
    expect(Object.keys(value).sort()).toEqual(['bio','completedGuards','contributions','gratitude','id','name','points','reputation'].sort());
    expect(value).toMatchObject({points:575,reputation:230,completedGuards:23});
    expect(value.contributions).toHaveLength(20);
    for(const entry of value.contributions)expect(entry).toEqual({points:25,reputation:10});
    for(const forbidden of [...journeyIds,person.token,'11111111111111111111111111111111','private-recovery-marker','private-account-marker','authVersion','recoveryConfigured']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('does not return missing, deactivated, or deleted member profiles',async()=>{
    const viewer=await session('Viewer'),inactive=await session('Inactive'),deleted=await session('Deleted');
    expect((await request(`/api/members/${crypto.randomUUID()}`,viewer)).status).toBe(404);
    await env.USERS.getByName(inactive.user.id).deactivate();
    expect((await request(`/api/members/${inactive.user.id}`,viewer)).status).toBe(404);
    expect((await request('/api/account/delete',deleted,{confirmation:'DELETE MY ACCOUNT'})).status).toBe(200);
    expect((await request(`/api/members/${deleted.user.id}`,viewer)).status).toBe(404);
  });

  it('lets both sides inspect a profile before approval while the request remains redacted',async()=>{
    const rider=await session('Rider'),candidate=await session('Candidate'),trip=await create(rider);
    const lobbyResponse=await request('/api/trips',candidate);
    const lobby=await lobbyResponse.json<{trips:(TripSummary&{riderProfile?:{id:string;name:string}|null})[]}>();
    const listing=lobby.trips.find(item=>item.id===trip.id)!;
    expect(listing.riderProfile).toEqual({id:rider.user.id,name:rider.user.name});
    expect(JSON.stringify(listing)).not.toContain('Private');
    expect(JSON.stringify(listing)).not.toContain('private-share-marker');
    expect(await member(rider,candidate)).toMatchObject({id:rider.user.id});
    const pending=await apply(trip,candidate);
    expect(pending).not.toHaveProperty('messages');
    expect(pending).not.toHaveProperty('origin');
    const riderView=await (await request(`/api/trips/${trip.id}`,rider)).json<{trip:Trip}>();
    expect(riderView.trip.guardianRequests[0].candidate.id).toBe(candidate.user.id);
    expect(await member(candidate,rider)).toMatchObject({id:candidate.user.id});
    const response=await action(trip,rider,'approve-guardian',{requestId:pending.application!.id});
    expect(response.status).toBe(200);
  });
});

describe('Free gratitude after a journey',()=>{
  it('requires authentication and only lets the rider view or send journey gratitude',async()=>{
    const {rider,guardian,trip}=await fixture(),stranger=await session('Stranger');
    expect((await action(trip,rider,'arrive')).status).toBe(200);
    expect((await request(`/api/trips/${trip.id}/gratitude`)).status).toBe(401);
    expect((await request(`/api/trips/${trip.id}/gratitude`,undefined,{guardianId:guardian.user.id,kind:'companionship'})).status).toBe(401);
    for(const actor of [guardian,stranger]) {
      expect((await request(`/api/trips/${trip.id}/gratitude`,actor)).status).toBe(403);
      expect((await give(trip,actor,guardian)).status).toBe(403);
    }
  });

  it('cannot promise a banner on an open or active request or award a simulated demo guardian',async()=>{
    const rider=await session('Rider'),guardian=await session('Guardian'),trip=await create(rider);
    expect((await request(`/api/trips/${trip.id}/gratitude`,rider)).status).toBe(409);
    expect((await give(trip,rider,guardian)).status).toBe(409);
    await approve(trip,rider,guardian);
    expect((await action(trip,guardian,'check-in')).status).toBe(200);
    expect((await give(trip,rider,guardian)).status).toBe(409);
    const demo=await create(rider,true);
    expect((await action(demo,rider,'arrive')).status).toBe(200);
    expect((await request(`/api/trips/${demo.id}/gratitude`,rider)).status).toBe(409);
    expect((await give(demo,rider,guardian)).status).toBe(409);
  });

  it('excludes an approved guardian without a check-in, a pending applicant, the rider, and strangers',async()=>{
    const rider=await session('Rider'),guardian=await session('Guardian'),candidate=await session('Applicant'),stranger=await session('Stranger'),trip=await create(rider);
    const selected=await apply(trip,guardian);await apply(trip,candidate);
    expect((await action(trip,rider,'approve-guardian',{requestId:selected.application!.id})).status).toBe(200);
    expect((await action(trip,rider,'arrive')).status).toBe(200);
    expect((await gratitude(trip,rider)).eligibleGuardians).toEqual([]);
    for(const target of [guardian,candidate,rider,stranger])expect((await give(trip,rider,target)).status).toBe(409);
  });

  it('records a free banner without changing contribution points or requiring wallet setup',async()=>{
    const {rider,guardian,trip}=await fixture();
    expect((await action(trip,rider,'arrive')).status).toBe(200);
    const before=await member(guardian,rider);
    expect(before).toMatchObject({points:25,reputation:10,completedGuards:1});
    const available=await gratitude(trip,rider);
    expect(available.eligibleGuardians).toEqual([{id:guardian.user.id,name:guardian.user.name}]);
    expect(available.banners).toEqual([]);
    const response=await give(trip,rider,guardian,'thoughtfulness');expect(response.status).toBe(200);
    const receipt=(await response.json<{gratitude:Gratitude}>()).gratitude;
    expect(receipt.banners).toHaveLength(1);
    expect(receipt.banners[0]).toMatchObject({guardianId:guardian.user.id,kind:'thoughtfulness',status:'recorded'});
    expect(receipt.banners[0].createdAt).toBeGreaterThan(0);
    const after=await member(guardian,rider);
    expect(after).toEqual({...before,gratitude:{total:1,companionship:0,thoughtfulness:1,relay:0}});
    expect(JSON.stringify(after)).not.toContain(trip.id);
    expect(JSON.stringify(after)).not.toContain(rider.user.id);
    expect(JSON.stringify(after)).not.toContain('Private');
  });

  it('allows gratitude for real help on a cancelled journey without asserting arrival or awarding points',async()=>{
    const {rider,guardian,trip}=await fixture();
    expect((await action(trip,rider,'cancel')).status).toBe(200);
    expect((await give(trip,rider,guardian)).status).toBe(200);
    expect(await member(guardian,rider)).toMatchObject({points:0,reputation:0,completedGuards:0,gratitude:{total:1,companionship:1}});
    const current=await (await request(`/api/trips/${trip.id}`,rider)).json<{trip:Trip}>();
    expect(current.trip.status).toBe('cancelled');
  });

  it('can thank a former guardian and a replacement without restoring former private access',async()=>{
    const {rider,guardian,trip}=await fixture(),replacement=await session('Replacement');
    const response=await action(trip,guardian,'request-relay');expect(response.status).toBe(200);
    const relay=(await response.json<{trip:Trip}>()).trip;
    await approve(trip,rider,replacement,relay.relay!.id);
    expect((await action(trip,replacement,'check-in')).status).toBe(200);
    expect((await request(`/api/trips/${trip.id}`,guardian)).status).toBe(403);
    expect((await action(trip,rider,'arrive')).status).toBe(200);
    expect((await gratitude(trip,rider)).eligibleGuardians.map(item=>item.id).sort()).toEqual([guardian.user.id,replacement.user.id].sort());
    expect((await give(trip,rider,guardian,'companionship')).status).toBe(200);
    expect((await give(trip,rider,replacement,'relay')).status).toBe(200);
    expect((await member(guardian,rider)).gratitude).toMatchObject({total:1,companionship:1});
    expect((await member(replacement,rider)).gratitude).toMatchObject({total:1,relay:1});
    expect((await request(`/api/trips/${trip.id}`,guardian)).status).toBe(403);
  });

  it('is idempotent across concurrent retries and rejects changing a recorded banner kind',async()=>{
    const {rider,guardian,trip}=await fixture();expect((await action(trip,rider,'arrive')).status).toBe(200);
    const results=await Promise.all(Array.from({length:4},()=>give(trip,rider,guardian)));
    expect(results.map(response=>response.status)).toEqual([200,200,200,200]);
    expect((await gratitude(trip,rider)).banners).toHaveLength(1);
    expect((await member(guardian,rider)).gratitude.total).toBe(1);
    expect((await give(trip,rider,guardian,'thoughtfulness')).status).toBe(409);
    expect((await member(guardian,rider)).gratitude).toEqual({total:1,companionship:1,thoughtfulness:0,relay:0});
  });

  it('validates fixed categories and refuses freeform text, money, and forged receipt fields',async()=>{
    const {rider,guardian,trip}=await fixture();expect((await action(trip,rider,'arrive')).status).toBe(200);
    const valid={guardianId:guardian.user.id,kind:'companionship'};
    for(const body of [{...valid,kind:'cash'},{...valid,text:'Private message'},{...valid,amount:100},{...valid,status:'recorded'},{...valid,guardianId:'not-an-id'}]) {
      expect((await request(`/api/trips/${trip.id}/gratitude`,rider,body)).status).toBe(400);
    }
    expect((await member(guardian,rider)).gratitude.total).toBe(0);
  });

  it('keeps closing and earning a contribution independent of sending any gratitude',async()=>{
    const {rider,guardian,trip}=await fixture();expect((await action(trip,rider,'arrive')).status).toBe(200);
    expect((await gratitude(trip,rider)).banners).toEqual([]);
    expect(await member(guardian,rider)).toMatchObject({points:25,reputation:10,completedGuards:1,gratitude:{total:0}});
    const next=await create(rider);expect(next.status).toBe('open');
  });
});

describe('Durable community data and deletion',()=>{
  it('preserves public bio and exactly one banner through Durable Object eviction and retry',async()=>{
    const {rider,guardian,trip}=await fixture();
    expect((await request('/api/me/profile',guardian,{bio:'Volunteer profile survives restart.'})).status).toBe(200);
    expect((await action(trip,rider,'arrive')).status).toBe(200);
    expect((await give(trip,rider,guardian)).status).toBe(200);
    await evictDurableObject(env.USERS.getByName(guardian.user.id));
    await evictDurableObject(env.TRIPS.getByName(trip.id));
    expect((await give(trip,rider,guardian)).status).toBe(200);
    expect((await gratitude(trip,rider)).banners).toHaveLength(1);
    expect(await member(guardian,rider)).toMatchObject({bio:'Volunteer profile survives restart.',points:25,gratitude:{total:1}});
  });

  it('validates account and journey backups containing the new community data',async()=>{
    const {rider,guardian,trip}=await fixture();
    expect((await request('/api/me/profile',guardian,{bio:'Backed up community introduction.'})).status).toBe(200);
    expect((await action(trip,rider,'arrive')).status).toBe(200);
    expect((await give(trip,rider,guardian,'relay')).status).toBe(200);
    const account=env.USERS.getByName(guardian.user.id),room=env.TRIPS.getByName(trip.id);
    const accountBackup=(await account.exportSnapshot())!,tripBackup=(await room.exportSnapshot())!;
    expect(await account.validateSnapshot(accountBackup,guardian.user.id)).toBe(true);
    const parsed=tripSnapshotSchema.safeParse(tripBackup);
    expect(parsed.success,parsed.success?'':JSON.stringify(parsed.error.issues)).toBe(true);
    expect(await room.validateSnapshot(tripBackup,trip.id)).toBe(true);
    const restored=env.USERS.getByName(`community-restore:${guardian.user.id}`);
    expect(await restored.restoreSnapshot(accountBackup)).toBe(true);
    expect(await restored.exportSnapshot()).toMatchObject({user:accountBackup.user});
    expect(await restored.communityProfile()).toMatchObject({bio:'Backed up community introduction.',points:25,gratitude:{total:1,relay:1}});
  });

  it('retains backwards compatibility with pre-community account and journey snapshots',async()=>{
    const {rider,guardian,trip}=await fixture();expect((await action(trip,rider,'arrive')).status).toBe(200);
    const account=env.USERS.getByName(guardian.user.id),room=env.TRIPS.getByName(trip.id),current=(await account.exportSnapshot())!;
    const {id,name,points,reputation,completedGuards}=current.user;
    const legacyAccount={version:current.version,user:{id,name,points,reputation,completedGuards},wallet:current.wallet,authVersion:current.authVersion,trips:current.trips,credits:current.credits};
    expect(await account.validateSnapshot(legacyAccount,guardian.user.id)).toBe(true);
    const restored=env.USERS.getByName(`legacy-community:${guardian.user.id}`);
    expect(await restored.restoreSnapshot(legacyAccount)).toBe(true);
    expect(await restored.communityProfile()).toMatchObject({points:25,bio:'',gratitude:{total:0}});
    const legacyTrip=JSON.parse(JSON.stringify(await room.exportSnapshot())) as Record<string,unknown>;
    delete legacyTrip.gratitude;
    delete (legacyTrip.trip as Record<string,unknown>).gratitude;
    expect(tripSnapshotSchema.safeParse(legacyTrip).success).toBe(true);
    expect(await room.validateSnapshot(legacyTrip,trip.id)).toBe(true);
  });

  it('retries a failed account write from an alarm after eviction without browser interaction',async()=>{
    const {rider,guardian,trip}=await fixture();expect((await action(trip,rider,'arrive')).status).toBe(200);
    await failNextGratitudeWrite(trip);
    expect((await give(trip,rider,guardian)).status).toBe(200);
    expect((await gratitude(trip,rider)).banners[0].status).toBe('pending');
    expect((await member(guardian,rider)).gratitude.total).toBe(0);
    await makeGratitudeRetryDue(trip);
    const room=env.TRIPS.getByName(trip.id);await evictDurableObject(room);
    expect(await runDurableObjectAlarm(room)).toBe(true);
    expect((await gratitude(trip,rider)).banners[0].status).toBe('recorded');
    expect((await member(guardian,rider)).gratitude.total).toBe(1);
  });

  it('does not double count a banner when the account persisted it but its acknowledgement was lost',async()=>{
    const {rider,guardian,trip}=await fixture();expect((await action(trip,rider,'arrive')).status).toBe(200);
    await failNextGratitudeWrite(trip,true);
    expect((await give(trip,rider,guardian)).status).toBe(200);
    expect((await gratitude(trip,rider)).banners[0].status).toBe('pending');
    expect((await member(guardian,rider)).gratitude.total).toBe(1);
    await makeGratitudeRetryDue(trip);
    expect(await runDurableObjectAlarm(env.TRIPS.getByName(trip.id))).toBe(true);
    expect((await gratitude(trip,rider)).banners[0].status).toBe('recorded');
    expect((await member(guardian,rider)).gratitude.total).toBe(1);
    expect((await give(trip,rider,guardian)).status).toBe(200);
    expect((await member(guardian,rider)).gratitude.total).toBe(1);
  });

  it('preserves a pending official banner on restore and retries its stable receipt without double counting',async()=>{
    const {rider,guardian,trip}=await fixture();expect((await action(trip,rider,'arrive')).status).toBe(200);
    await failNextGratitudeWrite(trip);
    expect((await give(trip,rider,guardian)).status).toBe(200);
    const backup=(await env.TRIPS.getByName(trip.id).exportSnapshot())!;
    expect(backup.gratitude?.[0].status).toBe('pending');
    const restoredId=crypto.randomUUID(),restored=env.TRIPS.getByName(restoredId);
    expect(await restored.restoreSnapshot({...backup,trip:{...backup.trip,id:restoredId}})).toBe(true);
    expect((await restored.exportSnapshot())!.gratitude?.[0].status).toBe('pending');
    expect(await restored.readGratitude(rider.user.id)).toMatchObject({ok:true,value:{banners:[{status:'pending'}]}});
    await makeGratitudeRetryDue({...trip,id:restoredId});
    expect(await runDurableObjectAlarm(restored)).toBe(true);
    expect((await member(guardian,rider)).gratitude.total).toBe(1);
    expect(await restored.sendGratitude(rider.user.id,guardian.user.id,'companionship')).toMatchObject({ok:true,value:{banners:[{status:'recorded'}]}});
    expect((await member(guardian,rider)).gratitude.total).toBe(1);
  });

  it('rejects malformed gratitude backups including duplicate account receipts and repeated journey recipients',async()=>{
    const {rider,guardian,trip}=await fixture();expect((await action(trip,rider,'arrive')).status).toBe(200);
    expect((await give(trip,rider,guardian)).status).toBe(200);
    const account=env.USERS.getByName(guardian.user.id),room=env.TRIPS.getByName(trip.id);
    const accountBackup=(await account.exportSnapshot())!,tripBackup=(await room.exportSnapshot())!;
    expect(await account.validateSnapshot({...accountBackup,gratitude:[...accountBackup.gratitude!,...accountBackup.gratitude!]},guardian.user.id)).toBe(false);
    expect(await account.validateSnapshot({...accountBackup,gratitude:[{...accountBackup.gratitude![0],senderId:rider.user.id}]},guardian.user.id)).toBe(false);
    expect(await room.validateSnapshot({...tripBackup,gratitude:[...tripBackup.gratitude!,...tripBackup.gratitude!]},trip.id)).toBe(false);
    expect(await room.validateSnapshot({...tripBackup,gratitude:[tripBackup.gratitude![0],{...tripBackup.gratitude![0],id:crypto.randomUUID(),kind:'relay'}]},trip.id)).toBe(false);
  });

  it('removes a deleted guardian profile and refuses further gratitude to that identity',async()=>{
    const {rider,guardian,trip}=await fixture();
    expect((await request('/api/me/profile',guardian,{bio:'Erase this public introduction.'})).status).toBe(200);
    expect((await action(trip,rider,'arrive')).status).toBe(200);
    expect((await give(trip,rider,guardian)).status).toBe(200);
    const backup=await env.USERS.getByName(guardian.user.id).exportSnapshot();
    expect((await request('/api/account/delete',guardian,{confirmation:'DELETE MY ACCOUNT'})).status).toBe(200);
    expect((await request(`/api/members/${guardian.user.id}`,rider)).status).toBe(404);
    expect((await give(trip,rider,guardian)).status).toBe(409);
    const current=await gratitude(trip,rider);
    expect(current.eligibleGuardians.some(item=>item.id===guardian.user.id)).toBe(false);
    expect(current.banners.some(item=>item.guardianId===guardian.user.id)).toBe(false);
    expect(await env.USERS.getByName(guardian.user.id).exportSnapshot()).toBeNull();
    expect(await env.USERS.getByName(guardian.user.id).restoreSnapshot(backup)).toBe(false);
  });

  it('can erase a closed private journey without removing the recipient anonymous gratitude count',async()=>{
    const {rider,guardian,trip}=await fixture();expect((await action(trip,rider,'arrive')).status).toBe(200);
    expect((await give(trip,rider,guardian)).status).toBe(200);
    expect((await request(`/api/trips/${trip.id}/delete`,rider,{confirmation:'DELETE JOURNEY'})).status).toBe(200);
    expect(await env.TRIPS.getByName(trip.id).exportSnapshot()).toBeNull();
    expect((await request(`/api/trips/${trip.id}/gratitude`,rider)).status).toBe(404);
    const profile=await member(guardian,rider);
    expect(profile.gratitude.total).toBe(1);
    expect(JSON.stringify(profile)).not.toContain(trip.id);
    expect(JSON.stringify(profile)).not.toContain(rider.user.id);
  });
});
