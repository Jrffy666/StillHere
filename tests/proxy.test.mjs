import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { GET, POST } from '../web/app/api/[...path]/route.ts';

// Node >=22.13 loads the actual TypeScript route using built-in type stripping.
// Every outbound request is mocked. No development server or network is needed.
const originalFetch = globalThis.fetch;
const originalOrigin = process.env.GUARD_API_ORIGIN;
let calls;

beforeEach(() => {
  process.env.GUARD_API_ORIGIN = 'https://backend.example.test';
  calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    throw new Error('An unstubbed external request was blocked by the test');
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalOrigin === undefined) delete process.env.GUARD_API_ORIGIN;
  else process.env.GUARD_API_ORIGIN = originalOrigin;
});

function stubFetch(handler) {
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return handler(...args);
  };
}

function request(path = '/api/health', init = {}) {
  return new Request(`https://web.example.test${path}`, init);
}

function assertNoStore(response) {
  assert.match(response.headers.get('cache-control') || '', /no-store/);
}

test('production proxy rejects missing, malformed, ambiguous, and non-HTTPS origins without fetching', async () => {
  const invalid = [
    '',
    'not a URL',
    'http://backend.example.test',
    'ftp://backend.example.test',
    'https://username:password@backend.example.test',
    'https://backend.example.test?api_key=synthetic-secret',
    'https://backend.example.test#fragment',
    'https://backend.example.test/nested-base',
  ];
  for (const configured of invalid) {
    process.env.GUARD_API_ORIGIN = configured;
    const response = await GET(request());
    assert.equal(response.status, 503, 'Invalid upstream configuration should return a controlled 503');
    assertNoStore(response);
    const body = await response.json();
    assert.equal(typeof body.error, 'string');
    assert.equal(JSON.stringify(body).includes('synthetic-secret'), false);
    assert.equal(calls.length, 0);
  }
});

test('HTTP is accepted only when both the incoming host and upstream host are local', async () => {
  process.env.GUARD_API_ORIGIN = 'http://127.0.0.1:8787';
  stubFetch(() => Response.json({ ok: true }));
  const localResponse = await GET(new Request('http://localhost:5173/api/health'));
  assert.equal(localResponse.status, 200);
  assert.equal(String(calls[0][0]), 'http://127.0.0.1:8787/api/health');
  const remoteIncoming = await GET(request());
  assert.equal(remoteIncoming.status, 503);
  assertNoStore(remoteIncoming);
  process.env.GUARD_API_ORIGIN = 'http://remote.example.test';
  const remoteTarget = await GET(new Request('http://localhost:5173/api/health'));
  assert.equal(remoteTarget.status, 503);
  assertNoStore(remoteTarget);
  assert.equal(calls.length, 1);
});

test('proxy forwards authorization, content type, method, query, and body without browser cookies', async () => {
  const payload = JSON.stringify({ name: 'Synthetic proxy user' });
  stubFetch((_url, init) => {
    assert.equal(init.method, 'POST');
    assert.equal(init.body, payload);
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), 'Bearer synthetic-test-token');
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('cookie'), null);
    assert.equal(headers.get('origin'), 'https://web.example.test');
    assert.equal(headers.get('x-forwarded-for'), null);
    return Response.json({ created: true }, { status: 201 });
  });
  const response = await POST(request('/api/session?source=integration', {
    method: 'POST',
    headers: {
      authorization: 'Bearer synthetic-test-token',
      'content-type': 'application/json',
      cookie: 'unrelated-session=do-not-forward',
      origin: 'https://untrusted.example.test',
      'x-forwarded-for': '203.0.113.20',
    },
    body: payload,
  }));
  assert.equal(String(calls[0][0]), 'https://backend.example.test/api/session?source=integration');
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { created: true });
  assertNoStore(response);
});

test('proxy enforces its 16 KB body cap for declared and streamed lengths', async () => {
  const declared = await POST(request('/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '16385' }, body: '{}',
  }));
  assert.equal(declared.status, 413);
  assertNoStore(declared);
  const actual = await POST(request('/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(16385),
  }));
  assert.equal(actual.status, 413);
  assertNoStore(actual);
  assert.equal(calls.length, 0);
});

test('upstream network failures return a controlled non-cacheable error without leaking details', async () => {
  stubFetch(() => { throw new Error('upstream-private-information'); });
  const response = await GET(request('/api/me'));
  assert.equal(response.status, 503);
  assertNoStore(response);
  const body = await response.json();
  assert.equal(typeof body.error, 'string');
  assert.equal(JSON.stringify(body).includes('upstream-private-information'), false);
  assert.match(body.error, /not a confirmed action/);
});

test('upstream redirects are rejected without following or exposing their location', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    stubFetch((_url, init) => {
      assert.equal(init.redirect, 'manual');
      return new Response(null, { status, headers: { Location: 'https://untrusted.example.test/collect' } });
    });
    const count = calls.length;
    const response = await POST(request('/api/session', {
      method: 'POST', headers: { Authorization: 'Bearer synthetic-test-token' }, body: '{}',
    }));
    assert.equal(response.status, 503);
    assert.equal(calls.length, count + 1, 'Do not request the redirect target');
    assert.equal(response.headers.get('location'), null);
    assert.equal((await response.text()).includes('untrusted.example.test'), false);
    assertNoStore(response);
  }
});

test('upstream error status and JSON are passed through without cache or cookie propagation', async () => {
  stubFetch(() => Response.json({ error: 'Session expired or invalid.' }, {
    status: 401,
    headers: { 'cache-control': 'public, max-age=3600', 'set-cookie': 'provider-cookie=do-not-copy' },
  }));
  const response = await GET(request('/api/me'));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Session expired or invalid.' });
  assert.equal(response.headers.get('set-cookie'), null);
  assertNoStore(response);
});

test('successful upstream audio is streamed with its original content type', async () => {
  const bytes = new Uint8Array([73, 68, 51, 1, 2, 3]);
  stubFetch(() => new Response(bytes, { headers: { 'content-type': 'audio/mpeg' } }));
  const response = await POST(request('/api/trips/synthetic/voice', { method: 'POST' }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assertNoStore(response);
});
