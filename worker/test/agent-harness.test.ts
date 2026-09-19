import { env, SELF, runInDurableObject, runDurableObjectAlarm, evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as agentProvider from '../src/agent';
import type { AgentRun, AgentStep, AgentToolCall } from '../src/agent';
import { tripSnapshotSchema } from '../src/snapshots';
import type { Trip, TripAction, TripSummary, User, WorkerEnv } from '../src/types';

interface Session { token:string; user:User }
interface StoredFixture {
  trip:Trip;
  assessmentVersion:number;
  aiNextCheckInAt:number|null;
  staleAlerted:boolean;
  lastNotificationAt:number;
  notificationJobs:Record<string,{attempts:number;retryAt:number;inFlightUntil:number}>;
}

const input = {
  origin:{label:'Private pickup',lat:43.472,lng:-80.54},
  destination:{label:'Private destination',lat:43.464,lng:-80.52},
  emergencyContact:{name:'Private contact',contact:'test-only-recipient'},
  notificationConsent:true,checkInIntervalSeconds:30,
};

beforeEach(async()=>{ await reset(); });
afterEach(()=>{ vi.restoreAllMocks(); });

async function request(path:string,session?:Session,body?:unknown) {
  return SELF.fetch(`https://guard.test${path}`,{
    method:body===undefined?'GET':'POST',
    headers:{'Content-Type':'application/json',...(session?{Authorization:`Bearer ${session.token}`}:{})},
    body:body===undefined?undefined:JSON.stringify(body),
  });
}
async function session(name:string):Promise<Session> {
  const response=await request('/api/session',undefined,{name});
  expect(response.status).toBe(201); const value=await response.json<Session>();await env.USERS.getByName(value.user.id).acceptCommunityNotice('community-v1');return value;
}
async function create(rider:Session):Promise<Trip> {
  const response=await request('/api/trips',rider,input);
  expect(response.status).toBe(201); return (await response.json<{trip:Trip}>()).trip;
}
async function act(trip:Trip,user:Session,action:TripAction):Promise<Trip> {
  const response=await request(`/api/trips/${trip.id}/actions`,user,action);
  expect(response.status).toBe(200); return (await response.json<{trip:Trip}>()).trip;
}
async function read(trip:Trip,user:Session):Promise<Trip> {
  const response=await request(`/api/trips/${trip.id}`,user);
  expect(response.status).toBe(200); return (await response.json<{trip:Trip}>()).trip;
}
async function approve(trip:Trip,rider:Session,guardian:Session,requestId=trip.id):Promise<Trip> {
  const response=await request(`/api/trips/${trip.id}/actions`,guardian,{action:'accept',requestId});
  expect(response.status).toBe(200);
  const pending=(await response.json<{trip:TripSummary}>()).trip;
  return act(trip,rider,{action:'approve-guardian',requestId:pending.application!.id});
}
async function fixture() {
  const rider=await session('Rider'),guardian=await session('Guardian'),trip=await create(rider);
  await approve(trip,rider,guardian);
  return {rider,guardian,trip};
}

// Reconstruct persisted deadlines/crash boundaries without relying on wall-clock sleeps.
async function mutate(trip:Trip,change:(stored:StoredFixture)=>void) {
  await runInDurableObject(env.TRIPS.getByName(trip.id),async(_instance,state)=>{
    const stored=JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM trip_state').one().data) as StoredFixture;
    change(stored);
    state.storage.sql.exec('UPDATE trip_state SET data = ?',JSON.stringify(stored));
    await state.storage.setAlarm(Date.now()+100);
  });
}
async function wake(trip:Trip) {
  const stub=env.TRIPS.getByName(trip.id);
  await evictDurableObject(stub);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
}
function queuedRun(stored:StoredFixture,steps:AgentStep[]=[]):AgentRun {
  const id=crypto.randomUUID(),now=Date.now();
  return {
    id,trigger:{id:crypto.randomUUID(),kind:'takeover',at:now},provider:'mock',status:'queued',
    createdAt:now,updatedAt:now,revision:stored.assessmentVersion,steps,
    attempts:0,nextAttemptAt:now-1,leaseUntil:0,
  };
}

describe('Offline durable agent harness',()=>{
  it('performs a visible mock takeover without crediting a guardian or granting replacement access',async()=>{
    const {rider,guardian,trip}=await fixture();
    const current=await act(trip,rider,{action:'takeover'});
    expect(current.guardMode).toBe('ai');
    expect(current.guardian?.id).toBe(guardian.user.id);
    expect(current.contributions[0].checkIns).toBe(0);
    expect(current.lastGuardianCheckInAt).toBeNull();
    expect(current.relay).not.toBeNull();
    expect(current.agent).toMatchObject({provider:'mock',liveModel:false});
    const completed=current.agent!.runs.filter(run=>run.status==='completed');
    expect(completed.length).toBeGreaterThan(0);
    expect(completed.some(run=>run.steps.some(step=>step.call.name==='get_journey_context'&&step.status==='succeeded'))).toBe(true);
    expect(completed.some(run=>run.steps.some(step=>step.call.name==='send_check_in'&&step.status==='succeeded'))).toBe(true);
    const context=completed.flatMap(run=>run.steps).find(step=>step.call.name==='get_journey_context')!.result!.context!;
    expect(JSON.stringify(context)).not.toContain('test-only-recipient');
    expect(JSON.stringify(context)).not.toContain('Private pickup');
    expect(context.location).not.toHaveProperty('lat');
    expect(current.agent!.followUpAt).toBeGreaterThan(Date.now());
    const candidate=await session('Candidate');
    expect((await request(`/api/trips/${trip.id}/actions`,candidate,{action:'check-in'})).status).toBe(403);
  });

  it('never calls OpenAI during takeover or rider conversation even when a key exists',async()=>{
    const {rider,trip}=await fixture();
    const stub=env.TRIPS.getByName(trip.id);
    const previousKey=await runInDurableObject(stub,async(instance)=>{
      const bindings=(instance as unknown as {env:WorkerEnv}).env;
      const previous=bindings.OPENAI_API_KEY;
      bindings.OPENAI_API_KEY='test-only-unused-openai-key';
      return previous;
    });
    try {
      const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('External network disabled in offline harness test.'));
      await act(trip,rider,{action:'takeover'});
      const current=await act(trip,rider,{action:'message',text:'The route looks unfamiliar; I am not sure whether the GPS is current.'});
      expect(current.agent).toMatchObject({provider:'mock',liveModel:false});
      expect(current.agent!.runs.some(run=>run.trigger.kind==='rider-message'&&run.status==='completed')).toBe(true);
      expect(current.ai.mode).toBe('rules');
      expect(network).not.toHaveBeenCalled();
    } finally {
      await runInDurableObject(stub,async(instance)=>{
        const bindings=(instance as unknown as {env:WorkerEnv}).env;
        if(previousKey===undefined) delete bindings.OPENAI_API_KEY;
        else bindings.OPENAI_API_KEY=previousKey;
      });
    }
  });

  it('checks stale location after restart without treating missing telemetry as confirmed danger',async()=>{
    const {rider,trip}=await fixture();
    await act(trip,rider,{action:'takeover'});
    await mutate(trip,stored=>{
      stored.trip.location.updatedAt=Date.now()-180000;
      stored.staleAlerted=false;
    });
    await wake(trip);
    const current=await read(trip,rider);
    expect(current.risk).toBe('attention');
    expect(current.agent!.runs.some(run=>run.trigger.kind==='stale-location'&&run.status==='completed')).toBe(true);
    expect(current.notifications).toHaveLength(0);
    expect(current.messages.some(message=>message.role==='agent'&&/location|GPS/i.test(message.text))).toBe(true);
    expect(current.contributions[0].checkIns).toBe(0);
  });

  it('keeps traces private and revokes a replaced guardian access to the full context',async()=>{
    const {rider,guardian,trip}=await fixture();
    const current=await act(trip,rider,{action:'takeover'});
    await act(trip,rider,{action:'message',text:'Private rider uncertainty about this road.'});
    const replacement=await session('Replacement');
    const publicResponse=await request(`/api/trips/${trip.id}`,replacement);
    expect(publicResponse.status).toBe(200);
    const publicText=await publicResponse.text();
    expect(publicText).not.toContain('agent');
    expect(publicText).not.toContain('Private');
    expect(publicText).not.toContain('get_journey_context');
    const replaced=await approve(current,rider,replacement,current.relay!.id);
    expect(replaced.guardMode).toBe('human');
    expect(replaced.agent!.runs.length).toBeGreaterThan(0);
    const revoked=await request(`/api/trips/${trip.id}`,guardian);
    expect(revoked.status).toBe(403);
    expect(await revoked.text()).not.toContain('get_journey_context');
    expect((await read(trip,replacement)).agent!.provider).toBe('mock');
  });

  it('removes nested context snapshots containing a deleted guardian message',async()=>{
    const {rider,guardian,trip}=await fixture();
    await act(trip,guardian,{action:'message',text:'Guardian-only private history marker.'});
    const current=await act(trip,rider,{action:'takeover'});
    expect(JSON.stringify(current.agent)).toContain('Guardian-only private history marker.');
    const response=await request('/api/account/delete',guardian,{confirmation:'DELETE MY ACCOUNT'});
    expect(response.status).toBe(200);
    const after=await read(trip,rider);
    expect(JSON.stringify(after)).not.toContain('Guardian-only private history marker.');
    expect(after.guardian).toBeNull();
    expect((await request('/api/me',guardian)).status).toBe(401);
  });

  it('validates backups with traces but restores a closed journey without replayable agent work',async()=>{
    const {rider,trip}=await fixture();
    await act(trip,rider,{action:'takeover'});
    await mutate(trip,stored=>{
      stored.trip.agent!.runs.push(queuedRun(stored));
    });
    const source=env.TRIPS.getByName(trip.id),backup=(await source.exportSnapshot())!;
    const parsed=tripSnapshotSchema.safeParse(backup);
    expect(parsed.success,parsed.success?'':JSON.stringify(parsed.error.issues)).toBe(true);
    expect(await source.validateSnapshot(backup,trip.id)).toBe(true);
    expect(backup.trip.agent!.runs.some(run=>run.status==='queued')).toBe(true);
    const restoredId=crypto.randomUUID(),restoredStub=env.TRIPS.getByName(restoredId);
    expect(await restoredStub.restoreSnapshot({...backup,trip:{...backup.trip,id:restoredId}})).toBe(true);
    const restored=(await restoredStub.chainContext())!;
    expect(restored.status).toBe('cancelled');
    expect(restored.agent).toEqual({provider:'mock',liveModel:false,runs:[],followUpAt:null,handoffSummary:null});
    expect(restored.notifications).toHaveLength(0);
    await evictDurableObject(restoredStub);
    expect(await runDurableObjectAlarm(restoredStub)).toBe(true);
    const after=(await restoredStub.chainContext())!;
    expect(after.agent!.runs).toHaveLength(0);
    expect(after.messages.map(message=>message.id)).toEqual(restored.messages.map(message=>message.id));
  });

  it('resumes a persisted queued run after eviction and records its actual tool results',async()=>{
    const {rider,trip}=await fixture();
    const current=await act(trip,rider,{action:'takeover'});
    let queuedId='';
    await mutate(trip,stored=>{
      const run=queuedRun(stored); queuedId=run.id;
      stored.trip.agent!.runs.push(run);
    });
    await wake(trip);
    const resumed=await read(trip,rider),run=resumed.agent!.runs.find(item=>item.id===queuedId)!;
    expect(run.status).toBe('completed');
    expect(run.steps.length).toBeGreaterThan(1);
    expect(run.steps.every(step=>step.status!=='pending'&&step.result)).toBe(true);
    expect(resumed.messages.filter(message=>message.role==='agent').length).toBe(current.messages.filter(message=>message.role==='agent').length+1);
    expect(resumed.relay?.id).toBe(current.relay!.id);
  });

  it('does not repeat already committed tool effects when a run is replayed after eviction',async()=>{
    const {rider,trip}=await fixture();
    const current=await act(trip,rider,{action:'takeover'});
    const completed=current.agent!.runs.find(run=>run.status==='completed')!;
    await mutate(trip,stored=>{
      // Recreate a crash after all tool effects/results committed, before run completion.
      const run=stored.trip.agent!.runs.find(item=>item.id===completed.id)!;
      run.status='queued'; run.summary=undefined; run.leaseUntil=0; run.nextAttemptAt=Date.now()-1;
    });
    await wake(trip);
    const replayed=await read(trip,rider),run=replayed.agent!.runs.find(item=>item.id===completed.id)!;
    expect(run.status).toBe('completed');
    expect(run.steps.map(step=>step.id)).toEqual(completed.steps.map(step=>step.id));
    expect(replayed.messages.map(message=>message.id)).toEqual(current.messages.map(message=>message.id));
    expect(replayed.notifications.map(notice=>notice.id)).toEqual(current.notifications.map(notice=>notice.id));
    expect(replayed.relay?.id).toBe(current.relay!.id);
    expect(replayed.contributions).toEqual(current.contributions);
  });

  it.each(['resume','arrive'] as const)('cancels persisted work when a human action ends automated monitoring: %s',async(action)=>{
    const {rider,guardian,trip}=await fixture();
    await act(trip,rider,{action:'takeover'});
    let queuedId='';
    await mutate(trip,stored=>{
      const run=queuedRun(stored); queuedId=run.id;
      stored.trip.agent!.runs.push(run);
      stored.trip.agent!.followUpAt=Date.now()-1;
    });
    const changed=await act(trip,action==='resume'?guardian:rider,{action});
    expect(changed.agent!.runs.find(run=>run.id===queuedId)!.status).toBe('cancelled');
    expect(changed.agent!.followUpAt).toBeNull();
    await wake(trip);
    const after=await read(trip,rider);
    expect(after.agent!.runs.find(run=>run.id===queuedId)!.steps).toHaveLength(0);
    expect(after.messages.map(message=>message.id)).toEqual(changed.messages.map(message=>message.id));
  });

  it('rejects a persisted tool call with invalid arguments before producing its effect',async()=>{
    const {rider,trip}=await fixture();
    const current=await act(trip,rider,{action:'takeover'});
    let queuedId='',stepId='';
    await mutate(trip,stored=>{
      const run=queuedRun(stored); queuedId=run.id; stepId=`${run.id}:0`;
      run.steps=[{
        id:stepId,at:Date.now(),status:'pending',
        call:{name:'send_check_in',arguments:{text:'Injected unauthorized output',recipient:'attacker.example'}} as unknown as AgentToolCall,
      }];
      stored.trip.agent!.runs.push(run);
    });
    await wake(trip);
    const after=await read(trip,rider),step=after.agent!.runs.find(run=>run.id===queuedId)!.steps.find(item=>item.id===stepId)!;
    expect(step.status).toBe('rejected'); expect(step.result?.ok).toBe(false);
    expect(after.messages.some(message=>message.text==='Injected unauthorized output')).toBe(false);
    expect(after.messages.map(message=>message.id)).toEqual(current.messages.map(message=>message.id));
  });

  it('rechecks contact consent immediately before a persisted notification tool executes',async()=>{
    const {rider,trip}=await fixture();
    await act(trip,rider,{action:'takeover'});
    let queuedId='',stepId='';
    await mutate(trip,stored=>{
      stored.trip.risk='urgent'; stored.trip.notificationConsent=false;
      const run=queuedRun(stored); queuedId=run.id; stepId=`${run.id}:0`;
      run.steps=[{id:stepId,at:Date.now(),status:'pending',call:{name:'notify_trusted_contact',arguments:{reason:'Previously planned escalation.'}}}];
      stored.trip.agent!.runs.push(run);
    });
    const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('No consented network effect allowed.'));
    await wake(trip);
    const after=await read(trip,rider),step=after.agent!.runs.find(run=>run.id===queuedId)!.steps.find(item=>item.id===stepId)!;
    expect(step.status).toBe('rejected'); expect(step.result?.ok).toBe(false);
    expect(after.notifications).toHaveLength(0);
    expect(after.risk).toBe('urgent');
    expect(network).not.toHaveBeenCalled();
  });

  it('refreshes stale context before a pending check-in when a new location arrives',async()=>{
    const {rider,trip}=await fixture();
    await mutate(trip,stored=>{stored.trip.location.updatedAt=Date.now()-180000;});
    const current=await act(trip,rider,{action:'takeover'});
    const oldContext=current.agent!.runs.flatMap(run=>run.steps).find(step=>step.call.name==='get_journey_context')!;
    expect(oldContext.result!.context!.location.stale).toBe(true);
    let queuedId='';
    await mutate(trip,stored=>{
      const run=queuedRun(stored); queuedId=run.id;
      run.steps=[
        {...structuredClone(oldContext),id:`${run.id}:0`},
        {id:`${run.id}:1`,at:Date.now(),status:'pending',call:{name:'send_check_in',arguments:{text:'Obsolete location warning proposal.'}}},
      ];
      stored.trip.agent!.runs.push(run);
    });
    const after=await act(trip,rider,{action:'location',lat:43.471,lng:-80.535});
    expect(after.agent!.runs.find(run=>run.id===queuedId)!.status).toBe('cancelled');
    expect(after.messages.some(message=>message.text==='Obsolete location warning proposal.')).toBe(false);
    const refreshed=after.agent!.runs.find(run=>run.trigger.id===`${queuedId}:refresh`)!;
    expect(refreshed.status).toBe('completed');
    expect(refreshed.steps.find(step=>step.call.name==='get_journey_context')!.result!.context!.location.stale).toBe(false);
  });

  it('does not enqueue another notification when an existing one is older than the cooldown',async()=>{
    const {rider,trip}=await fixture();
    await act(trip,rider,{action:'takeover'});
    let queuedId='',stepId='';
    const noticeId=crypto.randomUUID();
    await mutate(trip,stored=>{
      stored.trip.risk='urgent'; stored.lastNotificationAt=Date.now()-60000;
      stored.trip.notifications.push({id:noticeId,at:Date.now()-60000,status:'failed',channel:'none',message:'Existing contact workflow.',detail:'Provider did not confirm delivery.'});
      const run=queuedRun(stored); queuedId=run.id; stepId=`${run.id}:0`;
      run.steps=[{id:stepId,at:Date.now(),status:'pending',call:{name:'notify_trusted_contact',arguments:{reason:'Proposed repeat contact workflow.'}}}];
      stored.trip.agent!.runs.push(run);
    });
    const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('No duplicate contact effect allowed.'));
    await wake(trip);
    const after=await read(trip,rider),step=after.agent!.runs.find(run=>run.id===queuedId)!.steps.find(item=>item.id===stepId)!;
    expect(step.result).toMatchObject({ok:true,code:'notification_already_exists'});
    expect(after.notifications.map(notice=>notice.id)).toEqual([noticeId]);
    expect(after.notifications[0].status).toBe('failed');
    expect(network).not.toHaveBeenCalled();
  });

  it('drops a queued decision from an obsolete human-intent revision after restart',async()=>{
    const {rider,trip}=await fixture();
    const current=await act(trip,rider,{action:'takeover'});
    let queuedId='';
    await mutate(trip,stored=>{
      const run=queuedRun(stored); queuedId=run.id; run.revision=stored.assessmentVersion-1;
      stored.trip.agent!.runs.push(run);
    });
    await wake(trip);
    const after=await read(trip,rider),run=after.agent!.runs.find(item=>item.id===queuedId)!;
    expect(run.status).toBe('cancelled'); expect(run.steps).toHaveLength(0);
    expect(after.messages.map(message=>message.id)).toEqual(current.messages.map(message=>message.id));
  });

  it('persists a provider failure and retries successfully after eviction',async()=>{
    const {rider,trip}=await fixture();
    const provider=vi.spyOn(agentProvider,'nextMockDecision').mockRejectedValueOnce(new Error('Synthetic offline provider interruption.'));
    const interrupted=await act(trip,rider,{action:'takeover'});
    const pending=interrupted.agent!.runs.find(run=>run.status==='queued')!;
    expect(pending).toBeDefined();
    expect(pending.attempts).toBeGreaterThan(0);
    expect(pending.nextAttemptAt).toBeGreaterThan(Date.now());
    expect(interrupted.messages.some(message=>message.text.startsWith('Offline mock guardian:'))).toBe(false);
    await mutate(trip,stored=>{
      const run=stored.trip.agent!.runs.find(item=>item.id===pending.id)!;
      run.nextAttemptAt=Date.now()-1; run.leaseUntil=0;
    });
    await wake(trip);
    const recovered=await read(trip,rider),run=recovered.agent!.runs.find(item=>item.id===pending.id)!;
    expect(run.status).toBe('completed');
    expect(run.attempts).toBeGreaterThan(pending.attempts);
    expect(recovered.messages.filter(message=>message.text.startsWith('Offline mock guardian:'))).toHaveLength(1);
    expect(provider.mock.calls.length).toBeGreaterThan(1);
  });
});
