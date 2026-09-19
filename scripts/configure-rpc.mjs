import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const worker = join(root, 'worker');
const devnetGenesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

export function privateRpcSetting(contents) {
  const value = parseEnv(contents).SOLANA_PRIVATE_RPC_URL?.trim();
  if (!value || /YOUR_|REPLACE_|[<>]/i.test(value)) throw new Error('Fill SOLANA_PRIVATE_RPC_URL in worker/.dev.vars with your own Devnet HTTPS RPC URL.');
  let url;
  try { url = new URL(value); } catch { throw new Error('The private RPC URL is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use a remote HTTPS RPC URL without URL username, password, or fragment.');
  return value;
}

export async function verifyDevnetRpc(value, fetcher = fetch) {
  let response, result;
  try {
    response = await fetcher(value, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: [] }),
    });
    if (!response.ok) throw new Error();
    result = await response.json();
  } catch { throw new Error('The RPC check failed. Check the provider dashboard, Devnet endpoint, API key, and quota. No secret was uploaded.'); }
  if (result.result !== devnetGenesis) throw new Error('This RPC is not Solana Devnet. No secret was uploaded.');
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 3 || args[0] !== '--env' || !['staging', 'production'].includes(args[1]) || args[2] !== '--apply') throw new Error('Usage: node scripts/configure-rpc.mjs --env staging|production --apply');
  let contents;
  try { contents = await readFile(join(worker, '.dev.vars'), 'utf8'); } catch { throw new Error('Create worker/.dev.vars and set SOLANA_PRIVATE_RPC_URL first.'); }
  const value = privateRpcSetting(contents);
  await verifyDevnetRpc(value);
  const run = (command, input) => spawnSync(process.execPath, [join(worker, 'node_modules/wrangler/bin/wrangler.js'), ...command, '--env', args[1]], {
    cwd: worker, input, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  // Refuse to create an empty Worker when the wrong Cloudflare account is active.
  if (run(['deployments', 'list']).status !== 0) throw new Error('The selected Worker is unavailable. Check Cloudflare login and deploy the application first.');
  if (run(['secret', 'put', 'SOLANA_PRIVATE_RPC_URL'], value + '\n').status !== 0) throw new Error('Cloudflare did not accept the secret. Check Wrangler authentication and the selected environment.');
  console.log(`Devnet RPC verified and stored as a Cloudflare secret for ${args[1]}. The URL was not printed. Run the hosted chain preparation check next.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
