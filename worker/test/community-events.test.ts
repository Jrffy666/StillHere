import { env, SELF, reset, runInDurableObject, runDurableObjectAlarm, evictDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import type { User, Trip, TripSummary, WorkerEnv } from '../src/types';
import type { CommunityMemberLedger, CommunityRecordView } from '../src/community-types';
import type { TripRoom } from '../src/trips';
import type { PersonalAgentConnection, PersonalAgentResponse } from '../src/personal-agent';

interface Session {user:User;token:string}
const input={origin:{label:'Private origin marker',lat:43.4723,lng:-80.5449},destination:{label:'Private destination marker',lat:43.4643,lng:-80.5204},shareUrl:'https://trip.uber.com/private-invitation-marker',emergencyContact:{name:'Private contact marker',contact:'private-contact@example.invalid'},notificationConsent:false,checkInIntervalSeconds:60};
beforeEach(async()=>{await reset();});
const request=(path:string,session?:Session,body?:unknown)=>SELF.fetch(`https://guard.test/api${path}`,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(session?{Authorization:`Bearer ${session.token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
async function session(name:string,notice=true):Promise<Session>{
  const response=await request('/session',undefined,{name});expect(response.status).toBe(201);const value=await response.json<Session>();
  if(notice){const accepted=await request('/me/community-notice',value,{version:'community-v1'});expect(accepted.status).toBe(200);value.user=(await accepted.json<{user:User}>()).user;}
  return value;
}
async function create(rider:Session):Promise<Trip>{const response=await request('/trips',rider,input);expect(response.status).toBe(201);return (await response.json<{trip:Trip}>()).trip;}
async function act(trip:Trip,person:Session,action:string,extra:Record<string,unknown>={}):Promise<Trip>{const response=await request(`/trips/${trip.id}/actions`,person,{action,...extra});expect(response.status).toBe(200);return (await response.json<{trip:Trip}>()).trip;}
async function assign(trip:Trip,rider:Session,guardian:Session,requestId=trip.id):Promise<Trip>{
  const response=await request(`/trips/${trip.id}/actions`,guardian,{action:'accept',requestId});expect(response.status).toBe(200);
  const pending=(await response.json<{trip:TripSummary}>()).trip;
  return act(trip,rider,'approve-guardian',{requestId:pending.application!.id});
}
async function records(trip:Trip,viewer:Session){const response=await request(`/trips/${trip.id}/community`,viewer);expect(response.status).toBe(200);return (await response.json<{community:{enabled:boolean;journeyId:string|null;records:CommunityRecordView[];nextCursor:string|null}}>()).community;}
async function profile(member:Session,viewer:Session){const response=await request(`/members/${member.user.id}/records`,viewer);expect(response.status).toBe(200);return response.json<{ledger:CommunityMemberLedger;legacy:{points:number;reputation:number;contributions:number;banners:number}}>();}
async function personalRuntime(trip:Trip,rider:Session,guardian:Session){
  const manage=(actor:Session,body:unknown)=>request(`/trips/${trip.id}/delegation`,actor,body);
  const requested=await manage(guardian,{action:'request',agentName:'Private agent name marker',minutes:30,consent:true,noticeVersion:'personal-agent-v1'});expect(requested.status).toBe(200);
  const delegationId=(await requested.json<{trip:Trip}>()).trip.personalAgent!.id;
  expect((await manage(rider,{action:'approve',delegationId,consent:true,noticeVersion:'personal-agent-v1'})).status).toBe(200);
  const connected=await manage(guardian,{action:'connect',delegationId});expect(connected.status).toBe(200);
  const connection=(await connected.json<{connection:PersonalAgentConnection}>()).connection;
  const tool=(operation:string,body:unknown={})=>SELF.fetch(`https://guard.test/api/agent/trips/${trip.id}/delegations/${delegationId}/${operation}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${connection.token}`},body:JSON.stringify(body)});
  const accepted=await tool('accept');expect(accepted.status).toBe(200);const job=(await accepted.json<PersonalAgentResponse>()).job!;
  const proposal={jobId:job.id,assessment:{findings:[],question:{kind:'none',sourceIds:[]},requestRelay:false,followUpSeconds:60}};
  const activate=async()=>{const response=await tool('assess',proposal);expect(response.status).toBe(200);return response.json<PersonalAgentResponse>();};
  return {connection,delegationId,tool,activate};
}
async function failPublication(trip:Trip,lostAcknowledgement=false){
  await runInDurableObject(env.TRIPS.getByName(trip.id),async instance=>{
    const target=instance as unknown as {env:WorkerEnv},namespace=target.env.COMMUNITY;
    target.env={...target.env,COMMUNITY:new Proxy(namespace,{get(value,key){if(key==='getByName')return(name:string)=>{
      const stub=value.getByName(name);return new Proxy(stub,{get(inner,property){if(property==='append')return async (...args:Parameters<typeof inner.append>)=>{if(lostAcknowledgement)await inner.append(...args);throw new Error('Injected publication interruption');};const original=Reflect.get(inner,property);return typeof original==='function'?original.bind(inner):original;}});
    };const original=Reflect.get(value,key);return typeof original==='function'?original.bind(value):original;}})};
  });
}
async function makeSourceDue(trip:Trip){await runInDurableObject(env.TRIPS.getByName(trip.id),async(_instance,state)=>{state.storage.sql.exec('UPDATE community_source SET retry_at=0 WHERE delivered=0');await state.storage.setAlarm(Date.now()+100);});}

describe('Mandatory community business events',()=>{
  it('records validated personal service once, then human return before the genuine check-in, with no agent awards or private identifiers',async()=>{
    const rider=await session('Rider'),guardian=await session('Guardian'),trip=await create(rider);await assign(trip,rider,guardian);
    const runtime=await personalRuntime(trip,rider,guardian);
    expect((await records(trip,rider)).records.some(item=>item.event.kind==='agent_service')).toBe(false);
    await runtime.tool('heartbeat');await runtime.activate();await runtime.activate();await runtime.tool('heartbeat');
    const active=await records(trip,rider),service=active.records.filter(item=>item.event.kind==='agent_service');
    expect(service).toHaveLength(1);expect(service[0]).toMatchObject({points:0,reputation:0,event:{value:0,assignment:1}});
    expect(service[0].event.actorId).toBe(service[0].event.subjectId);
    expect((await profile(guardian,rider)).ledger.pending).toMatchObject({points:0,reputation:0,contributions:0,banners:0});
    const serialized=JSON.stringify(active);
    for(const secret of [guardian.user.id,rider.user.id,trip.id,runtime.connection.token,runtime.delegationId,'Private agent name marker',input.origin.label,input.emergencyContact.contact])expect(serialized).not.toContain(secret);
    await act(trip,guardian,'resume');
    const resumed=(await records(trip,rider)).records;
    expect(resumed.slice(-2).map(item=>[item.event.kind,item.event.value])).toEqual([['agent_service',3],['check_in',0]]);
    await act(trip,rider,'arrive');
    expect((await profile(guardian,rider)).ledger.pending).toMatchObject({points:25,reputation:10,contributions:1,banners:0});
  });

  it('ends automated-only service before arrival and never turns it into contribution or banner eligibility',async()=>{
    const rider=await session('Rider'),guardian=await session('Guardian'),trip=await create(rider);await assign(trip,rider,guardian);
    const runtime=await personalRuntime(trip,rider,guardian);await runtime.activate();await act(trip,rider,'arrive');
    const history=(await records(trip,rider)).records;
    expect(history.map(item=>item.event.kind)).toEqual(['created','assigned','agent_service','agent_service','closed']);
    expect(history[3].event).toMatchObject({actorId:'0'.repeat(64),assignment:1,value:1});
    expect(history.every(item=>item.points===0&&item.reputation===0)).toBe(true);
    expect((await request(`/trips/${trip.id}/gratitude`,rider,{guardianId:guardian.user.id,kind:'companionship'})).status).toBe(409);
    expect((await profile(guardian,rider)).ledger.pending).toMatchObject({points:0,reputation:0,contributions:0,banners:0});
  });

  it('publishes unavailable service before automated relay and does not duplicate the stop on later reads',async()=>{
    const rider=await session('Rider'),guardian=await session('Guardian'),trip=await create(rider);await assign(trip,rider,guardian);
    const runtime=await personalRuntime(trip,rider,guardian);await runtime.activate();
    expect((await runtime.tool('release',{reason:'model_unavailable'})).status).toBe(200);
    const history=(await records(trip,rider)).records;
    expect(history.slice(-2).map(item=>[item.event.kind,item.event.value])).toEqual([['agent_service',2],['relay_requested',1]]);
    expect(history.at(-2)!.event.actorId).toBe('0'.repeat(64));
    expect((await records(trip,rider)).records).toEqual(history);
  });

  it('ends service against the former assignment before recording the replacement',async()=>{
    const rider=await session('Rider'),a=await session('Former guardian'),b=await session('New guardian'),trip=await create(rider);await assign(trip,rider,a);
    const runtime=await personalRuntime(trip,rider,a);await runtime.activate();
    const relay=await act(trip,rider,'request-relay');await assign(trip,rider,b,relay.relay!.id);
    const history=(await records(trip,rider)).records;
    expect(history.slice(-2).map(item=>[item.event.kind,item.event.assignment,item.event.value])).toEqual([['agent_service',1,1],['assigned',2,0]]);
    const start=history.find(item=>item.event.kind==='agent_service')!;
    expect(history.at(-2)!.event.subjectId).toBe(start.event.subjectId);
    expect(history.at(-1)!.event.subjectId).not.toBe(start.event.subjectId);
  });

  it('retains an anonymous service-end event after deletion removes its owner mapping',async()=>{
    const rider=await session('Rider'),guardian=await session('Guardian'),trip=await create(rider);await assign(trip,rider,guardian);
    const runtime=await personalRuntime(trip,rider,guardian);await runtime.activate();
    const started=(await records(trip,rider)).records.find(item=>item.event.kind==='agent_service')!;
    expect((await request('/account/delete',guardian,{confirmation:'DELETE MY ACCOUNT'})).status).toBe(200);
    const history=(await records(trip,rider)).records,service=history.filter(item=>item.event.kind==='agent_service');
    expect(service.map(item=>item.event.value)).toEqual([0,1]);
    expect(service[1].event).toMatchObject({subjectId:started.event.subjectId,actorId:'0'.repeat(64),assignment:1});
    expect(JSON.stringify(history)).not.toContain(guardian.user.id);
    expect((await env.TRIPS.getByName(trip.id).exportSnapshot())!.community!.members[guardian.user.id]).toBeUndefined();
  });

  it('restoring an active-service backup appends a stop before forced closure without restoring capability authority',async()=>{
    const rider=await session('Rider'),guardian=await session('Guardian'),trip=await create(rider);await assign(trip,rider,guardian);
    const runtime=await personalRuntime(trip,rider,guardian);await runtime.activate();
    const room=env.TRIPS.getByName(trip.id),backup=(await room.exportSnapshot())!;
    expect(backup.personalAgent).toBeUndefined();
    await runInDurableObject(room,(_instance,state)=>{state.storage.sql.exec('DELETE FROM trip_state');});
    expect(await room.restoreSnapshot(backup)).toBe(true);
    const history=(await records(trip,rider)).records;
    expect(history.slice(-2).map(item=>[item.event.kind,item.event.value])).toEqual([['agent_service',1],['closed',2]]);
    expect((await runtime.tool('heartbeat')).status).toBe(401);
    expect((await room.exportSnapshot())!.trip.personalAgent?.status).toBe('ended');
  });

  it('requires explicit notice for new real journeys and volunteers, while demos remain available',async()=>{
    const rider=await session('Rider',false),guardian=await session('Guardian',false);
    expect((await request('/trips',rider,input)).status).toBe(409);
    expect((await request('/me/community-notice',rider,{version:'wrong'})).status).toBe(400);
    expect((await request('/me/community-notice',undefined,{version:'community-v1'})).status).toBe(401);
    const demoResponse=await request('/demo/start',rider,{});expect(demoResponse.status).toBe(201);
    const demo=(await demoResponse.json<{trip:Trip}>()).trip;
    expect(await records(demo,rider)).toMatchObject({enabled:false,journeyId:null,records:[]});
    expect(await env.USERS.getByName(rider.user.id).communityIdentity()).toBeNull();
    expect((await request('/me/community-notice',rider,{version:'community-v1'})).status).toBe(200);
    const firstIdentity=await env.USERS.getByName(rider.user.id).communityIdentity();
    expect((await request('/me/community-notice',rider,{version:'community-v1'})).status).toBe(200);
    expect(await env.USERS.getByName(rider.user.id).communityIdentity()).toEqual(firstIdentity);
    const trip=await create(rider);
    expect((await request(`/trips/${trip.id}/actions`,guardian,{action:'accept',requestId:trip.id})).status).toBe(409);
    expect((await request('/me/community-notice',guardian,{version:'community-v1'})).status).toBe(200);
    await assign(trip,rider,guardian);await act(trip,guardian,'check-in');await act(trip,rider,'cancel');
    expect((await records(trip,rider)).records.map(item=>item.event.kind)).toEqual(['created','assigned','check_in','closed']);
  });

  it('preserves A-B-A assignments, check-ins, accepted handoffs and one canonical contribution per guardian',async()=>{
    const rider=await session('Rider'),a=await session('First guardian'),b=await session('Second guardian'),stranger=await session('Stranger'),trip=await create(rider);
    await assign(trip,rider,a);await act(trip,a,'check-in');
    const relay1=await act(trip,a,'request-relay');await assign(trip,rider,b,relay1.relay!.id);await act(trip,b,'check-in');
    const relay2=await act(trip,rider,'request-relay');await assign(trip,rider,a,relay2.relay!.id);await act(trip,a,'check-in');
    const ended=await act(trip,rider,'arrive');
    expect((await request(`/trips/${trip.id}`,b)).status).toBe(403);
    expect((await request(`/trips/${trip.id}/community`,stranger)).status).toBe(403);
    expect((await request(`/trips/${trip.id}/community`)).status).toBe(401);
    const history=await records(trip,b),events=history.records.map(item=>item.event);
    expect(events.map(event=>event.sequence)).toEqual(events.map((_,index)=>index));
    expect(events.filter(event=>event.kind==='assigned').map(event=>event.assignment)).toEqual([1,2,3]);
    expect(events.filter(event=>event.kind==='contribution')).toHaveLength(2);
    expect(events.filter(event=>event.kind==='check_in')).toHaveLength(3);
    expect(history.records.every(record=>record.evidence==='platform_attested'&&record.status==='pending')).toBe(true);
    const publicText=JSON.stringify(history);
    for(const forbidden of [trip.id,rider.user.id,a.user.id,b.user.id,rider.token,a.token,input.origin.label,input.destination.label,input.shareUrl,input.emergencyContact.contact])expect(publicText).not.toContain(forbidden);
    const aProfile=await profile(a,stranger),bProfile=await profile(b,stranger);
    expect(aProfile.legacy).toEqual({points:0,reputation:0,contributions:0,banners:0});
    expect(aProfile.ledger.finalized.points).toBe(0);
    expect(aProfile.ledger.pending.points+bProfile.ledger.pending.points).toBe(25);
    expect(aProfile.ledger.pending.reputation+bProfile.ledger.pending.reputation).toBe(10);
    for(const [person,evidence] of [[a,aProfile],[b,bProfile]] as const){
      expect(ended.contributions.find(item=>item.guardian.id===person.user.id)?.points).toBe(evidence.ledger.pending.points);
      expect(evidence.ledger.pending.contributions).toBe(1);
    }
    const gratitude={guardianId:b.user.id,kind:'relay'};
    expect((await request(`/trips/${trip.id}/gratitude`,rider,gratitude)).status).toBe(200);
    expect((await request(`/trips/${trip.id}/gratitude`,rider,gratitude)).status).toBe(200);
    const final=await records(trip,rider),banners=final.records.filter(item=>item.event.kind==='gratitude');
    expect(banners).toHaveLength(1);expect(banners[0].event.assignment).toBe(2);
    expect((await profile(b,stranger)).ledger.pending.banners).toBe(1);
    expect((await profile(b,stranger)).legacy.banners).toBe(0);
  });

  it('records cancellation and former-guardian gratitude without arrival credit',async()=>{
    const rider=await session('Rider'),guardian=await session('Guardian'),trip=await create(rider);
    await assign(trip,rider,guardian);await act(trip,guardian,'check-in');await act(trip,rider,'cancel');
    expect((await request(`/trips/${trip.id}/gratitude`,rider,{guardianId:guardian.user.id,kind:'companionship'})).status).toBe(200);
    const history=await records(trip,rider);
    expect(history.records.find(item=>item.event.kind==='closed')?.event.value).toBe(2);
    expect(history.records.some(item=>item.event.kind==='contribution')).toBe(false);
    expect((await profile(guardian,rider)).ledger.pending).toMatchObject({points:0,reputation:0,banners:1,contributions:0});
  });

  it('labels an automated relay without pretending that a rider or guardian signed it',async()=>{
    const rider=await session('Rider'),guardian=await session('Guardian'),trip=await create(rider);
    await assign(trip,rider,guardian);
    await runInDurableObject(env.TRIPS.getByName(trip.id),async(_instance,state)=>{const value=JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM trip_state').one().data);value.trip.nextCheckInAt=Date.now()-1;state.storage.sql.exec('UPDATE trip_state SET data=?',JSON.stringify(value));});
    expect(await runDurableObjectAlarm(env.TRIPS.getByName(trip.id))).toBe(true);
    const relay=(await records(trip,rider)).records.find(item=>item.event.kind==='relay_requested');
    expect(relay?.event).toMatchObject({actorId:'0'.repeat(64),value:1});
  });

  it('retains pending source intents through private erasure, eviction and a failed cross-object enqueue',async()=>{
    const rider=await session('Rider'),guardian=await session('Guardian'),trip=await create(rider),room=env.TRIPS.getByName(trip.id);
    await assign(trip,rider,guardian);await failPublication(trip);
    await act(trip,guardian,'check-in');await act(trip,rider,'arrive');
    const ref=(await room.exportSnapshot())!.community!.journeyId;
    expect((await request(`/trips/${trip.id}/delete`,rider,{confirmation:'DELETE JOURNEY'})).status).toBe(200);
    expect(await room.exportSnapshot()).toBeNull();
    await runInDurableObject(room,async(_instance,state)=>{
      expect(state.storage.sql.exec('SELECT data FROM trip_state').toArray()).toHaveLength(0);
      const data=state.storage.sql.exec<{data:string}>('SELECT data FROM community_source WHERE delivered=0').toArray();expect(data.length).toBeGreaterThan(0);
      for(const forbidden of [trip.id,rider.user.id,guardian.user.id,input.shareUrl])expect(JSON.stringify(data)).not.toContain(forbidden);
    });
    await evictDurableObject(room);await makeSourceDue(trip);expect(await runDurableObjectAlarm(room)).toBe(true);
    const ledger=await env.COMMUNITY.getByName(`journey:${ref}`).journey(ref);expect(ledger.ok).toBe(true);
    if(ledger.ok)expect(ledger.value.records.filter(item=>item.event.kind==='contribution')).toHaveLength(1);
    expect((await profile(guardian,rider)).ledger.pending.points).toBe(25);
  });

  it('deduplicates a persisted enqueue with a lost acknowledgement and keeps publication intents in backups',async()=>{
    const rider=await session('Rider'),guardian=await session('Guardian'),trip=await create(rider),room=env.TRIPS.getByName(trip.id);
    await assign(trip,rider,guardian);await failPublication(trip,true);await act(trip,guardian,'check-in');await act(trip,rider,'arrive');
    const backup=(await room.exportSnapshot())!;
    expect(backup.communityEvents).toHaveLength(5);
    expect(await room.validateSnapshot({...backup,communityEvents:backup.communityEvents!.slice(1)},trip.id)).toBe(false);
    expect(await room.validateSnapshot({...backup,communityEvents:undefined},trip.id)).toBe(false);
    await evictDurableObject(room);await makeSourceDue(trip);await runDurableObjectAlarm(room);
    const history=await records(trip,rider);expect(history.records).toHaveLength(5);
    expect((await profile(guardian,rider)).ledger.pending.contributions).toBe(1);
    const restored=env.TRIPS.getByName(crypto.randomUUID());expect(await restored.restoreSnapshot(backup)).toBe(true);
    expect((await restored.exportSnapshot())!.communityEvents).toEqual(backup.communityEvents);
  });

  it('keeps legacy in-progress care and legacy credits separate without inventing a historical ledger',async()=>{
    const rider=await session('Legacy rider',false),guardian=await session('Legacy guardian',false),id=crypto.randomUUID();
    const initialized=await env.TRIPS.getByName(id).initialize(id,rider.user,input,false);expect(initialized.ok).toBe(true);if(!initialized.ok)return;
    const trip=initialized.value;await assign(trip,rider,guardian);await act(trip,guardian,'check-in');await act(trip,rider,'help');await act(trip,rider,'arrive');
    expect(await records(trip,rider)).toMatchObject({enabled:false,records:[]});
    expect(await profile(guardian,rider)).toMatchObject({ledger:{memberId:null,records:[]},legacy:{points:25,reputation:10,contributions:1,banners:0}});
    await request('/me/community-notice',guardian,{version:'community-v1'});
    expect((await profile(guardian,rider)).ledger.records).toHaveLength(0);
    expect((await profile(guardian,rider)).legacy.points).toBe(25);
  });

  it('removes the private member mapping on account deletion while retaining public evidence',async()=>{
    const rider=await session('Rider'),guardian=await session('Guardian'),trip=await create(rider);await assign(trip,rider,guardian);await act(trip,guardian,'check-in');await act(trip,rider,'arrive');
    const before=await profile(guardian,rider),ref=before.ledger.memberId!;
    expect((await request('/account/delete',guardian,{confirmation:'DELETE MY ACCOUNT'})).status).toBe(200);
    expect(await env.USERS.getByName(guardian.user.id).communityIdentity()).toBeNull();
    expect((await request(`/members/${guardian.user.id}/records`,rider)).status).toBe(404);
    expect((await env.COMMUNITY.getByName(`member:${ref}`).member(ref))).toMatchObject({ok:true,value:{pending:{points:25}}});
    const state=(await env.TRIPS.getByName(trip.id).exportSnapshot())!;expect(state.community!.members[guardian.user.id]).toBeUndefined();
  });

  it('refuses gratitude based only on a late aggregate former-guardian check-in instead of poisoning the publication queue',async()=>{
    const rider=await session('Rider'),a=await session('Earlier guardian'),b=await session('Current guardian'),trip=await create(rider),room=env.TRIPS.getByName(trip.id);
    await assign(trip,rider,a);const relay=await act(trip,rider,'request-relay');await assign(trip,rider,b,relay.relay!.id);await act(trip,b,'check-in');
    await runInDurableObject(room,async(_instance,state)=>{const value=JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM trip_state').one().data);value.trip.chainEnabled=true;state.storage.sql.exec('UPDATE trip_state SET data=?',JSON.stringify(value));});
    const wallets=['11111111111111111111111111111111','SysvarRent111111111111111111111111111111111'];
    const result=await room.applyChainSnapshot({address:wallets[0],state:'completed',currentGuardian:wallets[1],proposedGuardian:null,proposalExpiresAt:0,revision:2,sequence:2,deadline:Date.now()+60000,slot:1,contributions:wallets.map((wallet,index)=>({wallet,checkIns:1,startedAt:Date.now(),endedAt:Date.now(),points:index?12:13,reputation:5,claimed:false}))},[{person:a.user,wallet:wallets[0]},{person:b.user,wallet:wallets[1]}],null);
    expect(result.ok).toBe(true);
    expect((await request(`/trips/${trip.id}/gratitude`,rider,{guardianId:a.user.id,kind:'companionship'})).status).toBe(409);
    expect((await request(`/trips/${trip.id}/gratitude`,rider,{guardianId:b.user.id,kind:'companionship'})).status).toBe(200);
    const history=await records(trip,rider);expect(history.records.filter(item=>item.event.kind==='gratitude')).toHaveLength(1);
    expect(history.records.filter(item=>item.event.kind==='contribution')).toHaveLength(1);
  });

  it('rejects a stale official backup when the independent journal already contains newer events',async()=>{
    const rider=await session('Rider'),guardian=await session('Guardian'),trip=await create(rider),room=env.TRIPS.getByName(trip.id);
    await assign(trip,rider,guardian);await act(trip,guardian,'check-in');const older=(await room.exportSnapshot())!;
    await act(trip,rider,'arrive');
    const restored=env.TRIPS.getByName(crypto.randomUUID());expect(await restored.restoreSnapshot(older)).toBe(false);
    expect(await restored.exportSnapshot()).toBeNull();
    expect((await records(trip,rider)).records.find(item=>item.event.kind==='closed')?.event.value).toBe(1);
  });

  it('schedules source recovery before the first external call when journey registration fails',async()=>{
    const rider=await session('Rider'),id=crypto.randomUUID(),room=env.TRIPS.getByName(id);
    await runInDurableObject(room,async(instance,state)=>{
      const target=instance as unknown as TripRoom&{env:WorkerEnv},original=target.env.GOVERNANCE;
      target.env={...target.env,GOVERNANCE:new Proxy(original,{get(value,key){if(key==='getByName')return(name:string)=>{const stub=value.getByName(name);return new Proxy(stub,{get(inner,property){if(property==='registerTrip')return async()=>{throw new Error('Injected inventory failure');};const method=Reflect.get(inner,property);return typeof method==='function'?method.bind(inner):method;}});};const method=Reflect.get(value,key);return typeof method==='function'?method.bind(value):method;}})};
      await expect(target.initialize(id,rider.user,input,false)).rejects.toThrow('Injected inventory failure');
      expect(await state.storage.getAlarm()).not.toBeNull();
      expect(state.storage.sql.exec('SELECT data FROM community_source WHERE delivered=0').toArray()).toHaveLength(1);
    });
    await evictDurableObject(room);await makeSourceDue({id} as Trip);await runDurableObjectAlarm(room);
    const snapshot=(await room.exportSnapshot())!;expect((await records(snapshot.trip,rider)).records[0].event.kind).toBe('created');
  });

  it('requires operator authentication and audits publication retry attempts without accepting public ledger writes',async()=>{
    const rider=await session('Rider'),trip=await create(rider),journal=(await records(trip,rider)).journeyId!;
    expect((await request('/admin/community/retry',rider,{journeyId:journal})).status).toBe(401);
    expect((await request('/community/append',rider,{events:[]})).status).toBe(404);
    const operatorEnv={...env,OPERATOR_SECRET:'community-events-test-operator-secret'};
    const response=await worker.fetch(new Request('https://guard.test/api/admin/community/retry',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${operatorEnv.OPERATOR_SECRET}`},body:JSON.stringify({journeyId:journal})}),operatorEnv);
    expect(response.status).toBe(200);
    expect(await env.GOVERNANCE.getByName('governance-v1').auditList()).toEqual(expect.arrayContaining([expect.objectContaining({action:'community-publication-retry',target:journal,reason:null})]));
  });
});
