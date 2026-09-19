import { env, SELF, runInDurableObject, runDurableObjectAlarm, evictDurableObject, reset } from 'cloudflare:test';
import { describe,it,expect,beforeEach,afterEach,vi } from 'vitest';
import * as agentProvider from '../src/agent';
import type { Trip, TripSummary, User } from '../src/types';

interface Session {token:string;user:User}
beforeEach(async()=>{await reset();});
afterEach(()=>{vi.restoreAllMocks();});
const input = {origin:{label:'Private pickup',lat:43.472,lng:-80.54},destination:{label:'Private destination',lat:43.464,lng:-80.52},emergencyContact:{name:'Private contact',contact:'not-a-real-recipient'},notificationConsent:true,checkInIntervalSeconds:30};
async function request(path:string,token?:string,value?:unknown) {
  return SELF.fetch(`https://guard.test${path}`,{method:value === undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:value === undefined?undefined:JSON.stringify(value)});
}
async function session(name='Rider'):Promise<Session> {
  const response = await request('/api/session',undefined,{name}); expect(response.status).toBe(201); const value=await response.json<Session>();await env.USERS.getByName(value.user.id).acceptCommunityNotice('community-v1');return value;
}
async function create(rider:Session,demo=false):Promise<Trip> {
  const response = await request(demo?'/api/demo/start':'/api/trips',rider.token,demo?{}:input);
  expect(response.status).toBe(201); return (await response.json<{trip:Trip}>()).trip;
}
async function action(trip:Trip,user:Session,action:string,extra:Record<string,unknown>={}) {
  return request(`/api/trips/${trip.id}/actions`,user.token,{action,...extra});
}

async function approve(trip:Trip,rider:Session,guardian:Session):Promise<Trip> {
  const applicationResponse = await action(trip,guardian,'accept',{requestId:trip.id});
  expect(applicationResponse.status).toBe(200);
  const pending = (await applicationResponse.json<{trip:TripSummary}>()).trip;
  const approved = await action(trip,rider,'approve-guardian',{requestId:pending.application!.id});
  expect(approved.status).toBe(200); return (await approved.json<{trip:Trip}>()).trip;
}

describe('HTTP API, privacy, and durable state',()=>{
  it('persists hashed session credentials and rejects tampering',async()=>{
    const person = await session('Morgan');
    expect((await request('/api/me',person.token)).status).toBe(200);
    expect((await request('/api/me',person.token.slice(0,-1)+'x')).status).toBe(401);
    expect((await request('/api/me')).status).toBe(401);
    await runInDurableObject(env.USERS.getByName(person.user.id),async(_instance,state)=>{
      const row = state.storage.sql.exec<{data:string;digest:string}>('SELECT data,digest FROM account').one();
      expect(row.digest).not.toBe(person.token); expect(row.data).not.toContain(person.token);
    });
  });
  it('lists only redacted metadata and refuses outsider mutation',async()=>{
    const rider = await session(),stranger = await session('Stranger'); const trip = await create(rider);
    const list = await (await request('/api/trips',stranger.token)).json<{trips:unknown[]}>();
    expect(list.trips.length).toBeGreaterThan(0);
    expect(JSON.stringify(list)).not.toContain('Private'); expect(JSON.stringify(list)).not.toContain('-80.54');
    expect((await action(trip,stranger,'location',{lat:0,lng:0})).status).toBe(403);
    expect((await action(trip,rider,'accept')).status).toBe(400);
    const own = await (await request(`/api/trips/${trip.id}`,rider.token)).json<{trip:Trip}>();
    expect(own.trip.emergencyContact?.name).toBe('Private contact');
  });
  it('allows concurrent applications but only one rider-approved guardian receives private access',async()=>{
    const rider = await session(),a = await session('A'),b = await session('B');const trip = await create(rider);
    const applications = await Promise.all([action(trip,a,'accept',{requestId:trip.id}),action(trip,b,'accept',{requestId:trip.id})]);
    expect(applications.map(value=>value.status)).toEqual([200,200]);
    const pending = await Promise.all(applications.map(response=>response.json<{trip:TripSummary}>()));
    for (const value of pending) { expect(JSON.stringify(value)).not.toContain('Private'); expect(value.trip.application).not.toBeNull(); }
    const decisions = await Promise.all(pending.map(value=>action(trip,rider,'approve-guardian',{requestId:value.trip.application!.id})));
    expect(decisions.map(value=>value.status).sort()).toEqual([200,409]);
    const loser = decisions[0].status === 409 ? a : b;
    expect((await request(`/api/trips/${trip.id}`,loser.token)).status).toBe(403);
    expect((await action(trip,loser,'help')).status).toBe(403);
  });
  it('credits only an acknowledged human contribution exactly once',async()=>{
    const rider = await session(),guardian = await session('Guardian'); const trip = await create(rider);
    await approve(trip,rider,guardian);
    expect((await action(trip,guardian,'check-in')).status).toBe(200);
    expect((await action(trip,guardian,'arrive')).status).toBe(403);
    const arrived = await (await action(trip,rider,'arrive')).json<{trip:Trip}>();
    expect(arrived.trip.reward.status).toBe('credited');
    expect((await action(trip,rider,'arrive')).status).toBe(409);
    const profile = await (await request('/api/me',guardian.token)).json<{user:User}>();
    expect(profile.user.points).toBe(25);expect(profile.user.reputation).toBe(10);expect(profile.user.completedGuards).toBe(1);
    expect(await env.USERS.getByName(guardian.user.id).credit(trip.id,25,10)).toBe(false);
    const profileAgain = await (await request('/api/me',guardian.token)).json<{user:User}>();expect(profileAgain.user.points).toBe(25);
  });
  it('does not reward accepting without a check-in or credit simulated trips',async()=>{
    const rider = await session(),guardian = await session('Guardian'); const trip = await create(rider);
    await approve(trip,rider,guardian);
    expect((await (await action(trip,rider,'arrive')).json<{trip:Trip}>()).trip.reward.status).toBe('ineligible');
    const demo = await create(rider,true);const closed = await (await action(demo,rider,'arrive')).json<{trip:Trip}>();
    expect(closed.trip.reward.status).toBe('demo');
    expect((await (await request('/api/me',rider.token)).json<{user:User}>()).user.points).toBe(0);
  });
  it('takes over via a persisted alarm without a browser request, including after eviction',async()=>{
    const rider = await session();const trip = await create(rider,true);const stub = env.TRIPS.getByName(trip.id);
    await runInDurableObject(stub,async(_instance,state)=>{
      const row = state.storage.sql.exec<{data:string}>('SELECT data FROM trip_state').one();const data = JSON.parse(row.data);
      data.trip.nextCheckInAt = Date.now()-1;
      state.storage.sql.exec('UPDATE trip_state SET data = ?',JSON.stringify(data));
    });
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const result = await stub.read(rider.user.id);expect(result.ok).toBe(true);
    if (result.ok && 'guardMode' in result.value) {
      expect(result.value.guardMode).toBe('ai');expect(result.value.events.some(item=>item.type==='takeover')).toBe(true);
      expect(result.value.ai.mode).toBe('rules');
    }
  });
  it('detects stale location on the backend and preserves urgent risk',async()=>{
    const rider = await session();const trip = await create(rider,true);await action(trip,rider,'help');
    const stub = env.TRIPS.getByName(trip.id);
    await runInDurableObject(stub,async(_instance,state)=>{
      const row = state.storage.sql.exec<{data:string}>('SELECT data FROM trip_state').one();const data = JSON.parse(row.data);
      data.trip.location.updatedAt = Date.now()-180000;state.storage.sql.exec('UPDATE trip_state SET data = ?',JSON.stringify(data));
    });
    await runDurableObjectAlarm(stub);
    const response = await (await request(`/api/trips/${trip.id}`,rider.token)).json<{trip:Trip}>();
    expect(response.trip.risk).toBe('urgent');expect(response.trip.events.some(item=>item.type==='stale-location')).toBe(true);
  });
  it('always handles explicit help and truthfully distinguishes demo from missing delivery',async()=>{
    const rider = await session();const demo = await create(rider,true);
    const helped = await (await action(demo,rider,'help',{text:'I need help'})).json<{trip:Trip}>();
    expect(helped.trip.risk).toBe('urgent');expect(helped.trip.notifications[0].status).toBe('simulated');
    const real = await create(rider);const realHelp = await (await action(real,rider,'help')).json<{trip:Trip}>();
    expect(realHelp.trip.notifications[0].status).toBe('failed');expect(realHelp.trip.notifications[0].channel).toBe('none');
    expect(realHelp.trip.ai.mode).toBe('rules');
  });
  it('limits simulation to demo trips and validates URLs, coordinates, and body size',async()=>{
    const rider = await session();const trip = await create(rider);
    expect((await action(trip,rider,'simulate',{scenario:'guardian-offline'})).status).toBe(403);
    expect((await action(trip,rider,'location',{lat:95,lng:0})).status).toBe(400);
    expect((await request('/api/trips',rider.token,{...input,shareUrl:'https://uber.com.attacker.test/ride'})).status).toBe(400);
    expect((await action(trip,rider,'message',{text:'a'.repeat(20000)})).status).toBe(400);
  });
  it('shows real integration status and enforces origin restrictions',async()=>{
    const config = await (await request('/api/config')).json<{ai:{provider:string};notifications:{configured:boolean}}>();
    expect(config.ai.provider).toBe('mock');expect(config.notifications.configured).toBe(false);
    expect((await SELF.fetch('https://guard.test/api/config',{headers:{Origin:'https://evil.test'}})).status).toBe(403);
  });
  it('continues automated check-ins and queues only one escalation for unanswered prompts',async()=>{
    const rider = await session();const trip = await create(rider,true);await action(trip,rider,'takeover');const stub = env.TRIPS.getByName(trip.id);
    expect((await request(`/api/trips/${trip.id}/assistance`,rider.token,{automatedCheckIns:true,timeoutContact:true,liveAiConsent:false,noticeVersion:'openai-assistance-v1'})).status).toBe(200);
    await runInDurableObject(stub,async(_instance,state)=>{
      const data=JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM trip_state').one().data);
      data.trip.notificationConsent=true;data.trip.emergencyContact={name:'Synthetic contact',contact:'test-only-recipient'};
      state.storage.sql.exec('UPDATE trip_state SET data = ?',JSON.stringify(data));
    });
    async function makeDue() {
      await runInDurableObject(stub,async(_instance,state)=>{
        const row = state.storage.sql.exec<{data:string}>('SELECT data FROM trip_state').one();const data = JSON.parse(row.data);
        data.aiNextCheckInAt = Date.now()-1;state.storage.sql.exec('UPDATE trip_state SET data = ?',JSON.stringify(data));
      });
      await runDurableObjectAlarm(stub);
    }
    await makeDue();await makeDue();await makeDue();
    const updated = await (await request(`/api/trips/${trip.id}`,rider.token)).json<{trip:Trip}>();
    expect(updated.trip.events.filter(item=>item.type==='agent-check-in')).toHaveLength(3);
    expect(updated.trip.notifications).toHaveLength(1);expect(updated.trip.notifications[0].status).toBe('simulated');
    await action(trip,rider,'check-in');
    await runInDurableObject(stub,async(_instance,state)=>{
      const row = state.storage.sql.exec<{data:string}>('SELECT data FROM trip_state').one();const data = JSON.parse(row.data);
      expect(data.aiMissedCheckIns).toBe(0);expect(data.automatedEscalationSent).toBe(false);expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });
  it('starts the active monitoring window at rider approval, even for an older open request',async()=>{
    const rider = await session(),guardian=await session('Guardian');const trip=await create(rider);const stub=env.TRIPS.getByName(trip.id);
    await runInDurableObject(stub,async(_instance,state)=>{
      const row=state.storage.sql.exec<{data:string}>('SELECT data FROM trip_state').one();const data=JSON.parse(row.data);
      data.trip.createdAt=Date.now()-8*3600000;state.storage.sql.exec('UPDATE trip_state SET data = ?',JSON.stringify(data));
    });
    await approve(trip,rider,guardian);await runDurableObjectAlarm(stub);
    const updated=await (await request(`/api/trips/${trip.id}`,rider.token)).json<{trip:Trip}>();expect(updated.trip.status).toBe('active');
  });
  it('discards a slow model reply after a newer explicit request for help',async()=>{
    const rider=await session();const trip=await create(rider,true);await action(trip,rider,'takeover');
    vi.spyOn(agentProvider,'nextMockDecision').mockImplementationOnce(async()=>{
      // Simulate a newer human action while the model request is outstanding.
      // All work stays inside Workers request contexts rather than foreign deferred promises.
      const response = await action(trip,rider,'help'); expect(response.status).toBe(200);
      return {type:'tool',call:{name:'send_check_in',arguments:{text:'This is a stale reassuring response.'}}};
    });
    await action(trip,rider,'message',{text:'The route looks different.'});
    const updated=await (await request(`/api/trips/${trip.id}`,rider.token)).json<{trip:Trip}>();
    expect(updated.trip.risk).toBe('urgent');expect(updated.trip.ai.lastAssessment).toContain('request for help');
    expect(updated.trip.messages.some(message=>message.text.includes('stale reassuring'))).toBe(false);
  });
  it('keeps queued real-provider acknowledgement distinct from simulated delivery',async()=>{
    const rider=await session();const trip=await create(rider,true);await action(trip,rider,'help');const stub=env.TRIPS.getByName(trip.id);
    const initial=await (await request(`/api/trips/${trip.id}`,rider.token)).json<{trip:Trip}>();const id=initial.trip.notifications[0].id;
    expect((await stub.acknowledge(id)).ok).toBe(false);
    await runInDurableObject(stub,async(_instance,state)=>{
      const row=state.storage.sql.exec<{data:string}>('SELECT data FROM trip_state').one();const data=JSON.parse(row.data);
      data.trip.notifications[0].channel='webhook';data.trip.notifications[0].status='queued';
      state.storage.sql.exec('UPDATE trip_state SET data = ?',JSON.stringify(data));
    });
    expect((await stub.acknowledge(id)).ok).toBe(true);
    expect((await request(`/api/notifications/${trip.id}/${id}/ack`,rider.token,{})).status).toBe(401);
  });
});
