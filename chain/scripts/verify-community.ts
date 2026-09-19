import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js';
import {
  buildCommunityEventInstruction, buildInitializeCommunityInstruction, buildRotateCommunityAuthoritiesInstruction,
  buildWithdrawCommunityJourneyInstruction, decodeCommunityConfig, decodeCommunityJourney, decodeCommunityRecord,
  deriveCommunityConfigAddress, deriveCommunityJourneyAddress, deriveCommunityRecordAddress, deriveCommunityWithdrawalAddress,
  fetchFinalizedCommunityJourney, reconstructCommunityProfile, type CommunityEventInput,
} from '../src/community.ts';
import { confirmSignatureHttp, createPacedRpcFetch, validateTestGenesis } from './verify.ts';

const args=process.argv.slice(2);
if(args.length&&(args.length!==2||args[0]!=='--cluster'||!['localnet','devnet'].includes(args[1])))throw new Error('Use --cluster localnet or --cluster devnet.');
const cluster=args[1]==='devnet'?'devnet':'localnet';
const rpc=cluster==='devnet'?'https://api.devnet.solana.com':'http://127.0.0.1:8899';
const connection=new Connection(rpc,{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:createPacedRpcFetch({minimumIntervalMs:cluster==='devnet'?1100:15})});
const genesis=await connection.getGenesisHash();validateTestGenesis(cluster,genesis,cluster==='devnet');
const metadata=JSON.parse(await readFile(new URL('../../contracts/deployment-community.json',import.meta.url),'utf8'));
const programId=new PublicKey(metadata.programId);
const key=async(path:string|URL)=>Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(path,'utf8'))));
if(!process.env.COMMUNITY_TEST_ADMIN_KEYPAIR)throw new Error('Set COMMUNITY_TEST_ADMIN_KEYPAIR to the program upgrade-authority key. No key is printed.');
const admin=await key(process.env.COMMUNITY_TEST_ADMIN_KEYPAIR);
const issuer=await key(new URL('../../contracts/.keys/community-issuer.json',import.meta.url));
const sponsor=await key(new URL('../../contracts/.keys/community-sponsor.json',import.meta.url));
const outsider=Keypair.generate();
assert.equal(issuer.publicKey.toBase58(),metadata.issuer);assert.equal(sponsor.publicKey.toBase58(),metadata.sponsor);
assert.ok((await connection.getAccountInfo(programId))?.executable,'Deploy the community binary to the selected test network first.');
const signatures:Array<{label:string;signature:string}>=[],rejectionChecks:string[]=[];
async function send(label:string,ix:TransactionInstruction,signers:Keypair[],payer=sponsor):Promise<string>{
  const block=await connection.getLatestBlockhash('confirmed');const tx=new Transaction({...block,feePayer:payer.publicKey}).add(ix);
  tx.sign(...[...new Map([payer,...signers].map(k=>[k.publicKey.toBase58(),k])).values()]);
  const signature=await connection.sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:3});
  await confirmSignatureHttp(connection,signature,{lastValidBlockHeight:block.lastValidBlockHeight,pollIntervalMs:150,timeoutMs:60000});
  signatures.push({label,signature});return signature;
}
async function reject(label:string,ix:TransactionInstruction,signers:Keypair[]):Promise<void>{
  const block=await connection.getLatestBlockhash('confirmed');const tx=new Transaction({...block,feePayer:sponsor.publicKey}).add(ix);
  const result=await connection.simulateTransaction(tx,[...new Map([sponsor,...signers].map(k=>[k.publicKey.toBase58(),k])).values()]);
  assert.ok(result.value.err,`Expected program rejection: ${label}`);
  assert.ok(result.value.logs?.some(line=>line.includes(`Program ${programId.toBase58()} invoke`)),`Rejection must execute the community program: ${label}`);
  rejectionChecks.push(label);
}
if(cluster==='localnet')for(const wallet of[admin,sponsor]){const signature=await connection.requestAirdrop(wallet.publicKey,2_000_000_000);await confirmSignatureHttp(connection,signature,{pollIntervalMs:100,timeoutMs:60000});}
else{assert.ok((await connection.getBalance(sponsor.publicKey))>50_000_000,'Fund the dedicated sponsor with test SOL before verification.');}
const configAddress=deriveCommunityConfigAddress(programId);
if(!await connection.getAccountInfo(configAddress)){
  await reject('bootstrap-must-use-program-upgrade-authority',buildInitializeCommunityInstruction({programId,admin:sponsor.publicKey,issuer:issuer.publicKey,sponsor:outsider.publicKey}),[sponsor]);
  await send('initialize',buildInitializeCommunityInstruction({programId,admin:admin.publicKey,issuer:issuer.publicKey,sponsor:sponsor.publicKey}),[admin],admin);
}
const config=decodeCommunityConfig((await connection.getAccountInfo(configAddress))!.data);
assert.ok(config.admin.equals(admin.publicKey)&&config.issuer.equals(issuer.publicKey)&&config.sponsor.equals(sponsor.publicKey));
await reject('unauthorized-authority-rotation',buildRotateCommunityAuthoritiesInstruction({programId,admin:outsider.publicKey,nextAdmin:admin.publicKey,nextIssuer:issuer.publicKey,nextSponsor:sponsor.publicKey,expectedRevision:config.revision}),[outsider]);
await reject('stale-authority-rotation',buildRotateCommunityAuthoritiesInstruction({programId,admin:admin.publicKey,nextAdmin:admin.publicKey,nextIssuer:issuer.publicKey,nextSponsor:sponsor.publicKey,expectedRevision:config.revision+1}),[admin]);
await send('authority-revision',buildRotateCommunityAuthoritiesInstruction({programId,admin:admin.publicKey,nextAdmin:admin.publicKey,nextIssuer:issuer.publicKey,nextSponsor:sponsor.publicKey,expectedRevision:config.revision}),[admin]);
const rider='11'.repeat(32),a='22'.repeat(32),b='33'.repeat(32);
const journeyId=randomBytes(32).toString('hex');let sequence=0,assignment=0;
const event=(kind:CommunityEventInput['kind'],actorId:string,subjectId:string,value=0,selectedAssignment=assignment):CommunityEventInput=>({journeyId,sequence,kind,actorId,subjectId,assignment:selectedAssignment,observedAt:Math.floor(Date.now()/1000),value});
const instruction=(e:CommunityEventInput)=>buildCommunityEventInstruction({programId,issuer:issuer.publicKey,sponsor:sponsor.publicKey,event:e});
async function append(label:string,e:CommunityEventInput){await send(label,instruction(e),[issuer]);sequence++;}
const created=event('created',rider,rider);
await reject('unauthorized-issuer',buildCommunityEventInstruction({programId,issuer:outsider.publicKey,sponsor:sponsor.publicKey,event:created}),[outsider]);
await reject('unauthorized-sponsor',buildCommunityEventInstruction({programId,issuer:issuer.publicKey,sponsor:outsider.publicKey,event:created}),[issuer,outsider]);
await append('created',created);await reject('duplicate-created-receipt',instruction(created),[issuer]);
await reject('out-of-order-sequence',instruction({...event('assigned',rider,a,0,1),sequence:9}),[issuer]);
assignment=1;await append('assigned-A',event('assigned',rider,a));
await reject('checkin-wrong-actor',instruction(event('check_in',b,b)),[issuer]);
await reject('checkin-stale-assignment',instruction(event('check_in',a,a,0,0)),[issuer]);
await reject('checkin-future-observation',instruction({...event('check_in',a,a),observedAt:Math.floor(Date.now()/1000)+3600}),[issuer]);
await append('check-A',event('check_in',a,a));
await append('automatic-relay-request',event('relay_requested','0'.repeat(64),a,1));
assignment=2;await append('assigned-B',event('assigned',rider,b));
await reject('former-guardian-checkin',instruction(event('check_in',a,a)),[issuer]);
await append('check-B',event('check_in',b,b));
assignment=3;await append('returning-assignment-A',event('assigned',rider,a));
await append('check-returning-A',event('check_in',a,a));
await reject('thanks-before-close',instruction(event('gratitude',rider,b,1,2)),[issuer]);
await reject('withdrawal-before-close',buildWithdrawCommunityJourneyInstruction({programId,admin:admin.publicKey,sponsor:sponsor.publicKey,journeyId,sequence,targetSequence:0,reason:1,observedAt:Math.floor(Date.now()/1000)}),[admin]);
await append('arrived',event('closed',rider,rider,1));
await append('contribution-A',event('contribution',a,a));
await reject('duplicate-contribution-A',instruction(event('contribution',a,a)),[issuer]);
const beforeCorrection=decodeCommunityJourney((await connection.getAccountInfo(deriveCommunityJourneyAddress(journeyId,programId)))!.data);
assert.equal(beforeCorrection.assignment,3);assert.equal(beforeCorrection.contributions.length,2);assert.equal(beforeCorrection.contributions[0].checkIns,2);
const claimA=decodeCommunityRecord((await connection.getAccountInfo(deriveCommunityRecordAddress(journeyId,sequence-1,programId)))!.data);assert.equal(claimA.points,13);assert.equal(claimA.reputation,5);
const withdraw={programId,admin:admin.publicKey,sponsor:sponsor.publicKey,journeyId,sequence,targetSequence:sequence-1,reason:1,observedAt:Math.floor(Date.now()/1000)};
await reject('issuer-cannot-withdraw',buildWithdrawCommunityJourneyInstruction({...withdraw,admin:issuer.publicKey}),[issuer]);
await send('admin-withdrawal',buildWithdrawCommunityJourneyInstruction(withdraw),[admin]);
assert.equal(decodeCommunityJourney((await connection.getAccountInfo(deriveCommunityJourneyAddress(journeyId,programId)))!.data).nextSequence,sequence,'Correction must not consume source event sequence.');
await append('late-contribution-B-after-withdrawal',event('contribution',b,b,0,2));
await append('late-former-guardian-thanks-after-withdrawal',event('gratitude',rider,b,3,2));
await reject('duplicate-thanks',instruction(event('gratitude',rider,b,1,2)),[issuer]);
await reject('duplicate-withdrawal',buildWithdrawCommunityJourneyInstruction({...withdraw,sequence}),[admin]);
assert.equal(decodeCommunityRecord((await connection.getAccountInfo(deriveCommunityWithdrawalAddress(journeyId,programId)))!.data).kind,'withdrawn');

const cancelledId=randomBytes(32).toString('hex');
const cancelledEvents:CommunityEventInput[]=[
  {journeyId:cancelledId,sequence:0,kind:'created',actorId:rider,subjectId:rider,assignment:0,observedAt:Math.floor(Date.now()/1000),value:0},
  {journeyId:cancelledId,sequence:1,kind:'assigned',actorId:rider,subjectId:a,assignment:1,observedAt:Math.floor(Date.now()/1000),value:0},
  {journeyId:cancelledId,sequence:2,kind:'check_in',actorId:a,subjectId:a,assignment:1,observedAt:Math.floor(Date.now()/1000),value:0},
  {journeyId:cancelledId,sequence:3,kind:'closed',actorId:rider,subjectId:rider,assignment:1,observedAt:Math.floor(Date.now()/1000),value:2},
  {journeyId:cancelledId,sequence:4,kind:'gratitude',actorId:rider,subjectId:a,assignment:1,observedAt:Math.floor(Date.now()/1000),value:1},
];
for(const e of cancelledEvents)await send(`cancelled-${e.kind}`,instruction(e),[issuer]);
await reject('cancelled-no-contribution',instruction({...cancelledEvents[4],sequence:5,kind:'contribution',actorId:a,value:0}),[issuer]);
await reject('cancelled-cannot-checkin',instruction({...cancelledEvents[2],sequence:5}),[issuer]);
// Finalized reads intentionally occur after the normal confirmation path.
const start=Date.now();let proofs;
while(true){try{proofs=await Promise.all([fetchFinalizedCommunityJourney(connection,programId,journeyId),fetchFinalizedCommunityJourney(connection,programId,cancelledId)]);if(proofs[0].journey.nextSequence===sequence&&proofs[1].journey.nextSequence===5)break;}catch{ /* Finality can lag confirmation. */ }
  if(Date.now()-start>90000)throw new Error('Finalized community journals did not catch up.');await new Promise(resolve=>setTimeout(resolve,1000));}
const records=proofs.flatMap(p=>p.records);const profileA=reconstructCommunityProfile(a,records),profileB=reconstructCommunityProfile(b,records);
assert.equal(profileA.points,0);assert.equal(profileA.reputation,0);assert.equal(profileA.gratitude.total,1);assert.equal(profileB.points,0);assert.equal(profileB.gratitude.total,0);
const destination=resolve(process.env.COMMUNITY_VERIFICATION_REPORT??`artifacts/verification.community.${cluster}.json`);
await mkdir(dirname(destination),{recursive:true});await writeFile(destination,JSON.stringify({purpose:'Signed platform-attested community ledger, independent finalized reconstruction, and administrative withdrawal verification',cluster,genesis,programId:programId.toBase58(),verifiedAt:new Date().toISOString(),journeyId,cancelledId,signatures,rejectionChecks,finalizedRecords:records.length,profileA,profileB},null,2)+'\n');
console.log(JSON.stringify({ok:true,confirmedTransactions:signatures.length,rejectedScenarios:rejectionChecks.length,finalizedRecords:records.length,report:destination}));
