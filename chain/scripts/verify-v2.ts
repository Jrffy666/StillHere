import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { SafetyGuardV2Client, randomJourneyReference, journeyReferenceToHex } from '../src/v2.ts';
import { createPacedRpcFetch, confirmSignatureHttp, submitTransactionHttp, expectProgramRejectionHttp, validateTestGenesis, resolveVerificationReportPath, resolveTestFunderPath } from './verify.ts';
const args=process.argv.slice(2);
if(args.length && (args.length!==2||args[0]!=='--cluster'||!['localnet','devnet'].includes(args[1])))throw new Error('Use --cluster localnet or --cluster devnet.');
const cluster=args[1]==='devnet'?'devnet':'localnet';
const rpc = cluster==='devnet'?'https://api.devnet.solana.com':'http://127.0.0.1:8899';
const connection = new Connection(rpc, {commitment:'confirmed',disableRetryOnRateLimit:true,fetch:createPacedRpcFetch({minimumIntervalMs:cluster==='devnet'?1200:25})});
const genesis = await connection.getGenesisHash();
validateTestGenesis(cluster,genesis,cluster==='devnet');
const metadata = JSON.parse(await readFile(new URL('../../contracts/deployment-v2.json',import.meta.url),'utf8'));
assert.equal(metadata.version,2);
const programId = new PublicKey(metadata.programId);
assert.notEqual(programId.toBase58(),'6QoP3pGGBpCDdpCzK8DZhx5rZa99D4RZwkbNteSwY6kK','V1 must remain separate');
const sdk = new SafetyGuardV2Client(connection,programId);
assert.ok(await sdk.isProgramDeployed(),'Deploy the separate V2 binary to the local validator first');
const rider = Keypair.generate(), a = Keypair.generate(), b = Keypair.generate(), outsider = Keypair.generate();
const signatures:Array<{label:string;signature:string}>=[];
const rejectionChecks:string[]=[];
async function confirmed(signature:string,lastValidBlockHeight?:number) { await confirmSignatureHttp(connection,signature,{lastValidBlockHeight,pollIntervalMs:150,timeoutMs:60000}); }
const funder=cluster==='devnet'?Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(resolveTestFunderPath(process.env.GUARD_TEST_FUNDER_KEYPAIR??''),'utf8')))):null;
for(const [label,key] of [['rider',rider],['guardianA',a],['guardianB',b],['outsider',outsider]] as const) {
  if(funder){await send(`fund-${label}`,new Transaction().add(SystemProgram.transfer({fromPubkey:funder.publicKey,toPubkey:key.publicKey,lamports:LAMPORTS_PER_SOL/50})),funder);}
  else{const signature=await connection.requestAirdrop(key.publicKey,LAMPORTS_PER_SOL/5); await confirmed(signature); signatures.push({label:`fund-${label}`,signature});}
}
async function send(label:string,tx:Transaction,signer:Keypair) {
  const sent=await submitTransactionHttp(connection,tx,signer); signatures.push({label,signature:sent.signature}); await confirmed(sent.signature,sent.lastValidBlockHeight);
}
async function reject(label:string,tx:Transaction,signer:Keypair) { await expectProgramRejectionHttp(connection,tx,signer,label); rejectionChecks.push(label); }
const ref={rider:rider.publicKey,reference:randomJourneyReference()};
await send('create',sdk.createJourney({...ref,deadline:Math.floor(Date.now()/1000)+3600}),rider);
await send('propose-A',sdk.proposeGuardian({...ref,guardian:a.publicKey,expectedRevision:0}),rider);
await reject('stale-accept',sdk.acceptGuardian({...ref,guardian:a.publicKey,expectedRevision:0}),a);
await reject('outsider-accept',sdk.acceptGuardian({...ref,guardian:outsider.publicKey,expectedRevision:1}),outsider);
const wrongRider=sdk.cancelJourney({...ref,expectedRevision:1}); wrongRider.instructions[0].keys[0].pubkey=outsider.publicKey;
await reject('wrong-rider',wrongRider,outsider);
await send('accept-A',sdk.acceptGuardian({...ref,guardian:a.publicKey,expectedRevision:1}),a);
await reject('complete-without-checkin',sdk.completeJourney({...ref,expectedRevision:2}),rider);
await send('check-A',sdk.checkIn({...ref,guardian:a.publicKey,expectedSequence:1}),a);
await send('propose-B',sdk.proposeGuardian({...ref,guardian:b.publicKey,expectedRevision:2}),rider);
assert.ok((await sdk.fetchJourney(ref))!.currentGuardian.equals(a.publicKey),'A remains assigned while B is pending');
await reject('stale-cancel-proposal',sdk.cancelProposal({...ref,expectedRevision:2}),rider);
await send('accept-B',sdk.acceptGuardian({...ref,guardian:b.publicKey,expectedRevision:3}),b);
await reject('former-guardian-checkin',sdk.checkIn({...ref,guardian:a.publicKey,expectedSequence:2}),a);
await send('check-B',sdk.checkIn({...ref,guardian:b.publicKey,expectedSequence:2}),b);
await send('propose-returning-A',sdk.proposeGuardian({...ref,guardian:a.publicKey,expectedRevision:4}),rider);
await send('accept-returning-A',sdk.acceptGuardian({...ref,guardian:a.publicKey,expectedRevision:5}),a);
await reject('returning-guardian-old-sequence',sdk.checkIn({...ref,guardian:a.publicKey,expectedSequence:1}),a);
await new Promise(resolve=>setTimeout(resolve,16000));
await send('check-returning-A',sdk.checkIn({...ref,guardian:a.publicKey,expectedSequence:3}),a);
await send('complete',sdk.completeJourney({...ref,expectedRevision:6}),rider);
let journey=(await sdk.fetchJourney(ref))!;
assert.equal(journey.state,'completed'); assert.equal(journey.guardianCount,2); assert.equal(journey.assignmentRevision,7); assert.equal(journey.sequence,3);
assert.equal(journey.contributions.find(c=>c.guardian.equals(a.publicKey))!.checkIns,2);
assert.equal(journey.contributions.find(c=>c.guardian.equals(b.publicKey))!.checkIns,1);
assert.equal(journey.contributions.reduce((sum,c)=>sum+c.points,0n),25n);
assert.equal(journey.contributions.reduce((sum,c)=>sum+c.reputation,0n),10n);
const sorted=[...journey.contributions].sort((left,right)=>Buffer.compare(left.guardian.toBuffer(),right.guardian.toBuffer()));
assert.equal(sorted[0].points,13n); assert.equal(sorted[1].points,12n); assert.ok(sorted.every(c=>c.reputation===5n));
await send('claim-A',sdk.claimReward({...ref,guardian:a.publicKey,payer:rider.publicKey}),rider);
await send('claim-B',sdk.claimReward({...ref,guardian:b.publicKey,payer:rider.publicKey}),rider);
await reject('duplicate-claim',sdk.claimReward({...ref,guardian:a.publicKey,payer:rider.publicKey}),rider);
await reject('duplicate-complete',sdk.completeJourney({...ref,expectedRevision:7}),rider);
await reject('outsider-claim',sdk.claimReward({...ref,guardian:outsider.publicKey,payer:rider.publicKey}),rider);
journey=(await sdk.fetchJourney(ref))!; assert.ok(journey.contributions.every(c=>c.claimed));
for(const contribution of journey.contributions) {
  const rep=(await sdk.fetchReputation(contribution.guardian))!;
  assert.equal(rep.points,contribution.points); assert.equal(rep.reputation,contribution.reputation); assert.equal(rep.completedJourneys,1n);
}
const cancelled={rider:rider.publicKey,reference:randomJourneyReference()};
await send('create-cancelled',sdk.createJourney({...cancelled,deadline:Math.floor(Date.now()/1000)+3600}),rider);
await send('cancel',sdk.cancelJourney({...cancelled,expectedRevision:0}),rider);
await reject('cancelled-cannot-propose',sdk.proposeGuardian({...cancelled,guardian:a.publicKey,expectedRevision:1}),rider);
assert.equal((await sdk.fetchJourney(cancelled))!.state,'cancelled');
const report={purpose:'V2 signed relay and exact-once reward verification; no real funds',cluster,genesis,programId:programId.toBase58(),verifiedAt:new Date().toISOString(),journeyAddress:sdk.getJourneyAddress(ref).toBase58(),reference:journeyReferenceToHex(ref.reference),signatures,rejectionChecks,contributions:journey.contributions.map(c=>({...c,guardian:c.guardian.toBase58(),points:c.points.toString(),reputation:c.reputation.toString()}))};
const destination=resolveVerificationReportPath(process.env.GUARD_V2_VERIFICATION_REPORT??resolve(`artifacts/verification.v2.${cluster}.json`),cluster);
await mkdir(dirname(destination),{recursive:true}); await writeFile(destination,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({ok:true,programId:programId.toBase58(),confirmedTransactions:signatures.length,rejectedScenarios:rejectionChecks.length,report:destination}));
