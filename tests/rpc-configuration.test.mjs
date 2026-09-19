import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateRpcSetting, verifyDevnetRpc } from '../scripts/configure-rpc.mjs';

test('private RPC configuration accepts quoted dotenv input and rejects incomplete or unsafe values', () => {
  assert.equal(privateRpcSetting('SOLANA_PRIVATE_RPC_URL="https://devnet.example.test/?api-key=synthetic"'), 'https://devnet.example.test/?api-key=synthetic');
  for (const value of ['', 'https://devnet.example.test/?api-key=YOUR_API_KEY', 'http://devnet.example.test', 'https://user:password@example.test', 'https://localhost', 'https://example.test/#secret']) {
    assert.throws(() => privateRpcSetting(`SOLANA_PRIVATE_RPC_URL="${value}"`));
  }
});

test('RPC verification rejects mainnet and sanitizes transport or provider failures', async () => {
  const secret = 'https://devnet.example.test/?api-key=synthetic-secret';
  await verifyDevnetRpc(secret, async (url, init) => {
    assert.equal(url, secret);
    assert.equal(init.redirect, 'error'); // This CLI runs in Node, not workerd.
    assert.equal(JSON.parse(init.body).method, 'getGenesisHash');
    return Response.json({ result: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' });
  });
  await assert.rejects(verifyDevnetRpc(secret, async () => Response.json({ result: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' })), /not Solana Devnet/);
  for (const fetcher of [async () => { throw new Error(secret); }, async () => new Response(secret, { status: 403 })]) {
    await assert.rejects(verifyDevnetRpc(secret, fetcher), error => !error.message.includes('synthetic-secret') && error.message.includes('No secret was uploaded'));
  }
});
