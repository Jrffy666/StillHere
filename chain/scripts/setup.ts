import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';

const contracts = fileURLToPath(new URL('../../contracts/', import.meta.url));
const chainSource = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const programKeyPath = join(contracts, 'target/deploy/safety_guard-keypair.json');
const walletKeyPath = join(contracts, '.keys/deployer.json');

async function createOrLoad(path: string): Promise<Keypair> {
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(path, 'utf8'))));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const keypair = Keypair.generate();
    await writeFile(path, JSON.stringify(Array.from(keypair.secretKey)), { flag: 'wx', mode: 0o600 });
    return keypair;
  }
}
await mkdir(join(contracts, 'target/deploy'), { recursive: true });
await mkdir(join(contracts, '.keys'), { recursive: true });
const program = await createOrLoad(programKeyPath);
const wallet = await createOrLoad(walletKeyPath);
const id = program.publicKey.toBase58();
const rustPath = join(contracts, 'programs/safety-guard/src/lib.rs');
const anchorPath = join(contracts, 'Anchor.toml');
const rust = (await readFile(rustPath, 'utf8')).replace(/declare_id!\("[1-9A-HJ-NP-Za-km-z]+"\)/, `declare_id!("${id}")`);
const anchor = (await readFile(anchorPath, 'utf8')).replace(/safety_guard = "[1-9A-HJ-NP-Za-km-z]+"/g, `safety_guard = "${id}"`);
const client = (await readFile(chainSource, 'utf8')).replace(/DEFAULT_PROGRAM_ID = new PublicKey\('[1-9A-HJ-NP-Za-km-z]+'\)/, `DEFAULT_PROGRAM_ID = new PublicKey('${id}')`);
await writeFile(rustPath, rust);
await writeFile(anchorPath, anchor);
await writeFile(chainSource, client);
console.log(`Program ID: ${id}`);
console.log(`Test-only deployer address: ${wallet.publicKey.toBase58()}`);
console.log('Keys stored only under contracts/.keys and contracts/target (both gitignored).');
console.log(`Set SOLANA_PROGRAM_ID=${id} on the Worker only after successful deployment.`);
console.log('For Devnet, set SOLANA_RPC_URL=https://api.devnet.solana.com and restart the Worker.');
console.log('No funds requested, no transaction sent, no global wallet modified.');
