import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { apiOrigin } from './backup.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const worker = join(root, 'worker');
const requireWorker = createRequire(join(worker, 'package.json'));
const requiredBindings = { TRIPS: 'TripRoom', USERS: 'UserAccount', LOBBY: 'TripDirectory', AUTH: 'IdentityRegistry', GOVERNANCE: 'GovernanceStore', CHAIN: 'ChainJourney', COMMUNITY: 'CommunityLedger' };

export function validateDeployment(config, environment) {
  if (!['staging', 'production'].includes(environment)) throw new Error('Choose --env staging or --env production.');
  const selected = config.env?.[environment], vars = selected?.vars;
  if (!selected || !vars || vars.APP_ENV !== environment || !selected.name || selected.name === config.name || selected.name === config.env?.[environment === 'staging' ? 'production' : 'staging']?.name) throw new Error('Deployment environments must have distinct Worker names and matching APP_ENV values.');
  const siteOrigin = apiOrigin(vars.SITE_ORIGIN);
  if (['localhost', '127.0.0.1', '[::1]'].includes(new URL(siteOrigin).hostname) || vars.AUTH_DOMAIN !== new URL(siteOrigin).host) throw new Error('AUTH_DOMAIN must match the deployed HTTPS SITE_ORIGIN.');
  const origins = String(vars.ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim());
  if (!origins.includes(siteOrigin)) throw new Error('ALLOWED_ORIGINS must include SITE_ORIGIN.');
  for (const origin of origins) {
    const url = new URL(apiOrigin(origin));
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Hosted CORS origins cannot use localhost.');
  }
  if (vars.SOLANA_NETWORK !== 'devnet') throw new Error('Hosted V2 deployments currently support Solana Devnet only.');
  const { PublicKey } = requireWorker('@solana/web3.js');
  let program;
  try { program = new PublicKey(vars.SOLANA_V2_PROGRAM_ID); } catch { throw new Error('SOLANA_V2_PROGRAM_ID must be a valid, separately deployed V2 program.'); }
  if (program.equals(PublicKey.default) || vars.SOLANA_V2_PROGRAM_ID === vars.SOLANA_PROGRAM_ID) throw new Error('V2 requires its own nonzero program address; preserve the existing V1 deployment.');
  if (!['true', 'false'].includes(vars.COMMUNITY_ENABLED)) throw new Error('COMMUNITY_ENABLED must explicitly be true or false.');
  const community = { enabled: vars.COMMUNITY_ENABLED === 'true', programId: null };
  if (community.enabled) {
    if (typeof vars.COMMUNITY_PROGRAM_ID !== 'string' || !vars.COMMUNITY_PROGRAM_ID) throw new Error('Enabled community publication requires a valid COMMUNITY_PROGRAM_ID.');
    let communityProgram;
    try { communityProgram = new PublicKey(vars.COMMUNITY_PROGRAM_ID); } catch { throw new Error('Enabled community publication requires a valid COMMUNITY_PROGRAM_ID.'); }
    if (communityProgram.equals(PublicKey.default) || communityProgram.toBase58() !== vars.COMMUNITY_PROGRAM_ID
      || [vars.SOLANA_PROGRAM_ID, vars.SOLANA_V2_PROGRAM_ID].includes(communityProgram.toBase58())) {
      throw new Error('Community publication requires a separate nonzero program address; preserve V1 and V2.');
    }
    community.programId = communityProgram.toBase58();
  }
  const rpc = new URL(vars.SOLANA_RPC_URL);
  if (rpc.protocol !== 'https:' || rpc.username || rpc.password || ['localhost', '127.0.0.1', '[::1]'].includes(rpc.hostname)) throw new Error('SOLANA_RPC_URL must use hosted HTTPS without URL credentials.');
  if (environment === 'production' && vars.RESTORE_ALLOWED !== 'false') throw new Error('Production restore must remain disabled.');
  if (vars.NOTIFICATIONS_ENABLED !== 'false') throw new Error('This release keeps external notifications disabled.');
  const bindings = selected.durable_objects?.bindings ?? [];
  for (const [name, className] of Object.entries(requiredBindings)) if (!bindings.some(binding => binding.name === name && binding.class_name === className && !binding.script_name)) throw new Error(`Missing isolated ${name} Durable Object binding.`);
  const classes = new Set((config.migrations ?? []).flatMap(migration => migration.new_sqlite_classes ?? []));
  for (const className of Object.values(requiredBindings)) if (!classes.has(className)) throw new Error(`Missing SQLite migration for ${className}.`);
  return { environment, name: selected.name, siteOrigin, programId: program.toBase58(), community };
}

/** Validate names returned by Wrangler; never request or print deployed secret values. */
export function validateDeploymentSecrets(selected, secrets) {
  if (!Array.isArray(secrets)) throw new Error('Deployed secret metadata must be a list.');
  const names = new Set(secrets.filter(secret => secret && typeof secret.name === 'string').map(secret => secret.name));
  const required = ['OPERATOR_SECRET', ...(selected.community.enabled ? ['COMMUNITY_ISSUER_SECRET_KEY', 'COMMUNITY_SPONSOR_SECRET_KEY'] : [])];
  for (const name of required) if (!names.has(name)) throw new Error(`${name} is missing from the selected remote environment.`);
}

export function deployArguments(argv) {
  const options = { command: argv[0], apply: false };
  if (!['check', 'deploy', 'rollback', 'status'].includes(options.command)) throw new Error('Usage: node scripts/deploy.mjs check|deploy|rollback|status --env staging|production [--api-origin <origin>] [--version <UUID>] [--apply]');
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--apply') options.apply = true;
    else if (['--env', '--api-origin', '--version'].includes(flag) && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      const key = flag === '--env' ? 'environment' : flag === '--api-origin' ? 'origin' : 'version';
      if (options[key]) throw new Error('Duplicate deployment option.'); options[key] = argv[++index];
    } else throw new Error('Unknown or incomplete deployment option.');
  }
  if (!['staging', 'production'].includes(options.environment)) throw new Error('An explicit --env staging or --env production is required.');
  if (['deploy', 'rollback'].includes(options.command) && !options.apply) throw new Error('Remote changes require --apply. Run check first.');
  if (options.command !== 'check' && !options.origin) throw new Error('--api-origin is required for readiness verification.');
  if (options.command === 'rollback' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.version ?? '')) throw new Error('Rollback requires the exact known-good --version UUID.');
  if (options.origin) options.origin = apiOrigin(options.origin);
  return options;
}

function wrangler(args, { capture = false } = {}) {
  const result = spawnSync(process.execPath, [join(worker, 'node_modules/wrangler/bin/wrangler.js'), ...args], { cwd: worker, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', windowsHide: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Wrangler ${args[0]} failed. Check Cloudflare authentication, permissions, and the selected environment.`);
  return result.stdout ?? '';
}

class ReadinessError extends Error {
  constructor(message, retryable = false) { super(message); this.retryable = retryable; }
}

export async function checkReadiness(origin, environment, fetcher = fetch, timeoutMs = 15_000) {
  let response;
  try { response = await fetcher(origin + '/api/ready', { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } }); }
  catch { throw new ReadinessError('Readiness network request failed.', true); }
  let data;
  try { data = await response.json(); } catch (error) {
    if (response.ok) throw new ReadinessError('Readiness returned invalid JSON.', error instanceof TypeError || error?.name === 'TimeoutError' || error?.name === 'AbortError');
  }
  const required = ['identityDomain', 'operatorSecret', 'allowedOrigins', 'chainConfigured', 'chainNetwork', 'restoreDisabled'];
  // A real readiness payload reporting bad configuration is not propagation delay,
  // even when the endpoint intentionally returns 503 for that configuration.
  if (data && typeof data.environment === 'string' && (data.environment !== environment || data.checks && (data.ready !== true || required.some(key => data.checks[key] !== true)))) throw new ReadinessError('Readiness checks failed or the API belongs to a different environment.');
  if (!response.ok) throw new ReadinessError(`Readiness returned HTTP ${response.status}.`, [404, 503].includes(response.status));
  if (data?.ready !== true || data.environment !== environment || required.some(key => data.checks?.[key] !== true)) throw new ReadinessError('Readiness checks failed or the API belongs to a different environment.');
  return data;
}

export async function waitForReadiness(origin, environment, { fetcher = fetch, now = () => performance.now(), sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
  const deadline = now() + 45_000;
  const delays = [1000, 2000, 4000, 8000, 10_000];
  let lastError, attempts = 0;
  for (let index = 0; index <= delays.length; index++) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    attempts++;
    try { return await checkReadiness(origin, environment, fetcher, Math.max(1, Math.floor(Math.min(15_000, remaining)))); }
    catch (error) { if (!(error instanceof ReadinessError) || !error.retryable) throw error; lastError = error; }
    if (index === delays.length || now() >= deadline) break;
    await sleep(Math.min(delays[index], deadline - now()));
  }
  throw new Error(`Readiness did not become available after ${attempts} attempts within the 45-second propagation window. ${lastError?.message ?? ''}`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = deployArguments(argv);
  if (options.command === 'status') { await checkReadiness(options.origin, options.environment); console.log(`Readiness passed for ${options.environment}.`); return; }
  if (options.command === 'rollback') {
    // Rollback must remain available even when the current source/configuration is broken.
    wrangler(['rollback', options.version, '--env', options.environment, '--yes', '--message', 'Operator-selected known-good version']);
    await waitForReadiness(options.origin, options.environment);
    console.log('Worker code rollback passed readiness. Persistent data and Solana transactions were not rolled back.');
    return;
  }
  const ts = requireWorker('typescript');
  const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', await readFile(join(worker, 'wrangler.jsonc'), 'utf8'));
  if (parsed.error) throw new Error('Invalid worker/wrangler.jsonc.');
  const selected = validateDeployment(parsed.config, options.environment);
  wrangler(['deploy', '--env', options.environment, '--dry-run', '--outdir', join('dist', options.environment)]);
  if (options.command === 'check') { console.log(`Configuration and bundle checks passed for ${selected.name}. Nothing was published.`); return; }
  let secrets;
  try { secrets = JSON.parse(wrangler(['secret', 'list', '--env', options.environment, '--format', 'json'], { capture: true })); } catch { throw new Error('Could not verify deployed secret metadata. Configure required secrets with Wrangler secret put.'); }
  validateDeploymentSecrets(selected, secrets);
  wrangler(['deploy', '--env', options.environment]);
  await waitForReadiness(options.origin, options.environment);
  console.log(`Deployed ${selected.name}; readiness passed. Record the version ID printed by Wrangler before switching frontend traffic.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
