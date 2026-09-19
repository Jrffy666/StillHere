import { Buffer } from 'buffer';
import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta, type Connection } from '@solana/web3.js';

export const COMMUNITY_CONFIG_SIZE = 109;
export const COMMUNITY_JOURNEY_SIZE = 796;
export const COMMUNITY_RECORD_SIZE = 173;
export const COMMUNITY_RULE_VERSION = 1;
export const COMMUNITY_KINDS = ['created', 'assigned', 'check_in', 'relay_requested', 'closed', 'contribution', 'gratitude', 'withdrawn'] as const;
export type CommunityRecordKind = typeof COMMUNITY_KINDS[number];
export type CommunityEventKind = Exclude<CommunityRecordKind, 'withdrawn'>;
export const COMMUNITY_CORRECTION_REASONS = { incorrect_evidence: 1, duplicate_identity: 2, invalid_authorization: 3, administrative_correction: 4 } as const;
export interface CommunityEventInput {
  journeyId: string; sequence: number; kind: CommunityEventKind; actorId: string; subjectId: string;
  assignment: number; observedAt: number; value: number;
}
export interface CommunityRecord extends Omit<CommunityEventInput, 'kind'> {
  kind: CommunityRecordKind; version: 1; provenance: 'platform-attested'; ruleVersion: 1;
  issuer: PublicKey; recordedAt: number; points: number; reputation: number; targetSequence: number;
}
export interface CommunityConfig { version: 1; admin: PublicKey; issuer: PublicKey; sponsor: PublicKey; revision: number }
export interface CommunityJourney {
  version: 1; journeyId: string; riderId: string; nextSequence: number; assignment: number; currentGuardianId: string;
  outcome: number; withdrawn: boolean; lastObservedAt: number;
  contributions: Array<{ memberId: string; checkIns: number; claimed: boolean; thanked: boolean; lastAssignment: number }>;
}
const IX = { initialize: [175,175,109,31,13,152,155,237], rotate: [163,56,249,242,156,15,235,120], append: [2,24,69,228,125,65,62,11], withdraw: [14,196,155,242,15,215,99,142] };
const ACCOUNT = { config: [110,210,240,20,146,183,120,59], journey: [93,94,183,178,6,70,89,0], record: [211,49,8,242,56,112,96,207] };
const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const ZERO = '0'.repeat(64);
function id(value: string, allowZero = false): Buffer {
  if (!/^[a-f0-9]{64}$/.test(value) || (!allowZero && value === ZERO)) throw new Error('Community identities must be lowercase nonzero 32-byte hex references.');
  return Buffer.from(value, 'hex');
}
function u32(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error('Expected an unsigned 32-bit integer.');
  const result=Buffer.alloc(4); result.writeUInt32LE(value,0); return result;
}
function i64(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Expected a positive safe timestamp in seconds.');
  const result=Buffer.alloc(8); new DataView(result.buffer,result.byteOffset,result.byteLength).setBigInt64(0,BigInt(value),true); return result;
}
function key(pubkey: PublicKey, isSigner = false, isWritable = false): AccountMeta { return { pubkey, isSigner, isWritable }; }
function pda(seeds: Buffer[], programId: PublicKey): PublicKey { return PublicKey.findProgramAddressSync(seeds, programId)[0]; }
export function deriveCommunityConfigAddress(programId: PublicKey): PublicKey { return pda([Buffer.from('community_config')],programId); }
export function deriveCommunityJourneyAddress(journeyId: string, programId: PublicKey): PublicKey { return pda([Buffer.from('community_journey'),id(journeyId)],programId); }
export function deriveCommunityRecordAddress(journeyId: string, sequence: number, programId: PublicKey): PublicKey { return pda([Buffer.from('community_record'),id(journeyId),u32(sequence)],programId); }
export function deriveCommunityWithdrawalAddress(journeyId:string,programId:PublicKey):PublicKey { return pda([Buffer.from('community_withdrawal'),id(journeyId)],programId); }
export function deriveCommunityProgramDataAddress(programId: PublicKey): PublicKey { return pda([programId.toBuffer()],UPGRADEABLE_LOADER); }
function distinct(admin: PublicKey, issuer: PublicKey, sponsor: PublicKey): void {
  if (new Set([admin,issuer,sponsor].map(p=>p.toBase58())).size !== 3 || [admin,issuer,sponsor].some(p=>p.equals(PublicKey.default))) throw new Error('Administrator, issuer, and sponsor must be separate nonzero keys.');
}
export function buildInitializeCommunityInstruction(input: {programId:PublicKey;admin:PublicKey;issuer:PublicKey;sponsor:PublicKey}): TransactionInstruction {
  const {programId,admin,issuer,sponsor}=input; distinct(admin,issuer,sponsor);
  return new TransactionInstruction({programId,keys:[key(admin,true,true),key(deriveCommunityConfigAddress(programId),false,true),key(programId),key(deriveCommunityProgramDataAddress(programId)),key(SystemProgram.programId)],data:Buffer.concat([Buffer.from(IX.initialize),issuer.toBuffer(),sponsor.toBuffer()])});
}
export function buildRotateCommunityAuthoritiesInstruction(input:{programId:PublicKey;admin:PublicKey;nextAdmin:PublicKey;nextIssuer:PublicKey;nextSponsor:PublicKey;expectedRevision:number}):TransactionInstruction {
  const {programId,admin,nextAdmin,nextIssuer,nextSponsor,expectedRevision}=input; distinct(nextAdmin,nextIssuer,nextSponsor);
  return new TransactionInstruction({programId,keys:[key(admin,true),key(deriveCommunityConfigAddress(programId),false,true)],data:Buffer.concat([Buffer.from(IX.rotate),nextAdmin.toBuffer(),nextIssuer.toBuffer(),nextSponsor.toBuffer(),u32(expectedRevision)])});
}
export function buildCommunityEventInstruction(input:{programId:PublicKey;issuer:PublicKey;sponsor:PublicKey;event:CommunityEventInput}):TransactionInstruction {
  const {programId,issuer,sponsor,event:e}=input;
  const kind=COMMUNITY_KINDS.indexOf(e.kind)+1;
  if(kind<1||kind>7||!Number.isInteger(e.value)||e.value<0||e.value>255) throw new Error('Invalid community event kind or value.');
  if(issuer.equals(sponsor)) throw new Error('Issuer and sponsor must be separate keys.');
  const payload=Buffer.concat([id(e.journeyId),u32(e.sequence),Buffer.from([kind]),id(e.actorId,e.kind==='relay_requested'&&e.value===1),id(e.subjectId),u32(e.assignment),i64(e.observedAt),Buffer.from([e.value])]);
  return new TransactionInstruction({programId,keys:[key(deriveCommunityConfigAddress(programId)),key(issuer,true),key(sponsor,true,true),key(deriveCommunityJourneyAddress(e.journeyId,programId),false,true),key(deriveCommunityRecordAddress(e.journeyId,e.sequence,programId),false,true),key(SystemProgram.programId)],data:Buffer.concat([Buffer.from(IX.append),payload])});
}
export function buildWithdrawCommunityJourneyInstruction(input:{programId:PublicKey;admin:PublicKey;sponsor:PublicKey;journeyId:string;sequence:number;targetSequence:number;reason:number;observedAt:number}):TransactionInstruction {
  const {programId,admin,sponsor,journeyId,sequence,targetSequence,reason,observedAt}=input;
  if(!Number.isInteger(reason)||reason<1||reason>4||targetSequence>=sequence) throw new Error('Invalid correction reason or target.');
  return new TransactionInstruction({programId,keys:[key(deriveCommunityConfigAddress(programId)),key(admin,true),key(sponsor,true,true),key(deriveCommunityJourneyAddress(journeyId,programId),false,true),key(deriveCommunityRecordAddress(journeyId,targetSequence,programId)),key(deriveCommunityWithdrawalAddress(journeyId,programId),false,true),key(SystemProgram.programId)],data:Buffer.concat([Buffer.from(IX.withdraw),id(journeyId),u32(sequence),u32(targetSequence),Buffer.from([reason]),i64(observedAt)])});
}
function checked(data:Uint8Array,size:number,discriminator:number[]):Buffer {
  const buffer=Buffer.from(data);
  if(buffer.length!==size||discriminator.some((v,i)=>buffer[i]!==v)||buffer[8]!==1) throw new Error('Unsupported community account layout.');
  return buffer;
}
function timestamp(buffer:Buffer,offset:number):number {
  const n=new DataView(buffer.buffer,buffer.byteOffset,buffer.byteLength).getBigInt64(offset,true); if(n<0n||n>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('Unsafe account timestamp.'); return Number(n);
}
function hex(buffer:Buffer,start:number,end:number):string {return Buffer.from(buffer.subarray(start,end)).toString('hex');}
function bool(buffer:Buffer,offset:number):boolean { if(buffer[offset]>1)throw new Error('Invalid Boolean field.'); return buffer[offset]===1; }
export function decodeCommunityConfig(data:Uint8Array):CommunityConfig {
  const b=checked(data,COMMUNITY_CONFIG_SIZE,ACCOUNT.config); return {version:1,admin:new PublicKey(b.subarray(9,41)),issuer:new PublicKey(b.subarray(41,73)),sponsor:new PublicKey(b.subarray(73,105)),revision:b.readUInt32LE(105)};
}
export function decodeCommunityRecord(data:Uint8Array):CommunityRecord {
  const b=checked(data,COMMUNITY_RECORD_SIZE,ACCOUNT.record);
  if(b[9]!==1||b[10]!==1||b[47]<1||b[47]>8)throw new Error('Unsupported record provenance, rule, or kind.');
  return {version:1,provenance:'platform-attested',ruleVersion:1,journeyId:hex(b,11,43),sequence:b.readUInt32LE(43),kind:COMMUNITY_KINDS[b[47]-1],actorId:hex(b,48,80),subjectId:hex(b,80,112),assignment:b.readUInt32LE(112),observedAt:timestamp(b,116),value:b[124],issuer:new PublicKey(b.subarray(125,157)),recordedAt:timestamp(b,157),points:b.readUInt16LE(165),reputation:b.readUInt16LE(167),targetSequence:b.readUInt32LE(169)};
}
export function decodeCommunityJourney(data:Uint8Array):CommunityJourney {
  const b=checked(data,COMMUNITY_JOURNEY_SIZE,ACCOUNT.journey); const count=b[123];
  if(count>16||b[113]>3)throw new Error('Invalid journey state.');
  return {version:1,journeyId:hex(b,9,41),riderId:hex(b,41,73),nextSequence:b.readUInt32LE(73),assignment:b.readUInt32LE(77),currentGuardianId:hex(b,81,113),outcome:b[113],withdrawn:bool(b,114),lastObservedAt:timestamp(b,115),contributions:Array.from({length:count},(_,i)=>{const o=124+i*42;return{memberId:hex(b,o,o+32),checkIns:b.readUInt32LE(o+32),claimed:bool(b,o+36),thanked:bool(b,o+37),lastAssignment:b.readUInt32LE(o+38)};})};
}
/** Independently fetch a bounded finalized journey journal, including its withdrawal record. */
export async function fetchFinalizedCommunityJourney(connection:Connection,programId:PublicKey,journeyId:string,maxRecords=4096):Promise<{journey:CommunityJourney;records:CommunityRecord[];asOfSlot:number}> {
  if(!Number.isInteger(maxRecords)||maxRecords<1||maxRecords>100_000)throw new Error('Invalid journal retrieval limit.');
  const response=await connection.getAccountInfoAndContext(deriveCommunityJourneyAddress(journeyId,programId),'finalized');
  if(!response.value||!response.value.owner.equals(programId)||response.value.executable)throw new Error('Journey is absent or owned by a different program.');
  const journey=decodeCommunityJourney(response.value.data);
  if(journey.journeyId!==journeyId||journey.nextSequence>maxRecords)throw new Error('Journey identity or retrieval bound mismatch.');
  const records:CommunityRecord[]=[];
  for(let start=0;start<journey.nextSequence;start+=100){
    const addresses=Array.from({length:Math.min(100,journey.nextSequence-start)},(_,i)=>deriveCommunityRecordAddress(journeyId,start+i,programId));
    const accounts=await connection.getMultipleAccountsInfo(addresses,{commitment:'finalized',minContextSlot:response.context.slot});
    for(let i=0;i<accounts.length;i++){const account=accounts[i];if(!account||!account.owner.equals(programId)||account.executable)throw new Error('Journal has a missing or foreign receipt.');
      const record=decodeCommunityRecord(account.data);if(record.journeyId!==journeyId||record.sequence!==start+i)throw new Error('Receipt does not match its deterministic address.');records.push(record);}
  }
  if(records.length!==journey.nextSequence||records[0]?.kind!=='created'||records.some(r=>r.kind==='withdrawn'))throw new Error('Incomplete or inconsistent journey journal.');
  if(journey.withdrawn){const account=await connection.getAccountInfo(deriveCommunityWithdrawalAddress(journeyId,programId),{commitment:'finalized',minContextSlot:response.context.slot});
    if(!account||!account.owner.equals(programId)||account.executable)throw new Error('Missing or foreign withdrawal receipt.');
    const withdrawal=decodeCommunityRecord(account.data);if(withdrawal.journeyId!==journeyId||withdrawal.kind!=='withdrawn'||withdrawal.sequence>journey.nextSequence||withdrawal.targetSequence>=withdrawal.sequence)throw new Error('Invalid withdrawal receipt.');records.push(withdrawal);}
  return {journey,records,asOfSlot:response.context.slot};
}
export function communityRecordMatchesEvent(record:CommunityRecord,event:CommunityEventInput):boolean {
  return record.version===1&&record.provenance==='platform-attested'&&record.ruleVersion===1&&(['journeyId','sequence','kind','actorId','subjectId','assignment','observedAt','value'] as const).every(k=>record[k]===event[k]);
}
/** Input records must first be verified as finalized, program-owned accounts at their deterministic addresses. */
export function reconstructCommunityProfile(memberId:string,records:readonly CommunityRecord[]):{
  points:number;reputation:number;completedGuards:number;gratitude:{total:number;companionship:number;thoughtfulness:number;relay:number};withdrawnJourneys:string[];
} {
  id(memberId);
  const unique=new Map<string,CommunityRecord>();
  for(const record of records){const ref=`${record.journeyId}:${record.kind==='withdrawn'?'withdrawn':record.sequence}`; const prior=unique.get(ref);
    if(prior&&JSON.stringify(prior)!==JSON.stringify(record))throw new Error('Conflicting records for one deterministic receipt.'); unique.set(ref,record);}
  const values=[...unique.values()]; const withdrawn=new Set(values.filter(r=>r.kind==='withdrawn').map(r=>r.journeyId));
  const result={points:0,reputation:0,completedGuards:0,gratitude:{total:0,companionship:0,thoughtfulness:0,relay:0},withdrawnJourneys:[...withdrawn].sort()};
  const credited=new Set<string>(), thanked=new Set<string>();
  for(const r of values){if(r.subjectId!==memberId||withdrawn.has(r.journeyId))continue;
    if(r.kind==='contribution'){if(credited.has(r.journeyId))throw new Error('Duplicate journey contribution.');credited.add(r.journeyId);result.points+=r.points;result.reputation+=r.reputation;result.completedGuards++;}
    if(r.kind==='gratitude'){if(thanked.has(r.journeyId))throw new Error('Duplicate journey gratitude.');thanked.add(r.journeyId);const category=({1:'companionship',2:'thoughtfulness',3:'relay'} as const)[r.value as 1|2|3];if(!category)throw new Error('Unknown gratitude category.');result.gratitude[category]++;result.gratitude.total++;}}
  return result;
}
