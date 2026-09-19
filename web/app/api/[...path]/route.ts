export const dynamic = 'force-dynamic';

async function forward(request: Request) {
  const incoming = new URL(request.url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(incoming.hostname);
  const origin =
    process.env.GUARD_API_ORIGIN || (local ? 'http://127.0.0.1:8787' : '');
  if (!origin)
    return Response.json(
      {
        error:
          'The guard service is not connected yet. Set GUARD_API_ORIGIN on the web deployment.',
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  let configured: URL;
  try {
    configured = new URL(origin);
    if (
      configured.username ||
      configured.password ||
      configured.search ||
      configured.hash ||
      configured.pathname !== '/'
    )
      throw new Error('Invalid origin');
  } catch {
    return Response.json(
      { error: 'The guard service origin is invalid.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (
    configured.protocol !== 'https:' &&
    !(
      local &&
      configured.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(configured.hostname)
    )
  ) {
    return Response.json(
      { error: 'The guard service must use HTTPS.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (!incoming.pathname.startsWith('/api/'))
    return Response.json(
      { error: 'Not found.' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  const headers = new Headers();
  // Derive the signing origin from this server's URL, never a forwarded header.
  headers.set('origin', incoming.origin);
  const authorization = request.headers.get('authorization');
  if (authorization) headers.set('authorization', authorization);
  if (request.headers.has('content-type'))
    headers.set('content-type', request.headers.get('content-type')!);
  try {
    let body: string | undefined;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (Number(request.headers.get('content-length') || 0) > 16_384)
        return Response.json(
          { error: 'Request is too large.' },
          { status: 413, headers: { 'Cache-Control': 'no-store' } },
        );
      const reader = request.body?.getReader();
      if (reader) {
        let length = 0;
        const chunks: Uint8Array[] = [];
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          length += result.value.byteLength;
          if (length > 16_384) {
            await reader.cancel();
            return Response.json(
              { error: 'Request is too large.' },
              { status: 413, headers: { 'Cache-Control': 'no-store' } },
            );
          }
          chunks.push(result.value);
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        body = new TextDecoder().decode(bytes);
      }
    }
    const upstream = new URL(configured);
    upstream.pathname = incoming.pathname;
    upstream.search = incoming.search;
    const response = await fetch(upstream, {
      method: request.method,
      headers,
      body,
      // Workerd accepts manual/follow only. Never forward credentials to a redirect.
      redirect: 'manual',
      signal: AbortSignal.timeout(23_000),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error('The guard service redirected the request.');
    }
    return new Response(response.body, {
      status: response.status,
      headers: {
        'Content-Type':
          response.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return Response.json(
      {
        error:
          'The guard service is temporarily unavailable. Please retry; a failed request is not a confirmed action.',
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
export const GET = forward;
export const POST = forward;
