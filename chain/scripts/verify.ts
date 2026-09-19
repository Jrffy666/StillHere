import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction,
  VersionedTransaction, type SignatureStatus,
} from '@solana/web3.js';
import { SafetyGuardClient, randomTripId, deriveTaskAddress } from '../src/index.ts';

type TestCluster = 'localnet' | 'devnet';
export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PUBLIC_GENESIS_HASHES = new Set([
  DEVNET_GENESIS_HASH,
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
]);
const PARTICIPANT_LAMPORTS = 0.05 * LAMPORTS_PER_SOL;
const PROJECT_FUNDER_PATH = fileURLToPath(new URL('../../contracts/.keys/deployer.json', import.meta.url));

type Delay = (milliseconds: number) => Promise<void>;
const delay: Delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

interface RpcPacingOptions {
  minimumIntervalMs?: number;
  max429Retries?: number;
  baseRetryDelayMs?: number;
  maximumRetryDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: Delay;
  now?: () => number;
  onRetry?: (attempt: number, waitMs: number) => void;
}

/** One queue covers every RPC method, including retries of the same signed bytes. */
export function createPacedRpcFetch(options: RpcPacingOptions = {}): typeof fetch {
  const minimumIntervalMs = options.minimumIntervalMs ?? 1200;
  const maximumRetries = options.max429Retries ?? 4;
  const baseDelay = options.baseRetryDelayMs ?? 2000;
  const maximumDelay = options.maximumRetryDelayMs ?? 30_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  let previousStart = -Infinity;
  let queue: Promise<unknown> = Promise.resolve();
  return (input, init) => {
    const operation = queue.then(async () => {
      for (let attempt = 0; ; attempt++) {
        const spacing = previousStart + minimumIntervalMs - now();
        if (spacing > 0) await sleep(spacing);
        previousStart = now();
        const timeout = AbortSignal.timeout(15_000);
        const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
        const response = await fetchImpl(input, { ...init, signal });
        if (response.status !== 429) return response;
        const retryAfter = response.headers.get('retry-after');
        const retryAfterMs = retryAfter === null ? 0
          : /^\d+(?:\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000
          : Math.max(0, Date.parse(retryAfter) - now());
        // Release the HTTP response before retrying, without logging its body.
        await response.arrayBuffer();
        if (attempt >= maximumRetries) throw new Error('Solana RPC rate limit persisted after bounded retries. Stop and retry verification later.');
        const waitMs = Math.max(baseDelay * 2 ** attempt, Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
        if (waitMs > maximumDelay) throw new Error('Solana RPC Retry-After exceeds this verification retry budget. Wait before running verification again.');
        options.onRetry?.(attempt + 1, waitMs);
        await sleep(waitMs);
      }
    });
    // A failed request must not permanently reject the queue for later callers.
    queue = operation.catch(() => undefined);
    return operation;
  };
}

type ConfirmationRpc = Pick<Connection, 'getSignatureStatuses' | 'getBlockHeight'>;
interface HttpConfirmationOptions {
  lastValidBlockHeight?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: Delay;
  now?: () => number;
}
export class HttpConfirmationError extends Error {
  constructor(public state: 'failed' | 'expired' | 'unconfirmed', public signature: string, message: string) {
    super(message);
    this.name = 'HttpConfirmationError';
  }
}

/** Confirm over HTTP only; never create a WebSocket subscription. */
export async function confirmSignatureHttp(connection: ConfirmationRpc, signature: string, options: HttpConfirmationOptions = {}): Promise<void> {
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 120_000);
  const isConfirmed = (status: SignatureStatus | null) => {
    if (status?.err) throw new HttpConfirmationError('failed', signature, `Transaction ${signature} failed on chain: ${JSON.stringify(status.err)}`);
    return status !== null && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized'
      || (status.confirmationStatus === undefined && status.confirmations === null));
  };
  while (now() < deadline) {
    const result = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    if (isConfirmed(result.value[0])) return;
    if (options.lastValidBlockHeight !== undefined
      && await connection.getBlockHeight('confirmed') > options.lastValidBlockHeight) {
      // The status may advance while the height request is in flight.
      const finalStatus = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      if (isConfirmed(finalStatus.value[0])) return;
      throw new HttpConfirmationError('expired', signature, `Transaction ${signature} exceeded its last valid block height without confirmed success. Inspect the signature before retrying.`);
    }
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(options.pollIntervalMs ?? 2000, remaining));
  }
  throw new HttpConfirmationError('unconfirmed', signature, `Confirmation timed out for ${signature}. This is not evidence of transaction failure; inspect the signature before retrying.`);
}

/** Submit exactly one signed transaction; confirmation is handled separately. */
export async function submitTransactionHttp(connection: Pick<Connection, 'getLatestBlockhash' | 'sendRawTransaction'>, transaction: Transaction, signer: Keypair) {
  const lifetime = await connection.getLatestBlockhash('confirmed');
  transaction.feePayer = signer.publicKey;
  transaction.recentBlockhash = lifetime.blockhash;
  transaction.sign(signer);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3,
  });
  return { signature, ...lifetime };
}

/** Negative checks simulate against current state rather than resending a previously confirmed signature. */
export async function expectProgramRejectionHttp(connection: Pick<Connection, 'getLatestBlockhash' | 'simulateTransaction'>, transaction: Transaction, signer: Keypair, label: string) {
  const lifetime = await connection.getLatestBlockhash('confirmed');
  transaction.feePayer = signer.publicKey;
  transaction.recentBlockhash = lifetime.blockhash;
  const signed = new VersionedTransaction(transaction.compileMessage());
  signed.sign([signer]);
  const result = await connection.simulateTransaction(signed, { sigVerify: true, commitment: 'confirmed' });
  // A transport failure, successful simulation, or unrelated runtime failure is not a passed check.
  assert.ok(result.value.err && result.value.logs?.some(line => line.includes('failed: custom program error')), `${label} must fail with a program custom error`);
}

/** Validate the cluster before reading any private key or requesting funds. */
export function validateTestGenesis(cluster: TestCluster, genesisHash: string, usesFunder: boolean, expectedLocalHash?: string) {
  new PublicKey(genesisHash);
  if (cluster === 'devnet') {
    if (genesisHash !== DEVNET_GENESIS_HASH) throw new Error('RPC genesis does not match Solana Devnet. No funds were requested.');
  } else if (cluster === 'localnet') {
    if (PUBLIC_GENESIS_HASHES.has(genesisHash)) throw new Error('The localhost RPC is connected to a public cluster. No funds were requested.');
    if ((usesFunder || expectedLocalHash !== undefined) && genesisHash !== expectedLocalHash) {
      throw new Error('Set GUARD_LOCALNET_GENESIS_HASH to the running local validator genesis hash before using a test funder.');
    }
  } else {
    throw new Error('Only localnet and devnet are supported.');
  }
}

export function resolveTestFunderPath(value: string) {
  const selected = resolve(value);
  if (selected !== resolve(PROJECT_FUNDER_PATH)) {
    throw new Error('GUARD_TEST_FUNDER_KEYPAIR must point to this project\'s contracts/.keys/deployer.json. Global or other wallet paths are unsupported.');
  }
  return selected;
}

export function resolveVerificationReportPath(value: string, cluster: TestCluster) {
  const target = resolve(value);
  const name = basename(target);
  const otherCluster = cluster === 'localnet' ? 'devnet' : 'localnet';
  if (!name.endsWith('.json') || !new RegExp(`(^|[._-])${cluster}([._-]|$)`).test(name)
    || new RegExp(`(^|[._-])${otherCluster}([._-]|$)`).test(name)) {
    throw new Error(`GUARD_VERIFICATION_REPORT must name a ${cluster} JSON report, for example verification.${cluster}.json.`);
  }
  return target;
}

async function readTestFunder(selected: string) {
  // The named project file must not redirect to a personal wallet through a symlink.
  const projectRoot = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
  if (resolve(await realpath(selected)) !== resolve(projectRoot, 'contracts', '.keys', 'deployer.json')) {
    throw new Error('The project test deployer path must not redirect through a symbolic link.');
  }
  let bytes: unknown;
  try { bytes = JSON.parse(await readFile(selected, 'utf8')); } catch {
    throw new Error('Cannot read the project test deployer keypair. Run the project setup script first.');
  }
  if (!Array.isArray(bytes) || bytes.length !== 64
    || !bytes.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) {
    throw new Error('The project test deployer must be a 64-byte Solana keypair JSON array.');
  }
  try { return Keypair.fromSecretKey(Uint8Array.from(bytes)); } catch {
    throw new Error('The project test deployer keypair is invalid.');
  } finally { bytes.fill(0); }
}

export async function main() {
  const clusterIndex = process.argv.indexOf('--cluster');
  const selectedCluster = clusterIndex >= 0 ? process.argv[clusterIndex + 1] : undefined;
  if (selectedCluster !== 'localnet' && selectedCluster !== 'devnet') {
    throw new Error('Pass --cluster localnet or --cluster devnet. Mainnet is intentionally unsupported.');
  }
  const cluster: TestCluster = selectedCluster;
  const funderPath = process.env.GUARD_TEST_FUNDER_KEYPAIR
    ? resolveTestFunderPath(process.env.GUARD_TEST_FUNDER_KEYPAIR) : undefined;
  const reportPath = process.env.GUARD_VERIFICATION_REPORT
    ? resolveVerificationReportPath(process.env.GUARD_VERIFICATION_REPORT, cluster) : undefined;
  const rpc = cluster === 'localnet' ? 'http://127.0.0.1:8899' : 'https://api.devnet.solana.com';
  const connection = new Connection(rpc, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: createPacedRpcFetch({
      minimumIntervalMs: cluster === 'devnet' ? 1200 : 0,
      onRetry: (attempt, waitMs) => console.warn(`RPC 429: retry ${attempt}/4 after ${waitMs / 1000}s.`),
    }),
  });
  const genesisHash = await connection.getGenesisHash();
  validateTestGenesis(cluster, genesisHash, funderPath !== undefined, process.env.GUARD_LOCALNET_GENESIS_HASH);
  const client = new SafetyGuardClient(connection, process.env.SOLANA_PROGRAM_ID ? new PublicKey(process.env.SOLANA_PROGRAM_ID) : undefined);
  if (!(await client.isProgramDeployed())) throw new Error(`Program ${client.programId.toBase58()} is not executable on ${cluster}. Run setup/build/deploy first.`);

  // Participant keys exist only in memory and receive only test SOL.
  const rider = Keypair.generate();
  const guardian = Keypair.generate();
  const attacker = Keypair.generate();
  const funder = funderPath ? await readTestFunder(funderPath) : undefined;
  const task = { rider: rider.publicKey, guardian: guardian.publicKey, tripId: randomTripId() };
  const cancelled = { ...task, tripId: randomTripId() };
  const report = {
    schemaVersion: 2,
    purpose: 'Safety Guard test-network lifecycle and authorization verification; public evidence only, not a production safety certification.',
    cluster, rpc, genesisHash, programId: client.programId.toBase58(),
    startedAt: new Date().toISOString(), finishedAt: null as string | null,
    status: 'running' as 'running' | 'passed' | 'failed', verified: false,
    funding: { mode: funder ? 'project-test-deployer' : 'airdrop',
      funder: funder?.publicKey.toBase58() ?? null,
      lamportsPerParticipant: funder ? PARTICIPANT_LAMPORTS : LAMPORTS_PER_SOL },
    participants: { rider: rider.publicKey.toBase58(), guardian: guardian.publicKey.toBase58(), attacker: attacker.publicKey.toBase58() },
    taskAddress: deriveTaskAddress(task.rider, task.tripId, client.programId).toBase58(),
    cancelledTaskAddress: deriveTaskAddress(cancelled.rider, cancelled.tripId, client.programId).toBase58(),
    transactions: [] as Array<{ label: string; signature: string }>,
    submittedTransactions: [] as Array<{ label: string; signature: string; status: 'submitted' | 'confirmed' | 'failed' | 'expired' | 'unconfirmed' }>,
    rejectedOperations: [] as Array<{ label: string; evidence: string }>,
    guardianPoints: null as string | null, guardianCompletedTasks: null as string | null,
    receipt: null as string | null,
  };
  async function saveReport() {
    if (!reportPath) return;
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  async function recordTransaction(label: string, signature: string) {
    report.transactions.push({ label, signature });
    console.log(`CONFIRMED: ${label}: ${signature}`);
    await saveReport();
  }
  async function confirmAndRecord(label: string, signature: string, lastValidBlockHeight?: number) {
    const submission: typeof report.submittedTransactions[number] = { label, signature, status: 'submitted' };
    report.submittedTransactions.push(submission);
    console.log(`SUBMITTED: ${label}: ${signature}`);
    await saveReport();
    try {
      await confirmSignatureHttp(connection, signature, { lastValidBlockHeight, pollIntervalMs: cluster === 'devnet' ? 2000 : 250 });
      submission.status = 'confirmed';
      await recordTransaction(label, signature);
    } catch (error) {
      submission.status = error instanceof HttpConfirmationError ? error.state : 'unconfirmed';
      await saveReport();
      throw error;
    }
  }
  async function send(label: string, tx: Transaction, signer: Keypair) {
    const { signature, lastValidBlockHeight } = await submitTransactionHttp(connection, tx, signer);
    await confirmAndRecord(label, signature, lastValidBlockHeight);
    return signature;
  }
  async function mustReject(label: string, tx: Transaction, signer: Keypair) {
    await expectProgramRejectionHttp(connection, tx, signer, label);
    report.rejectedOperations.push({ label, evidence: 'Program custom error during transaction simulation; no confirmed transaction signature.' });
    console.log(`PASS: ${label} rejected`);
    await saveReport();
  }

  await saveReport();
  try {
    if (funder) {
      const recipients = [rider.publicKey, guardian.publicKey, attacker.publicKey];
      if (await connection.getBalance(funder.publicKey, 'confirmed') < recipients.length * PARTICIPANT_LAMPORTS + 10_000) {
        throw new Error('The project test deployer needs at least 0.15001 test SOL to fund this verification run.');
      }
      await send('fund test participants (0.05 SOL each)', new Transaction().add(...recipients.map(toPubkey => SystemProgram.transfer({
        fromPubkey: funder.publicKey, toPubkey, lamports: PARTICIPANT_LAMPORTS,
      }))), funder);
    } else {
      for (const [label, participant] of [['rider', rider], ['guardian', guardian], ['attacker', attacker]] as const) {
        const signature = await connection.requestAirdrop(participant.publicKey, LAMPORTS_PER_SOL);
        // The faucet selects its own blockhash, so use a bounded HTTP poll without inventing an expiry height.
        await confirmAndRecord(`airdrop to ${label}`, signature);
      }
    }
    await send('create task', client.createTask({ ...task, deadline: Math.floor(Date.now() / 1000) + 3600 }), rider);
    assert.equal((await client.fetchTask(task))?.state, 'pending');
    await mustReject('wrong guardian', client.acceptTask({ ...task, guardian: attacker.publicKey }), attacker);
    await send('accept task', client.acceptTask(task), guardian);
    assert.equal((await client.fetchTask(task))?.state, 'active');
    await mustReject('completion without check-in', client.completeTask(task), rider);
    await send('guardian check-in', client.checkIn(task), guardian);
    assert.equal((await client.fetchTask(task))?.checkInCount, 1);
    report.receipt = await send('complete task', client.completeTask(task), rider);
    assert.equal((await client.fetchTask(task))?.state, 'completed');
    assert.equal((await client.fetchReputation(guardian.publicKey))?.points, 10n);
    await mustReject('duplicate reward', client.completeTask(task), rider);
    await mustReject('completed task cancellation', client.cancelTask(task), rider);
    await mustReject('completed task recreation', client.createTask({ ...task, deadline: Math.floor(Date.now() / 1000) + 3600 }), rider);
    assert.equal((await client.fetchReputation(guardian.publicKey))?.points, 10n);
    await send('create cancellation task', client.createTask({ ...cancelled, deadline: Math.floor(Date.now() / 1000) + 3600 }), rider);
    await send('cancel task', client.cancelTask(cancelled), rider);
    assert.equal((await client.fetchTask(cancelled))?.state, 'cancelled');
    await mustReject('cancelled task acceptance', client.acceptTask(cancelled), guardian);
    const reputation = await client.fetchReputation(guardian.publicKey);
    assert.equal(reputation?.completedTasks, 1n);
    assert.equal(reputation.points, 10n);
    report.guardianPoints = reputation.points.toString();
    report.guardianCompletedTasks = reputation.completedTasks.toString();
    report.status = 'passed';
    report.verified = true;
  } catch (error) {
    report.status = 'failed';
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await saveReport();
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Verification failed.'); process.exitCode = 1; });
}

