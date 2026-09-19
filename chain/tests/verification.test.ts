import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import {
  DEVNET_GENESIS_HASH, resolveTestFunderPath, resolveVerificationReportPath, validateTestGenesis,
} from '../scripts/verify.ts';

const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const TESTNET_GENESIS_HASH = '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY';
const LOCAL_GENESIS_HASH = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
const OTHER_LOCAL_GENESIS_HASH = new PublicKey(new Uint8Array(32).fill(8)).toBase58();

test('verification accepts only the exact Devnet genesis on the public RPC', () => {
  assert.doesNotThrow(() => validateTestGenesis('devnet', DEVNET_GENESIS_HASH, true));
  assert.doesNotThrow(() => validateTestGenesis('devnet', DEVNET_GENESIS_HASH, false));
  for (const unsupported of [MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH, LOCAL_GENESIS_HASH]) {
    assert.throws(() => validateTestGenesis('devnet', unsupported, true), /does not match Solana Devnet/);
  }
  assert.throws(() => validateTestGenesis('devnet', 'malformed', true));
  assert.throws(() => validateTestGenesis('mainnet' as never, MAINNET_GENESIS_HASH, true), /Only localnet and devnet/);
});

test('a localhost endpoint cannot disguise a known public network as localnet', () => {
  for (const hash of [MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH, DEVNET_GENESIS_HASH]) {
    assert.throws(() => validateTestGenesis('localnet', hash, false), /public cluster/);
    assert.throws(() => validateTestGenesis('localnet', hash, true, hash), /public cluster/);
  }
});

test('local deployer funding is bound to an explicitly supplied validator genesis', () => {
  assert.doesNotThrow(() => validateTestGenesis('localnet', LOCAL_GENESIS_HASH, false));
  assert.doesNotThrow(() => validateTestGenesis('localnet', LOCAL_GENESIS_HASH, true, LOCAL_GENESIS_HASH));
  assert.throws(() => validateTestGenesis('localnet', LOCAL_GENESIS_HASH, true), /GUARD_LOCALNET_GENESIS_HASH/);
  assert.throws(() => validateTestGenesis('localnet', LOCAL_GENESIS_HASH, true, OTHER_LOCAL_GENESIS_HASH), /GUARD_LOCALNET_GENESIS_HASH/);
  // A supplied expectation remains binding even when using the faucet.
  assert.throws(() => validateTestGenesis('localnet', LOCAL_GENESIS_HASH, false, OTHER_LOCAL_GENESIS_HASH), /GUARD_LOCALNET_GENESIS_HASH/);
});

test('the funding key must be explicitly selected from this project, never a global wallet', () => {
  const projectDeployer = fileURLToPath(new URL('../../contracts/.keys/deployer.json', import.meta.url));
  assert.equal(resolveTestFunderPath(projectDeployer), resolve(projectDeployer));
  assert.equal(resolveTestFunderPath('../contracts/.keys/deployer.json'), resolve(projectDeployer));
  for (const wrongPath of ['~/.config/solana/id.json', '../contracts/.keys/other.json', './deployer.json', '../../other-project/contracts/.keys/deployer.json']) {
    assert.throws(() => resolveTestFunderPath(wrongPath), /Global or other wallet paths are unsupported/);
  }
});

test('verification reports have explicit, separate localnet and Devnet filenames', () => {
  for (const cluster of ['localnet', 'devnet'] as const) {
    for (const filename of [`reports/verification.${cluster}.json`, `${cluster}.json`, `run-${cluster}-2026.json`]) {
      assert.equal(resolveVerificationReportPath(filename, cluster), resolve(filename));
    }
    const otherCluster = cluster === 'localnet' ? 'devnet' : 'localnet';
    for (const filename of ['report.json', `report.${otherCluster}.json`, 'report.localnet.devnet.json', `report.${cluster}.txt`, `report.not${cluster}.json`]) {
      assert.throws(() => resolveVerificationReportPath(filename, cluster), /must name a/);
    }
  }
});
