import { z } from 'zod';
import { digest } from './accounts';
import type { AccountSnapshot } from './accounts';
import { boundedJson } from './integrations';
import { moderationReason, operatorAuthorized, reportSchema } from './governance';
import type { GratitudeView, User, WorkerEnv } from './types';
import type { ChainBinding } from './chain-types';
import type { GovernanceExport } from './governance';
import { IdentityError } from './identity';

export function readiness(env:WorkerEnv) {
  const environment=env.APP_ENV??'development';
  const local=environment==='development';
  let validOrigin=false;
  try {const origin=new URL(env.SITE_ORIGIN);validOrigin=origin.origin===env.SITE_ORIGIN && (local || origin.protocol==='https:') && origin.host===env.AUTH_DOMAIN;}catch{}
  const checks={identityDomain:validOrigin,operatorSecret:Boolean(env.OPERATOR_SECRET&&env.OPERATOR_SECRET.length>=32),
    allowedOrigins:Boolean(env.ALLOWED_ORIGINS && env.ALLOWED_ORIGINS.split(',').every(value=>{try{const url=new URL(value.trim());return url.origin===value.trim()&&(local||url.protocol==='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname));}catch{return false;}})),
    chainConfigured:/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(env.SOLANA_V2_PROGRAM_ID??''),
    chainNetwork:env.SOLANA_NETWORK==='devnet'||local&&env.SOLANA_NETWORK==='localnet',
    restoreDisabled:environment!=='production'||env.RESTORE_ALLOWED!=='true'};
  return {ready:local||Object.values(checks).every(Boolean),environment,checks};
}
async function json(request:Request,max=16384):Promise<unknown> {
  if(!request.headers.get('Content-Type')?.toLowerCase().includes('application/json'))throw new IdentityError(415,'JSON content type required.');
  try{return await boundedJson(new Response(request.body),max);}catch{throw new IdentityError(400,'Invalid or oversized JSON.');}
}
function response<T>(outcome:{ok:true;value:T}|{ok:false;status:number;error:string}):Response {
  return outcome.ok?Response.json(outcome.value):Response.json({error:outcome.error},{status:outcome.status});
}
export async function resumeDeletion(env:WorkerEnv,userId:string):Promise<void> {
  const gov=env.GOVERNANCE.getByName('governance-v1');const job=await gov.deletionStatus(userId);if(!job||job.completedAt)return;
  await env.USERS.getByName(userId).deactivate();
  for(const id of job.tripIds){await env.TRIPS.getByName(id).scrubUser(userId);await env.CHAIN.getByName(id).scrubUser(userId);}
  await env.USERS.getByName(userId).purgePrivate();await gov.completeDeletion(userId);
}
export async function handleAccount(request:Request,env:WorkerEnv,user:User):Promise<Response|null> {
  const path=new URL(request.url).pathname;const account=env.USERS.getByName(user.id);const gov=env.GOVERNANCE.getByName('governance-v1');
  if(path==='/api/account/export'&&request.method==='GET') {
    const data=await account.exportData();const trips=[];const sentGratitude:{tripId:string;banners:GratitudeView['banners']}[]=[];
    for(const row of data.trips){
      const room=env.TRIPS.getByName(row.id),read=await room.read(user.id);
      if(read.ok&&'rider'in read.value){
        trips.push(read.value);
        if(read.value.rider.id===user.id){const gratitude=await room.readGratitude(user.id);if(gratitude.ok&&gratitude.value.banners.length)sentGratitude.push({tripId:row.id,banners:gratitude.value.banners});}
      }
    }
    return Response.json({exportedAt:Date.now(),account:data,trips,sentGratitude,notice:'Public blockchain records cannot be deleted. Private records may include data shared by your current journey participants.'});
  }
  if(path==='/api/account/delete'&&request.method==='POST') {
    z.object({confirmation:z.literal('DELETE MY ACCOUNT')}).strict().parse(await json(request));
    const data=await account.exportData();await gov.beginDeletion(user.id,data.trips.map(item=>item.id));
    await resumeDeletion(env,user.id);return Response.json({deleted:true,notice:'Private account data was erased. Public chain records and minimal anti-replay tombstones remain.'});
  }
  if(path==='/api/reports'&&request.method==='POST')return response(await gov.submitReport(user.id,reportSchema.parse(await json(request))));
  const erase=/^\/api\/trips\/([0-9a-f-]{36})\/delete$/.exec(path);
  if(erase&&request.method==='POST') {z.object({confirmation:z.literal('DELETE JOURNEY')}).strict().parse(await json(request));return response(await env.TRIPS.getByName(erase[1]).eraseForRider(user.id));}
  return null;
}
async function allIds(env:WorkerEnv,kind:'user'|'trip'):Promise<string[]> {
  const result:string[]=[];let cursor:string|undefined;
  do {const page=await env.GOVERNANCE.getByName('governance-v1').resourceIds(kind,cursor,100);result.push(...page.ids);cursor=page.nextCursor??undefined;
    if(result.length>2000)throw new Error('This backup exceeds the bounded maintenance export size. Export a smaller isolated environment.');
  }while(cursor);return result;
}
const record=z.object({id:z.string().min(1).max(150),snapshot:z.unknown()}).strict();
const backup=z.object({schemaVersion:z.literal(1),environment:z.enum(['development','staging','production']),createdAt:z.number().int().nonnegative(),
  resources:z.object({users:z.array(record).max(2000),trips:z.array(record).max(2000),auth:z.array(record).max(2000),chain:z.array(record).max(2000),governance:z.unknown()}).strict()}).strict();

export async function handleAdmin(request:Request,env:WorkerEnv):Promise<Response|null> {
  const url=new URL(request.url),path=url.pathname;if(!path.startsWith('/api/admin/'))return null;
  if(!await operatorAuthorized(request,env.OPERATOR_SECRET))return Response.json({error:'Operator authentication is required.'},{status:401});
  const gov=env.GOVERNANCE.getByName('governance-v1');
  if(path==='/api/admin/reports'&&request.method==='GET') {
    const options=z.object({status:z.enum(['open','dismissed','actioned']).optional(),before:z.coerce.number().int().nonnegative().optional(),beforeId:z.uuid().optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().parse(Object.fromEntries(url.searchParams));
    return Response.json({reports:await gov.listReports(options)});
  }
  if(path==='/api/admin/audit'&&request.method==='GET')return Response.json({audit:await gov.auditList(100)});
  const resolve=/^\/api\/admin\/reports\/([0-9a-f-]{36})\/resolve$/.exec(path);
  if(resolve&&request.method==='POST') {const input=z.object({status:z.enum(['dismissed','actioned'])}).strict().parse(await json(request));return response(await gov.resolveReport(resolve[1],input.status));}
  const suspend=/^\/api\/admin\/users\/([0-9a-f-]{36})\/suspension$/.exec(path);
  if(suspend&&request.method==='POST') {const input=z.object({suspended:z.boolean(),reason:moderationReason}).strict().parse(await json(request));return Response.json(await gov.setSuspended(suspend[1],input.suspended,input.reason));}
  if(path==='/api/admin/backups/manifests'&&request.method==='GET')return Response.json({manifests:await gov.backupManifests()});
  if(path==='/api/admin/backups/export'&&request.method==='POST') {
    const users=[];const trips=[];const auth=[];const chain=[];
    for(const id of await allIds(env,'user')){
      const snapshot=await env.USERS.getByName(id).exportSnapshot();if(!snapshot)continue;users.push({id,snapshot});
      if(snapshot.wallet){const authId=`wallet:${snapshot.wallet}`;const wallet=await env.AUTH.getByName(authId).exportSnapshot();if(wallet)auth.push({id:authId,snapshot:wallet});}
    }
    let cursor:string|undefined;
    do{const page=await gov.walletIds(cursor,100);for(const wallet of page.ids){const id=`wallet:${wallet}`;if(auth.some(item=>item.id===id))continue;const snapshot=await env.AUTH.getByName(id).exportSnapshot();if(snapshot)auth.push({id,snapshot});}cursor=page.nextCursor??undefined;if(auth.length>2000)throw new Error('Wallet registry exceeds the bounded maintenance export size.');}while(cursor);
    for(const id of await allIds(env,'trip')){const snapshot=await env.TRIPS.getByName(id).exportSnapshot();if(snapshot)trips.push({id,snapshot});const linked=await env.CHAIN.getByName(id).exportSnapshot();if(linked)chain.push({id,snapshot:linked});}
    const value={schemaVersion:1 as const,environment:env.APP_ENV as 'development'|'staging'|'production',createdAt:Date.now(),resources:{users,trips,auth,chain,governance:await gov.exportState()}};
    const encoded=JSON.stringify(value);if(new TextEncoder().encode(encoded).length>8_000_000)return Response.json({error:'Backup exceeds the 8 MB maintenance limit.'},{status:413});
    await gov.recordBackup({id:crypto.randomUUID(),schemaVersion:1,createdAt:value.createdAt,environment:value.environment,sha256:await digest(encoded),resources:{users:users.length,trips:trips.length,auth:auth.length,chain:chain.length}});
    return new Response(encoded,{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  }
  if(path==='/api/admin/backups/restore'&&request.method==='POST') {
    if(env.APP_ENV==='production'||env.RESTORE_ALLOWED!=='true')return Response.json({error:'Restore requires an explicitly enabled isolated development or staging environment.'},{status:403});
    const input=z.object({snapshot:backup,idempotencyKey:z.uuid()}).strict().parse(await json(request,8_100_000));const data=input.snapshot;
    for(const kind of ['users','trips','auth','chain'] as const)if(new Set(data.resources[kind].map(item=>item.id)).size!==data.resources[kind].length)return Response.json({error:'Duplicate backup resource ID.'},{status:400});
    if(!await gov.validateState(data.resources.governance))return Response.json({error:'Invalid governance snapshot.'},{status:400});
    // Each object validates its complete schema before ANY restore writes are started.
    for(const item of data.resources.users){if(!z.uuid().safeParse(item.id).success||!await env.USERS.getByName(item.id).validateSnapshot(item.snapshot,item.id))return Response.json({error:'Invalid account snapshot.'},{status:400});}
    for(const item of data.resources.trips){if(!z.uuid().safeParse(item.id).success||!await env.TRIPS.getByName(item.id).validateSnapshot(item.snapshot,item.id))return Response.json({error:'Invalid trip snapshot.'},{status:400});}
    for(const item of data.resources.chain){if(!z.uuid().safeParse(item.id).success||!await env.CHAIN.getByName(item.id).validateSnapshot(item.snapshot,item.id))return Response.json({error:'Invalid chain snapshot.'},{status:400});}
    for(const item of data.resources.auth){const snap=z.object({version:z.literal(1),accountId:z.uuid()}).strict().safeParse(item.snapshot);if(!snap.success||!/^wallet:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(item.id)||!(data.resources.users.some(user=>user.id===snap.data.accountId&&(user.snapshot as AccountSnapshot).wallet===item.id.slice(7))||(data.resources.governance as GovernanceExport).wallets?.some(entry=>entry.wallet===item.id.slice(7)&&entry.accountId===snap.data.accountId)))return Response.json({error:'Invalid wallet registry snapshot.'},{status:400});}
    const begun=await gov.beginRestore(input.idempotencyKey,await digest(JSON.stringify(data)));if(!begun.ok||begun.value.completed)return response(begun);
    const protectedState=await gov.restoreState(data.resources.governance);if(!protectedState.ok)return response(protectedState);
    for(const item of data.resources.users)if(!(await gov.status(item.id)).deleted)await env.USERS.getByName(item.id).restoreSnapshot(item.snapshot as AccountSnapshot);
    for(const item of data.resources.auth){const value=item.snapshot as {version:1;accountId:string};await env.AUTH.getByName(item.id).restoreSnapshot(value);}
    for(const item of data.resources.trips)if(!await gov.isTripPurged(item.id))await env.TRIPS.getByName(item.id).restoreSnapshot(item.snapshot as NonNullable<Awaited<ReturnType<ReturnType<WorkerEnv['TRIPS']['getByName']>['exportSnapshot']>>>);
    for(const item of data.resources.chain)if(!await gov.isTripPurged(item.id))await env.CHAIN.getByName(item.id).restoreSnapshot(item.snapshot as ChainBinding);
    return response(await gov.completeRestore(input.idempotencyKey));
  }
  return Response.json({error:'Operator endpoint not found.'},{status:404});
}
