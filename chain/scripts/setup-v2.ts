import { mkdir, readFile, writeFile, chmod, lstat } from 'node:fs/promises';
import { Keypair } from '@solana/web3.js';
const root = new URL('../../contracts/', import.meta.url);
const keyUrl = new URL('target/deploy/safety_guard_v2-keypair.json', root);
const backupUrl = new URL('.keys/program-v2.json', root);
await mkdir(new URL('target/deploy/', root), { recursive: true });
await mkdir(new URL('.keys/', root), { recursive: true, mode: 0o700 });
async function readKey(url: URL) {
  try { if ((await lstat(url)).isSymbolicLink()) throw new Error('V2 key files cannot be symlinks.'); return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(url, 'utf8')))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
const existing = await readKey(keyUrl), backup = await readKey(backupUrl);
let recordedId:string|null=null;
try { recordedId=JSON.parse(await readFile(new URL('deployment-v2.json',root),'utf8')).programId??null; }
catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
if(recordedId&&!existing&&!backup)throw new Error('V2 deployment metadata already exists but the original program key is absent. Use the existing deployment workspace; refusing to generate a replacement identity.');
if (existing && backup && !existing.publicKey.equals(backup.publicKey)) throw new Error('V2 program key mismatch; refusing to replace either key.');
const key = existing ?? backup ?? Keypair.generate();
if(recordedId&&key.publicKey.toBase58()!==recordedId)throw new Error('V2 program key does not match the recorded deployment.');
for (const [url, present] of [[keyUrl, existing], [backupUrl, backup]] as const) {
  if (!present) await writeFile(url, JSON.stringify(Array.from(key.secretKey)), { flag: 'wx', mode: 0o600 });
  await chmod(url, 0o600);
}
const programId = key.publicKey.toBase58();
const source = new URL('programs/safety-guard-v2/src/lib.rs', root);
await writeFile(source, (await readFile(source, 'utf8')).replace(/declare_id!\("[^"]+"\)/, `declare_id!("${programId}")`));
await writeFile(new URL('deployment-v2.json', root), JSON.stringify({version:2,programId,maxGuardians:16,pointsPool:25,reputationPool:10,journeyAccountSize:1412,reputationAccountSize:66}, null, 2) + '\n');
console.log(`Prepared separate V2 program ${programId}. Existing V1 keys are unchanged. No transaction was submitted.`);
