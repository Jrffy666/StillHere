import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { apiOrigin, applyProtection, backupArguments, backupKey, decryptSnapshot, encryptSnapshot, externalBackupPath, operatorRequest, writeEncryptedBackup } from '../scripts/backup.mjs';
import { checkReadiness, deployArguments, validateDeployment, validateDeploymentSecrets, waitForReadiness } from '../scripts/deploy.mjs';

const snapshot = () => { const id = randomUUID(); return { schemaVersion: 1, environment: 'staging', createdAt: Date.now(), resources: { users: [{ id, snapshot: { version: 1, user: { id, name: 'Private passenger name', points: 0, reputation: 0, completedGuards: 0 }, wallet: null, authVersion: 1, trips: [], credits: [] } }], trips: [], auth: [], chain: [], governance: { schemaVersion: 1, users: [], resources: [], deletions: [], purgedTrips: [], wallets: [] } } }; };
const config = () => ({
  name: 'guard-local',
  migrations: [
    { tag: 'v1', new_sqlite_classes: ['TripRoom', 'UserAccount', 'TripDirectory'] },
    { tag: 'v2', new_sqlite_classes: ['IdentityRegistry', 'GovernanceStore', 'ChainJourney'] },
    { tag: 'v3', new_sqlite_classes: ['CommunityLedger'] },
  ],
  env: Object.fromEntries(['staging', 'production'].map(environment => [environment, {
    name: `guard-${environment}`,
    vars: { APP_ENV: environment, SITE_ORIGIN: `https://${environment}.guard.test`, AUTH_DOMAIN: `${environment}.guard.test`, ALLOWED_ORIGINS: `https://${environment}.guard.test`, SOLANA_NETWORK: 'devnet', SOLANA_V2_PROGRAM_ID: '6QoP3pGGBpCDdpCzK8DZhx5rZa99D4RZwkbNteSwY6kK', SOLANA_PROGRAM_ID: '', SOLANA_RPC_URL: 'https://api.devnet.solana.com', RESTORE_ALLOWED: 'false', NOTIFICATIONS_ENABLED: 'false', COMMUNITY_ENABLED: 'false', COMMUNITY_PROGRAM_ID: '' },
    durable_objects: { bindings: Object.entries({ TRIPS: 'TripRoom', USERS: 'UserAccount', LOBBY: 'TripDirectory', AUTH: 'IdentityRegistry', GOVERNANCE: 'GovernanceStore', CHAIN: 'ChainJourney', COMMUNITY: 'CommunityLedger' }).map(([name, class_name]) => ({ name, class_name })) },
  }])),
});

test('authenticated backups round-trip private data with a fresh nonce and identity each time', () => {
  const key = randomBytes(32), data = snapshot();
  const first = encryptSnapshot(data, key), second = encryptSnapshot(data, key);
  assert.deepEqual(decryptSnapshot(first, key), data);
  assert.notEqual(first.iv, second.iv); assert.notEqual(first.id, second.id); assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(JSON.stringify(first).includes('Private passenger'), false);
  assert.equal(first.sha256, second.sha256);
});

test('wrong keys, ciphertext changes, authentication tags, and public metadata tampering are rejected', () => {
  const key = randomBytes(32), envelope = encryptSnapshot(snapshot(), key);
  assert.throws(() => decryptSnapshot(envelope, randomBytes(32)), /authentication failed/);
  for (const field of ['ciphertext', 'tag', 'iv']) {
    const bytes = Buffer.from(envelope[field], 'base64'); bytes[0] ^= 1;
    assert.throws(() => decryptSnapshot({ ...envelope, [field]: bytes.toString('base64') }, key), /authentication failed/);
  }
  for (const mutation of [{ id: randomUUID() }, { createdAt: envelope.createdAt + 1 }, { sha256: 'f'.repeat(64) }]) assert.throws(() => decryptSnapshot({ ...envelope, ...mutation }, key), /authentication failed/);
  assert.throws(() => decryptSnapshot({ ...envelope, version: 2 }, key), /Unsupported/);
  assert.throws(() => decryptSnapshot({ ...envelope, plaintext: 'injected' }, key), /Unsupported/);
});

test('encryption keys and snapshot size/identity bounds are validated before writing', () => {
  const key = randomBytes(32);
  assert.deepEqual(backupKey(key.toString('base64')), key);
  for (const value of [undefined, 'secret', randomBytes(31).toString('base64'), key.toString('base64') + '\n']) assert.throws(() => backupKey(value));
  assert.throws(() => encryptSnapshot({ ...snapshot(), schemaVersion: 7 }, key), /Unsupported/);
  const duplicate = snapshot(); duplicate.resources.users.push(duplicate.resources.users[0]);
  assert.throws(() => encryptSnapshot(duplicate, key), /duplicate/);
  const large = snapshot(); large.resources.users[0].snapshot.name = 'x'.repeat(8_000_001);
  assert.throws(() => encryptSnapshot(large, key), /8 MB/);
});

test('atomic backup output stays outside the checkout and never overwrites an existing archive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guard-backup-test-'));
  try {
    const checkout = join(directory, 'checkout'); await mkdir(checkout);
    const target = join(directory, 'vault', 'snapshot.sgbackup');
    const key = randomBytes(32), envelope = encryptSnapshot(snapshot(), key);
    assert.equal(await writeEncryptedBackup(target, envelope, checkout), target);
    const saved = await readFile(target, 'utf8');
    assert.deepEqual(JSON.parse(saved), envelope); assert.equal(saved.includes('Private passenger'), false);
    await assert.rejects(writeEncryptedBackup(target, encryptSnapshot(snapshot(), key), checkout), /already exists/);
    assert.equal(await readFile(target, 'utf8'), saved);
    await assert.rejects(externalBackupPath(join(checkout, 'secret.sgbackup'), checkout), /outside/);
    await assert.rejects(externalBackupPath('relative.sgbackup', checkout), /absolute/);
    const shortcut = join(directory, 'shortcut'); await symlink(checkout, shortcut, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(externalBackupPath(join(shortcut, 'nested', 'secret.sgbackup'), checkout), /inside/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('restore requires a recent protection journal from the same source environment', () => {
  const old = snapshot(), fresh = structuredClone(old);
  fresh.createdAt += 1000; fresh.resources.governance.purgedTrips.push({ id: randomUUID(), at: fresh.createdAt });
  const protectedData = applyProtection(old, fresh);
  assert.deepEqual(protectedData.resources.users, old.resources.users);
  assert.deepEqual(protectedData.resources.governance, fresh.resources.governance);
  assert.throws(() => applyProtection(fresh, old), /at least as recent/);
  assert.throws(() => applyProtection(old, { ...fresh, environment: 'production' }), /same source/);
});

test('an old data backup retains current wallet authority and refuses missing or regressed live identity', () => {
  const old = snapshot(), id = old.resources.users[0].id;
  const oldWallet = '6QoP3pGGBpCDdpCzK8DZhx5rZa99D4RZwkbNteSwY6kK', newWallet = '23f7UAfNbQCGdfQbJV3Tois98dETDfXnAXgjE5qTH5gb';
  old.resources.users[0].snapshot.wallet = oldWallet;
  old.resources.auth.push({ id: `wallet:${oldWallet}`, snapshot: { version: 1, accountId: id } });
  const fresh = structuredClone(old); fresh.createdAt += 1000;
  fresh.resources.users[0].snapshot.wallet = newWallet; fresh.resources.users[0].snapshot.authVersion = 2;
  fresh.resources.users[0].snapshot.user.name = 'Later display name';
  fresh.resources.auth.push({ id: `wallet:${newWallet}`, snapshot: { version: 1, accountId: id } });
  const recovered = applyProtection(old, fresh);
  assert.equal(recovered.resources.users[0].snapshot.wallet, newWallet); assert.equal(recovered.resources.users[0].snapshot.authVersion, 2);
  assert.equal(recovered.resources.users[0].snapshot.user.name, 'Private passenger name'); assert.equal(recovered.resources.auth.length, 2);
  const missing = structuredClone(fresh); missing.resources.users = [];
  assert.throws(() => applyProtection(old, missing), /missing a live account identity/);
  missing.resources.governance.users.push({ id, deleted: true, suspended: false });
  assert.doesNotThrow(() => applyProtection(old, missing));
  const regressed = structuredClone(fresh); regressed.resources.users[0].snapshot.authVersion = 1;
  assert.throws(() => applyProtection(old, regressed), /regress account authorization/);
  const ownerConflict = structuredClone(fresh); ownerConflict.resources.auth[0].snapshot.accountId = randomUUID();
  assert.throws(() => applyProtection(old, ownerConflict), /immutable wallet ownership/);
});

test('CLI restore and deployment mutations require explicit bounded targets', () => {
  const file = join(tmpdir(), 'backup.sgbackup');
  assert.equal(backupArguments(['verify', '--file', file]).command, 'verify');
  assert.throws(() => backupArguments(['restore', '--file', file, '--api-origin', 'https://guard.test']), /--apply/);
  assert.throws(() => backupArguments(['restore', '--file', file, '--api-origin', 'https://guard.test', '--apply']), /--protection/);
  assert.equal(backupArguments(['restore', '--file', file, '--api-origin', 'https://guard.test', '--apply', '--protection', file]).apply, true);
  assert.throws(() => backupArguments(['verify', '--file', file, '--key', 'secret']), /Secrets/);
  assert.throws(() => deployArguments(['deploy', '--env', 'production', '--api-origin', 'https://guard.test']), /--apply/);
  assert.throws(() => deployArguments(['rollback', '--env', 'production', '--api-origin', 'https://guard.test', '--apply']), /exact known-good/);
  assert.equal(deployArguments(['rollback', '--env', 'staging', '--api-origin', 'https://guard.test', '--version', randomUUID(), '--apply']).command, 'rollback');
});

test('operator traffic rejects insecure targets, redirects, and private error-body disclosure', async () => {
  assert.equal(apiOrigin('https://guard.test'), 'https://guard.test');
  assert.equal(apiOrigin('http://127.0.0.1:8787', { allowLocal: true }), 'http://127.0.0.1:8787');
  for (const value of ['http://guard.test', 'https://user:password@guard.test', 'https://guard.test/path', 'https://guard.test/']) assert.throws(() => apiOrigin(value));
  const secret = 'operator-secret-'.repeat(4);
  const data = await operatorRequest('https://guard.test', '/api/admin/backups/export', secret, {}, async (url, options) => {
    assert.equal(url, 'https://guard.test/api/admin/backups/export'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, `Bearer ${secret}`);
    return Response.json({ accepted: true });
  });
  assert.deepEqual(data, { accepted: true });
  await assert.rejects(operatorRequest('https://guard.test', '/api/admin/backups/export', secret, {}, async () => new Response('private stack trace', { status: 500 })), error => error.message.includes('HTTP 500') && !error.message.includes('private'));
  await assert.rejects(operatorRequest('https://guard.test', '/api/admin/backups/export', 'short', {}), /at least 32/);
});

test('deployment preflight rejects environment mixups, missing bindings, V1 reuse, and unsafe production settings', () => {
  assert.equal(validateDeployment(config(), 'staging').name, 'guard-staging');
  assert.equal(validateDeployment(config(), 'production').environment, 'production');
  const variants = [
    value => { value.env.production.name = value.env.staging.name; },
    value => { value.env.production.vars.AUTH_DOMAIN = 'wrong.test'; },
    value => { value.env.production.vars.ALLOWED_ORIGINS = '*'; },
    value => { value.env.production.vars.SOLANA_NETWORK = 'mainnet-beta'; },
    value => { value.env.production.vars.SOLANA_PROGRAM_ID = value.env.production.vars.SOLANA_V2_PROGRAM_ID; },
    value => { value.env.production.vars.SOLANA_V2_PROGRAM_ID = '11111111111111111111111111111111'; },
    value => { value.env.production.vars.RESTORE_ALLOWED = 'true'; },
    value => { value.env.production.vars.NOTIFICATIONS_ENABLED = 'true'; },
    value => { value.env.production.durable_objects.bindings.pop(); },
    value => { value.env.production.durable_objects.bindings[0].script_name = 'guard-staging'; },
    value => { value.migrations.pop(); },
  ];
  for (const mutate of variants) { const value = config(); mutate(value); assert.throws(() => validateDeployment(value, 'production')); }
});

test('readiness checks verify the destination environment and every required runtime control', async () => {
  const ready = { ready: true, environment: 'staging', checks: { identityDomain: true, operatorSecret: true, allowedOrigins: true, chainConfigured: true, chainNetwork: true, restoreDisabled: true } };
  assert.deepEqual(await checkReadiness('https://guard.test', 'staging', async () => Response.json(ready)), ready);
  await assert.rejects(checkReadiness('https://guard.test', 'production', async () => Response.json(ready)), /different environment/);
  await assert.rejects(checkReadiness('https://guard.test', 'staging', async () => Response.json({ ...ready, checks: { ...ready.checks, operatorSecret: false } })), /Readiness checks failed/);
  await assert.rejects(checkReadiness('https://guard.test', 'staging', async () => Response.json({}, { status: 503 })), /503/);
});

test('community deployment requires its isolated binding and SQLite migration even while publication is disabled', () => {
  const disabled = config();
  assert.deepEqual(validateDeployment(disabled, 'staging').community, { enabled: false, programId: null });
  const missingBinding = config();
  missingBinding.env.production.durable_objects.bindings = missingBinding.env.production.durable_objects.bindings.filter(binding => binding.name !== 'COMMUNITY');
  assert.throws(() => validateDeployment(missingBinding, 'production'), /Missing isolated COMMUNITY/);
  const externalBinding = config();
  externalBinding.env.production.durable_objects.bindings.find(binding => binding.name === 'COMMUNITY').script_name = 'guard-staging';
  assert.throws(() => validateDeployment(externalBinding, 'production'), /Missing isolated COMMUNITY/);
  const missingMigration = config();
  missingMigration.migrations = missingMigration.migrations.filter(migration => !migration.new_sqlite_classes.includes('CommunityLedger'));
  assert.throws(() => validateDeployment(missingMigration, 'production'), /Missing SQLite migration for CommunityLedger/);
});

test('enabled community publication requires a valid program distinct from both earlier programs', () => {
  const fresh = () => { const value = config(); value.env.production.vars.COMMUNITY_ENABLED = 'true'; value.env.production.vars.COMMUNITY_PROGRAM_ID = '23f7UAfNbQCGdfQbJV3Tois98dETDfXnAXgjE5qTH5gb'; return value; };
  assert.deepEqual(validateDeployment(fresh(), 'production').community, { enabled: true, programId: '23f7UAfNbQCGdfQbJV3Tois98dETDfXnAXgjE5qTH5gb' });
  for (const programId of ['', undefined, 'invalid-address', '11111111111111111111111111111111', config().env.production.vars.SOLANA_V2_PROGRAM_ID]) {
    const value = fresh(); value.env.production.vars.COMMUNITY_PROGRAM_ID = programId;
    assert.throws(() => validateDeployment(value, 'production'), /community|Community/);
  }
  const v1Reuse = fresh(); v1Reuse.env.production.vars.SOLANA_PROGRAM_ID = v1Reuse.env.production.vars.COMMUNITY_PROGRAM_ID;
  assert.throws(() => validateDeployment(v1Reuse, 'production'), /preserve V1 and V2/);
  const implicit = fresh(); delete implicit.env.production.vars.COMMUNITY_ENABLED;
  assert.throws(() => validateDeployment(implicit, 'production'), /COMMUNITY_ENABLED/);
});

test('deployment application checks issuer and sponsor secret metadata only when community publication is enabled', () => {
  const value = config(); value.env.production.vars.COMMUNITY_ENABLED = 'true'; value.env.production.vars.COMMUNITY_PROGRAM_ID = '23f7UAfNbQCGdfQbJV3Tois98dETDfXnAXgjE5qTH5gb';
  const enabled = validateDeployment(value, 'production'), disabled = validateDeployment(config(), 'staging');
  const metadata = ['OPERATOR_SECRET', 'COMMUNITY_ISSUER_SECRET_KEY', 'COMMUNITY_SPONSOR_SECRET_KEY'].map(name => ({ name, type: 'secret_text' }));
  assert.doesNotThrow(() => validateDeploymentSecrets(enabled, metadata));
  assert.doesNotThrow(() => validateDeploymentSecrets(disabled, [{ name: 'OPERATOR_SECRET', type: 'secret_text' }]));
  for (const required of metadata) {
    assert.throws(() => validateDeploymentSecrets(enabled, metadata.filter(secret => secret.name !== required.name)), error => error.message === `${required.name} is missing from the selected remote environment.`);
  }
  assert.throws(() => validateDeploymentSecrets(enabled, { secret: 'private-value-must-not-be-logged' }), error => !error.message.includes('private-value'));
  assert.throws(() => validateDeploymentSecrets(enabled, [null, { name: 42 }]), /OPERATOR_SECRET/);
});

test('publisher unavailability does not make otherwise healthy active-care readiness fail', async () => {
  const ready = { ready: true, environment: 'production', checks: { identityDomain: true, operatorSecret: true, allowedOrigins: true, chainConfigured: true, chainNetwork: true, restoreDisabled: true, communityConfigured: false }, community: { configured: false, pending: 10 } };
  assert.deepEqual(await checkReadiness('https://guard.test', 'production', async () => Response.json(ready)), ready);
});

test('post-deployment readiness tolerates transient propagation errors while status remains immediate', async () => {
  const ready = { ready: true, environment: 'production', checks: { identityDomain: true, operatorSecret: true, allowedOrigins: true, chainConfigured: true, chainNetwork: true, restoreDisabled: true } };
  let elapsed = 0, attempts = 0; const sleeps = [];
  const fetcher = async () => {
    attempts++;
    if (attempts === 1) return new Response('Not found during propagation', { status: 404 });
    if (attempts === 2) throw new TypeError('Connection reset');
    if (attempts === 3) return Response.json({ error: 'Service unavailable' }, { status: 503 });
    return Response.json(ready);
  };
  assert.deepEqual(await waitForReadiness('https://guard.test', 'production', { fetcher, now: () => elapsed, sleep: async ms => { sleeps.push(ms); elapsed += ms; } }), ready);
  assert.equal(attempts, 4); assert.deepEqual(sleeps, [1000, 2000, 4000]);
  let statusCalls = 0;
  await assert.rejects(checkReadiness('https://guard.test', 'production', async () => { statusCalls++; return new Response('Not found', { status: 404 }); }), /HTTP 404/);
  assert.equal(statusCalls, 1);
});

test('readiness propagation never retries a wrong environment, bad configuration, or forbidden endpoint', async () => {
  const good = { ready: true, environment: 'production', checks: { identityDomain: true, operatorSecret: true, allowedOrigins: true, chainConfigured: true, chainNetwork: true, restoreDisabled: true } };
  const variants = [
    () => Response.json({ ...good, environment: 'staging' }),
    () => Response.json({ ...good, ready: false, checks: { ...good.checks, operatorSecret: false } }, { status: 503 }),
    () => new Response('Forbidden', { status: 403 }),
  ];
  for (const response of variants) {
    let calls = 0, sleeps = 0;
    await assert.rejects(waitForReadiness('https://guard.test', 'production', { fetcher: async () => { calls++; return response(); }, sleep: async () => { sleeps++; } }));
    assert.equal(calls, 1); assert.equal(sleeps, 0);
  }
});

test('readiness propagation has both an attempt bound and a 45-second total deadline', async () => {
  let elapsed = 0, attempts = 0;
  await assert.rejects(waitForReadiness('https://guard.test', 'production', { fetcher: async () => { attempts++; return new Response(null, { status: 404 }); }, now: () => elapsed, sleep: async ms => { elapsed += ms; } }), /6 attempts.*45-second/);
  assert.equal(attempts, 6); assert.equal(elapsed, 25_000);
  elapsed = 0; attempts = 0;
  await assert.rejects(waitForReadiness('https://guard.test', 'production', { fetcher: async (_url, options) => { assert.equal(options.signal.aborted, false); attempts++; elapsed += Math.min(15_000, 45_000 - elapsed); throw new DOMException('Timed out', 'TimeoutError'); }, now: () => elapsed, sleep: async ms => { elapsed += ms; } }), /3 attempts.*45-second/);
  assert.equal(attempts, 3); assert.equal(elapsed, 45_000);
});

test('backup CLI exports, verifies, and restores through HTTP without writing plaintext or exposing credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guard-backup-cli-'));
  const file = join(directory, 'archive.sgbackup'), key = randomBytes(32).toString('base64'), secret = 'test-operator-secret-'.repeat(3), data = snapshot();
  const restores = [];
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${secret}`) { response.writeHead(401); response.end(); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/admin/backups/export') response.end(JSON.stringify(data));
    else if (request.url === '/api/admin/backups/restore') { restores.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); response.end(JSON.stringify({ completed: true })); }
    else { response.writeHead(404); response.end('{}'); }
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const script = fileURLToPath(new URL('../scripts/backup.mjs', import.meta.url));
    const run = args => promisify(execFile)(process.execPath, [script, ...args], { windowsHide: true, env: { ...process.env, SAFETY_GUARD_BACKUP_KEY: key, SAFETY_GUARD_OPERATOR_SECRET: secret } });
    const exported = await run(['export', '--file', file, '--api-origin', origin, '--allow-local']);
    const verified = await run(['verify', '--file', file]);
    const restored = await run(['restore', '--file', file, '--protection', file, '--api-origin', origin, '--allow-local', '--apply']);
    assert.equal(JSON.parse(verified.stdout).verified, true); assert.equal(JSON.parse(restored.stdout).restored, true);
    const output = exported.stdout + verified.stdout + restored.stdout;
    for (const privateValue of ['Private passenger', secret, key]) assert.equal(output.includes(privateValue), false);
    assert.deepEqual(restores[0].snapshot, data);
    assert.match(restores[0].idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    await run(['restore', '--file', file, '--protection', file, '--api-origin', origin, '--allow-local', '--apply']);
    assert.equal(restores[1].idempotencyKey, restores[0].idempotencyKey);
    assert.equal((await readFile(file, 'utf8')).includes('Private passenger'), false);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
});
