import { z } from 'zod';
import { digest, safeEqual } from './accounts';
import { boundedJson, configuration } from './integrations';
import { authenticate, createGuestSession, handleIdentity, IdentityError } from './identity';
import { handleAccount, handleAdmin, readiness, resumeDeletion } from './operations';
import { chainConfigured, operationSchema } from './chain-sync';
import { COMMUNITY_NOTICE_VERSION } from './community-events';
import { emptyCommunityLedger } from './community-ledger';
import { communityConfiguration } from './community-chain';
import { communityRef, correctionSchema } from './community-types';
import { operatorAuthorized } from './governance';
import { summary, type Outcome, type Trip, type User, type WorkerEnv } from './types';
export { UserAccount, TripDirectory } from './accounts';
export { TripRoom } from './trips';
export { IdentityRegistry } from './identity';
export { GovernanceStore } from './governance';
export { ChainJourney } from './chain-sync';
export { CommunityLedger } from './community-ledger';

const place = z.object({label:z.string().trim().min(1).max(160),lat:z.number().finite().min(-90).max(90),lng:z.number().finite().min(-180).max(180)}).strict();
const createSchema = z.object({
  chainEnabled:z.boolean().default(false),
  origin:place,destination:place,
  shareUrl:z.url().max(1500).refine(value => {const url = new URL(value); return url.protocol === 'https:' && (url.hostname === 'uber.com' || url.hostname.endsWith('.uber.com')) && !url.username && !url.password;},'Use an HTTPS uber.com trip-sharing link.').optional(),
  checkInIntervalSeconds:z.number().int().min(30).max(300).default(60),
  emergencyContact:z.object({name:z.string().trim().min(1).max(80),contact:z.string().trim().min(3).max(160)}).strict().optional(),
  notificationConsent:z.boolean().default(false),
}).strict();
const actionSchema = z.object({
  action:z.enum(['accept','withdraw-application','approve-guardian','reject-guardian','request-relay','cancel-relay','check-in','takeover','resume','arrive','cancel','help','message','location','simulate']),
  requestId:z.uuid().optional(),text:z.string().trim().max(1500).optional(),lat:z.number().finite().min(-90).max(90).optional(),lng:z.number().finite().min(-180).max(180).optional(),
  scenario:z.enum(['guardian-offline','route-deviation','stale-location','notification-failure']).optional(),
}).strict();
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
function result<T>(outcome: Outcome<T>, key?: string, status = 200): Response {
  if (!outcome.ok) return Response.json({error:outcome.error},{status:outcome.status});
  return Response.json(key ? {[key]:outcome.value} : outcome.value,{status});
}
async function body(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new HttpError(415,'Use Content-Type: application/json.');
  try { return await boundedJson(new Response(request.body),16384); }
  catch { throw new HttpError(400,'Invalid JSON or request body exceeds 16 KB.'); }
}
class HttpError extends Error { constructor(public status:number, message:string) {super(message);} }
async function handle(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (path === '/api/health' && method === 'GET') return Response.json({ok:true,service:'safety-guard',version:'0.1.0',capabilities:['persisted-trips','server-alarms','human-handoff','rules-fallback','optional-openai','notification-outbox','idempotent-rewards']});
  if (path === '/api/config' && method === 'GET') {
    const community=communityConfiguration(env);
    return Response.json({...configuration(env),community:{network:community.network,programId:community.programId,configured:community.configured,noticeVersion:COMMUNITY_NOTICE_VERSION}});
  }
  if (path === '/api/ready' && method === 'GET') {const status=readiness(env);return Response.json(status,{status:status.ready?200:503});}
  if(env.APP_ENV==='production'&&!readiness(env).ready)throw new HttpError(503,'Production configuration is incomplete.');
  if(path.startsWith('/api/admin/community/')){
    if(!await operatorAuthorized(request,env.OPERATOR_SECRET))throw new HttpError(401,'Operator authentication is required.');
    const journal=/^\/api\/admin\/community\/journeys\/([a-f0-9]{64})$/.exec(path);
    if(method==='GET'&&journal)return result(await env.COMMUNITY.getByName(`journey:${journal[1]}`).journey(journal[1],url.searchParams.get('cursor')??undefined));
    if(method==='POST'&&path==='/api/admin/community/corrections/prepare'){
      const input=correctionSchema.parse(await body(request));
      await env.GOVERNANCE.getByName('governance-v1').recordCommunityOperation('community-correction-prepare',input.journeyId);
      return result(await env.COMMUNITY.getByName(`journey:${input.journeyId}`).prepareCorrection(input));
    }
    if(method==='POST'&&path==='/api/admin/community/corrections/submit'){
      const input=z.object({journeyId:communityRef,transaction:z.string().min(1).max(5000)}).strict().parse(await body(request));
      await env.GOVERNANCE.getByName('governance-v1').recordCommunityOperation('community-correction-submit',input.journeyId);
      return result(await env.COMMUNITY.getByName(`journey:${input.journeyId}`).submitCorrection(input.transaction));
    }
    if(method==='POST'&&path==='/api/admin/community/retry'){
      const input=z.object({journeyId:communityRef}).strict().parse(await body(request));
      await env.GOVERNANCE.getByName('governance-v1').recordCommunityOperation('community-publication-retry',input.journeyId);
      await env.COMMUNITY.getByName(`journey:${input.journeyId}`).retry();return Response.json({queued:true});
    }
    throw new HttpError(404,'Community operator endpoint not found.');
  }
  const operator=await handleAdmin(request,env);if(operator)return operator;
  const auth=await handleIdentity(request,env);if(auth)return auth;
  if (path === '/api/session' && method === 'POST') {
    const input = z.object({name:z.string().trim().min(1).max(60)}).strict().parse(await body(request));
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    if (!await env.USERS.getByName(`session-rate-${await digest(ip)}`).allow('session',20,60000)) throw new HttpError(429,'Too many new sessions. Try again in a minute.');
    const session=await createGuestSession(env,input.name);
    await env.GOVERNANCE.getByName('governance-v1').registerUser(session.user.id);
    return Response.json(session,{status:201});
  }
  const ackPath = new RegExp(`^/api/notifications/(${uuid})/(${uuid})/ack$`).exec(path);
  if (ackPath && method === 'POST') {
    const token = request.headers.get('Authorization')?.replace(/^Bearer /,'') ?? '';
    if (!env.NOTIFICATION_ACK_SECRET || !safeEqual(token,env.NOTIFICATION_ACK_SECRET)) throw new HttpError(401,'Provider acknowledgement authentication required.');
    return result(await env.TRIPS.getByName(ackPath[1]).acknowledge(ackPath[2]));
  }
  const user = await authenticate(request,env);
  const accountResponse=await handleAccount(request,env,user);if(accountResponse)return accountResponse;
  const restriction=await env.GOVERNANCE.getByName('governance-v1').status(user.id);
  if(restriction.deleted)throw new HttpError(403,'This account is being deleted.');
  if (path === '/api/me' && method === 'GET') return Response.json({user});
  if(path==='/api/me/community-notice'&&method==='POST'){
    const input=z.object({version:z.literal(COMMUNITY_NOTICE_VERSION)}).strict().parse(await body(request));
    const current=await env.USERS.getByName(user.id).acceptCommunityNotice(input.version);
    if(!current)throw new HttpError(404,'Community member not found.');
    return Response.json({user:current});
  }
  if (path === '/api/me/profile' && method === 'POST') {
    const input=z.object({bio:z.string().trim().max(280)}).strict().parse(await body(request));
    if(!await env.USERS.getByName(user.id).allow('profile',20,60000))throw new HttpError(429,'Too many profile updates.');
    const member=await env.USERS.getByName(user.id).updateProfile(input.bio);
    if(!member)throw new HttpError(404,'Community member not found.');
    return Response.json({member});
  }
  const memberRecordsPath=new RegExp(`^/api/members/(${uuid})/records$`).exec(path);
  if(memberRecordsPath&&method==='GET'){
    if((await env.GOVERNANCE.getByName('governance-v1').status(memberRecordsPath[1])).deleted)throw new HttpError(404,'Community member not found.');
    const account=env.USERS.getByName(memberRecordsPath[1]);
    if(!await account.communityProfile())throw new HttpError(404,'Community member not found.');
    const [identity,legacy]=await Promise.all([account.communityIdentity(),account.communityLegacy()]);
    const cursor=z.string().max(200).optional().parse(url.searchParams.get('cursor')??undefined);
    if(!identity)return Response.json({ledger:emptyCommunityLedger(env),legacy});
    const ledger=await env.COMMUNITY.getByName(`member:${identity.memberId}`).member(identity.memberId,cursor);
    if(!ledger.ok)return result(ledger);
    return Response.json({ledger:ledger.value,legacy});
  }
  const memberPath=new RegExp(`^/api/members/(${uuid})$`).exec(path);
  if(memberPath&&method==='GET') {
    if((await env.GOVERNANCE.getByName('governance-v1').status(memberPath[1])).deleted)throw new HttpError(404,'Community member not found.');
    const member=await env.USERS.getByName(memberPath[1]).communityProfile();
    if(!member)throw new HttpError(404,'Community member not found.');
    return Response.json({member});
  }
  if (path === '/api/commitments' && method === 'GET') {
    const ids=await env.USERS.getByName(user.id).tripIds();
    const views=await Promise.all(ids.map(async id=>{const value=await env.CHAIN.getByName(id).view(user.id);return value.ok?{id,chainEnabled:true,status:value.value.snapshot.state==='completed'?'arrived':value.value.snapshot.state==='cancelled'?'cancelled':value.value.snapshot.state==='uncreated'?'open':'active'}:null;}));
    return Response.json({journeys:views.filter(Boolean)});
  }
  if (path === '/api/trips' && method === 'GET') {
    const [groups,ids] = await Promise.all([
      Promise.all(Array.from('0123456789abcdef',shard => env.LOBBY.getByName(`lobby-${shard}`).list())),
      env.USERS.getByName(user.id).tripIds(),
    ]);
    const own = await Promise.all(ids.map(id => env.TRIPS.getByName(id).read(user.id)));
    const myTrips = own.flatMap(item => item.ok && ('rider' in item.value || item.value.application !== null) ? [item.value] : []);
    const mine = new Set(myTrips.map(trip => trip.id));
    const requests=groups.flat().filter(trip => !mine.has(trip.id)).sort((a,b)=>b.createdAt-a.createdAt).slice(0,60);
    // Legacy directory rows gain only the explicit public projection, never private journey fields.
    const trips=await Promise.all(requests.map(async trip=>{
      if(trip.riderProfile)return trip;
      const current=await env.TRIPS.getByName(trip.id).read(user.id);
      return current.ok?('messages'in current.value?summary(current.value,user.id):current.value):null;
    }));
    return Response.json({trips:trips.filter(trip=>trip&&trip.requestKind),myTrips});
  }
  if ((path === '/api/trips' || path === '/api/demo/start') && method === 'POST') {
    if(restriction.suspended)throw new HttpError(403,'This account is suspended from creating journeys.');
    if (!await env.USERS.getByName(user.id).allow('create',15,3600000)) throw new HttpError(429,'Trip creation limit reached. Try again later.');
    const demo = path === '/api/demo/start';
    if(!demo&&user.communityNoticeVersion!==COMMUNITY_NOTICE_VERSION)throw new HttpError(409,'Accept the community public-record notice before starting a real journey.');
    const input = demo ? createSchema.parse({origin:{label:'University of Waterloo',lat:43.4723,lng:-80.5449},destination:{label:'Uptown Waterloo',lat:43.4643,lng:-80.5204},checkInIntervalSeconds:30}) : createSchema.parse(await body(request));
    const tripId = crypto.randomUUID();
    if(input.chainEnabled&&(!user.wallet||!chainConfigured(env)))throw new HttpError(409,'Bind a wallet and configure the V2 program before starting a chain-linked journey.');
    const created=await env.TRIPS.getByName(tripId).initialize(tripId,{id:user.id,name:user.name,wallet:user.wallet},input,demo);
    if(created.ok&&input.chainEnabled){const linked=await env.CHAIN.getByName(tripId).initialize(tripId,user);if(!linked.ok)return result(linked);}
    return result(created,'trip',201);
  }
  const chainPath=new RegExp(`^/api/trips/(${uuid})/chain(?:/(prepare|submit|refresh|discard))?$`).exec(path);
  if(chainPath){
    const bridge=env.CHAIN.getByName(chainPath[1]);
    if(method==='GET'&&!chainPath[2])return result(await bridge.view(user.id),'chain');
    if(method==='POST') {
      if(!await env.USERS.getByName(user.id).allow('chain',30,60000))throw new HttpError(429,'Too many chain requests.');
      if(chainPath[2]==='prepare'){const input=z.object({operation:operationSchema,applicationId:z.uuid().optional()}).strict().parse(await body(request));return result(await bridge.prepare(user,input.operation,input.applicationId));}
      if(chainPath[2]==='submit'){const input=z.object({intentId:z.uuid(),transaction:z.string().min(1).max(5000)}).strict().parse(await body(request));return result(await bridge.submit(user.id,input.intentId,input.transaction),'chain');}
      if(chainPath[2]==='refresh')return result(await bridge.refresh(user.id),'chain');
      if(chainPath[2]==='discard'){const input=z.object({intentId:z.uuid()}).strict().parse(await body(request));return result(await bridge.discard(user.id,input.intentId),'chain');}
    }
  }
  const communityPath=new RegExp(`^/api/trips/(${uuid})/community$`).exec(path);
  if(communityPath&&method==='GET'){
    const cursor=z.string().max(200).optional().parse(url.searchParams.get('cursor')??undefined);
    return result(await env.TRIPS.getByName(communityPath[1]).readCommunity(user.id,cursor),'community');
  }
  const gratitudePath=new RegExp(`^/api/trips/(${uuid})/gratitude$`).exec(path);
  if(gratitudePath) {
    const room=env.TRIPS.getByName(gratitudePath[1]);
    if(method==='GET')return result(await room.readGratitude(user.id),'gratitude');
    if(method==='POST') {
      const input=z.object({guardianId:z.uuid(),kind:z.enum(['companionship','thoughtfulness','relay'])}).strict().parse(await body(request));
      if(!await env.USERS.getByName(user.id).allow('gratitude',30,60000))throw new HttpError(429,'Too many gratitude requests.');
      return result(await room.sendGratitude(user.id,input.guardianId,input.kind),'gratitude');
    }
  }
  const match = new RegExp(`^/api/trips/(${uuid})(/actions|/voice)?$`).exec(path);
  if (match) {
    const stub = env.TRIPS.getByName(match[1]);
    if (method === 'GET' && !match[2]) return result(await stub.read(user.id),'trip');
    if (method === 'POST' && match[2] === '/actions') {
      const input = actionSchema.parse(await body(request));
      if(restriction.suspended&&['accept','approve-guardian','request-relay'].includes(input.action))throw new HttpError(403,'This account is suspended from recruitment.');
      if(input.action==='approve-guardian') {
        const own=await stub.read(user.id);
        if(own.ok&&'rider'in own.value){const applicant=own.value.guardianRequests.find(item=>item.id===input.requestId);if(applicant){const status=await env.GOVERNANCE.getByName('governance-v1').status(applicant.candidate.id);if(status.deleted||status.suspended)throw new HttpError(403,'This applicant is unavailable.');}}
      }
      if (!await env.USERS.getByName(user.id).allow('actions',120,60000)) throw new HttpError(429,'Too many actions. Try again shortly.');
      return result(await stub.act(user,input),'trip');
    }
    if (method === 'POST' && match[2] === '/voice') {
      let read = await stub.read(user.id);
      if (!read.ok) return result(read);
      if (!('messages' in read.value)) throw new HttpError(403,'This trip is private.');
      if (!env.ELEVENLABS_API_KEY) throw new HttpError(503,'ElevenLabs is not configured.');
      if (!await env.USERS.getByName(user.id).allow('voice',6,60000)) throw new HttpError(429,'Voice limit reached.');
      read = await stub.read(user.id);
      if (!read.ok) return result(read);
      if (!('messages' in read.value)) throw new HttpError(403,'This trip is private.');
      const message = read.value.messages.filter(item => item.role === 'agent').at(-1);
      if (!message) throw new HttpError(409,'No agent message is available to read.');
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${env.ELEVENLABS_VOICE_ID}`,{method:'POST',signal:AbortSignal.timeout(10000),headers:{'xi-api-key':env.ELEVENLABS_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({text:message.text,model_id:'eleven_multilingual_v2'})});
      if (!response.ok) { await response.body?.cancel(); throw new HttpError(502,'The voice provider is unavailable. The text message is still available.'); }
      const current = await stub.read(user.id);
      if (!current.ok || !('messages' in current.value)) { await response.body?.cancel(); throw new HttpError(403,'Your access to this trip has changed.'); }
      return new Response(response.body,{headers:{'Content-Type':'audio/mpeg'}});
    }
  }
  throw new HttpError(404,'Endpoint not found.');
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const origin = request.headers.get('Origin');
    const allowed = env.ALLOWED_ORIGINS.split(',').map(value=>value.trim());
    const headers = new Headers({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Vary':'Origin'});
    if (origin && (allowed.includes(origin) || origin === new URL(request.url).origin)) {
      headers.set('Access-Control-Allow-Origin',origin);
      headers.set('Access-Control-Allow-Methods','GET,POST,OPTIONS');
      headers.set('Access-Control-Allow-Headers','Authorization,Content-Type');
    } else if (origin) return Response.json({error:'Origin is not allowed.'},{status:403,headers});
    if (request.method === 'OPTIONS') return new Response(null,{status:204,headers});
    let response: Response;
    try { response = await handle(request,env); }
    catch (error) {
      if (error instanceof z.ZodError) response = Response.json({error:'Invalid input.',details:error.issues.map(issue=>({path:issue.path.join('.'),message:issue.message}))},{status:400});
      else if (error instanceof HttpError || error instanceof IdentityError) response = Response.json({error:error.message},{status:error.status});
      else {
        // Never log request bodies, positions, contact data, or bearer credentials.
        console.error(JSON.stringify({event:'request_failed',category:'internal'}));
        response = Response.json({error:'The service is temporarily unavailable. Please retry.'},{status:500});
      }
    }
    const finalHeaders = new Headers(response.headers);
    headers.forEach((value,key)=>finalHeaders.set(key,value));
    return new Response(response.body,{status:response.status,headers:finalHeaders});
  },
  async scheduled(_event:ScheduledController,env:WorkerEnv):Promise<void> {
    for(const job of await env.GOVERNANCE.getByName('governance-v1').pendingDeletions(25))await resumeDeletion(env,job.userId);
  },
} satisfies ExportedHandler<WorkerEnv>;
