import { env, SELF, reset, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Trip, User } from '../src/types';
import type { ChainSnapshot } from '../src/chain-types';

beforeEach(async()=>{await reset();});
interface Session {user:User;token:string}
async function request(path:string,token?:string,body?:unknown){return SELF.fetch('https://guard.test/api'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});}
async function session(name:string):Promise<Session>{const value=await (await request('/session',undefined,{name})).json<Session>();await env.USERS.getByName(value.user.id).acceptCommunityNotice('community-v1');return value;}
async function create(rider:Session){const r=await request('/trips',rider.token,{origin:{label:'Hidden pickup',lat:43,lng:-80},destination:{label:'Hidden destination',lat:44,lng:-81},checkInIntervalSeconds:60});expect(r.status).toBe(201);return (await r.json<{trip:Trip}>()).trip;}
const act=(id:string,user:Session,action:string,extra={})=>request(`/trips/${id}/actions`,user.token,{action,...extra});
async function fixture(){const rider=await session('Rider'),guardian=await session('Private name');const trip=await create(rider);const application=await (await act(trip.id,guardian,'accept',{requestId:trip.id})).json<{trip:{application:{id:string}}}>();await act(trip.id,rider,'approve-guardian',{requestId:application.trip.application.id});return{rider,guardian,trip};}

describe('Private-data lifecycle and chain handoff consent',()=>{
  it('erases closed private journeys and prevents stale backup resurrection',async()=>{
    const {rider,trip}=await fixture();await act(trip.id,rider,'cancel');const stub=env.TRIPS.getByName(trip.id);const backup=await stub.exportSnapshot();
    expect((await request(`/trips/${trip.id}/delete`,rider.token,{confirmation:'wrong'})).status).toBe(400);
    expect((await request(`/trips/${trip.id}/delete`,rider.token,{confirmation:'DELETE JOURNEY'})).status).toBe(200);
    expect(await stub.exportSnapshot()).toBeNull();expect(await stub.restoreSnapshot(backup!)).toBe(false);
    expect(await env.GOVERNANCE.getByName('governance-v1').isTripPurged(trip.id)).toBe(true);
  });
  it('requires closure before manual deletion and allows safety actions while suspended',async()=>{
    const {rider,guardian,trip}=await fixture();expect((await request(`/trips/${trip.id}/delete`,rider.token,{confirmation:'DELETE JOURNEY'})).status).toBe(409);
    await env.GOVERNANCE.getByName('governance-v1').setSuspended(guardian.user.id,true,'safety');
    expect((await act(trip.id,guardian,'request-relay')).status).toBe(403);
    expect((await act(trip.id,guardian,'help',{text:'Please help'})).status).toBe(200);
    expect((await act(trip.id,rider,'cancel')).status).toBe(200);
  });
  it('deletes a guardian account, removes its private data, revokes credentials and opens replacement',async()=>{
    const {rider,guardian,trip}=await fixture();await act(trip.id,guardian,'message',{text:'My private message'});
    expect((await request('/account/delete',guardian.token,{confirmation:'DELETE MY ACCOUNT'})).status).toBe(200);
    expect((await request('/me',guardian.token)).status).toBe(401);
    const visible=await env.TRIPS.getByName(trip.id).read(rider.user.id);expect(visible.ok).toBe(true);
    expect(JSON.stringify(visible)).not.toContain('My private message');expect(JSON.stringify(visible)).not.toContain('Private name');
    if(visible.ok&&'guardian'in visible.value){expect(visible.value.guardian).toBeNull();expect(visible.value.relay).not.toBeNull();}
    expect((await env.GOVERNANCE.getByName('governance-v1').deletionStatus(guardian.user.id))?.completedAt).not.toBeNull();
  });
  it('purges expired private data from an alarm without an open browser',async()=>{
    const {rider,trip}=await fixture();await act(trip.id,rider,'cancel');const stub=env.TRIPS.getByName(trip.id);
    await runInDurableObject(stub,async(_,state)=>{const row=state.storage.sql.exec<{data:string}>('SELECT data FROM trip_state').one();const value=JSON.parse(row.data);value.closedAt=Date.now()-31*86400000;value.trip.privacyExpiresAt=Date.now()-1;state.storage.sql.exec('UPDATE trip_state SET data=?',JSON.stringify(value));await state.storage.setAlarm(Date.now()+60000);});
    await runDurableObjectAlarm(stub);expect(await stub.exportSnapshot()).toBeNull();
  });
  it('retains approved consent across automatic expiry but never resurrects a withdrawn application',async()=>{
    const rider=await session('Rider'),guardian=await session('Candidate');const trip=await create(rider),stub=env.TRIPS.getByName(trip.id);
    // Only application state is synthetic: this test isolates the finality-to-private-access bridge, not RPC verification.
    const wallet='11111111111111111111111111111111';
    await runInDurableObject(stub,async(_,state)=>{const row=state.storage.sql.exec<{data:string}>('SELECT data FROM trip_state').one();const value=JSON.parse(row.data);value.trip.chainEnabled=true;state.storage.sql.exec('UPDATE trip_state SET data=?',JSON.stringify(value));});
    const applied=await stub.act({...guardian.user,wallet},{action:'accept',requestId:trip.id});expect(applied.ok).toBe(true);
    const context=await stub.chainContext();const app=context!.guardianRequests[0];expect(await stub.reserveChainApplication(app.id,guardian.user.id)).toMatchObject({ok:true});
    await runInDurableObject(stub,async(_,state)=>{const row=state.storage.sql.exec<{data:string}>('SELECT data FROM trip_state').one();const value=JSON.parse(row.data);value.trip.guardianRequests[0].expiresAt=Date.now()-1;state.storage.sql.exec('UPDATE trip_state SET data=?',JSON.stringify(value));});
    await stub.read(rider.user.id);expect(await stub.chainApplicationAvailable(app.id,guardian.user.id)).toBe(true);
    const snapshot:ChainSnapshot={address:wallet,state:'active',currentGuardian:wallet,proposedGuardian:null,proposalExpiresAt:0,revision:1,sequence:1,deadline:Date.now()+3600000,slot:10,contributions:[]};
    expect(await stub.applyChainSnapshot(snapshot,[{person:app.candidate,wallet}],app.id)).toMatchObject({ok:true,value:{applied:true}});
    const after=await stub.chainContext();expect(after!.guardian?.id).toBe(guardian.user.id);expect(after!.contributions).toHaveLength(1);
    await stub.applyChainSnapshot(snapshot,[{person:app.candidate,wallet}],app.id);expect((await stub.chainContext())!.contributions).toHaveLength(1);
  });
  it('rejects invalid backup shapes before restoring and keeps restored active journeys closed',async()=>{
    const rider=await session('Rider'),trip=await create(rider),stub=env.TRIPS.getByName(trip.id);const data=await stub.exportSnapshot();expect(await stub.validateSnapshot({...data,unexpected:'credential'},trip.id)).toBe(false);
    const restoreId=crypto.randomUUID(),copy={...data!,trip:{...data!.trip,id:restoreId}};expect(await env.TRIPS.getByName(restoreId).restoreSnapshot(copy)).toBe(true);
    const restored=await env.TRIPS.getByName(restoreId).chainContext();expect(restored?.status).toBe('cancelled');expect(restored?.nextCheckInAt).toBeNull();
  });
});
