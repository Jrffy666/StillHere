import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey, Transaction, type AccountInfo } from '@solana/web3.js';
import {
  buildCommunityEventInstruction, buildWithdrawCommunityJourneyInstruction,
  deriveCommunityConfigAddress, deriveCommunityRecordAddress, deriveCommunityJourneyAddress, deriveCommunityWithdrawalAddress,
  decodeCommunityConfig, decodeCommunityRecord, decodeCommunityJourney, communityRecordMatchesEvent,
  type CommunityConfig, type CommunityRecord,
} from '../../chain/src/community';
import { boundedJson } from './integrations';
import type { WorkerEnv } from './types';
import type { CommunityChainConfiguration, CommunityChainResult, CommunityCorrectionView, CommunitySignedSubmission, CommunityStoredRecord } from './community-types';

const DEVNET_GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PUBLIC_GENESIS=new Set([DEVNET_GENESIS,'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d','4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY']);
function keypair(value:string|undefined):Keypair {
  if(!value||value.length>1024)throw new Error('Missing publication authority.');
  const bytes:unknown=JSON.parse(value);
  if(!Array.isArray(bytes)||bytes.length!==64||bytes.some(item=>!Number.isInteger(item)||item<0||item>255))throw new Error('Invalid publication authority.');
  return Keypair.fromSecretKey(new Uint8Array(bytes));
}
function program(env:WorkerEnv):PublicKey {
  const key=new PublicKey(env.COMMUNITY_PROGRAM_ID);
  if(key.equals(PublicKey.default)||key.toBase58()!==env.COMMUNITY_PROGRAM_ID)throw new Error('Invalid community program.');return key;
}
function cluster(env:WorkerEnv):'devnet'|'localnet'{
  if(env.SOLANA_NETWORK==='devnet')return 'devnet';
  if(env.SOLANA_NETWORK==='localnet'&&env.APP_ENV==='development')return 'localnet';
  throw new Error('Community publication supports Devnet and local development only.');
}
export function communityConfiguration(env:WorkerEnv):CommunityChainConfiguration {
  let programId:string|null=null,issuer:string|null=null,sponsor:string|null=null;
  const network=env.SOLANA_NETWORK==='localnet'&&env.APP_ENV==='development'?'localnet':'devnet';
  try{programId=program(env).toBase58();cluster(env);issuer=keypair(env.COMMUNITY_ISSUER_SECRET_KEY).publicKey.toBase58();sponsor=keypair(env.COMMUNITY_SPONSOR_SECRET_KEY).publicKey.toBase58();
    return {configured:env.COMMUNITY_ENABLED==='true'&&issuer!==sponsor,network,programId,issuer,sponsor};
  }catch{return {configured:false,network,programId,issuer:null,sponsor:null};}
}
export function communityReadConfigured(env:WorkerEnv):boolean {try{program(env);cluster(env);return true;}catch{return false;}}
async function reader(env:WorkerEnv):Promise<{rpc:Connection;programId:PublicKey;config:CommunityConfig}>{
  const programId=program(env),network=cluster(env);
  let url:URL;try{url=new URL(env.SOLANA_PRIVATE_RPC_URL?.trim()||env.SOLANA_RPC_URL);}catch{throw new Error('Invalid community RPC configuration.');}
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.username||url.password||(network==='devnet'&&(local||url.protocol!=='https:'))||(network==='localnet'&&(!local||!['http:','https:'].includes(url.protocol))))throw new Error('Invalid community RPC network.');
  const signal=AbortSignal.timeout(10_000);
  const rpc=new Connection(url.toString(),{commitment:'finalized',disableRetryOnRateLimit:true,fetch:async(input,init)=>{
    try{
      const response=await fetch(input,{...init,signal,redirect:'manual'});
      if(!response.ok){await response.body?.cancel();throw new Error('RPC unavailable.');}
      const data=await boundedJson(response,512_000);if(data&&typeof data==='object'&&'error'in data)throw new Error('RPC rejected the request.');return Response.json(data);
    }catch{
      // Let web3 construct its own RPC error. This also avoids its callback
      // transport swallowing errors created in a different runtime realm.
      return new Response('The community RPC request could not be verified.',{status:503});
    }
  }});
  const genesis=await rpc.getGenesisHash();if(network==='devnet'?genesis!==DEVNET_GENESIS:PUBLIC_GENESIS.has(genesis))throw new Error('The community RPC uses the wrong network.');
  const account=await rpc.getAccountInfo(deriveCommunityConfigAddress(programId),'finalized');
  validateOwner(account,programId);const config=decodeCommunityConfig(account!.data);
  return {rpc,programId,config};
}
async function client(env:WorkerEnv):Promise<{rpc:Connection;programId:PublicKey;issuer:Keypair;sponsor:Keypair;config:CommunityConfig}>{
  if(!communityConfiguration(env).configured)throw new Error('Community publication is not configured.');
  const {rpc,programId,config}=await reader(env),issuer=keypair(env.COMMUNITY_ISSUER_SECRET_KEY),sponsor=keypair(env.COMMUNITY_SPONSOR_SECRET_KEY);
  if(!config.issuer.equals(issuer.publicKey)||!config.sponsor.equals(sponsor.publicKey)||config.admin.equals(issuer.publicKey)||config.admin.equals(sponsor.publicKey))throw new Error('The community authorities do not match the deployed configuration.');
  return {rpc,programId,issuer,sponsor,config};
}
function validateOwner(account:AccountInfo<Buffer>|null,programId:PublicKey):asserts account is AccountInfo<Buffer> {
  if(!account||account.executable||!account.owner.equals(programId))throw new Error('Community account ownership could not be verified.');
}
async function readRecord(rpc:Connection,programId:PublicKey,journeyId:string,sequence:number):Promise<{record:CommunityRecord;address:string}|null>{
  const address=deriveCommunityRecordAddress(journeyId,sequence,programId),account=await rpc.getAccountInfo(address,'finalized');
  if(!account)return null;validateOwner(account,programId);return {record:decodeCommunityRecord(account.data),address:address.toBase58()};
}
function verified(record:CommunityStoredRecord,value:{record:CommunityRecord;address:string},issuer:PublicKey,programId:PublicKey):CommunityChainResult&{programId:string;issuer:string}{
  const observed=value.record;
  if(!communityRecordMatchesEvent(observed,record.event)||!observed.issuer.equals(record.issuer?new PublicKey(record.issuer):issuer)||observed.points!==record.points||observed.reputation!==record.reputation||observed.targetSequence!==0)throw new Error('The finalized receipt differs from the expected evidence.');
  return {status:'finalized',recordAddress:value.address,signature:record.signature,finalizedAt:observed.recordedAt*1000,points:observed.points,reputation:observed.reputation,programId:programId.toBase58(),issuer:observed.issuer.toBase58()};
}
function assertPinned(record:CommunityStoredRecord,env:WorkerEnv,programId:PublicKey){
  if(record.network!==cluster(env)||record.programId&&record.programId!==programId.toBase58())throw new Error('An existing community journal cannot change network or program.');
}
/** Reconcile deterministic finalized receipts before preparing another signed transaction. */
export async function prepareCommunityRecord(env:WorkerEnv,record:CommunityStoredRecord):Promise<(CommunityChainResult&{programId:string;issuer:string})|{submission:CommunitySignedSubmission;programId:string;issuer:string;recordAddress:string}>{
  const {rpc,programId,issuer,sponsor}=await client(env);assertPinned(record,env,programId);
  const found=await readRecord(rpc,programId,record.event.journeyId,record.event.sequence);
  if(found)return verified(record,found,issuer.publicKey,programId);
  if(record.submission&&await rpc.getBlockHeight('finalized')<=record.submission.lastValidBlockHeight)return {submission:record.submission,programId:programId.toBase58(),issuer:record.issuer??issuer.publicKey.toBase58(),recordAddress:deriveCommunityRecordAddress(record.event.journeyId,record.event.sequence,programId).toBase58()};
  const latest=await rpc.getLatestBlockhash('finalized');
  const transaction=new Transaction({feePayer:sponsor.publicKey,recentBlockhash:latest.blockhash}).add(buildCommunityEventInstruction({programId,issuer:issuer.publicKey,sponsor:sponsor.publicKey,event:record.event}));
  transaction.sign(sponsor,issuer);
  const submission={signature:bs58.encode(transaction.signature!),transaction:transaction.serialize().toString('base64'),lastValidBlockHeight:latest.lastValidBlockHeight,expiresAt:Date.now()+60_000};
  return {submission,programId:programId.toBase58(),issuer:issuer.publicKey.toBase58(),recordAddress:deriveCommunityRecordAddress(record.event.journeyId,record.event.sequence,programId).toBase58()};
}
/** Caller persists the exact signed bytes before this network side effect. */
export async function sendCommunityRecord(env:WorkerEnv,record:CommunityStoredRecord):Promise<CommunityChainResult&{programId:string;issuer:string}>{
  if(!record.submission)throw new Error('Persist a signed community submission first.');
  const {rpc,programId,issuer}=await client(env);assertPinned(record,env,programId);
  const existing=await readRecord(rpc,programId,record.event.journeyId,record.event.sequence);if(existing)return verified(record,existing,issuer.publicKey,programId);
  const signature=await rpc.sendRawTransaction(Buffer.from(record.submission.transaction,'base64'),{skipPreflight:false,maxRetries:0,preflightCommitment:'finalized'});
  if(signature!==record.submission.signature)throw new Error('The RPC returned a different transaction signature.');
  const found=await readRecord(rpc,programId,record.event.journeyId,record.event.sequence);if(found)return verified(record,found,issuer.publicKey,programId);
  return {status:'submitted',recordAddress:deriveCommunityRecordAddress(record.event.journeyId,record.event.sequence,programId).toBase58(),signature,finalizedAt:null,points:record.points,reputation:record.reputation,programId:programId.toBase58(),issuer:record.issuer??issuer.publicKey.toBase58()};
}
export async function prepareCommunityCorrection(env:WorkerEnv,view:CommunityCorrectionView):Promise<{transaction:string;admin:string;recordAddress:string;expiresAt:number}>{
  const {rpc,programId,sponsor,config}=await client(env),latest=await rpc.getLatestBlockhash('finalized');
  const transaction=new Transaction({feePayer:sponsor.publicKey,recentBlockhash:latest.blockhash}).add(buildWithdrawCommunityJourneyInstruction({programId,admin:config.admin,sponsor:sponsor.publicKey,...view}));
  transaction.partialSign(sponsor);
  return {transaction:transaction.serialize({requireAllSignatures:false}).toString('base64'),admin:config.admin.toBase58(),recordAddress:deriveCommunityWithdrawalAddress(view.journeyId,programId).toBase58(),expiresAt:Date.now()+60_000};
}
export function acceptCommunityCorrection(prepared:string,signed:string,expiresAt:number):CommunitySignedSubmission {
  if(Date.now()>=expiresAt||signed.length>4096||!/^[A-Za-z0-9+/]+={0,2}$/.test(signed))throw new Error('Correction signing window expired or invalid transaction.');
  const expected=Transaction.from(Buffer.from(prepared,'base64')),transaction=Transaction.from(Buffer.from(signed,'base64'));
  if(!expected.serializeMessage().equals(transaction.serializeMessage())||!transaction.verifySignatures()||!transaction.signature)throw new Error('Correction authorization does not match.');
  return {signature:bs58.encode(transaction.signature),transaction:transaction.serialize().toString('base64'),lastValidBlockHeight:0,expiresAt};
}
export async function reconcileCommunityCorrection(env:WorkerEnv,view:CommunityCorrectionView,submission:CommunitySignedSubmission,admin:string):Promise<Pick<CommunityCorrectionView,'status'|'recordAddress'|'signature'|'finalizedAt'>>{
  const {rpc,programId}=await reader(env);
  const validate=(found:{record:CommunityRecord;address:string})=>{
    const record=found.record;if(record.kind!=='withdrawn'||record.journeyId!==view.journeyId||record.sequence!==view.sequence||record.targetSequence!==view.targetSequence||record.value!==view.reason||record.observedAt!==view.observedAt||!record.issuer.equals(new PublicKey(admin))||record.points!==0||record.reputation!==0)throw new Error('The correction receipt does not match the authorized withdrawal.');
    return {status:'finalized' as const,recordAddress:found.address,signature:submission.signature,finalizedAt:record.recordedAt*1000};
  };
  const prior=await readWithdrawal(rpc,programId,view.journeyId);if(prior)return validate(prior);
  if(Date.now()>=submission.expiresAt)throw new Error('Reprepare the correction for a fresh admin signature.');
  const signature=await rpc.sendRawTransaction(Buffer.from(submission.transaction,'base64'),{skipPreflight:false,maxRetries:0,preflightCommitment:'finalized'});
  if(signature!==submission.signature)throw new Error('Unexpected correction signature.');
  const found=await readWithdrawal(rpc,programId,view.journeyId);if(found)return validate(found);
  return {status:'submitted',recordAddress:deriveCommunityWithdrawalAddress(view.journeyId,programId).toBase58(),signature,finalizedAt:null};
}
async function readWithdrawal(rpc:Connection,programId:PublicKey,journeyId:string):Promise<{record:CommunityRecord;address:string}|null>{
  const address=deriveCommunityWithdrawalAddress(journeyId,programId),account=await rpc.getAccountInfo(address,'finalized');
  if(!account)return null;validateOwner(account,programId);return {record:decodeCommunityRecord(account.data),address:address.toBase58()};
}
/** Refresh an externally signed withdrawal without trusting application flags or the current admin after rotation. */
export async function readCommunityWithdrawal(env:WorkerEnv,journeyId:string,expectedProgramId?:string):Promise<CommunityCorrectionView|null>{
  const {rpc,programId}=await reader(env),account=await rpc.getAccountInfo(deriveCommunityJourneyAddress(journeyId,programId),'finalized');
  if(expectedProgramId&&programId.toBase58()!==expectedProgramId)throw new Error('A journal cannot change its deployed program.');
  if(!account)return null;validateOwner(account,programId);const journey=decodeCommunityJourney(account.data);
  if(journey.journeyId!==journeyId)throw new Error('Unexpected community journey.');if(!journey.withdrawn)return null;
  const found=await readWithdrawal(rpc,programId,journeyId);
  if(!found||found.record.kind!=='withdrawn'||found.record.journeyId!==journeyId||found.record.targetSequence>=journey.nextSequence||![1,2,3,4].includes(found.record.value)||found.record.points!==0||found.record.reputation!==0)throw new Error('The withdrawal receipt could not be verified.');
  const record=found.record;return {journeyId,targetSequence:record.targetSequence,reason:record.value as 1|2|3|4,sequence:record.sequence,observedAt:record.observedAt,status:'finalized',recordAddress:found.address,signature:null,finalizedAt:record.recordedAt*1000,error:null,authority:record.issuer.toBase58()};
}
