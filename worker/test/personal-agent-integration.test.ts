import { env, SELF, reset, runInDurableObject, runDurableObjectAlarm, evictDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as openaiProvider from '../src/openai-provider';
import { renderSemanticQuestion, type SemanticAssessment } from '../src/agent-semantic';
import {
  PERSONAL_AGENT_NOTICE_VERSION, PERSONAL_AGENT_CONNECTIVITY_MS, PERSONAL_AGENT_RESPONSE_MS,
  personalAgentConnectionSchema, personalAgentResponseSchema,
  type PersonalAgentConnection, type PersonalAgentJob, type PersonalAgentResponse, type PersonalAgentState,
} from '../src/personal-agent';
import type { Trip, TripAction, TripSummary, User } from '../src/types';

interface Session { token:string; user:User }
interface Stored {
  trip:Trip;
  assessmentVersion:number;
  personalAgent?:PersonalAgentState;
  aiNextCheckInAt:number|null;
  rewardEligible:boolean;
}
const creation = {
  origin:{label:'PRIVATE-PICKUP',lat:43.472123,lng:-80.541234},
  destination:{label:'PRIVATE-DESTINATION',lat:43.464567,lng:-80.527654},
  emergencyContact:{name:'PRIVATE-CONTACT',contact:'never-a-real-notification-recipient'},
  notificationConsent:true,checkInIntervalSeconds:300,
};
const riderText = 'We passed the blue cafe three times; I would like someone to stay with me.';
const guardianText = 'I can stay until another companion is ready.';
const agentName = 'Guardian test agent';
const requestBody = {action:'request',agentName,minutes:10,consent:true,noticeVersion:PERSONAL_AGENT_NOTICE_VERSION};

beforeEach(async()=>{
  await reset();
  vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('External network is forbidden in personal-agent integration tests.'));
  vi.spyOn(openaiProvider,'runOpenAIAssessmentWithDeadline').mockRejectedValue(new Error('Personal-agent tools must not invoke a hosted model.'));
});
afterEach(()=>{
  try{
    expect(fetch).not.toHaveBeenCalled();
    expect(openaiProvider.runOpenAIAssessmentWithDeadline).not.toHaveBeenCalled();
  }finally{vi.restoreAllMocks();}
});

function request(path:string,token?:string,body?:unknown){
  return SELF.fetch(`https://guard.test${path}`,{
    method:body===undefined?'GET':'POST',
    headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},
    body:body===undefined?undefined:JSON.stringify(body),
  });
}
async function session(name:string):Promise<Session>{
  const response=await request('/api/session',undefined,{name});expect(response.status).toBe(201);
  const user=await response.json<Session>();await env.USERS.getByName(user.user.id).acceptCommunityNotice('community-v1');return user;
}
async function action(trip:Trip,user:Session,body:TripAction):Promise<Trip>{
  const response=await request(`/api/trips/${trip.id}/actions`,user.token,body);expect(response.status).toBe(200);
  return (await response.json<{trip:Trip}>()).trip;
}
async function read(trip:Trip,user:Session):Promise<Trip>{
  const response=await request(`/api/trips/${trip.id}`,user.token);expect(response.status).toBe(200);
  return (await response.json<{trip:Trip}>()).trip;
}
async function fixture(){
  const rider=await session('Rider private account'),guardian=await session('Guardian private account');
  const response=await request('/api/trips',rider.token,creation);expect(response.status).toBe(201);
  let trip=(await response.json<{trip:Trip}>()).trip;
  const applied=await request(`/api/trips/${trip.id}/actions`,guardian.token,{action:'accept',requestId:trip.id});
  expect(applied.status).toBe(200);
  const application=(await applied.json<{trip:TripSummary}>()).trip.application!;
  trip=await action(trip,rider,{action:'approve-guardian',requestId:application.id});
  trip=await action(trip,guardian,{action:'message',text:guardianText});
  trip=await action(trip,rider,{action:'message',text:riderText});
  expect(trip.demo).toBe(false);expect(trip.guardMode).toBe('human');
  return {trip,rider,guardian};
}
const management=(trip:Trip,user:Session|undefined,body:unknown)=>request(`/api/trips/${trip.id}/delegation`,user?.token,body);
async function pending(value?:Awaited<ReturnType<typeof fixture>>){
  const f=value??await fixture();
  const response=await management(f.trip,f.guardian,requestBody);expect(response.status).toBe(200);
  const trip=(await response.json<{trip:Trip}>()).trip;
  expect(trip.personalAgent?.status).toBe('requested');
  return {...f,trip,delegationId:trip.personalAgent!.id};
}
async function issued(){
  const f=await pending();
  const approved=await management(f.trip,f.rider,{action:'approve',delegationId:f.delegationId,consent:true,noticeVersion:PERSONAL_AGENT_NOTICE_VERSION});
  expect(approved.status).toBe(200);
  const response=await management(f.trip,f.guardian,{action:'connect',delegationId:f.delegationId});
  expect(response.status).toBe(200);
  const value=await response.json<{trip:Trip;connection:PersonalAgentConnection}>();
  const connection=personalAgentConnectionSchema.parse(value.connection);
  return {...f,trip:value.trip,connection};
}
async function connected(){
  const f=await issued(),connection=f.connection;
  const accepted=await capability(connection,'accept');expect(accepted.status).toBe(200);
  const started=personalAgentResponseSchema.parse(await accepted.json());expect(started.job).not.toBeNull();
  return {...f,job:started.job!,started};
}
function capability(connection:PersonalAgentConnection,operation:string,body:unknown={},token=connection.token){
  return request(`/api/agent/trips/${connection.tripId}/delegations/${connection.delegationId}/${operation}`,token,body);
}
function assessment(job:PersonalAgentJob,overrides:Partial<SemanticAssessment>={}):SemanticAssessment{
  const source=job.context.messages.filter(message=>message.role==='rider').at(-1)!;
  return {
    findings:[{kind:'concern',topic:'route',sourceIds:[`message:${source.id}`]}],
    question:{kind:'route_explanation',sourceIds:[`message:${source.id}`]},requestRelay:true,followUpSeconds:60,...overrides,
  };
}
async function assess(connection:PersonalAgentConnection,job:PersonalAgentJob,proposal=assessment(job)):Promise<PersonalAgentResponse>{
  const response=await capability(connection,'assess',{jobId:job.id,assessment:proposal});expect(response.status).toBe(200);
  return personalAgentResponseSchema.parse(await response.json());
}
async function stored(trip:Trip):Promise<Stored>{
  return runInDurableObject(env.TRIPS.getByName(trip.id),(_instance,state)=>JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM trip_state').one().data) as Stored);
}
async function mutate(trip:Trip,change:(value:Stored)=>void){
  await runInDurableObject(env.TRIPS.getByName(trip.id),async(_instance,state)=>{
    const value=JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM trip_state').one().data) as Stored;
    change(value);state.storage.sql.exec('UPDATE trip_state SET data=?',JSON.stringify(value));
    await state.storage.setAlarm(Date.now()+60_000);
  });
}
async function expectCapabilityRejected(connection:PersonalAgentConnection,operation='status',body:unknown={}){
  const response=await capability(connection,operation,body);expect([401,403,409]).toContain(response.status);
  expect(await response.json()).not.toHaveProperty('job');
}

describe('Personal-agent participant approval and scoped capability',()=>{
  it('requires the current nonsimulated guardian, exact notice and strict request fields',async()=>{
    const f=await fixture(),outsider=await session('Unassigned outsider');
    for(const user of [f.rider,outsider,undefined])expect((await management(f.trip,user,requestBody)).status).toBe(user?403:401);
    for(const change of [{consent:false},{consent:'true'},{noticeVersion:'personal-agent-v0'},{minutes:4},{minutes:121},{minutes:5.5},{agentName:'x'.repeat(41)},{recipient:'someone'}]){
      expect((await management(f.trip,f.guardian,{...requestBody,...change})).status).toBe(400);
    }
    await mutate(f.trip,value=>{value.trip.guardian!.simulated=true;});
    expect((await management(f.trip,f.guardian,requestBody)).status).toBe(409);
    await mutate(f.trip,value=>{delete value.trip.guardian!.simulated;});
    const result=await pending(f);expect(result.trip.personalAgent).toMatchObject({ownerId:f.guardian.user.id,agentName,status:'requested',riderApprovedAt:null,connectionIssued:false});
  });

  it('requires rider approval of the exact pending request before only its owner can connect',async()=>{
    const f=await pending(),outsider=await session('Approval outsider');
    const approval={action:'approve',delegationId:f.delegationId,consent:true,noticeVersion:PERSONAL_AGENT_NOTICE_VERSION};
    expect((await management(f.trip,f.guardian,{action:'connect',delegationId:f.delegationId})).status).toBe(409);
    for(const user of [f.guardian,outsider])expect((await management(f.trip,user,approval)).status).toBe(403);
    for(const change of [{consent:false},{consent:1},{noticeVersion:'openai-assistance-v2'},{approveAll:true}])expect((await management(f.trip,f.rider,{...approval,...change})).status).toBe(400);
    expect((await management(f.trip,f.rider,{...approval,delegationId:crypto.randomUUID()})).status).toBe(409);
    expect((await management(f.trip,f.rider,approval)).status).toBe(200);
    for(const user of [f.rider,outsider])expect((await management(f.trip,user,{action:'connect',delegationId:f.delegationId})).status).toBe(403);
    const response=await management(f.trip,f.guardian,{action:'connect',delegationId:f.delegationId});expect(response.status).toBe(200);
    const value=await response.json<{trip:Trip;connection:PersonalAgentConnection}>();
    expect(personalAgentConnectionSchema.safeParse(value.connection).success).toBe(true);
    expect(value.connection).toMatchObject({origin:'https://guard.test',tripId:f.trip.id,delegationId:f.delegationId});
    expect(JSON.stringify(value.connection)).not.toContain(f.guardian.token);
    expect(JSON.stringify(value.trip)).not.toContain(value.connection.token);
  });

  it('rotates scoped tokens and prevents account sessions, wrong journeys and wrong delegations from using capability tools',async()=>{
    const f=await issued(),other=await fixture();
    const rotation=await management(f.trip,f.guardian,{action:'connect',delegationId:f.delegationId});expect(rotation.status).toBe(200);
    const fresh=(await rotation.json<{connection:PersonalAgentConnection}>()).connection;
    expect(fresh.token).not.toBe(f.connection.token);await expectCapabilityRejected(f.connection);
    expect((await capability(fresh,'status')).status).toBe(200);
    expect((await capability(fresh,'accept')).status).toBe(200);
    expect((await management(f.trip,f.guardian,{action:'connect',delegationId:f.delegationId})).status).toBe(409);
    for(const token of [f.rider.token,f.guardian.token,'shpa_'+'0'.repeat(64)])expect([401,403]).toContain((await capability(fresh,'status',{},token)).status);
    for(const bad of [{...fresh,tripId:other.trip.id},{...fresh,delegationId:crypto.randomUUID()}])await expectCapabilityRejected(bad);
    expect((await request(`/api/trips/${f.trip.id}/actions`,fresh.token,{action:'arrive'})).status).toBe(401);
    const raw=await stored(f.trip);expect(raw.personalAgent?.tokenDigest).toMatch(/^[a-f0-9]{64}$/);
    for(const value of [raw,(await read(f.trip,f.rider)),await env.TRIPS.getByName(f.trip.id).exportSnapshot()]){
      expect(JSON.stringify(value)).not.toContain(fresh.token);expect(JSON.stringify(value)).not.toContain(f.connection.token);
    }
  });

  it('rejects extra capability arguments and unsupported action tools',async()=>{
    const f=await connected();
    for(const operation of ['status','accept','updates','heartbeat'])expect((await capability(f.connection,operation,{token:f.connection.token})).status).toBe(400);
    expect((await capability(f.connection,'release',{reason:'stopped',recipient:'outsider'})).status).toBe(400);
    expect((await capability(f.connection,'assess',{jobId:f.job.id,assessment:assessment(f.job),notificationAuthorized:true})).status).toBe(400);
    for(const operation of ['notify_trusted_contact','approve-guardian','sign','award-reputation'])expect([401,404]).toContain((await capability(f.connection,operation)).status);
  });
});

describe('Personal-agent readiness, minimized evidence and one-shot effects',()=>{
  it('keeps accept and heartbeats connecting until a valid source-bound assessment arrives',async()=>{
    const f=await connected(),initial=await stored(f.trip);
    expect(f.started.delegation).toMatchObject({status:'connecting',lastProcessedAt:null,lastActionAt:null});
    expect(initial.trip.guardMode).toBe('human');expect(initial.trip.contributions[0].checkIns).toBe(0);
    const beat=await capability(f.connection,'heartbeat');expect(beat.status).toBe(200);
    const view=(await beat.json<PersonalAgentResponse>()).delegation;expect(view.status).toBe('connecting');expect(view.lastProcessedAt).toBeNull();
    const forged=assessment(f.job,{question:{kind:'route_explanation',sourceIds:['message:invented']}});
    expect((await capability(f.connection,'assess',{jobId:f.job.id,assessment:forged})).status).toBe(400);
    expect((await read(f.trip,f.rider)).personalAgent?.status).toBe('connecting');
    expect((await assess(f.connection,f.job)).delegation.status).toBe('active');
  });

  it('sends only current eligible authors and minimized evidence, never account, contact or exact location fields',async()=>{
    const f=await fixture(),pastGuardian=crypto.randomUUID(),savedId=crypto.randomUUID();
    const privateMessage='Explain the detour: person@example.com https://example.com/private token=verysecret 31.12345,121.12345';
    await action(f.trip,f.rider,{action:'message',text:privateMessage});
    await mutate(f.trip,value=>{
      value.trip.messages.push({id:crypto.randomUUID(),at:Date.now(),role:'guardian',senderId:pastGuardian,senderName:'Former guardian',text:'FORMER-GUARDIAN-SECRET'});
      value.trip.messages.push({id:crypto.randomUUID(),at:Date.now(),role:'system',senderId:'system',senderName:'System',text:'SYSTEM-SECRET'});
      value.trip.messages.push({id:crypto.randomUUID(),at:Date.now(),role:'agent',senderId:'agent',senderName:'Agent',text:'AGENT-SECRET'});
      value.trip.agent!.concerns=[{id:savedId,observedAt:Date.now()-600_000,receivedAt:Date.now()-590_000,text:'OLDER-SAVED-CONCERN person@example.com'}];
    });
    const pendingResponse=await pending(f);
    await management(f.trip,f.rider,{action:'approve',delegationId:pendingResponse.delegationId,consent:true,noticeVersion:PERSONAL_AGENT_NOTICE_VERSION});
    const connResponse=await management(f.trip,f.guardian,{action:'connect',delegationId:pendingResponse.delegationId});
    const connection=(await connResponse.json<{connection:PersonalAgentConnection}>()).connection;
    const accepted=await capability(connection,'accept');expect(accepted.status).toBe(200);
    const job=(await accepted.json<PersonalAgentResponse>()).job!,serialized=JSON.stringify(job.context);
    expect(job.context.messages.some(message=>message.text===guardianText)).toBe(true);
    expect(job.context.messages.some(message=>message.text===riderText)).toBe(true);
    expect(job.context.messages.length).toBeLessThanOrEqual(12);expect(job.context.unresolvedConcerns!.length).toBeLessThanOrEqual(8);
    expect(job.context.unresolvedConcerns).toEqual([expect.objectContaining({id:savedId,text:'OLDER-SAVED-CONCERN [redacted email]'})]);
    for(const secret of [f.rider.user.id,f.guardian.user.id,pastGuardian,f.rider.user.name,f.guardian.user.name,connection.token,
      creation.origin.label,creation.destination.label,creation.emergencyContact.contact,'31.12345','121.12345','person@example.com','https://example.com','verysecret','FORMER-GUARDIAN-SECRET','SYSTEM-SECRET','AGENT-SECRET'])expect(serialized).not.toContain(secret);
    expect(job.context.notifications).toEqual([]);expect(job.context.contactAvailable).toBe(false);
    expect(job.context).not.toHaveProperty('notificationAuthorized');expect(job.context).not.toHaveProperty('escalationCause');
  });

  it('posts the canonical cited question and actual relay receipt without contact authority or human rewards',async()=>{
    const f=await connected(),before=await read(f.trip,f.rider),proposal=assessment(f.job),response=await assess(f.connection,f.job,proposal);
    expect(response.receipt).toMatchObject({jobId:f.job.id,assessment:proposal});
    expect(response.receipt!.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({name:'send_check_in'}),expect.objectContaining({name:'request_human_relay'}),expect.objectContaining({name:'schedule_follow_up'}),
    ]));
    const current=await read(f.trip,f.rider),posted=current.messages.find(message=>message.text.includes(renderSemanticQuestion(proposal,f.job.context)));
    expect(posted).toBeDefined();expect(`${posted!.senderName} ${posted!.text}`).toContain(agentName);
    expect(current.personalAgent).toMatchObject({status:'active',lastProcessedAt:expect.any(Number),lastActionAt:expect.any(Number)});
    expect(current.guardian?.id).toBe(f.guardian.user.id);expect(current.relay).not.toBeNull();expect(current.guardianRequests).toEqual([]);
    expect(current.agent?.concerns).toEqual(expect.arrayContaining([expect.objectContaining({id:f.job.context.messages.find(item=>item.role==='rider')!.id})]));
    expect(current.notifications).toEqual(before.notifications);expect(current.escalation).toEqual(before.escalation);
    expect(current.contributions).toEqual(before.contributions);expect(current.reward).toEqual(before.reward);
    const outsider=await session('Recruitment viewer'),directory=await (await request('/api/trips',outsider.token)).json<{trips:TripSummary[]}>();
    expect(directory.trips.find(trip=>trip.id===f.trip.id)?.requestKind).toBe('relay');
    expect(JSON.stringify(directory)).not.toContain('personalAgent');expect(JSON.stringify(directory)).not.toContain(f.connection.token);
    expect(JSON.stringify(directory)).not.toContain(riderText);expect(JSON.stringify(directory)).not.toContain(guardianText);
    const ended=await action(f.trip,f.rider,{action:'arrive'});expect(ended.reward.status).toBe('ineligible');
    const profile=(await (await request('/api/me',f.guardian.token)).json<{user:User}>()).user;
    expect(profile.points).toBe(0);expect(profile.reputation).toBe(0);expect(profile.completedGuards).toBe(0);
  });

  it('returns the original receipt for identical retries across eviction and rejects changed or superseded replays',async()=>{
    const f=await connected(),proposal=assessment(f.job),first=await assess(f.connection,f.job,proposal),before=await read(f.trip,f.rider);
    await evictDurableObject(env.TRIPS.getByName(f.trip.id));
    const again=await assess(f.connection,f.job,proposal);expect(again.receipt).toEqual(first.receipt);
    const after=await read(f.trip,f.rider);
    expect(after.messages).toEqual(before.messages);expect(after.notifications).toEqual(before.notifications);expect(after.contributions).toEqual(before.contributions);
    expect(after.personalAgent?.receipts).toEqual(before.personalAgent?.receipts);expect(after.reward).toEqual(before.reward);
    expect((await capability(f.connection,'assess',{jobId:f.job.id,assessment:{...proposal,followUpSeconds:61}})).status).toBe(409);
    await action(f.trip,f.rider,{action:'message',text:'There is new information about the route.'});
    expect((await capability(f.connection,'assess',{jobId:f.job.id,assessment:proposal})).status).toBe(409);
  });

  it('serializes simultaneous identical submissions into one receipt and one set of effects',async()=>{
    const f=await connected(),proposal=assessment(f.job),before=await read(f.trip,f.rider);
    const responses=await Promise.all([capability(f.connection,'assess',{jobId:f.job.id,assessment:proposal}),capability(f.connection,'assess',{jobId:f.job.id,assessment:proposal})]);
    expect(responses.map(response=>response.status)).toEqual([200,200]);
    const values=await Promise.all(responses.map(response=>response.json<PersonalAgentResponse>()));
    expect(values[0].receipt).toEqual(values[1].receipt);
    const current=await read(f.trip,f.rider);expect(current.personalAgent?.receipts).toHaveLength(1);
    expect(current.messages.filter(message=>message.automatedBy==='personal_agent')).toHaveLength(1);
    expect((await stored(f.trip)).personalAgent?.completed).toHaveLength(1);
    expect(current.contributions).toEqual(before.contributions);expect(current.notifications).toEqual(before.notifications);
  });

  it('returns no work before the follow-up is due and creates fresh bounded work when the durable schedule becomes due',async()=>{
    const f=await connected();await assess(f.connection,f.job);
    const idle=await capability(f.connection,'updates');expect(idle.status).toBe(200);
    expect((await idle.json<PersonalAgentResponse>()).job).toBeNull();
    await mutate(f.trip,value=>{value.personalAgent!.nextJobAt=Date.now()-1;value.personalAgent!.view.lastSeenAt=Date.now();});
    const updates=await capability(f.connection,'updates');expect(updates.status).toBe(200);
    const next=(await updates.json<PersonalAgentResponse>()).job!;expect(next).not.toBeNull();expect(next.id).not.toBe(f.job.id);
    expect(next.expiresAt-next.createdAt).toBeLessThanOrEqual(PERSONAL_AGENT_RESPONSE_MS);
    expect(next.expiresAt).toBeLessThanOrEqual(f.connection.expiresAt);
    expect(next.context.unresolvedConcerns).toEqual(expect.arrayContaining([expect.objectContaining({id:f.job.context.messages.find(message=>message.role==='rider')!.id})]));
    const deadline=(await stored(f.trip)).personalAgent!.responseDeadline;
    expect((await capability(f.connection,'heartbeat')).status).toBe(200);
    expect((await stored(f.trip)).personalAgent!.responseDeadline).toBe(deadline);
  });

  it('invalidates an old job after a new rider message without extending its pending response deadline',async()=>{
    const f=await connected(),deadline=(await stored(f.trip)).personalAgent!.responseDeadline;
    await action(f.trip,f.rider,{action:'message',text:'The next turn is different from what I expected.'});
    expect((await capability(f.connection,'assess',{jobId:f.job.id,assessment:assessment(f.job)})).status).toBe(409);
    const updates=await capability(f.connection,'updates');expect(updates.status).toBe(200);
    const next=(await updates.json<PersonalAgentResponse>()).job!;expect(next).not.toBeNull();expect(next.id).not.toBe(f.job.id);
    expect(next.context.messages.at(-1)!.text).toContain('next turn');
    expect(next.expiresAt).toBeLessThanOrEqual(deadline!);expect((await stored(f.trip)).personalAgent!.responseDeadline).toBe(deadline);
  });

  it('rejects forged, guardian-as-concern and future references without consuming valid work',async()=>{
    const f=await connected(),guardian=f.job.context.messages.find(item=>item.role==='guardian')!;
    for(const sourceId of ['message:forged',`message:${guardian.id}`]){
      const proposal=assessment(f.job,{findings:[{kind:'concern',topic:'route',sourceIds:[sourceId]}]});
      expect((await capability(f.connection,'assess',{jobId:f.job.id,assessment:proposal})).status).toBe(400);
    }
    expect((await capability(f.connection,'assess',{jobId:f.job.id,assessment:{...assessment(f.job),recipient:'outsider',notificationAuthorized:true}})).status).toBe(400);
    expect((await stored(f.trip)).personalAgent!.pending?.id).toBe(f.job.id);
    await mutate(f.trip,value=>{const current=value.personalAgent!.pending!;current.context.messages.find(message=>message.role==='rider')!.at=Date.now()+10_000;});
    expect((await capability(f.connection,'assess',{jobId:f.job.id,assessment:assessment(f.job)})).status).toBe(400);
  });

  it('rechecks source age at action time while a connected job is otherwise still valid',async()=>{
    const f=await fixture();
    await mutate(f.trip,value=>{value.trip.messages.find(message=>message.role==='rider')!.at=Date.now()-299_000;});
    const p=await pending(f);
    await management(f.trip,f.rider,{action:'approve',delegationId:p.delegationId,consent:true,noticeVersion:PERSONAL_AGENT_NOTICE_VERSION});
    const connect=await management(f.trip,f.guardian,{action:'connect',delegationId:p.delegationId});
    const connection=(await connect.json<{connection:PersonalAgentConnection}>()).connection;
    const accepted=await capability(connection,'accept'),job=(await accepted.json<PersonalAgentResponse>()).job!;
    vi.spyOn(Date,'now').mockReturnValue(Date.now()+1500);
    expect((await capability(connection,'assess',{jobId:job.id,assessment:assessment(job)})).status).toBe(400);
    expect((await read(f.trip,f.rider)).personalAgent?.status).toBe('connecting');
  });
});

describe('Personal-agent revocation and durable continuity',()=>{
  it.each(['guardian resume','guardian check-in','rider revocation','guardian revocation','arrival','cancellation','assistance off','explicit help'] as const)
    ('revokes capability and pending action after %s',async(change)=>{
      const f=await connected();await assess(f.connection,f.job);
      if(change==='guardian resume')await action(f.trip,f.guardian,{action:'resume'});
      if(change==='guardian check-in')await action(f.trip,f.guardian,{action:'check-in'});
      if(change==='rider revocation'||change==='guardian revocation')expect((await management(f.trip,change==='rider revocation'?f.rider:f.guardian,{action:'revoke',delegationId:f.delegationId})).status).toBe(200);
      if(change==='arrival')await action(f.trip,f.rider,{action:'arrive'});
      if(change==='cancellation')await action(f.trip,f.rider,{action:'cancel'});
      if(change==='explicit help')await action(f.trip,f.rider,{action:'help'});
      if(change==='assistance off')expect((await request(`/api/trips/${f.trip.id}/assistance`,f.rider.token,{automatedCheckIns:false,timeoutContact:false,liveAiConsent:false,noticeVersion:'openai-assistance-v1'})).status).toBe(200);
      await expectCapabilityRejected(f.connection);await expectCapabilityRejected(f.connection,'assess',{jobId:f.job.id,assessment:assessment(f.job)});
      const value=await stored(f.trip);expect(['revoked','ended','unavailable','expired']).toContain(value.trip.personalAgent?.status);
      expect(value.personalAgent?.tokenDigest).toBeNull();expect(value.personalAgent?.pending).toBeNull();
    });

  it('withdraws permission while connecting and requires a new approved delegation cycle before reconnecting',async()=>{
    const f=await connected();
    expect((await management(f.trip,f.rider,{action:'revoke',delegationId:f.delegationId})).status).toBe(200);
    await expectCapabilityRejected(f.connection,'assess',{jobId:f.job.id,assessment:assessment(f.job)});
    const next=await pending({trip:await read(f.trip,f.rider),rider:f.rider,guardian:f.guardian});
    expect(next.delegationId).not.toBe(f.delegationId);
    expect((await management(f.trip,f.guardian,{action:'connect',delegationId:f.delegationId})).status).toBe(409);
    expect((await management(f.trip,f.guardian,{action:'connect',delegationId:next.delegationId})).status).toBe(409);
    expect((await management(f.trip,f.rider,{action:'approve',delegationId:next.delegationId,consent:true,noticeVersion:PERSONAL_AGENT_NOTICE_VERSION})).status).toBe(200);
    const response=await management(f.trip,f.guardian,{action:'connect',delegationId:next.delegationId});expect(response.status).toBe(200);
    const connection=(await response.json<{connection:PersonalAgentConnection}>()).connection;
    expect(connection.token).not.toBe(f.connection.token);await expectCapabilityRejected(f.connection);
    expect((await capability(connection,'accept')).status).toBe(200);
  });

  it('revokes the prior guardian capability after rider-approved replacement',async()=>{
    const f=await connected();await assess(f.connection,f.job);
    const replacement=await session('Replacement guardian'),current=await read(f.trip,f.rider);
    const applied=await request(`/api/trips/${f.trip.id}/actions`,replacement.token,{action:'accept',requestId:current.relay!.id});expect(applied.status).toBe(200);
    const application=(await applied.json<{trip:TripSummary}>()).trip.application!;
    const replaced=await action(f.trip,f.rider,{action:'approve-guardian',requestId:application.id});
    expect(replaced.guardian?.id).toBe(replacement.user.id);await expectCapabilityRejected(f.connection);
    expect((await management(f.trip,f.guardian,{action:'connect',delegationId:f.delegationId})).status).toBe(403);
  });

  it('treats release as loss of agent coverage and prevents reconnection with the old capability',async()=>{
    const f=await connected();await assess(f.connection,f.job);
    const released=await capability(f.connection,'release',{reason:'model_unavailable'});expect(released.status).toBe(200);
    const view=(await released.json<PersonalAgentResponse>()).delegation;expect(['unavailable','ended']).toContain(view.status);
    await expectCapabilityRejected(f.connection,'accept');expect((await stored(f.trip)).personalAgent?.tokenDigest).toBeNull();
  });

  it('heartbeats update connectivity but cannot establish readiness, earn human contribution or postpone pending work',async()=>{
    const f=await connected(),before=await stored(f.trip);
    const deadline=before.personalAgent!.responseDeadline;
    expect(deadline).not.toBeNull();expect(deadline!-f.job.createdAt).toBeLessThanOrEqual(PERSONAL_AGENT_RESPONSE_MS);
    for(let index=0;index<3;index++)expect((await capability(f.connection,'heartbeat')).status).toBe(200);
    const after=await stored(f.trip);
    expect(after.personalAgent!.view.lastSeenAt).toBeGreaterThanOrEqual(before.personalAgent!.view.lastSeenAt!);
    expect(after.personalAgent!.view.status).toBe('connecting');expect(after.personalAgent!.responseDeadline).toBe(deadline);
    expect(after.personalAgent!.pending!.expiresAt).toBe(f.job.expiresAt);
    expect(after.trip.contributions).toEqual(before.trip.contributions);expect(after.trip.lastGuardianCheckInAt).toBe(before.trip.lastGuardianCheckInAt);
    expect(after.rewardEligible).toBe(before.rewardEligible);expect(after.trip.reward).toEqual(before.trip.reward);
  });

  it('detects a 45-second disconnect from persisted state after eviction without model or human activity',async()=>{
    const f=await connected(),before=await stored(f.trip);
    await mutate(f.trip,value=>{
      value.personalAgent!.view.lastSeenAt=Date.now()-PERSONAL_AGENT_CONNECTIVITY_MS-1;
      value.personalAgent!.responseDeadline=Date.now()+30_000;value.personalAgent!.pending!.expiresAt=Date.now()+30_000;
    });
    await evictDurableObject(env.TRIPS.getByName(f.trip.id));await runDurableObjectAlarm(env.TRIPS.getByName(f.trip.id));
    const after=await stored(f.trip);expect(after.trip.personalAgent?.status).toBe('unavailable');
    expect(after.personalAgent!.tokenDigest).toBeNull();expect(after.personalAgent!.pending).toBeNull();
    expect(after.trip.contributions).toEqual(before.trip.contributions);await expectCapabilityRejected(f.connection);
  });

  it('expires the 90-second model deadline despite a recent heartbeat and rejects delayed results after recovery',async()=>{
    const f=await connected();
    await mutate(f.trip,value=>{
      value.personalAgent!.view.lastSeenAt=Date.now();value.personalAgent!.view.connectedAt=Date.now()-PERSONAL_AGENT_RESPONSE_MS-1;
      value.personalAgent!.responseDeadline=Date.now()-1;value.personalAgent!.view.nextResponseDueAt=Date.now()-1;
      value.personalAgent!.pending!.createdAt=Date.now()-PERSONAL_AGENT_RESPONSE_MS-1;value.personalAgent!.pending!.expiresAt=Date.now()-1;
    });
    await evictDurableObject(env.TRIPS.getByName(f.trip.id));await runDurableObjectAlarm(env.TRIPS.getByName(f.trip.id));
    const after=await stored(f.trip);expect(after.trip.personalAgent?.status).toBe('unavailable');
    expect(after.trip.personalAgent?.endReason).toMatch(/response|model|deadline|progress/i);
    await expectCapabilityRejected(f.connection,'assess',{jobId:f.job.id,assessment:assessment(f.job)});
    expect(after.personalAgent!.completed).toEqual([]);expect(after.trip.personalAgent?.receipts).toEqual([]);
  });

  it('expires the delegation even when connectivity and work timestamps are recent',async()=>{
    const f=await connected();
    await mutate(f.trip,value=>{value.personalAgent!.view.expiresAt=Date.now()-1;value.personalAgent!.view.lastSeenAt=Date.now();});
    await expectCapabilityRejected(f.connection);
    const current=await read(f.trip,f.rider);expect(current.personalAgent?.status).toBe('expired');
  });

  it('drops capability secrets and pending jobs from backups and never revives authority on restore',async()=>{
    const f=await connected(),stub=env.TRIPS.getByName(f.trip.id),raw=await stored(f.trip),backup=await stub.exportSnapshot();
    const serialized=JSON.stringify(backup);expect(serialized).not.toContain(f.connection.token);expect(serialized).not.toContain(raw.personalAgent!.tokenDigest!);
    expect(serialized).not.toContain(f.job.id);
    expect(await stub.validateSnapshot(backup,f.trip.id)).toBe(true);
    await runInDurableObject(stub,(_instance,state)=>state.storage.sql.exec('DELETE FROM trip_state'));
    expect(await stub.restoreSnapshot(backup!)).toBe(true);
    const restored=await read(f.trip,f.rider);expect(restored.status).toBe('cancelled');
    expect(['ended','revoked','unavailable']).toContain(restored.personalAgent?.status);
    expect((await stored(f.trip)).personalAgent?.tokenDigest??null).toBeNull();await expectCapabilityRejected(f.connection);
  });

  it('revokes capabilities and removes personal snapshots when the owning guardian is deleted',async()=>{
    const f=await connected();
    expect((await request('/api/account/delete',f.guardian.token,{confirmation:'DELETE MY ACCOUNT'})).status).toBe(200);
    await expectCapabilityRejected(f.connection);
    const current=await read(f.trip,f.rider);expect(current.guardian).toBeNull();
    const serialized=JSON.stringify(await stored(f.trip));expect(serialized).not.toContain(f.connection.token);expect(serialized).not.toContain(guardianText);
  });
});
