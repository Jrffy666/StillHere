import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction, type SignatureStatus } from '@solana/web3.js';
import { createPacedRpcFetch, confirmSignatureHttp, HttpConfirmationError, submitTransactionHttp, expectProgramRejectionHttp } from '../scripts/verify.ts';

function clock() {
  let time = 0;
  const sleeps: number[] = [];
  return { now: () => time, sleep: async (ms: number) => { sleeps.push(ms); time += ms; }, sleeps };
}
const confirmed: SignatureStatus = { slot: 42, confirmations: 1, err: null, confirmationStatus: 'confirmed' };
const processed: SignatureStatus = { slot: 41, confirmations: 0, err: null, confirmationStatus: 'processed' };
function statusResult(status: SignatureStatus | null) { return { context: { slot: 50 }, value: [status] }; }

test('RPC transport serializes concurrent callers and spaces request starts', async () => {
  const timing = clock();
  const starts: number[] = [];
  let inFlight = 0;
  let maximumInFlight = 0;
  const rpcFetch = createPacedRpcFetch({ ...timing, minimumIntervalMs: 1200, fetchImpl: async () => {
    starts.push(timing.now());
    maximumInFlight = Math.max(maximumInFlight, ++inFlight);
    await Promise.resolve();
    inFlight--;
    return new Response('{}');
  } });
  await Promise.all([rpcFetch('https://rpc.invalid'), rpcFetch('https://rpc.invalid'), rpcFetch('https://rpc.invalid')]);
  assert.equal(maximumInFlight, 1);
  assert.deepEqual(starts, [0, 1200, 2400]);
});

test('HTTP429 retries preserve the original signed payload and honor Retry-After', async () => {
  const timing = clock();
  const bodies: unknown[] = [];
  const responses = [new Response('limited', { status: 429, headers: { 'Retry-After': '3' } }), new Response('limited', { status: 429 }), new Response('{}')];
  let calls = 0;
  const rpcFetch = createPacedRpcFetch({ ...timing, minimumIntervalMs: 1200, fetchImpl: async (_input, init) => {
    bodies.push(init?.body);
    return responses[calls++];
  } });
  assert.equal((await rpcFetch('https://rpc.invalid', { method: 'POST', body: 'same-signed-transaction-bytes' })).status, 200);
  assert.deepEqual(timing.sleeps, [3000, 4000]);
  assert.deepEqual(bodies, Array(3).fill('same-signed-transaction-bytes'));
  assert.equal(responses[0].bodyUsed, true);
  assert.equal(responses[1].bodyUsed, true);
});

test('persistent HTTP429 is bounded and a failed request does not poison the queue', async () => {
  const timing = clock();
  let calls = 0;
  const rpcFetch = createPacedRpcFetch({ ...timing, minimumIntervalMs: 0, max429Retries: 2, fetchImpl: async () => {
    calls++;
    return new Response('', { status: calls <= 3 ? 429 : 200 });
  } });
  await assert.rejects(rpcFetch('https://rpc.invalid'), /bounded retries/);
  assert.equal(calls, 3);
  assert.deepEqual(timing.sleeps, [2000, 4000]);
  assert.equal((await rpcFetch('https://rpc.invalid')).status, 200);
  assert.equal(calls, 4);
});

test('a server cooldown beyond the retry budget stops without an early retry', async () => {
  const timing = clock();
  let calls = 0;
  const rpcFetch = createPacedRpcFetch({ ...timing, fetchImpl: async () => {
    calls++;
    return new Response('', { status: 429, headers: { 'Retry-After': '120' } });
  } });
  await assert.rejects(rpcFetch('https://rpc.invalid'), /Retry-After exceeds/);
  assert.equal(calls, 1);
  assert.deepEqual(timing.sleeps, []);
});

test('HTTP confirmation waits for confirmed status rather than accepting processed', async () => {
  const timing = clock();
  const statuses = [null, processed, confirmed];
  let reads = 0;
  let heightReads = 0;
  await confirmSignatureHttp({
    getSignatureStatuses: async (signatures, config) => {
      assert.deepEqual(signatures, ['public-signature']);
      assert.equal(config?.searchTransactionHistory, true);
      return statusResult(statuses[reads++]);
    },
    getBlockHeight: async () => { heightReads++; return 100; },
  }, 'public-signature', { ...timing, lastValidBlockHeight: 100, pollIntervalMs: 250 });
  assert.equal(reads, 3);
  assert.equal(heightReads, 2);
  assert.deepEqual(timing.sleeps, [250, 250]);
});

test('expiry checks the correct height and performs a final status read to avoid a confirmation race', async () => {
  for (const landsDuringHeightCheck of [false, true]) {
    const timing = clock();
    let reads = 0;
    const operation = confirmSignatureHttp({
      getSignatureStatuses: async () => statusResult(++reads === 2 && landsDuringHeightCheck ? confirmed : null),
      getBlockHeight: async () => 101,
    }, 'public-signature', { ...timing, lastValidBlockHeight: 100 });
    if (landsDuringHeightCheck) await operation;
    else await assert.rejects(operation, error => error instanceof HttpConfirmationError && error.state === 'expired' && error.signature === 'public-signature');
    assert.equal(reads, 2);
    assert.deepEqual(timing.sleeps, []);
  }
});

test('HTTP confirmation distinguishes on-chain errors from an unknown timed-out result', async () => {
  const failureTiming = clock();
  await assert.rejects(confirmSignatureHttp({
    getSignatureStatuses: async () => statusResult({ ...confirmed, err: { InstructionError: [0, { Custom: 6000 }] } }),
    getBlockHeight: async () => { throw new Error('No height read is needed after a known transaction failure.'); },
  }, 'failed-signature', failureTiming), error => error instanceof HttpConfirmationError && error.state === 'failed');
  const timeoutTiming = clock();
  let reads = 0;
  await assert.rejects(confirmSignatureHttp({
    getSignatureStatuses: async () => { reads++; return statusResult(null); },
    getBlockHeight: async () => { throw new Error('Faucet signatures have no client-known last valid height.'); },
  }, 'unknown-signature', { ...timeoutTiming, timeoutMs: 500, pollIntervalMs: 250 }), error => error instanceof HttpConfirmationError && error.state === 'unconfirmed' && /not evidence of transaction failure/.test(error.message));
  assert.equal(reads, 2);
  assert.deepEqual(timeoutTiming.sleeps, [250, 250]);
});

test('submission signs one transaction with the fetched lifetime and never opens a confirmation subscription', async () => {
  // Deterministic disposable test key: no wallet files or real RPC are involved.
  const signer = Keypair.fromSeed(new Uint8Array(32).fill(9));
  const recipient = new PublicKey(new Uint8Array(32).fill(8));
  const blockhash = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: recipient, lamports: 1 }));
  let submissions = 0;
  const result = await submitTransactionHttp({
    getLatestBlockhash: async commitment => { assert.equal(commitment, 'confirmed'); return { blockhash, lastValidBlockHeight: 123 }; },
    sendRawTransaction: async (raw, options) => {
      submissions++;
      const signed = Transaction.from(raw);
      assert.equal(signed.recentBlockhash, blockhash);
      assert.equal(signed.feePayer?.toBase58(), signer.publicKey.toBase58());
      assert.equal(signed.verifySignatures(), true);
      assert.deepEqual(options, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
      return 'public-signature';
    },
  }, tx, signer);
  assert.equal(submissions, 1);
  assert.deepEqual(result, { signature: 'public-signature', blockhash, lastValidBlockHeight: 123 });
});


test('negative checks use signed simulation without resubmitting an already confirmed transaction', async () => {
  const signer = Keypair.fromSeed(new Uint8Array(32).fill(9));
  const blockhash = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
  const makeTransaction = () => new Transaction().add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: new PublicKey(new Uint8Array(32).fill(8)), lamports: 1 }));
  let simulations = 0;
  await expectProgramRejectionHttp({
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 123 }),
    simulateTransaction: async (transaction, options) => {
      simulations++;
      assert.ok(transaction instanceof VersionedTransaction);
      assert.deepEqual(options, { sigVerify: true, commitment: 'confirmed' });
      assert.ok(transaction.signatures[0].some(byte => byte !== 0));
      return { context: { slot: 50 }, value: { err: { InstructionError: [0, { Custom: 6000 }] }, logs: ['Program failed: custom program error: 0x1770'] } };
    },
  }, makeTransaction(), signer, 'duplicate reward');
  assert.equal(simulations, 1);
  for (const outcome of ['success', 'unrelated-failure', 'network-error']) {
    await assert.rejects(expectProgramRejectionHttp({
      getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 123 }),
      simulateTransaction: async () => {
        if (outcome === 'network-error') throw new Error('RPC unavailable');
        return { context: { slot: 50 }, value: { err: outcome === 'success' ? null : 'BlockhashNotFound', logs: [] } };
      },
    }, makeTransaction(), signer, 'duplicate reward'));
  }
});
