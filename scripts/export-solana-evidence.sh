#!/usr/bin/env bash
set -euo pipefail
source /root/.local/share/safety-guard-env.sh
cd /root/safety-guard
node --input-type=module <<'NODE'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const destination = '/mnt/c/Users/20120/Desktop/HTN/safety-guard';
const report = JSON.parse(await readFile('artifacts/verification.localnet.json', 'utf8'));
if (report.cluster !== 'localnet' || !report.verified || report.status !== 'passed') throw new Error('No passing local report to export.');
const binary = await readFile('contracts/target/deploy/safety_guard.so');
const idl = JSON.parse(await readFile('contracts/target/idl/safety_guard.json', 'utf8'));
if (idl.address !== report.programId) throw new Error('IDL and verified program IDs differ.');
for (const directory of ['docs/deployment', 'contracts/target/deploy', 'contracts/target/idl']) await mkdir(`${destination}/${directory}`, { recursive: true });
await copyFile('artifacts/verification.localnet.json', `${destination}/docs/deployment/verification.localnet.json`);
await copyFile('contracts/target/deploy/safety_guard.so', `${destination}/contracts/target/deploy/safety_guard.so`);
await copyFile('contracts/target/idl/safety_guard.json', `${destination}/contracts/target/idl/safety_guard.json`);
const rpc = 'https://api.devnet.solana.com';
async function call(method, params = []) {
  const response = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error('RPC request failed.');
  return data.result;
}
const deployer = 'AHdX6zJn3xYQXCBix3TvEqXUyV9x8PdPcEstsCkyhdE8';
const genesis = await call('getGenesisHash');
if (genesis !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') throw new Error('Unexpected Devnet genesis.');
const balance = await call('getBalance', [deployer, { commitment: 'confirmed' }]);
const account = await call('getAccountInfo', [report.programId, { encoding: 'base64', commitment: 'confirmed' }]);
let devnetReport;
try {
  devnetReport = JSON.parse(await readFile('artifacts/verification.devnet.json', 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (devnetReport) {
  if (devnetReport.cluster !== 'devnet' || devnetReport.genesisHash !== genesis || devnetReport.programId !== report.programId) throw new Error('Devnet report does not match the deployed network and program.');
  await copyFile('artifacts/verification.devnet.json', `${destination}/docs/deployment/verification.devnet.json`);
}
const workflowVerified = Boolean(account.value?.executable && devnetReport?.verified && devnetReport.status === 'passed');
const status = {
  recordedAt: new Date().toISOString(),
  programId: report.programId,
  deployer,
  linuxWorkspace: '/root/safety-guard',
  binary: { bytes: binary.length, sha256: createHash('sha256').update(binary).digest('hex'), localFile: 'contracts/target/deploy/safety_guard.so' },
  toolchain: { ubuntu: '24.04.5', node: '24.14.1', hostRust: '1.94.1', anchor: '0.32.1', solana: '4.1.2', platformTools: 'v1.56', architecture: 'v3' },
  localnet: { verified: true, genesisHash: report.genesisHash, report: 'docs/deployment/verification.localnet.json', confirmedTransactions: report.transactions.length, rejectedOperations: report.rejectedOperations.length, guardianPoints: report.guardianPoints },
  devnet: { rpc, genesisHash: genesis, balanceLamports: balance.value, executableProgramFound: Boolean(account.value?.executable), workflowVerified, status: workflowVerified ? 'verified' : account.value?.executable ? 'deployed-awaiting-verification' : balance.value > 0 ? 'funded-awaiting-deployment' : 'awaiting-test-sol', report: devnetReport ? 'docs/deployment/verification.devnet.json' : null, confirmedTransactions: devnetReport?.transactions.length ?? 0, rejectedOperations: devnetReport?.rejectedOperations.length ?? 0, guardianPoints: devnetReport?.guardianPoints ?? null, note: 'CLI workflow verification is separate from browser wallet interaction and website hosting.' },
};
await writeFile(`${destination}/docs/deployment/status.json`, JSON.stringify(status, null, 2) + '\n');
console.log(JSON.stringify(status, null, 2));
console.log('Exported public artifacts and reports only. No keypair files copied.');
NODE
