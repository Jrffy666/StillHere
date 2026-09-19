import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { fetchFinalizedCommunityJourney, reconstructCommunityProfile, communityRecordMatchesEvent } from '../src/community.ts';

// Uses synthetic participants only. Credentials are supplied by the operator and never written to the report.
const origin = new URL(process.env.GUARD_TEST_ORIGIN ?? 'http://localhost:5173');
if (origin.pathname !== '/' || origin.username || origin.password || !['http:', 'https:'].includes(origin.protocol)) throw new Error('Use a plain HTTP(S) application origin.');
const gateway = process.env.GUARD_TEST_GATEWAY_TOKEN;
if (gateway && origin.origin !== 'https://safety-guard-htn2026.klavander56.chatgpt.site') throw new Error('The private-site credential is restricted to the project origin.');
const operator = process.env.GUARD_TEST_OPERATOR_SECRET;
const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const rpc = new Connection(rpcUrl, { commitment: 'finalized', disableRetryOnRateLimit: true });
const metadata = JSON.parse(await readFile(new URL('../../contracts/deployment-community.json', import.meta.url), 'utf8'));
const programId = new PublicKey(metadata.programId);
const sessions: Array<{ token: string; user: { id: string; name: string } }> = [];
const checks: string[] = [];
const receipts: Array<{ journeyId: string; records: number; asOfSlot: number; addresses: string[]; signatures: string[]; withdrawalAddress?: string }> = [];
const marker = randomUUID().slice(0, 8);
let cleaned = 0;
let passed = false;
function check(condition: unknown, name: string): asserts condition { assert.ok(condition, name); checks.push(name); }
async function request(path: string, token?: string, data?: unknown, expected = 200): Promise<any> {
  const response = await fetch(new URL(`/api${path}`, origin), {
    method: data === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(25000),
    headers: { ...(gateway ? { 'OAI-Sites-Authorization': `Bearer ${gateway}` } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  assert.equal(response.status, expected, `${path.split('/')[1]} operation: HTTP ${expected} required, received ${response.status}`);
  return response.json();
}
async function session(role: string) {
  const value = await request('/session', undefined, { name: `Ledger verification ${role} ${marker}` }, 201);
  sessions.push(value);
  await request('/me/community-notice', value.token, { version: 'community-v1' });
  return value as typeof sessions[number];
}
const input = { origin: { label: `Synthetic private pickup ${marker}`, lat: 43.47, lng: -80.54 }, destination: { label: `Synthetic private arrival ${marker}`, lat: 43.46, lng: -80.52 }, checkInIntervalSeconds: 300, notificationConsent: false, chainEnabled: false };
async function action(id: string, person: typeof sessions[number], name: string, extra: object = {}) { return request(`/trips/${id}/actions`, person.token, { action: name, ...extra }); }
async function assign(id: string, rider: typeof sessions[number], guardian: typeof sessions[number], requestId: string) {
  const application = (await action(id, guardian, 'accept', { requestId })).trip.application;
  assert.ok(application?.id, 'A guardian applies before being assigned');
  await action(id, rider, 'approve-guardian', { requestId: application.id });
  await action(id, guardian, 'check-in');
}
async function allRecords(id: string, token: string) {
  let cursor: string | null = null;
  const records: any[] = [];
  let correction: any = null;
  let journeyId: string | null = null;
  do {
    const page: { enabled: boolean; records: any[]; nextCursor: string | null; correction: any; journeyId: string } = (await request(`/trips/${id}/community${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, token)).community;
    assert.equal(page.enabled, true);
    records.push(...page.records); cursor = page.nextCursor; correction = page.correction; journeyId = page.journeyId;
  } while (cursor);
  return { records, correction, journeyId: journeyId! };
}
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, description: string, timeout = 600000): Promise<T> {
  const deadline = Date.now() + timeout;
  let logged = 0;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - logged >= 30000) { console.log(`Waiting: ${description}`); logged = Date.now(); }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}
try {
  check(await rpc.getGenesisHash() === 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', 'RPC is Solana Devnet');
  const [rider, first, second] = [await session('rider'), await session('guardian A'), await session('guardian B')];
  check(sessions.every(person => !('wallet' in person.user) || !person.user.wallet), 'All participants use free walletless accounts');
  const trip = (await request('/trips', rider.token, input, 201)).trip;
  await assign(trip.id, rider, first, trip.id);
  const relay1 = (await action(trip.id, first, 'request-relay')).trip.relay;
  await assign(trip.id, rider, second, relay1.id);
  const relay2 = (await action(trip.id, second, 'request-relay')).trip.relay;
  await assign(trip.id, rider, first, relay2.id);
  await action(trip.id, rider, 'arrive');
  await request(`/trips/${trip.id}/gratitude`, rider.token, { guardianId: first.user.id, kind: 'companionship' });
  await request(`/trips/${trip.id}/gratitude`, rider.token, { guardianId: second.user.id, kind: 'relay' });
  await request(`/trips/${trip.id}/gratitude`, rider.token, { guardianId: first.user.id, kind: 'companionship' });
  const journal = await until(() => allRecords(trip.id, rider.token), value => value.records.length >= 14 && value.records.every(record => record.status === 'finalized'), 'A → B → A history and appreciation publication');
  const sorted = journal.records.sort((a, b) => a.event.sequence - b.event.sequence);
  check(sorted.every((record, index) => record.event.sequence === index), 'Source and chain preserve every ordered event');
  const assignments = sorted.filter(record => record.event.kind === 'assigned');
  check(assignments.length === 3 && assignments[0].event.subjectId === assignments[2].event.subjectId && assignments[0].event.subjectId !== assignments[1].event.subjectId, 'A → B → A retains three distinct guarding assignments');
  check(sorted.filter(record => record.event.kind === 'contribution').reduce((sum, record) => sum + record.points, 0) === 25, 'One fixed 25-point contribution pool');
  check(sorted.filter(record => record.event.kind === 'gratitude').length === 2, 'Repeated thanks does not duplicate a banner');
  check(sorted.every(record => record.evidence === 'platform_attested' && record.programId === programId.toBase58()), 'All receipts identify the platform attestation and deployed program');
  const serialized = JSON.stringify(sorted);
  check(![input.origin.label, input.destination.label, trip.id, ...sessions.flatMap(person => [person.user.id, person.user.name, person.token])].some(value => serialized.includes(value)), 'Public records exclude private journey IDs, names, routes and credentials');
  const chain = await fetchFinalizedCommunityJourney(rpc, programId, journal.journeyId);
  receipts.push({ journeyId: journal.journeyId, records: chain.records.length, asOfSlot: chain.asOfSlot, addresses: sorted.map(record => record.recordAddress), signatures: sorted.map(record => record.signature).filter(Boolean) });
  check(chain.records.length === sorted.length, 'Every published record is independently readable from program-owned accounts');
  check(chain.records.every(record => {
    const projected = sorted.find(candidate => candidate.event.sequence === record.sequence);
    return projected && communityRecordMatchesEvent(record, projected.event) && record.points === projected.points && record.reputation === projected.reputation && record.issuer.toBase58() === projected.issuer;
  }), 'Every public event, allocation and issuer matches its independently decoded receipt');
  for (const person of [first, second]) {
    const profile = await until(() => request(`/members/${person.user.id}/records`, rider.token), value => value.ledger.finalized.contributions === 1 && value.ledger.finalized.banners === 1, 'member indexes to reflect finality');
    const rebuilt = reconstructCommunityProfile(profile.ledger.memberId, chain.records);
    check(rebuilt.points === profile.ledger.finalized.points && rebuilt.reputation === profile.ledger.finalized.reputation && rebuilt.gratitude.total === profile.ledger.finalized.banners, 'Profile recognition matches independent chain reconstruction');
    check(profile.legacy.points === 0 && profile.ledger.pending.points === 0, 'Published contributions are neither legacy credits nor counted twice');
  }
  const cancelled = (await request('/trips', rider.token, input, 201)).trip;
  await assign(cancelled.id, rider, second, cancelled.id);
  await action(cancelled.id, rider, 'cancel');
  await request(`/trips/${cancelled.id}/gratitude`, rider.token, { guardianId: second.user.id, kind: 'thoughtfulness' });
  const cancelledJournal = await until(() => allRecords(cancelled.id, rider.token), value => value.records.length >= 5 && value.records.every(record => record.status === 'finalized'), 'cancelled history and optional thanks');
  check(!cancelledJournal.records.some(record => record.event.kind === 'contribution') && cancelledJournal.records.some(record => record.event.kind === 'gratitude'), 'Cancellation preserves appreciation without awarding completion points');
  const cancelledChain = await fetchFinalizedCommunityJourney(rpc, programId, cancelledJournal.journeyId);
  receipts.push({ journeyId: cancelledJournal.journeyId, records: cancelledChain.records.length, asOfSlot: cancelledChain.asOfSlot, addresses: cancelledJournal.records.map(record => record.recordAddress), signatures: cancelledJournal.records.map(record => record.signature).filter(Boolean) });
  if (operator && process.env.GUARD_COMMUNITY_ADMIN_KEYPAIR) {
    const key = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(process.env.GUARD_COMMUNITY_ADMIN_KEYPAIR, 'utf8'))));
    const prepared = await request('/admin/community/corrections/prepare', operator, { journeyId: journal.journeyId, targetSequence: sorted.find(record => record.event.kind === 'contribution').event.sequence, reason: 4 });
    assert.equal(prepared.admin, key.publicKey.toBase58(), 'Use the configured correction authority');
    const transaction = Transaction.from(Buffer.from(prepared.transaction, 'base64')); transaction.partialSign(key);
    await request('/admin/community/corrections/submit', operator, { journeyId: journal.journeyId, transaction: transaction.serialize().toString('base64') });
    const correctedJournal = await until(() => allRecords(trip.id, rider.token), value => value.correction?.status === 'finalized' && value.records.every(record => record.withdrawn), 'authorized append-only correction');
    receipts[0].withdrawalAddress = correctedJournal.correction.recordAddress;
    const corrected = await fetchFinalizedCommunityJourney(rpc, programId, journal.journeyId);
    const profile = await until(() => request(`/members/${first.user.id}/records`, rider.token), value => value.ledger.finalized.points === 0 && value.ledger.finalized.banners === 0, 'corrected profile totals');
    check(reconstructCommunityProfile(profile.ledger.memberId, corrected.records).points === 0 && corrected.records.length === chain.records.length + 1, 'Correction preserves original evidence and excludes recognition');
  }
  for (const item of [trip, cancelled]) await request(`/trips/${item.id}/delete`, rider.token, { confirmation: 'DELETE JOURNEY' });
  const retained = await fetchFinalizedCommunityJourney(rpc, programId, cancelledJournal.journeyId);
  check(retained.records.length === cancelledChain.records.length, 'Deleting private journey details retains public receipts');
  passed = true;
  console.log(`Passed ${checks.length} hosted community checks.`);
} finally {
  for (const person of sessions) {
    try { await request('/account/delete', person.token, { confirmation: 'DELETE MY ACCOUNT' }); cleaned++; }
    catch { console.error('A synthetic account needs cleanup; no credential is logged.'); }
  }
  if (process.env.GUARD_COMMUNITY_REPORT) await writeFile(process.env.GUARD_COMMUNITY_REPORT, JSON.stringify({ verifiedAt: new Date().toISOString(), status: passed && cleaned === sessions.length ? 'passed' : 'failed', origin: origin.origin, programId: programId.toBase58(), checks, receipts, syntheticAccountsCreated: sessions.length, syntheticAccountsDeleted: cleaned }, null, 2) + '\n');
  console.log(`Removed ${cleaned}/${sessions.length} synthetic accounts.`);
}
