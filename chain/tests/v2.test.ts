import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { SafetyGuardV2Client, V2_INSTRUCTION_DISCRIMINATORS, JOURNEY_V2_DISCRIMINATOR, REPUTATION_V2_DISCRIMINATOR, deriveJourneyAddress, deriveReputationV2Address, decodeJourneyV2, decodeReputationV2, randomJourneyReference, journeyReferenceFromHex, journeyReferenceToHex } from '../src/v2.ts';
const rider=Keypair.generate().publicKey, guardian=Keypair.generate().publicKey, program=Keypair.generate().publicKey;
const reference=new Uint8Array(32).fill(23), input={rider,guardian,reference,expectedRevision:4};
const client=new SafetyGuardV2Client(new Connection('http://127.0.0.1:8899'),program);
test('V2 instruction and account discriminators match Anchor',()=>{
  const names={createJourney:'create_journey',proposeGuardian:'propose_guardian',cancelProposal:'cancel_proposal',acceptGuardian:'accept_guardian',checkIn:'check_in',completeJourney:'complete_journey',cancelJourney:'cancel_journey',claimReward:'claim_reward'};
  for(const [key,name] of Object.entries(names)) assert.deepEqual(Buffer.from(V2_INSTRUCTION_DISCRIMINATORS[key as keyof typeof names]),createHash('sha256').update(`global:${name}`).digest().subarray(0,8));
  assert.deepEqual(Buffer.from(JOURNEY_V2_DISCRIMINATOR),createHash('sha256').update('account:JourneyV2').digest().subarray(0,8));
  assert.deepEqual(Buffer.from(REPUTATION_V2_DISCRIMINATOR),createHash('sha256').update('account:ReputationV2').digest().subarray(0,8));
});
test('V2 create and staged handover have correct actors, revisions, and no prior guardian signer',()=>{
  const create=client.createJourney({...input,deadline:1900000000}).instructions[0];
  assert.equal(create.keys.length,3); assert.ok(create.keys[0].pubkey.equals(rider)&&create.keys[0].isSigner&&create.keys[0].isWritable);
  assert.deepEqual(create.data.subarray(8,40),Buffer.from(reference)); assert.equal(create.data.readBigInt64LE(40),1900000000n);
  const propose=client.proposeGuardian(input).instructions[0]; assert.equal(propose.keys.length,2); assert.deepEqual(propose.data.subarray(8,40),guardian.toBuffer()); assert.equal(propose.data.readUInt32LE(40),4);
  const accept=client.acceptGuardian(input).instructions[0]; assert.ok(accept.keys[0].pubkey.equals(guardian)&&accept.keys[0].isSigner); assert.equal(accept.data.readUInt32LE(8),4);
  for(const transaction of [client.cancelProposal(input),client.completeJourney(input),client.cancelJourney(input)]) assert.ok(transaction.instructions[0].keys[0].pubkey.equals(rider)&&transaction.instructions[0].keys[0].isSigner);
  assert.equal(client.checkIn({...input,expectedSequence:3}).instructions[0].data.readUInt32LE(8),3);
});
test('V2 PDA and claims bind exact journey and beneficiary without forcing beneficiary to pay',()=>{
  assert.ok(client.getTaskAddress(input).equals(deriveJourneyAddress(rider,reference,program)));
  assert.ok(!deriveJourneyAddress(rider,reference,program).equals(deriveJourneyAddress(guardian,reference,program)));
  const ix=client.claimReward({...input,payer:rider}).instructions[0];
  assert.ok(ix.keys[0].isSigner&&ix.keys[0].pubkey.equals(rider)); assert.equal(ix.keys[1].isSigner,false);
  assert.ok(ix.keys[3].pubkey.equals(deriveReputationV2Address(guardian,program))); assert.ok(ix.keys[4].pubkey.equals(SystemProgram.programId));
});
function bytes(){const b=Buffer.alloc(1412); b.set(JOURNEY_V2_DISCRIMINATOR); b[8]=2; b.set(rider.toBytes(),9); b.set(reference,41); b.set(guardian.toBytes(),73); b.writeBigInt64LE(100n,137); b.writeBigInt64LE(200n,145); b.writeUInt32LE(9,169); b.writeUInt32LE(3,173); b[177]=2; b[178]=1; b[179]=250; b.set(guardian.toBytes(),180); b.writeUInt32LE(4,212); b.writeBigInt64LE(140n,216); b.writeBigInt64LE(101n,224); b.writeBigInt64LE(150n,232); b.writeBigUInt64LE(25n,240); b.writeBigUInt64LE(10n,248); b[256]=1; return b;}
test('V2 decoder reads exact sliced-byte offsets and preserves unsigned reward values',()=>{
  const storage=Buffer.alloc(1500); storage.set(bytes(),17); const j=decodeJourneyV2(storage.subarray(17,1429));
  assert.equal(j.assignmentRevision,9); assert.equal(j.sequence,3); assert.equal(j.state,'completed'); assert.equal(j.guardianCount,1);
  assert.deepEqual(j.contributions[0],{guardian,checkIns:4,lastCheckInAt:140,startedAt:101,endedAt:150,points:25n,reputation:10n,claimed:true});
  const rep=Buffer.alloc(66); rep.set(REPUTATION_V2_DISCRIMINATOR); rep[8]=2; rep.set(guardian.toBytes(),9); rep.writeBigUInt64LE(18446744073709551615n,41); rep.writeBigUInt64LE(10n,49); rep.writeBigUInt64LE(1n,57); assert.equal(decodeReputationV2(rep).points,18446744073709551615n);
});
test('V2 rejects legacy/wrong versions, malformed counts/flags and unsafe timestamps',()=>{
  assert.throws(()=>decodeJourneyV2(Buffer.alloc(150)));
  for(const [offset,value] of [[8,1],[177,9],[178,17],[256,2]]) {const b=bytes();b[offset]=value;assert.throws(()=>decodeJourneyV2(b));}
  const b=bytes();b.writeBigInt64LE(9007199254740992n,137);assert.throws(()=>decodeJourneyV2(b),/safe integer/);
  for(const expectedRevision of [-1,0x100000000,1.5]) assert.throws(()=>client.acceptGuardian({...input,expectedRevision}));
  assert.throws(()=>client.proposeGuardian({...input,guardian:rider}));assert.throws(()=>client.createJourney({...input,reference:new Uint8Array(32),deadline:200}));
  assert.throws(()=>journeyReferenceFromHex('00'.repeat(32)));const ref=randomJourneyReference();assert.deepEqual(journeyReferenceFromHex(journeyReferenceToHex(ref)),ref);
});
test('V2 fetch verifies program owner and immutable identity before returning data',async()=>{
  const data=bytes();const fake={getAccountInfo:async()=>({owner:program,data})} as unknown as Connection;
  const sdk=new SafetyGuardV2Client(fake,program); assert.equal((await sdk.fetchJourney(input))?.version,2);
  await assert.rejects(sdk.fetchJourney({...input,rider:guardian}),/identity/);
  const wrong={getAccountInfo:async()=>({owner:SystemProgram.programId,data})} as unknown as Connection;
  await assert.rejects(new SafetyGuardV2Client(wrong,program).fetchJourney(input),/owner/);
});
