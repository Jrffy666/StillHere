import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { link, mkdir, open, readFile, realpath, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const MAX_PLAINTEXT = 8_000_000;
const MAX_ENVELOPE = 11_000_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function backupKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('SAFETY_GUARD_BACKUP_KEY must be a base64-encoded 32-byte key.');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw new Error('Invalid backup encryption key.');
  return key;
}

function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !['development', 'staging', 'production'].includes(snapshot.environment) || !Number.isSafeInteger(snapshot.createdAt) || snapshot.createdAt < 0) throw new Error('Unsupported backup snapshot.');
  const resources = snapshot.resources;
  if (!resources || !resources.governance || ['users', 'trips', 'auth', 'chain'].some(kind => !Array.isArray(resources[kind]) || resources[kind].length > 2000)) throw new Error('Invalid backup resource manifest.');
  // The server validates every individual resource before any restore write.
  for (const kind of ['users', 'trips', 'auth', 'chain']) {
    const ids = new Set();
    for (const item of resources[kind]) {
      if (!item || typeof item.id !== 'string' || !item.snapshot || ids.has(item.id)) throw new Error('Invalid or duplicate backup resource.');
      ids.add(item.id);
    }
  }
  return snapshot;
}

function headerFor(envelope) {
  return { format: envelope.format, version: envelope.version, algorithm: envelope.algorithm, id: envelope.id, createdAt: envelope.createdAt, sha256: envelope.sha256 };
}

export function encryptSnapshot(snapshot, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('A 32-byte backup key is required.');
  validateSnapshot(snapshot);
  const plaintext = Buffer.from(JSON.stringify(snapshot));
  if (plaintext.length > MAX_PLAINTEXT) throw new Error('Backup exceeds the 8 MB maintenance limit.');
  const header = { format: 'safety-guard-backup', version: 1, algorithm: 'AES-256-GCM', id: randomUUID(), createdAt: Date.now(), sha256: sha256(plaintext) };
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  plaintext.fill(0);
  return { ...header, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

function base64(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid encrypted backup.');
  const result = Buffer.from(value, 'base64');
  if (result.toString('base64') !== value || (length !== undefined && result.length !== length)) throw new Error('Invalid encrypted backup.');
  return result;
}

export function decryptSnapshot(envelope, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('A 32-byte backup key is required.');
  if (!envelope || Object.keys(envelope).sort().join() !== 'algorithm,ciphertext,createdAt,format,id,iv,sha256,tag,version' || envelope.format !== 'safety-guard-backup' || envelope.version !== 1 || envelope.algorithm !== 'AES-256-GCM' || !uuid.test(envelope.id) || !Number.isSafeInteger(envelope.createdAt) || envelope.createdAt < 0 || !/^[0-9a-f]{64}$/.test(envelope.sha256)) throw new Error('Unsupported encrypted backup.');
  if (typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > Math.ceil(MAX_PLAINTEXT / 3) * 4) throw new Error('Encrypted backup exceeds the maintenance limit.');
  const cipher = base64(envelope.ciphertext), iv = base64(envelope.iv, 12), tag = base64(envelope.tag, 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(JSON.stringify(headerFor(envelope))));
  decipher.setAuthTag(tag);
  let plaintext;
  try { plaintext = Buffer.concat([decipher.update(cipher), decipher.final()]); }
  catch { throw new Error('Backup authentication failed: the key is wrong or the file was modified.'); }
  try {
    if (!timingSafeEqual(Buffer.from(sha256(plaintext), 'hex'), Buffer.from(envelope.sha256, 'hex'))) throw new Error('Backup checksum mismatch.');
    return validateSnapshot(JSON.parse(plaintext.toString('utf8')));
  } finally { plaintext.fill(0); }
}

function inside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

export async function externalBackupPath(path, checkout = root) {
  if (!isAbsolute(path)) throw new Error('Use an absolute backup path outside the checkout.');
  const target = resolve(path), checkoutPath = await realpath(checkout);
  if (inside(checkoutPath, target)) throw new Error('Backups must be stored outside the checkout.');
  // Resolve existing ancestors before mkdir, so a symlink cannot redirect into the checkout.
  let ancestor = dirname(target), suffix = [];
  while (true) {
    try { const resolved = await realpath(ancestor); if (inside(checkoutPath, resolve(resolved, ...suffix))) throw new Error('Backup directory resolves inside the checkout.'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; const parent = dirname(ancestor); if (parent === ancestor) throw error; suffix.unshift(relative(parent, ancestor)); ancestor = parent; }
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const directory = await realpath(dirname(target));
  if (inside(checkoutPath, directory)) throw new Error('Backup directory resolves inside the checkout.');
  return resolve(directory, relative(dirname(target), target));
}

export async function writeEncryptedBackup(path, envelope, checkout = root) {
  const target = await externalBackupPath(path, checkout);
  try { await stat(target); throw new Error('Backup file already exists. Choose a new filename.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${target}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(envelope) + '\n', 'utf8');
    await handle.sync(); await handle.close(); handle = undefined;
    // Publish the complete file atomically without replacing a concurrently created target.
    await link(temporary, target);
    return target;
  } finally { if (handle) await handle.close(); await rm(temporary, { force: true }); }
}

export function apiOrigin(value, { allowLocal = false } = {}) {
  let url; try { url = new URL(value); } catch { throw new Error('A valid API origin is required.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.origin !== value || url.username || url.password || (url.protocol !== 'https:' && !(allowLocal && local && url.protocol === 'http:'))) throw new Error('Use an HTTPS API origin (local HTTP requires --allow-local).');
  return url.origin;
}

async function boundedResponse(response, limit) {
  if (!response.body) throw new Error('Empty server response.');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > limit) throw new Error('Server response exceeds the maintenance limit.'); chunks.push(Buffer.from(chunk.value)); } }
  finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString('utf8');
}

export async function operatorRequest(origin, path, secret, body, fetcher = fetch) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('SAFETY_GUARD_OPERATOR_SECRET must contain at least 32 characters.');
  const response = await fetcher(origin + path, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(120_000) });
  const text = await boundedResponse(response, MAX_PLAINTEXT);
  if (!response.ok) throw new Error(`Operator API failed with HTTP ${response.status}. Check the destination readiness and operator credentials.`);
  try { return JSON.parse(text); } catch { throw new Error('Operator API returned invalid JSON.'); }
}

export function backupArguments(argv) {
  const command = argv[0];
  if (!['export', 'verify', 'restore'].includes(command)) throw new Error('Usage: node scripts/backup.mjs export|verify|restore --file <absolute-path> [--api-origin <origin>] [--allow-local] [--apply]');
  const options = { command, allowLocal: false, apply: false };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--allow-local') options.allowLocal = true;
    else if (flag === '--apply') options.apply = true;
    else if (['--file', '--api-origin', '--protection'].includes(flag) && argv[i + 1] && !argv[i + 1].startsWith('--')) { const name = flag === '--file' ? 'file' : flag === '--protection' ? 'protection' : 'origin'; if (options[name]) throw new Error('Duplicate option.'); options[name] = argv[++i]; }
    else throw new Error('Unknown or incomplete backup option. Secrets must be provided through environment variables.');
  }
  if (!options.file || !isAbsolute(options.file)) throw new Error('An absolute --file path is required.');
  if (command !== 'verify' && !options.origin) throw new Error('--api-origin is required.');
  if (command === 'restore' && !options.apply) throw new Error('Restore writes to the destination. Supply --apply for an explicitly enabled isolated environment.');
  if (command === 'restore' && (!options.protection || !isAbsolute(options.protection))) throw new Error('Restore requires --protection <absolute-path> containing the latest encrypted governance/deletion snapshot.');
  return options;
}

export function applyProtection(snapshot, protection) {
  validateSnapshot(snapshot); validateSnapshot(protection);
  if (protection.environment !== snapshot.environment || protection.createdAt < snapshot.createdAt) throw new Error('Protection snapshot must come from the same source environment and be at least as recent as the data backup.');
  const governance = protection.resources.governance;
  const deleted = new Set([...(governance.users ?? []).filter(user => user.deleted).map(user => user.id), ...(governance.deletions ?? []).map(record => record.userId)]);
  const currentUsers = new Map(protection.resources.users.map(record => [record.id, record.snapshot]));
  const auth = new Map();
  for (const record of [...snapshot.resources.auth, ...protection.resources.auth]) {
    if (auth.has(record.id) && auth.get(record.id).snapshot.accountId !== record.snapshot.accountId) throw new Error('Protection snapshot conflicts with immutable wallet ownership.');
    auth.set(record.id, record);
  }
  const users = snapshot.resources.users.map(record => {
    if (deleted.has(record.id)) return record; // Destination erasure protections skip these records.
    const current = currentUsers.get(record.id), previous = record.snapshot;
    if (!current || !Number.isSafeInteger(current.authVersion) || current.authVersion < 1 || current.authVersion >= Number.MAX_SAFE_INTEGER || !(current.wallet === null || typeof current.wallet === 'string')) throw new Error('Latest protection snapshot is missing a live account identity.');
    if (current.authVersion < previous.authVersion || current.wallet !== previous.wallet && current.authVersion <= previous.authVersion) throw new Error('Protection snapshot would regress account authorization.');
    if (current.wallet && auth.get(`wallet:${current.wallet}`)?.snapshot.accountId !== record.id) throw new Error('Latest wallet identity has no matching ownership reservation.');
    // Keep the old business ledger, but never restore a rotated-away wallet as login authority.
    return { ...record, snapshot: { ...previous, wallet: current.wallet, authVersion: current.authVersion } };
  });
  const result = { ...snapshot, resources: { ...snapshot.resources, users, auth: [...auth.values()], governance } };
  validateSnapshot(result);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_PLAINTEXT) throw new Error('Protected recovery snapshot exceeds the 8 MB maintenance limit.');
  return result;
}

async function readEncryptedFile(path) {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_ENVELOPE) throw new Error('Invalid or oversized backup file.');
  return JSON.parse(await readFile(path, 'utf8'));
}

function restoreId(dataId, protectionId) {
  const hash = sha256(dataId + ':' + protectionId);
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-8${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = backupArguments(argv), key = backupKey(environment.SAFETY_GUARD_BACKUP_KEY);
  try {
    if (options.command === 'export') {
      // Validate the destination before requesting private data.
      await externalBackupPath(options.file);
      const snapshot = await operatorRequest(apiOrigin(options.origin, options), '/api/admin/backups/export', environment.SAFETY_GUARD_OPERATOR_SECRET, {});
      const envelope = encryptSnapshot(snapshot, key);
      const path = await writeEncryptedBackup(options.file, envelope);
      console.log(JSON.stringify({ saved: path, id: envelope.id, sha256: envelope.sha256, environment: snapshot.environment }));
      return;
    }
    const envelope = await readEncryptedFile(options.file);
    const snapshot = decryptSnapshot(envelope, key);
    if (options.command === 'verify') { console.log(JSON.stringify({ verified: true, id: envelope.id, sha256: envelope.sha256, environment: snapshot.environment, resources: Object.fromEntries(['users', 'trips', 'auth', 'chain'].map(kind => [kind, snapshot.resources[kind].length])) })); return; }
    const protectionEnvelope = await readEncryptedFile(options.protection);
    const protectedSnapshot = applyProtection(snapshot, decryptSnapshot(protectionEnvelope, key));
    const result = await operatorRequest(apiOrigin(options.origin, options), '/api/admin/backups/restore', environment.SAFETY_GUARD_OPERATOR_SECRET, { snapshot: protectedSnapshot, idempotencyKey: restoreId(envelope.id, protectionEnvelope.id) });
    console.log(JSON.stringify({ restored: Boolean(result.completed), id: envelope.id }));
  } finally { key.fill(0); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
