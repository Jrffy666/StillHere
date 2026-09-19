import { env, SELF, runInDurableObject, runDurableObjectAlarm, evictDurableObject, reset } from 'cloudflare:test';
import { describe,it,expect,beforeEach,afterEach,vi } from 'vitest';
import * as integrations from '../src/integrations';
import worker from '../src/index';
import { directoryName } from '../src/accounts';
import { allocateContributions } from '../src/guarding';
import { summary, type Trip, type TripSummary, type User } from '../src/types';

interface Session {token:string;user:User}
beforeEach(async()=>{await reset();});
afterEach(()=>{vi.restoreAllMocks();});
const input = {origin:{label:'Secret pickup',lat:43.472,lng:-80.54},destination:{label:'Secret destination',lat:43.464,lng:-80.52},emergencyContact:{name:'Secret contact',contact:'test-only-recipient'},notificationConsent:true,checkInIntervalSeconds:30};
async function request(path:string,token?:string,value?:unknown) {
  return SELF.fetch(`https://guard.test${path}`,{method:value===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:value===undefined?undefined:JSON.stringify(value)});
}
async function session(name='Rider'):Promise<Session> {
  const response=await request('/api/session',undefined,{name});expect(response.status).toBe(201);const value=await response.json<Session>();await env.USERS.getByName(value.user.id).acceptCommunityNotice('community-v1');return value;
}
async function create(rider:Session):Promise<Trip> {
  const response=await request('/api/trips',rider.token,input);expect(response.status).toBe(201);return (await response.json<{trip:Trip}>()).trip;
}
async function act(trip:Trip,user:Session,action:string,requestId?:string) {
  return request(`/api/trips/${trip.id}/actions`,user.token,{action,...(requestId?{requestId}:{})});
}
async function read(trip:Trip,user:Session):Promise<Trip> {
  const response=await request(`/api/trips/${trip.id}`,user.token);expect(response.status).toBe(200);return (await response.json<{trip:Trip}>()).trip;
}
async function apply(trip:Trip,user:Session,requestId=trip.id):Promise<TripSummary> {
  const response=await act(trip,user,'accept',requestId);expect(response.status).toBe(200);return (await response.json<{trip:TripSummary}>()).trip;
}
async function approve(trip:Trip,rider:Session,guardian:Session,requestId=trip.id):Promise<Trip> {
  const pending=await apply(trip,guardian,requestId);
  const response=await act(trip,rider,'approve-guardian',pending.application!.id);expect(response.status).toBe(200);return (await response.json<{trip:Trip}>()).trip;
}
async function relay(trip:Trip,user:Session):Promise<string> {
  const response=await act(trip,user,'request-relay');expect(response.status).toBe(200);return (await response.json<{trip:Trip}>()).trip.relay!.id;
}
async function profile(user:Session):Promise<User> {return (await (await request('/api/me',user.token)).json<{user:User}>()).user;}

// Storage mutation is used only to advance persisted deadlines without waiting minutes in tests.
async function expireApplication(trip:Trip) {
  await runInDurableObject(env.TRIPS.getByName(trip.id),async(_instance,state)=>{
    const stored=JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM trip_state').one().data);
    stored.trip.guardianRequests[0].expiresAt=Date.now()-1;
    state.storage.sql.exec('UPDATE trip_state SET data = ?',JSON.stringify(stored));
  });
}

describe('Rider-approved human guarding and replacement',()=>{
  it('keeps pending applications private, indexed, bounded, and tied to current request IDs',async()=>{
    const rider=await session(),trip=await create(rider),candidates:Session[]=[];
    for(let i=0;i<6;i++) candidates.push(await session(`Candidate ${i}`));
    const pending=await apply(trip,candidates[0]);
    expect(pending.requestKind).toBe('initial');expect(pending.requestId).toBe(trip.id);
    expect(JSON.stringify(pending)).not.toContain('Secret');expect(JSON.stringify(pending)).not.toContain('Candidate');
    const list=await (await request('/api/trips',candidates[0].token)).json<{trips:TripSummary[];myTrips:TripSummary[]}>();
    expect(list.myTrips.find(item=>item.id===trip.id)?.application?.id).toBe(pending.application!.id);
    expect(JSON.stringify(list)).not.toContain('Secret');
    expect((await act(trip,candidates[0],'check-in')).status).toBe(403);
    expect((await act(trip,candidates[0],'approve-guardian',pending.application!.id)).status).toBe(403);
    expect((await act(trip,candidates[0],'accept',trip.id)).status).toBe(409);
    for(const candidate of candidates.slice(1,5)) await apply(trip,candidate);
    expect((await act(trip,candidates[5],'accept',trip.id)).status).toBe(409);
    expect((await act(trip,candidates[5],'accept',crypto.randomUUID())).status).toBe(409);
    await expireApplication(trip);
    await apply(trip,candidates[5]);
    expect((await read(trip,rider)).guardianRequests).toHaveLength(5);
    expect((await act(trip,rider,'approve-guardian',pending.application!.id)).status).toBe(409);
    const directory=await env.LOBBY.getByName(directoryName(trip.id)).list();
    expect(directory[0].application).toBeNull();expect(JSON.stringify(directory)).not.toContain('candidate');
  });

  it('keeps the old guardian until approval, revokes access, and counts a returning guardian only once',async()=>{
    const rider=await session(),first=await session('First'),second=await session('Second'),trip=await create(rider);
    let current=await approve(trip,rider,first);
    expect(current.lastGuardianCheckInAt).toBeNull();expect(current.contributions[0].checkIns).toBe(0);
    await act(trip,first,'check-in');
    const relayId=await relay(trip,first),application=await apply(trip,second,relayId);
    expect((await read(trip,first)).guardian?.id).toBe(first.user.id);
    expect((await act(trip,first,'check-in')).status).toBe(200);
    await act(trip,first,'help');
    expect((await act(trip,first,'approve-guardian',application.application!.id)).status).toBe(403);
    expect((await act(trip,rider,'approve-guardian',application.application!.id)).status).toBe(200);
    expect((await request(`/api/trips/${trip.id}`,first.token)).status).toBe(403);
    expect((await act(trip,first,'help')).status).toBe(403);
    expect((await act(trip,rider,'approve-guardian',application.application!.id)).status).toBe(409);
    current=await read(trip,second);expect(current.risk).toBe('urgent');expect(current.lastGuardianCheckInAt).toBeNull();
    await act(trip,second,'check-in');
    const secondRelay=await relay(trip,rider);
    await approve(trip,rider,first,secondRelay);
    await act(trip,first,'resume');
    current=await read(trip,rider);
    expect(current.contributions).toHaveLength(2);
    expect(current.contributions.find(item=>item.guardian.id===first.user.id)?.checkIns).toBe(3);
    expect(current.risk).toBe('urgent');
    const response=await act(trip,rider,'arrive');expect(response.status).toBe(200);
    const arrived=(await response.json<{trip:Trip}>()).trip;
    expect(arrived.contributions.every(item=>item.rewardStatus==='credited')).toBe(true);
    expect(arrived.contributions.reduce((sum,item)=>sum+item.points,0)).toBe(25);
    expect(arrived.contributions.reduce((sum,item)=>sum+item.reputation,0)).toBe(10);
    const references=await Promise.all([first,second].map(async person=>({person,ref:(await env.USERS.getByName(person.user.id).communityIdentity())!.memberId})));
    const ordered=references.sort((a,b)=>a.ref<b.ref?-1:1).map(item=>item.person);
    expect((await profile(ordered[0])).points).toBe(13);expect((await profile(ordered[1])).points).toBe(12);
    for(const person of ordered) {const user=await profile(person);expect(user.reputation).toBe(5);expect(user.completedGuards).toBe(1);}
    expect((await act(trip,rider,'arrive')).status).toBe(409);
  });

  it('expires applications through persisted alarms across object eviction',async()=>{
    const rider=await session(),candidate=await session('Candidate'),trip=await create(rider);
    const pending=await apply(trip,candidate);const stub=env.TRIPS.getByName(trip.id);
    await runInDurableObject(stub,async(_instance,state)=>{expect(await state.storage.getAlarm()).toBe(pending.application!.expiresAt);});
    await expireApplication(trip);await evictDurableObject(stub);expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await read(trip,rider)).guardianRequests).toHaveLength(0);
    const view=await (await request(`/api/trips/${trip.id}`,candidate.token)).json<{trip:TripSummary}>();expect(view.trip.application).toBeNull();
    expect((await act(trip,rider,'approve-guardian',pending.application!.id)).status).toBe(409);
  });

  it('expires a relay and its applications without removing the assigned guardian',async()=>{
    const rider=await session(),guardian=await session('Guardian'),candidate=await session('Candidate'),trip=await create(rider);
    await approve(trip,rider,guardian);const relayId=await relay(trip,rider);const pending=await apply(trip,candidate,relayId);
    const stub=env.TRIPS.getByName(trip.id);
    await runInDurableObject(stub,async(_instance,state)=>{
      const stored=JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM trip_state').one().data);
      stored.trip.relay.expiresAt=Date.now()-1;state.storage.sql.exec('UPDATE trip_state SET data = ?',JSON.stringify(stored));
    });
    await evictDurableObject(stub);await runDurableObjectAlarm(stub);
    const current=await read(trip,guardian);expect(current.guardian?.id).toBe(guardian.user.id);expect(current.guardMode).toBe('human');expect(current.relay).toBeNull();expect(current.guardianRequests).toHaveLength(0);
    expect((await request(`/api/trips/${trip.id}`,candidate.token)).status).toBe(403);
    expect((await act(trip,candidate,'accept',relayId)).status).toBe(409);
    expect((await act(trip,rider,'approve-guardian',pending.application!.id)).status).toBe(409);
    expect((await env.LOBBY.getByName(directoryName(trip.id)).list()).some(item=>item.id===trip.id)).toBe(false);
  });

  it('opens a replacement request on missed human availability and keeps rules monitoring truthful',async()=>{
    const rider=await session(),guardian=await session('Guardian'),outsider=await session('Outsider'),trip=await create(rider);
    await approve(trip,rider,guardian);const stub=env.TRIPS.getByName(trip.id);
    await runInDurableObject(stub,async(_instance,state)=>{
      const stored=JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM trip_state').one().data);
      stored.trip.nextCheckInAt=Date.now()-1;state.storage.sql.exec('UPDATE trip_state SET data = ?',JSON.stringify(stored));
    });
    await runDurableObjectAlarm(stub);
    const current=await read(trip,guardian);expect(current.guardMode).toBe('ai');expect(current.ai.mode).toBe('rules');expect(current.guardian?.id).toBe(guardian.user.id);expect(current.relay).not.toBeNull();
    const publicView=(await (await request(`/api/trips/${trip.id}`,outsider.token)).json<{trip:TripSummary}>()).trip;
    expect(publicView.requestKind).toBe('relay');expect(JSON.stringify(publicView)).not.toContain('Secret');
    await act(trip,guardian,'resume');const resumed=await read(trip,rider);expect(resumed.guardMode).toBe('human');expect(resumed.relay?.id).toBe(current.relay?.id);expect(resumed.contributions[0].checkIns).toBe(1);
  });

  it('rechecks private access after a guardian action awaits external notification work',async()=>{
    const rider=await session(),first=await session('First'),second=await session('Second'),trip=await create(rider);
    await approve(trip,rider,first);const relayId=await relay(trip,rider);const pending=await apply(trip,second,relayId);
    vi.spyOn(integrations,'sendNotification').mockImplementation(async()=>{
      expect((await act(trip,rider,'approve-guardian',pending.application!.id)).status).toBe(200);
      return {status:'failed',channel:'none',detail:'Test provider unavailable.'};
    });
    const previousGuardianResponse=await act(trip,first,'help');expect(previousGuardianResponse.status).toBe(403);
    expect(await previousGuardianResponse.text()).not.toContain('Secret');
    const current=await read(trip,rider);expect(current.guardian?.id).toBe(second.user.id);expect(current.risk).toBe('urgent');
  });

  it('discards a voice response if its caller is replaced while the provider runs',async()=>{
    const rider=await session(),first=await session('First'),second=await session('Second'),trip=await create(rider);
    await approve(trip,rider,first);await act(trip,rider,'help');const relayId=await relay(trip,rider);const pending=await apply(trip,second,relayId);
    vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{
      expect((await act(trip,rider,'approve-guardian',pending.application!.id)).status).toBe(200);
      return new Response('private voice bytes',{headers:{'Content-Type':'audio/mpeg'}});
    });
    const response=await worker.fetch(new Request(`https://guard.test/api/trips/${trip.id}/voice`,{method:'POST',headers:{Authorization:`Bearer ${first.token}`}}),{...env,ELEVENLABS_API_KEY:'test-only-placeholder'});
    expect(response.status).toBe(403);expect(await response.text()).not.toContain('private voice bytes');
  });

  it('retries an interrupted reward credit after eviction without issuing a second pool',async()=>{
    const rider=await session(),guardian=await session('Guardian'),trip=await create(rider);await approve(trip,rider,guardian);await act(trip,guardian,'check-in');
    const stub=env.TRIPS.getByName(trip.id);
    // Reconstruct the exact crash boundary: arrival/allocation persisted, user
    // credit committed, but the trip has not yet marked that credit complete.
    await runInDurableObject(stub,async(_instance,state)=>{
      const stored=JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM trip_state').one().data);
      stored.trip.status='arrived';stored.trip.nextCheckInAt=null;
      allocateContributions(stored.trip);
      state.storage.sql.exec('UPDATE trip_state SET data = ?',JSON.stringify(stored));
      await state.storage.setAlarm(Date.now()+1000);
    });
    expect(await env.USERS.getByName(guardian.user.id).credit(trip.id,25,10)).toBe(true);
    expect((await profile(guardian)).points).toBe(25);
    await evictDurableObject(stub);expect(await runDurableObjectAlarm(stub)).toBe(true);
    const arrived=await read(trip,rider);expect(arrived.reward.status).toBe('credited');expect(arrived.contributions[0].rewardStatus).toBe('credited');
    const user=await profile(guardian);expect(user.points).toBe(25);expect(user.reputation).toBe(10);expect(user.completedGuards).toBe(1);
  });

  it('migrates older assigned trips while preserving existing eligibility and credited rewards',async()=>{
    const rider=await session(),guardian=await session('Guardian'),trip=await create(rider);await approve(trip,rider,guardian);await act(trip,guardian,'check-in');
    const stub=env.TRIPS.getByName(trip.id);
    async function makeLegacy() {
      await runInDurableObject(stub,async(_instance,state)=>{
        const stored=JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM trip_state').one().data);
        delete stored.schemaVersion;delete stored.community;delete stored.trip.guardianRequests;delete stored.trip.relay;delete stored.trip.contributions;
        state.storage.sql.exec('UPDATE trip_state SET data = ?',JSON.stringify(stored));
      });
      await evictDurableObject(stub);
    }
    await makeLegacy();const migrated=await read(trip,guardian);expect(migrated.contributions[0].checkIns).toBe(1);expect(migrated.guardianRequests).toEqual([]);expect(migrated.relay).toBeNull();
    expect((await act(trip,rider,'arrive')).status).toBe(200);await makeLegacy();
    const credited=await read(trip,rider);expect(credited.reward.status).toBe('credited');expect(credited.contributions[0].points).toBe(25);expect(credited.contributions[0].rewardStatus).toBe('credited');
    expect((await profile(guardian)).points).toBe(25);
  });

  it('prevents stale directory writes from reopening a closed request and strips candidate data',async()=>{
    const rider=await session(),trip=await create(rider);const directory=env.LOBBY.getByName(directoryName(trip.id));
    const publicTrip=summary(trip);
    await directory.update({...publicTrip,application:{id:crypto.randomUUID(),expiresAt:Date.now()+10000}},20);
    expect((await directory.list())[0].application).toBeNull();
    await directory.update({...publicTrip,status:'cancelled',requestKind:null,requestId:null,requestExpiresAt:null},21);
    await directory.update(publicTrip,20);
    expect((await directory.list()).some(item=>item.id===trip.id)).toBe(false);
  });

  it('keeps an unexpired relay listed when its original trip was created more than a day ago',async()=>{
    const rider=await session(),trip=await create(rider),directory=env.LOBBY.getByName(directoryName(trip.id));
    const record={...summary(trip),status:'active' as const,createdAt:Date.now()-25*3600000,requestKind:'relay' as const,requestId:crypto.randomUUID(),requestExpiresAt:Date.now()+600000};
    await directory.update(record,50);
    expect((await directory.list()).some(item=>item.id===trip.id)).toBe(true);
  });

  it('conserves the fixed reward pool even with more contributors than integer points',async()=>{
    const rider=await session(),trip=await create(rider);trip.status='arrived';
    trip.contributions=Array.from({length:31},(_,i)=>({guardian:{id:String(i).padStart(2,'0'),name:'Guardian'},checkIns:1,startedAt:1,endedAt:null,points:0,reputation:0,rewardStatus:'pending' as const}));
    allocateContributions(trip);
    expect(trip.contributions.reduce((sum,item)=>sum+item.points,0)).toBe(25);
    expect(trip.contributions.reduce((sum,item)=>sum+item.reputation,0)).toBe(10);
    expect(trip.contributions.every(item=>Number.isInteger(item.points)&&item.points>=0)).toBe(true);
    expect(trip.contributions.at(-1)?.points).toBe(0);
    trip.status='cancelled';allocateContributions(trip);
    expect(trip.contributions.every(item=>item.points===0&&item.reputation===0&&item.rewardStatus==='ineligible')).toBe(true);
  });
});
