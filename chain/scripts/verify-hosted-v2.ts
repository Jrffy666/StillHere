import { createPrivateKey, sign } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { SafetyGuardV2Client, decodeJourneyV2, deriveJourneyAddress, journeyReferenceFromHex, JOURNEY_V2_ACCOUNT_SIZE, REPUTATION_V2_ACCOUNT_SIZE } from '../src/v2.ts';
import { createPacedRpcFetch, DEVNET_GENESIS_HASH } from './verify.ts';

const API='https://safety-guard-api-production.2012044zj.workers.dev';
const SITE='https://safety-guard-htn2026.klavander56.chatgpt.site';
const PROGRAM='23f7UAfNbQCGdfQbJV3Tois98dETDfXnAXgjE5qTH5gb';
const LINUX_FUNDER='/root/safety-guard/contracts/.keys/deployer.json';
const WINDOWS_FUNDER=String.raw`\\wsl.localhost\Ubuntu-24.04\root\safety-guard\contracts\.keys\deployer.json`;
// Read the existing Linux key in place on either supported host. Never copy it
// into the Windows checkout or fall back to a wallet chosen by global settings.
const FUNDER=process.platform==='win32'?WINDOWS_FUNDER:LINUX_FUNDER;
const FUNDER_ADDRESS='AHdX6zJn3xYQXCBix3TvEqXUyV9x8PdPcEstsCkyhdE8';
const PARTICIPANT_LAMPORTS=20_000_000;
const MAXIMUM_FUNDER_DEBIT=150_000_000;
const pause=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));

class VerificationFailure extends Error {
  constructor(readonly code:string){super(code);}
}
function ensure(condition:unknown,code:string):asserts condition {if(!condition)throw new VerificationFailure(code);}
interface Options {funder:string;rpcEnvFile:string;report:string}
export function parseHostedOptions(args:string[]):Options {
  const values=new Map<string,string>();let apply=false;
  for(let index=0;index<args.length;index++){
    const arg=args[index];
    if(arg==='--apply'){ensure(!apply,'duplicate-apply');apply=true;continue;}
    ensure(['--funder','--rpc-env-file','--report'].includes(arg)&&!values.has(arg),'unsupported-or-duplicate-option');
    const value=args[++index];ensure(value&&!value.startsWith('--'),'missing-option-value');values.set(arg,value);
  }
  ensure(apply,'explicit-apply-required');
  ensure(values.get('--funder')===FUNDER,'only-project-devnet-funder-supported');
  const rpcEnvFile=values.get('--rpc-env-file');
  ensure(rpcEnvFile&&isAbsolute(rpcEnvFile)&&basename(rpcEnvFile)==='.dev.vars','explicit-absolute-dev-vars-path-required');
  const report=resolve(values.get('--report')??fileURLToPath(new URL('../../docs/deployment/application.v2.hosted.devnet.json',import.meta.url)));
  ensure(basename(report)==='application.v2.hosted.devnet.json'&&!report.split(/[\\/]/).includes('.keys'),'public-devnet-report-path-required');
  return {funder:FUNDER,rpcEnvFile,report};
}
export function rpcUrlFromEnvironment(contents:string):string {
  const lines=contents.split(/\r?\n/).filter(line=>/^\s*(?:export\s+)?SOLANA_PRIVATE_RPC_URL\s*=/.test(line));
  ensure(lines.length===1,'one-explicit-rpc-setting-required');
  let value:string|undefined;try{value=parseEnv(contents).SOLANA_PRIVATE_RPC_URL;}catch{throw new VerificationFailure('invalid-rpc-setting');}
  ensure(typeof value==='string'&&value.length>0,'invalid-rpc-setting');
  let url:URL;try{url=new URL(value);}catch{throw new VerificationFailure('invalid-rpc-setting');}
  ensure(url.protocol==='https:'&&!url.username&&!url.password&&!url.hash
    &&['devnet.helius-rpc.com','api.devnet.solana.com'].includes(url.hostname),'devnet-rpc-host-required');
  return url.toString();
}
function signatureText(bytes:Uint8Array):string {
  const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let value=0n;
  for(const byte of bytes)value=value*256n+BigInt(byte);
  let text='';while(value){text=alphabet[Number(value%58n)]+text;value/=58n;}
  for(const byte of bytes){if(byte)break;text='1'+text;}return text;
}
interface Profile {id:string;name:string;wallet:string|null;points:number;reputation:number;completedGuards:number}
interface Session {token:string;user:Profile}
interface Actor {label:string;session:Session;key:Keypair}
interface View {
  reference:string;programId:string;network:string;
  snapshot:{address:string;state:string;revision:number;sequence:number;deadline:number;currentGuardian:string|null;contributions:{wallet:string;checkIns:number;claimed:boolean;points:number;reputation:number}[]};
  intents:{id:string;status:string;signature:string|null}[];lastError:string|null;
}
interface Prepared {intentId:string;transaction:string;wallet:string;view:View}
type Operation='create'|'propose'|'accept'|'check-in'|'complete'|'claim';
interface Trace {operation:string;signature:string;status:'submitted'|'finalized'|'failed'|'expired'|'unconfirmed'}

/** No top-level execution on import: validation tests never connect or spend. */
export async function main(args=process.argv.slice(2)):Promise<void> {
  const options=parseHostedOptions(args);
  const report={schemaVersion:1,purpose:'Hosted Worker / Devnet V2 verification using project test SOL only',
    apiOrigin:API,signingOrigin:SITE,cluster:'devnet',programId:PROGRAM,startedAt:new Date().toISOString(),finishedAt:null as string|null,
    status:'running' as 'running'|'passed'|'failed',failure:null as string|null,checks:[] as string[],
    funding:{participantCount:3,lamportsPerParticipant:PARTICIPANT_LAMPORTS,totalTransferred:0,transactionFee:0,maximumDebit:MAXIMUM_FUNDER_DEBIT,
      rentLamports:{journey:0,reputation:0},feeReservePerParticipant:1_000_000,signature:null as string|null,status:'not-submitted'},
    transactions:[] as Trace[],points:[] as number[],reputation:[] as number[],
    cleanup:{syntheticAccounts:0,deletedAccounts:0,privateJourneyRemoved:false,monitoringStopped:false,reauthenticationAttempts:0},
    credentialsPersisted:false,publicChainRecordsRemain:true};
  const actors:Actor[]=[];let tripId:string|undefined,rider:Actor|undefined,journeyClosed=false;
  let connection:Connection|undefined;let lastSend=0,stage='preflight';
  const runDeadline=Date.now()+20*60_000;
  async function saveReport(){await mkdir(dirname(options.report),{recursive:true});await writeFile(options.report,JSON.stringify(report,null,2)+'\n','utf8');}
  function check(label:string,condition:unknown){ensure(condition,label);report.checks.push(label);}
  async function request<T>(path:string,actor?:Actor,body?:unknown,expected=200,timeout=15000):Promise<T>{
    ensure(stage==='cleanup'||Date.now()<runDeadline,'run-time-budget-exhausted');
    let response:Response;
    try{response=await fetch(API+'/api'+path,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(timeout),
      headers:{'Content-Type':'application/json',Origin:SITE,...(actor?{Authorization:`Bearer ${actor.session.token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});}
    catch{throw new VerificationFailure(`hosted-http-transport-${stage}`);}
    if(response.status!==expected){await response.body?.cancel();throw new VerificationFailure(`hosted-http-${response.status}-${stage}`);}
    try{return await response.json() as T;}catch{throw new VerificationFailure(`hosted-json-${stage}`);}
  }
  async function sendSpacing(){const wait=lastSend+1100-Date.now();if(wait>0)await pause(wait);lastSend=Date.now();}
  async function finalized(signature:string,deadline=Date.now()+90_000):Promise<void>{
    while(Date.now()<deadline){
      const status=(await connection!.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];
      if(status?.confirmationStatus==='finalized'){ensure(!status.err,'finalized-transaction-rejected');return;}
      await pause(Math.min(2500,Math.max(0,deadline-Date.now())));
    }
    throw new VerificationFailure('finalized-confirmation-timeout');
  }
  async function createActor(label:string):Promise<Actor>{
    stage=`account-${label}`;
    const value={label,key:Keypair.generate(),session:await request<Session>('/session',undefined,{name:`Hosted V2 ${label}`},201)};
    actors.push(value);report.cleanup.syntheticAccounts=actors.length;
    const challenge=await request<{id:string;message:string;domain:string;wallet:string;expiresAt:number}>('/auth/challenge',value,{intent:'bind',wallet:value.key.publicKey.toBase58()});
    ensure(challenge.domain===SITE&&challenge.wallet===value.key.publicKey.toBase58()&&challenge.expiresAt>Date.now()
      &&challenge.message.includes(`Domain: ${SITE}\n`)&&challenge.message.includes(`Account: ${value.session.user.id}\n`),'canonical-wallet-challenge-required');
    const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(value.key.secretKey.subarray(0,32))]),format:'der',type:'pkcs8'});
    const session=await request<Session>('/auth/verify',value,{challengeId:challenge.id,signature:sign(null,Buffer.from(challenge.message),privateKey).toString('base64')});
    ensure(session.user.id===value.session.user.id&&session.user.wallet===value.key.publicKey.toBase58(),'stable-wallet-account-required');value.session=session;
    return value;
  }
  function expectedTransaction(operation:Operation,actor:Actor,view:View,candidate?:Actor):Transaction {
    ensure(view.network==='devnet'&&view.programId===PROGRAM,'prepared-program-network-mismatch');
    const input={rider:rider!.key.publicKey,reference:journeyReferenceFromHex(view.reference),expectedRevision:view.snapshot.revision};
    ensure(deriveJourneyAddress(input.rider,input.reference,new PublicKey(PROGRAM)).toBase58()===view.snapshot.address,'prepared-journey-address-mismatch');
    const sdk=new SafetyGuardV2Client(connection!,new PublicKey(PROGRAM));
    switch(operation){
      case 'create':ensure(view.snapshot.deadline>Date.now()&&view.snapshot.deadline<=Date.now()+6*3_600_000+60_000,'unexpected-journey-deadline');return sdk.createJourney({...input,deadline:Math.floor(view.snapshot.deadline/1000)});
      case 'propose':ensure(candidate,'proposal-candidate-required');return sdk.proposeGuardian({...input,guardian:candidate.key.publicKey});
      case 'accept':return sdk.acceptGuardian({...input,guardian:actor.key.publicKey});
      case 'check-in':return sdk.checkIn({...input,guardian:actor.key.publicKey,expectedSequence:view.snapshot.sequence});
      case 'complete':return sdk.completeJourney(input);
      case 'claim':return sdk.claimReward({...input,guardian:actor.key.publicKey,payer:actor.key.publicKey});
    }
  }
  async function chain(actor:Actor,operation:Operation,label:string,applicationId?:string,candidate?:Actor):Promise<View>{
    stage=label;
    const prepared=await request<Prepared>(`/trips/${tripId}/chain/prepare`,actor,{operation,...(applicationId?{applicationId}:{})});
    ensure(prepared.wallet===actor.key.publicKey.toBase58(),'prepared-signer-mismatch');
    const transaction=Transaction.from(Buffer.from(prepared.transaction,'base64'));
    const expected=expectedTransaction(operation,actor,prepared.view,candidate);
    expected.feePayer=actor.key.publicKey;expected.recentBlockhash=transaction.recentBlockhash;
    ensure(transaction.signatures.every(item=>item.signature===null)&&transaction.serializeMessage().equals(expected.serializeMessage()),'prepared-message-mismatch');
    transaction.sign(actor.key);ensure(transaction.signature,'signed-transaction-required');
    const signature=signatureText(transaction.signature),trace:Trace={operation:label,signature,status:'submitted'};report.transactions.push(trace);
    await sendSpacing();await saveReport();
    const accepted=await request<{chain:View}>(`/trips/${tripId}/chain/submit`,actor,{intentId:prepared.intentId,transaction:transaction.serialize().toString('base64')});
    const initial=accepted.chain.intents.find(item=>item.id===prepared.intentId);
    ensure(initial?.signature===signature&&['submitted','confirmed'].includes(initial.status),'submitted-signature-mismatch');
    const deadline=Date.now()+90_000;
    while(Date.now()<deadline){
      await pause(Math.min(2500,Math.max(0,deadline-Date.now())));
      if(Date.now()>=deadline)break;
      const view=(await request<{chain:View}>(`/trips/${tripId}/chain/refresh`,actor,{},200,Math.max(1,Math.min(15000,deadline-Date.now())))).chain;
      const receipt=view.intents.find(item=>item.id===prepared.intentId);ensure(receipt?.signature===signature,'reconciled-signature-mismatch');
      if(receipt.status==='failed'||receipt.status==='expired'){trace.status=receipt.status;throw new VerificationFailure(`chain-${receipt.status}-${label}`);}
      if(receipt.status==='confirmed'&&!view.lastError){
        await finalized(signature,deadline);trace.status='finalized';await saveReport();
        console.log(JSON.stringify({operation:label,status:'finalized',signature}));return view;
      }
    }
    trace.status='unconfirmed';throw new VerificationFailure(`hosted-finality-timeout-${label}`);
  }
  async function action(actor:Actor,name:string,extra:Record<string,unknown>={}){
    return request<{trip:{status:string;application?:{id:string};relay?:{id:string};guardian?:{id:string}}}>(`/trips/${tripId}/actions`,actor,{action:name,...extra});
  }
  try{
    const config=await request<{chainV2:{network:string;configured:boolean;programId:string}}>('/config');
    const ready=await request<{ready:boolean;environment:string}>('/ready');
    check('hosted-production-devnet-ready',ready.ready&&ready.environment==='production'&&config.chainV2.configured&&config.chainV2.network==='devnet'&&config.chainV2.programId===PROGRAM);
    let rpc:string;try{rpc=rpcUrlFromEnvironment(await readFile(options.rpcEnvFile,'utf8'));}catch(error){if(error instanceof VerificationFailure)throw error;throw new VerificationFailure('cannot-read-explicit-rpc-env-file');}
    connection=new Connection(rpc,{commitment:'finalized',disableRetryOnRateLimit:true,
      fetch:createPacedRpcFetch({minimumIntervalMs:250,max429Retries:2,maximumRetryDelayMs:5000,
        fetchImpl:async(input,init)=>{try{return await fetch(input,{...init,redirect:'error'});}catch{throw new VerificationFailure('rpc-transport-unavailable');}}})});
    check('exact-devnet-genesis',await connection.getGenesisHash()===DEVNET_GENESIS_HASH);
    const deployed=await connection.getAccountInfo(new PublicKey(PROGRAM),'finalized');check('v2-program-executable',deployed?.executable===true);
    report.funding.rentLamports={journey:await connection.getMinimumBalanceForRentExemption(JOURNEY_V2_ACCOUNT_SIZE,'finalized'),
      reputation:await connection.getMinimumBalanceForRentExemption(REPUTATION_V2_ACCOUNT_SIZE,'finalized')};
    check('participant-funding-covers-actual-rent-and-fees',Object.values(report.funding.rentLamports).every(value=>
      Number.isSafeInteger(value)&&value>=0&&value+report.funding.feeReservePerParticipant<=PARTICIPANT_LAMPORTS));
    // No key is read until explicit apply, fixed endpoints, and the genesis check pass.
    ensure(resolve(await realpath(options.funder))===resolve(FUNDER),'project-funder-symlink-refused');
    let data:unknown;try{data=JSON.parse(await readFile(options.funder,'utf8'));}catch{throw new VerificationFailure('cannot-read-project-funder');}
    ensure(Array.isArray(data)&&data.length===64&&data.every(value=>Number.isInteger(value)&&value>=0&&value<=255),'invalid-project-funder');
    const funder=Keypair.fromSecretKey(Uint8Array.from(data));data.fill(0);
    ensure(funder.publicKey.toBase58()===FUNDER_ADDRESS,'project-funder-address-mismatch');
    rider=await createActor('rider');const a=await createActor('guardian A'),b=await createActor('guardian B');
    check('three-wallet-identities-bound',actors.length===3);
    stage='funding';
    const funding=new Transaction().add(...actors.map(actor=>SystemProgram.transfer({fromPubkey:funder.publicKey,toPubkey:actor.key.publicKey,lamports:PARTICIPANT_LAMPORTS})));
    const lifetime=await connection.getLatestBlockhash('finalized');funding.feePayer=funder.publicKey;funding.recentBlockhash=lifetime.blockhash;
    const fee=(await connection.getFeeForMessage(funding.compileMessage(),'finalized')).value;
    const total=actors.length*PARTICIPANT_LAMPORTS;
    ensure(fee!==null&&Number.isSafeInteger(fee)&&fee>=0&&total+fee<=MAXIMUM_FUNDER_DEBIT,'test-funding-budget-exceeded');
    ensure(await connection.getBalance(funder.publicKey,'finalized')>=total+fee,'insufficient-project-test-sol');
    // A single transfer packet is signed once; an ambiguous send is never re-signed.
    funding.sign(funder);ensure(funding.signature,'funding-signature-required');const fundingSignature=signatureText(funding.signature);
    report.funding={...report.funding,totalTransferred:total,transactionFee:fee,signature:fundingSignature,status:'submitted'};
    await sendSpacing();await saveReport();
    const submitted=await connection.sendRawTransaction(funding.serialize(),{skipPreflight:false,preflightCommitment:'finalized',maxRetries:0});
    ensure(submitted===fundingSignature,'funding-signature-mismatch');await finalized(fundingSignature);report.funding.status='finalized';await saveReport();
    check('funding-below-0.15-test-sol',total+fee<=MAXIMUM_FUNDER_DEBIT);
    stage='create-private-journey';
    tripId=(await request<{trip:{id:string}}>('/trips',rider,{chainEnabled:true,origin:{label:'Synthetic hosted start',lat:0,lng:0},destination:{label:'Synthetic hosted destination',lat:0.001,lng:0.001},checkInIntervalSeconds:300,notificationConsent:false},201)).trip.id;
    await chain(rider,'create','create');
    const first=await action(a,'accept',{requestId:tripId});ensure(first.trip.application,'guardian-a-application-required');
    await chain(rider,'propose','propose-A',first.trip.application.id,a);await chain(a,'accept','accept-A');
    check('signed-handoff-grants-private-access',(await request<{trip:{guardian:{id:string}}}>(`/trips/${tripId}`,a)).trip.guardian.id===a.session.user.id);
    await action(a,'check-in');await chain(a,'check-in','check-in-A');
    const relay=await action(a,'request-relay');ensure(relay.trip.relay,'relay-request-required');
    const second=await action(b,'accept',{requestId:relay.trip.relay.id});ensure(second.trip.application,'guardian-b-application-required');
    await chain(rider,'propose','propose-B',second.trip.application.id,b);await chain(b,'accept','accept-B');
    stage='former-guardian-access';await request(`/trips/${tripId}`,a,undefined,403);await request(`/trips/${tripId}/actions`,a,{action:'message',text:'Synthetic former guardian access check'},403);
    report.checks.push('former-guardian-private-access-revoked');
    await action(b,'check-in');await chain(b,'check-in','check-in-B');
    await action(rider,'arrive');journeyClosed=true;
    const before=await Promise.all([request<{user:Profile}>('/me',a),request<{user:Profile}>('/me',b)]);
    check('app-arrival-does-not-double-credit',before.every(value=>value.user.points===0&&value.user.reputation===0));
    await chain(rider,'complete','complete');await chain(a,'claim','claim-A');const settled=await chain(b,'claim','claim-B');
    stage='duplicate-claim';await request(`/trips/${tripId}/chain/prepare`,a,{operation:'claim'},409);report.checks.push('duplicate-claim-rejected');
    const profiles=await Promise.all([request<{user:Profile}>('/me',a),request<{user:Profile}>('/me',b)]);
    report.points=profiles.map(value=>value.user.points);report.reputation=profiles.map(value=>value.user.reputation);
    check('one-shared-25-point-10-reputation-pool',report.points.reduce((sum,value)=>sum+value,0)===25&&report.reputation.reduce((sum,value)=>sum+value,0)===10&&profiles.every(value=>value.user.completedGuards===1));
    const account=await connection.getAccountInfo(new PublicKey(settled.snapshot.address),'finalized');ensure(account?.owner.toBase58()===PROGRAM,'finalized-journey-owner-mismatch');
    const decoded=decodeJourneyV2(account.data);
    check('independent-finalized-chain-reward-check',decoded.state==='completed'&&decoded.contributions.length===2&&decoded.contributions.every(value=>value.claimed&&value.checkIns>0)
      &&decoded.contributions.reduce((sum,value)=>sum+value.points,0n)===25n&&decoded.contributions.reduce((sum,value)=>sum+value.reputation,0n)===10n);
    for(const actor of [a,b]){
      const allocation=decoded.contributions.find(value=>value.guardian.equals(actor.key.publicKey)),profile=profiles[[a,b].indexOf(actor)].user;
      ensure(allocation&&Number(allocation.points)===profile.points&&Number(allocation.reputation)===profile.reputation,'application-chain-allocation-mismatch');
    }
    const commitments=await request<{journeys:{id:string}[]}>('/commitments',a);check('former-guardian-retains-public-receipt-access',commitments.journeys.some(value=>value.id===tripId));
    check('ten-finalized-journey-transactions',report.transactions.length===10&&report.transactions.every(value=>value.status==='finalized'));
    report.status='passed';
  }catch(error){
    report.status='failed';report.failure=error instanceof VerificationFailure?error.code:`verification-failed-${stage}`;
  }finally{
    // Cleanup is application-only. Public transactions and funded test wallets
    // remain on Devnet; the generated signing keys are never written to disk.
    stage='cleanup';
    if(rider&&tripId){
      try{
        if(!journeyClosed){const cancelled=await action(rider,'cancel');journeyClosed=cancelled.trip.status==='cancelled';}
        report.cleanup.monitoringStopped=journeyClosed;
      }catch{report.cleanup.monitoringStopped=false;}
    }
    for(const actor of [...actors].sort((left,right)=>Number(left===rider)-Number(right===rider))){
      try{
        const remove=()=>request<{deleted:boolean}>('/account/delete',actor,{confirmation:'DELETE MY ACCOUNT'});
        let response:{deleted:boolean};
        try{response=await remove();}
        catch(error){
          if(!(error instanceof VerificationFailure)||error.code!=='hosted-http-401-cleanup')throw error;
          // Binding can commit before its HTTP response is lost. The retained
          // ephemeral wallet can recover a valid session for cleanup once.
          report.cleanup.reauthenticationAttempts++;
          const challenge=await request<{id:string;message:string;domain:string;intent:string;wallet:string;expiresAt:number}>('/auth/challenge',undefined,{intent:'login',wallet:actor.key.publicKey.toBase58()});
          ensure(challenge.domain===SITE&&challenge.intent==='login'&&challenge.wallet===actor.key.publicKey.toBase58()&&challenge.expiresAt>Date.now()
            &&challenge.message.includes(`Domain: ${SITE}\n`)&&challenge.message.includes('Intent: login\n')
            &&challenge.message.includes(`Wallet: ${actor.key.publicKey.toBase58()}\n`)&&challenge.message.includes(`Account: ${actor.session.user.id}\n`),'cleanup-login-challenge-mismatch');
          const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(actor.key.secretKey.subarray(0,32))]),format:'der',type:'pkcs8'});
          const recovered=await request<Session>('/auth/verify',undefined,{challengeId:challenge.id,signature:sign(null,Buffer.from(challenge.message),privateKey).toString('base64')});
          ensure(recovered.user.id===actor.session.user.id&&recovered.user.wallet===actor.key.publicKey.toBase58(),'cleanup-login-account-mismatch');
          actor.session=recovered;response=await remove();
        }
        if(response.deleted){report.cleanup.deletedAccounts++;if(actor===rider&&tripId)report.cleanup.privateJourneyRemoved=true;}
      }catch{ /* Continue deleting the other synthetic accounts without exposing errors or credentials. */ }
    }
    if(report.cleanup.deletedAccounts!==report.cleanup.syntheticAccounts||tripId&&(!report.cleanup.monitoringStopped||!report.cleanup.privateJourneyRemoved)){
      report.status='failed';report.failure??='synthetic-cleanup-incomplete';
    }
    report.finishedAt=new Date().toISOString();await saveReport();
    console.log(JSON.stringify({status:report.status,failure:report.failure,finalizedJourneyTransactions:report.transactions.filter(value=>value.status==='finalized').length,
      checks:report.checks.length,points:report.points,reputation:report.reputation,cleanup:report.cleanup}));
    if(report.status!=='passed')process.exitCode=1;
  }
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  main().catch(error=>{
    // Do not print raw SDK/network exceptions: they may contain a credentialed RPC URL.
    console.error(JSON.stringify({status:'failed',failure:error instanceof VerificationFailure?error.code:'hosted-verification-initialization-failed'}));process.exitCode=1;
  });
}
