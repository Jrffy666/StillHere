import { env } from 'cloudflare:test';
import { describe,it,expect,vi,afterEach } from 'vitest';
import { assess,sendNotification,configuration } from '../src/integrations';
import type { Trip,Notification,WorkerEnv } from '../src/types';

afterEach(()=>{vi.restoreAllMocks();});
const configured = ():WorkerEnv => ({...env,OPENAI_API_KEY:'test-only-fake-key',NOTIFICATIONS_ENABLED:'true',NOTIFICATION_WEBHOOK_URL:'https://notification.example.test/send',NOTIFICATION_WEBHOOK_SECRET:'test-only-fake-secret'});
const trip = (demo=false,consent=true):Trip => ({
  id:'test-trip',demo,status:'active',rider:{id:'rider',name:'Test rider'},guardian:{id:'guardian',name:'Test guardian'},guardMode:'ai',
  guardianRequests:[],relay:null,contributions:[],
  origin:{label:'Test origin',lat:0,lng:0},destination:{label:'Test destination',lat:1,lng:1},location:{lat:0,lng:0,updatedAt:Date.now()},
  createdAt:Date.now(),updatedAt:Date.now(),checkInIntervalSeconds:30,nextCheckInAt:null,lastGuardianCheckInAt:null,risk:'attention',
  ai:{mode:'rules',lastAssessment:''},messages:[],events:[],notifications:[],reward:{points:25,reputation:10,status:'pending'},
  emergencyContact:{name:'Mock recipient',contact:'fake-recipient'},notificationConsent:consent,
});
const notice:Notification = {id:'notice-id',at:1,status:'queued',channel:'webhook',message:'A test request for help',detail:''};
describe('Optional integrations use truthful failure paths',()=>{
  it('exposes only the public Devnet endpoint even when server RPC settings contain private API keys',()=>{
    const privateRpc='https://private-rpc.example.test/?api-key=private-secret-value';
    const legacyRpc='https://legacy-rpc.example.test/?api-key=legacy-secret-value';
    const visible=configuration({...env,SOLANA_PRIVATE_RPC_URL:privateRpc,SOLANA_RPC_URL:legacyRpc});
    expect(visible.chain.rpcUrl).toBe('https://api.devnet.solana.com');
    const encoded=JSON.stringify(visible);expect(encoded).not.toContain('secret-value');expect(encoded).not.toContain('rpc.example.test');
  });
  it('handles explicit help without ever waiting for a model',async()=>{
    const network = vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('offline'));
    const result = await assess(configured(),'I need help','normal');
    expect(result.risk).toBe('urgent');expect(result.mode).toBe('rules');expect(network).not.toHaveBeenCalled();
  });
  it('keeps the legacy assessment boundary offline even when a key is present',async()=>{
    const network = vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Network forbidden'));
    expect((await assess(configured(),'The route changed','normal')).mode).toBe('rules');
    expect((await assess(configured(),'The route changed','normal')).mode).toBe('rules');
    expect(network).not.toHaveBeenCalled();
  });
  it('reports offline configuration without treating a key as a live connection',()=>{
    expect(configuration(configured()).ai).toMatchObject({provider:'mock',configured:false,liveModel:false,model:null});
  });
  it('never sends notifications for demo trips or without rider consent',async()=>{
    const network = vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Network forbidden'));
    expect((await sendNotification(configured(),trip(true),notice)).status).toBe('simulated');
    expect((await sendNotification(configured(),trip(false,false),notice)).status).toBe('failed');
    expect(network).not.toHaveBeenCalled();
  });
  it('records provider acceptance as sent, never as acknowledged, with an idempotency key',async()=>{
    const network = vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
      // Exercise the real workerd Request constructor rather than letting a mock
      // silently accept a redirect mode that fails in the deployed runtime.
      const outgoing=new Request(input,init);expect(outgoing.redirect).toBe('manual');
      return new Response(null,{status:202});
    });
    const result = await sendNotification(configured(),trip(),notice);
    expect(result.status).toBe('sent');expect(result.detail).toContain('pending');
    expect(network.mock.calls[0][0]).toBe('https://notification.example.test/send');
    expect(new Headers(network.mock.calls[0][1]?.headers).get('Idempotency-Key')).toBe('notice-id');
  });
  it('rejects provider redirects without sending credentials or contact data to another address',async()=>{
    const codes=[301,302,303,307,308];
    const network=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
      const outgoing=new Request(input,init);expect(outgoing.redirect).toBe('manual');
      expect(outgoing.url).toBe('https://notification.example.test/send');
      return new Response(null,{status:codes.shift()!,headers:{Location:'https://untrusted.example.test/collect'}});
    });
    for(let index=0;index<5;index++){
      const result=await sendNotification(configured(),trip(),notice);
      expect(result).toMatchObject({status:'failed',channel:'webhook'});expect(result.detail).toContain('configured address');
    }
    expect(network).toHaveBeenCalledTimes(5);
    expect(network.mock.calls.every(([input])=>input==='https://notification.example.test/send')).toBe(true);
  });
  it('reports delivery failure when the provider rejects or the network fails',async()=>{
    vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response(null,{status:500})).mockRejectedValueOnce(new Error('offline'));
    expect((await sendNotification(configured(),trip(),notice)).status).toBe('failed');
    expect((await sendNotification(configured(),trip(),notice)).status).toBe('failed');
  });
});
