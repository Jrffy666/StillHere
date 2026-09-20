import { env, SELF, runInDurableObject, runDurableObjectAlarm, evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as openaiProvider from '../src/openai-provider';
import * as aiRuntime from '../src/ai-runtime';
import type { AgentDecision } from '../src/agent';
import type { CodexDemoExportFile, CodexDemoJob, CodexDemoResult } from '../src/codex-demo';
import { tripSnapshotSchema } from '../src/snapshots';
import type { Trip, TripAction, TripSummary, User, WorkerEnv } from '../src/types';

interface Session { token:string; user:User }
interface Stored {trip:Trip;assessmentVersion:number;codexDemoJob?:CodexDemoJob;paidAiBudget?:unknown;aiNextCheckInAt:number|null}
const consent={consent:true,syntheticOnly:true,noticeVersion:'codex-demo-v1'};
const riderText='We passed the blue cafe three times; I would like someone to stay with me.';
const guardianText='GUARDIAN-PRIVATE-MESSAGE never belongs in the local export.';
const input={origin:{label:'Private pickup',lat:43.472,lng:-80.54},destination:{label:'Private destination',lat:43.464,lng:-80.52},
  emergencyContact:{name:'Private contact',contact:'test-only-recipient'},notificationConsent:true,checkInIntervalSeconds:300};

beforeEach(async()=>{
  await reset();
  vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Network is forbidden in the local Codex integration suite.'));
});
afterEach(()=>vi.restoreAllMocks());

async function request(path:string,user?:Session,body?:unknown){
  return SELF.fetch(`https://guard.test${path}`,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(user?{Authorization:`Bearer ${user.token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
}
async function session(name:string):Promise<Session>{
  const response=await request('/api/session',undefined,{name});expect(response.status).toBe(201);
  const value=await response.json<Session>();await env.USERS.getByName(value.user.id).acceptCommunityNotice('community-v1');return value;
}
async function act(trip:Trip,user:Session,action:TripAction):Promise<Trip>{
  const response=await request(`/api/trips/${trip.id}/actions`,user,action);expect(response.status).toBe(200);
  return (await response.json<{trip:Trip}>()).trip;
}
async function read(trip:Trip,user:Session):Promise<Trip>{
  const response=await request(`/api/trips/${trip.id}`,user);expect(response.status).toBe(200);return (await response.json<{trip:Trip}>()).trip;
}
async function fixture(){
  const rider=await session('Rider'),guardian=await session('Guardian');
  const response=await request('/api/trips',rider,input);expect(response.status).toBe(201);
  let trip=(await response.json<{trip:Trip}>()).trip;
  const applied=await request(`/api/trips/${trip.id}/actions`,guardian,{action:'accept',requestId:trip.id});expect(applied.status).toBe(200);
  trip=await act(trip,rider,{action:'approve-guardian',requestId:(await applied.json<{trip:TripSummary}>()).trip.application!.id});
  await act(trip,guardian,{action:'message',text:guardianText});
  await act(trip,rider,{action:'message',text:riderText});
  trip=await act(trip,rider,{action:'takeover'});
  return {trip,rider,guardian};
}
const route=(trip:Trip,operation:string)=>`/api/trips/${trip.id}/codex-demo/${operation}`;
async function exportJob(trip:Trip,rider:Session):Promise<CodexDemoExportFile>{
  const response=await request(route(trip,'export'),rider,consent);expect(response.status).toBe(200);
  return (await response.json<{request:CodexDemoExportFile;trip:Trip}>()).request;
}
function localResult(job:CodexDemoExportFile):CodexDemoResult{
  const source=job.context.messages.filter(item=>item.role==='rider').at(-1)!;
  return {version:1,kind:'safety-guard-codex-result',jobId:job.jobId,
    assessment:{findings:[{kind:'concern',topic:'route',sourceIds:[`message:${source.id}`]}],question:{kind:'route_explanation',sourceIds:[`message:${source.id}`]},requestRelay:true,followUpSeconds:60},
    execution:{tool:'codex-cli',auth:'chatgpt',cliVersion:'0.1.test',completedAt:Date.now(),usage:{inputTokens:120,outputTokens:40,cachedInputTokens:20}}};
}
async function stored(trip:Trip):Promise<Stored>{
  return runInDurableObject(env.TRIPS.getByName(trip.id),(_instance,state)=>JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM trip_state').one().data) as Stored);
}
async function mutate(trip:Trip,change:(value:Stored)=>void){
  await runInDurableObject(env.TRIPS.getByName(trip.id),async(_instance,state)=>{
    const value=JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM trip_state').one().data) as Stored;change(value);
    state.storage.sql.exec('UPDATE trip_state SET data=?',JSON.stringify(value));await state.storage.setAlarm(Date.now()+100);
  });
}
async function configured(trip:Trip,operation:()=>Promise<void>){
  const changes={OPENAI_ENABLED:'true',OPENAI_API_KEY:'dummy-never-dispatch-local-demo-key',OPENAI_MODEL:'gpt-4.1-mini-2025-04-14'};
  const stub=env.TRIPS.getByName(trip.id);
  const before=await runInDurableObject(stub,instance=>{
    const bindings=(instance as unknown as {env:WorkerEnv}).env;
    const values=Object.fromEntries(Object.keys(changes).map(key=>[key,bindings[key as keyof WorkerEnv]]));Object.assign(bindings,changes);return values;
  });
  try{await operation();}finally{await runInDurableObject(stub,instance=>{
    const bindings=(instance as unknown as {env:Record<string,unknown>}).env;
    for(const key of Object.keys(changes)){if(before[key]===undefined)delete bindings[key];else bindings[key]=before[key];}
  });}
}

describe('Manually imported local Codex demo',()=>{
  it('exports only minimized rider evidence while keeping authority context private and strict consent explicit',async()=>{
    const {trip,rider,guardian}=await fixture();
    const coordinates='37.123456, -122.123456',wallet='23f7UAfNbQCGdfQbJV3Tois98dETDfXnAXgjE5qTH5gb';
    await act(trip,guardian,{action:'resume'});
    await act(trip,rider,{action:'message',text:`${riderText} Coordinates ${coordinates}; wallet ${wallet}.`});
    await act(trip,rider,{action:'takeover'});
    for(const invalid of [{...consent,consent:false},{...consent,syntheticOnly:false},{...consent,noticeVersion:'openai-assistance-v2'},{...consent,guardianConsent:true}]){
      expect((await request(route(trip,'export'),rider,invalid)).status).toBe(400);
    }
    const job=await exportJob(trip,rider),json=JSON.stringify(job);
    expect(job.expiresAt-job.createdAt).toBe(300000);
    expect(job.context.messages.every(message=>message.role==='rider')).toBe(true);
    for(const privateValue of [guardianText,input.origin.label,input.emergencyContact.contact,coordinates,'37.123456','-122.123456',wallet,'authorityContext'])expect(json).not.toContain(privateValue);
    const current=await read(trip,rider);
    expect(current.codexDemo).toEqual({id:job.jobId,status:'pending',expiresAt:job.expiresAt});
    expect(Object.keys(current.codexDemo!).sort()).toEqual(['expiresAt','id','status']);
    expect((await stored(trip)).codexDemoJob?.authorityContext.messages.some(message=>message.text===guardianText)).toBe(true);
    expect(tripSnapshotSchema.safeParse(await env.TRIPS.getByName(trip.id).exportSnapshot()).success).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('executes a cited local plan with an actual fresh context receipt, unverified metadata and no API request or new authority',async()=>{
    const {trip,rider,guardian}=await fixture();
    await act(trip,rider,{action:'cancel-relay',requestId:trip.relay!.id});
    expect((await request(`/api/trips/${trip.id}/ai-consent`,rider,{consent:true,noticeVersion:'openai-assistance-v2'})).status).toBe(200);
    const provider=vi.spyOn(openaiProvider,'runOpenAIAssessmentWithDeadline').mockRejectedValue(new Error('Local import must not dispatch this provider.'));
    await configured(trip,async()=>{
      const before=await read(trip,rider),job=await exportJob(trip,rider);
      expect(before.agent?.concerns??[]).toEqual([]);
      const response=await request(route(trip,'import'),rider,localResult(job));expect(response.status).toBe(200);
      const current=(await response.json<{trip:Trip}>()).trip,run=current.agent!.runs.at(-1)!;
      expect(current.codexDemo?.status).toBe('consumed');
      expect(current.agent).toMatchObject({provider:'codex_local',liveModel:false,structuredHandoff:{mode:'codex_demo'}});
      expect(run).toMatchObject({provider:'codex_local',status:'completed',trigger:{kind:'codex-import'},semantic:{source:'codex_local',jobId:job.jobId,execution:{tool:'codex-cli',auth:'chatgpt'}}});
      expect(run.steps[0]).toMatchObject({call:{name:'get_journey_context'},status:'succeeded',result:{ok:true,context:{guardMode:'ai'}}});
      expect(run.steps[0].at).toBeGreaterThanOrEqual(job.createdAt);
      expect(run.steps.map(step=>step.call.name)).toEqual(['get_journey_context','send_check_in','request_human_relay','schedule_follow_up']);
      const message=current.messages.filter(item=>item.automatedBy==='codex_local').at(-1)!;
      expect(message.text).toContain('imported, unverified');expect(message.text).toContain('blue cafe');
      expect(current.agent?.handoffSummary).toContain('unverified execution metadata');
      expect(current.agent?.concerns).toEqual([expect.objectContaining({id:job.context.messages.at(-1)!.id,text:riderText})]);
      expect(current.escalation).toEqual(before.escalation);expect(current.risk).toBe(before.risk);
      expect(current.notifications).toEqual(before.notifications);expect(current.contributions).toEqual(before.contributions);
      expect(current.guardian?.id).toBe(guardian.user.id);expect(current.guardianRequests).toEqual([]);
      expect(current.relay).not.toBeNull();expect(current.reward).toEqual(before.reward);
      expect(run.semanticAttempt).toBeUndefined();expect((await stored(trip)).paidAiBudget).toBeUndefined();
      for(const key of ['responseId','model','requestId','promptVersion','usage'])expect(run.semantic).not.toHaveProperty(key);
      expect(JSON.stringify(current)).not.toContain('dummy-never-dispatch-local-demo-key');
      expect(tripSnapshotSchema.safeParse(await env.TRIPS.getByName(trip.id).exportSnapshot()).success).toBe(true);
      expect(provider).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
    });
  });

  it('keeps a manual export across eviction, uses a new lease after 20 seconds, and rejects replay across another eviction',async()=>{
    const {trip,rider}=await fixture(),job=await exportJob(trip,rider);
    await evictDurableObject(env.TRIPS.getByName(trip.id));
    vi.spyOn(Date,'now').mockReturnValue(job.createdAt+20000);
    const result=localResult(job),response=await request(route(trip,'import'),rider,result);expect(response.status).toBe(200);
    const current=(await response.json<{trip:Trip}>()).trip,run=current.agent!.runs.at(-1)!;
    expect(run.createdAt).toBe(job.createdAt+20000);expect(run.steps[0].result?.context?.now).toBe(run.createdAt);
    await evictDurableObject(env.TRIPS.getByName(trip.id));
    expect((await request(route(trip,'import'),rider,result)).status).toBe(409);
    expect((await read(trip,rider)).messages.filter(message=>message.automatedBy==='codex_local')).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('denies export, import and cancellation to guardians, outsiders and unauthenticated callers',async()=>{
    const {trip,rider,guardian}=await fixture(),outsider=await session('Outsider'),job=await exportJob(trip,rider);
    for(const caller of [guardian,outsider,undefined])for(const [operation,body] of [['export',consent],['import',localResult(job)],['cancel',{jobId:job.jobId}]] as const){
      expect((await request(route(trip,operation),caller,body)).status).toBe(caller?403:401);
    }
    expect((await read(trip,rider)).codexDemo?.status).toBe('pending');expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an expired export and releases its pending status without running a provider',async()=>{
    const {trip,rider}=await fixture(),job=await exportJob(trip,rider),result=localResult(job);
    vi.spyOn(Date,'now').mockReturnValue(job.expiresAt);
    expect((await request(route(trip,'import'),rider,result)).status).toBe(409);
    expect((await read(trip,rider)).codexDemo?.status).toBe('cancelled');
    expect((await stored(trip)).trip.agent?.runs.some(run=>run.provider==='codex_local')).toBe(false);expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['rider message','guardian message','rider check-in','new location','guardian resume','explicit help','automation disabled','journey closed','manual cancel','new export'] as const)
    ('rejects the old import after %s',async(change)=>{
      const {trip,rider,guardian}=await fixture(),job=await exportJob(trip,rider),result=localResult(job);
      if(change==='rider message')await act(trip,rider,{action:'message',text:'I am okay now.'});
      if(change==='guardian message')await act(trip,guardian,{action:'message',text:'New guardian context.'});
      if(change==='rider check-in')await act(trip,rider,{action:'check-in'});
      if(change==='new location'){
        vi.spyOn(Date,'now').mockReturnValue(Date.now()+1000);
        await act(trip,rider,{action:'location',lat:44,lng:-80});
      }
      if(change==='guardian resume')await act(trip,guardian,{action:'resume'});
      if(change==='explicit help')await act(trip,rider,{action:'help'});
      if(change==='automation disabled')expect((await request(`/api/trips/${trip.id}/assistance`,rider,{automatedCheckIns:false,timeoutContact:false,liveAiConsent:false,noticeVersion:'openai-assistance-v1'})).status).toBe(200);
      if(change==='journey closed')await act(trip,rider,{action:'cancel'});
      if(change==='manual cancel')expect((await request(route(trip,'cancel'),rider,{jobId:job.jobId})).status).toBe(200);
      if(change==='new export')await exportJob(trip,rider);
      expect((await request(route(trip,'import'),rider,result)).status).toBe(409);
      expect((await read(trip,rider)).messages.some(message=>message.automatedBy==='codex_local')).toBe(false);expect(fetch).not.toHaveBeenCalled();
    });

  it.each(['human monitoring','automation disabled','explicit help','closed journey'] as const)('refuses export during %s',async(condition)=>{
    const {trip,rider,guardian}=await fixture();
    if(condition==='human monitoring')await act(trip,guardian,{action:'resume'});
    if(condition==='automation disabled')await request(`/api/trips/${trip.id}/assistance`,rider,{automatedCheckIns:false,timeoutContact:false,liveAiConsent:false,noticeVersion:'openai-assistance-v1'});
    if(condition==='explicit help')await act(trip,rider,{action:'help'});
    if(condition==='closed journey')await act(trip,rider,{action:'cancel'});
    expect((await request(route(trip,'export'),rider,consent)).status).toBe(409);expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects invented sources, guardian citations, and injected dispatch fields without consuming the valid job',async()=>{
    const {trip,rider}=await fixture(),job=await exportJob(trip,rider),result=localResult(job);
    const guardianSource=trip.messages.find(item=>item.role==='guardian')!;
    for(const id of ['message:invented',`message:${guardianSource.id}`]){
      const invalid=structuredClone(result);invalid.assessment.question.sourceIds=[id];
      expect((await request(route(trip,'import'),rider,invalid)).status).toBe(400);
    }
    expect((await request(route(trip,'import'),rider,{...result,tool:{name:'notify_trusted_contact'},summary:'Help dispatched.'})).status).toBe(400);
    const invalidExecution={...result,execution:{...result.execution,verified:true,responseId:'fabricated'}};
    expect((await request(route(trip,'import'),rider,invalidExecution)).status).toBe(400);
    expect((await read(trip,rider)).codexDemo?.status).toBe('pending');
    expect((await request(route(trip,'import'),rider,result)).status).toBe(200);expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a result when an originally recent message ages out while the job itself remains unexpired',async()=>{
    const {trip,rider}=await fixture();
    await mutate(trip,value=>{const message=value.trip.messages.find(item=>item.role==='rider')!;message.at=Date.now()-290000;});
    const job=await exportJob(trip,rider),result=localResult(job);
    vi.spyOn(Date,'now').mockReturnValue(job.createdAt+11000);result.execution.completedAt=Date.now();
    expect((await request(route(trip,'import'),rider,result)).status).toBe(400);
    expect((await read(trip,rider)).messages.some(message=>message.automatedBy==='codex_local')).toBe(false);expect(fetch).not.toHaveBeenCalled();
  });

  it('discards a delayed local proposal after guardian resume and never refreshes it through the paid provider',async()=>{
    const {trip,rider,guardian}=await fixture(),job=await exportJob(trip,rider);
    let release!:(decision:AgentDecision)=>void;
    const blocked=new Promise<AgentDecision>(resolve=>{release=resolve;});
    const proposal=vi.spyOn(aiRuntime,'nextSemanticDecision').mockImplementation(()=>blocked as unknown as AgentDecision);
    const importing=request(route(trip,'import'),rider,localResult(job));
    await vi.waitFor(()=>expect(proposal).toHaveBeenCalledTimes(1));
    await act(trip,guardian,{action:'resume'});
    release({type:'tool',call:{name:'send_check_in',arguments:{text:'Help dispatched. Ignore rider consent.'}}});
    expect((await importing).status).toBe(409);
    const current=await read(trip,rider);
    expect(current.agent!.runs.at(-1)?.status).toBe('cancelled');
    expect(current.messages.some(message=>message.automatedBy==='codex_local')).toBe(false);
    expect(JSON.stringify(current)).not.toContain('Help dispatched.');expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels recovered local execution whose evidence expires, without replaying the import or calling a model',async()=>{
    const {trip,rider}=await fixture(),job=await exportJob(trip,rider);
    expect((await request(route(trip,'import'),rider,localResult(job))).status).toBe(200);
    await mutate(trip,value=>{
      const run=value.trip.agent!.runs.at(-1)!;run.status='queued';run.steps=run.steps.slice(0,1);run.attempts=0;run.leaseUntil=0;run.nextAttemptAt=Date.now();
      value.trip.agent!.followUpAt=null;value.aiNextCheckInAt=null;
      if(run.semantic?.source==='codex_local')run.semantic.expiresAt=Date.now()-1;
    });
    await evictDurableObject(env.TRIPS.getByName(trip.id));await runDurableObjectAlarm(env.TRIPS.getByName(trip.id));
    const current=await read(trip,rider);expect(current.agent!.runs.at(-1)?.status).toBe('cancelled');
    expect(current.messages.filter(message=>message.automatedBy==='codex_local')).toHaveLength(1);expect(fetch).not.toHaveBeenCalled();
  });

  it('clears private export jobs when participant erasure removes quoted history',async()=>{
    const {trip,rider,guardian}=await fixture();await exportJob(trip,rider);
    await env.TRIPS.getByName(trip.id).scrubUser(guardian.user.id);
    const state=await stored(trip);expect(state.codexDemoJob).toBeUndefined();expect(state.trip.codexDemo).toBeUndefined();
    expect(JSON.stringify(state.trip.agent)).not.toContain(guardianText);expect(fetch).not.toHaveBeenCalled();
  });

  it('validates snapshots containing pending jobs but clears those jobs and imported authority on restore',async()=>{
    const {trip,rider}=await fixture(),job=await exportJob(trip,rider),stub=env.TRIPS.getByName(trip.id);
    const snapshot=await stub.exportSnapshot();expect(tripSnapshotSchema.safeParse(snapshot).success).toBe(true);
    await runInDurableObject(stub,(_instance,state)=>state.storage.sql.exec('DELETE FROM trip_state'));
    expect(await stub.restoreSnapshot(snapshot!)).toBe(true);
    const current=await read(trip,rider);expect(current.codexDemo).toBeUndefined();expect(current.agent?.runs).toEqual([]);
    expect((await stored(trip)).codexDemoJob).toBeUndefined();
    expect((await request(route(trip,'import'),rider,localResult(job))).status).toBe(409);expect(fetch).not.toHaveBeenCalled();
  });
});
