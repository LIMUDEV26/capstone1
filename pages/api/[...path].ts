import type { NextApiRequest, NextApiResponse } from 'next';

export const config = {
  api: {
    // Preserve request bytes for JSON, forms, and chunked uploads. Explicit
    // limits below prevent unbounded buffering.
    bodyParser: false,
    responseLimit: false,
  },
};

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'content-encoding', 'content-length', 'host', 'keep-alive',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
]);

// Never pass client-supplied forwarding or Vercel platform headers upstream.
const FORWARDED_REQUEST_HEADERS = new Set([
  'accept', 'accept-language', 'authorization', 'content-type', 'cookie',
  'if-modified-since', 'if-none-match', 'origin', 'range', 'sec-fetch-dest',
  'sec-fetch-mode', 'sec-fetch-site', 'user-agent', 'x-no-toast',
  'x-requested-with',
]);

class PayloadTooLargeError extends Error {}

async function readRequestBody(req: NextApiRequest): Promise<Buffer> {
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new PayloadTooLargeError();
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_REQUEST_BYTES) throw new PayloadTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readResponseBody(upstream: Response): Promise<Buffer> {
  const declaredLength = Number(upstream.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new PayloadTooLargeError();
  }

  const reader = upstream.body?.getReader();
  if (!reader) return Buffer.alloc(0);

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new PayloadTooLargeError();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function safeForwardedHost(req: NextApiRequest) {
  const host = String(req.headers.host || '');
  return /^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(host) ? host : '';
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');

  const backendOrigin = String(process.env.PHP_BACKEND_ORIGIN || '').replace(/\/+$/, '');
  if (!backendOrigin) {
    // The hardened PHP API is the sole authentication and authorization source.
    return res.status(503).json({ success: false, message: 'Backend API is not configured.' });
  }

  const backendBasePath = `/${String(process.env.PHP_BACKEND_BASE_PATH || '/capstone1')
    .replace(/^\/+|\/+$/g, '')}`;
  const pathParts = Array.isArray(req.query.path) ? req.query.path : [String(req.query.path || '')];
  const target = new URL(`${backendOrigin}${backendBasePath}/api/${pathParts.map(encodeURIComponent).join('/')}`);
  for (const [key, value] of Object.entries(req.query)) {
    if (key === 'path' || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      target.searchParams.append(key, String(item));
    }
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || !FORWARDED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const forwardedHost = safeForwardedHost(req);
  if (forwardedHost) headers.set('x-forwarded-host', forwardedHost);
  headers.set('x-forwarded-proto', 'https');

  const method = String(req.method || 'GET').toUpperCase();
  let requestBody: Buffer;
  try {
    requestBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readRequestBody(req);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return res.status(413).json({ success: false, message: 'Request payload is too large.' });
    }
    throw error;
  }

  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body: requestBody.length ? Uint8Array.from(requestBody).buffer : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });

    let responseBody: Buffer;
    try {
      responseBody = await readResponseBody(upstream);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return res.status(502).json({ success: false, message: 'Backend response is too large.' });
      }
      throw error;
    }

    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && key.toLowerCase() !== 'set-cookie') {
        res.setHeader(key, value);
      }
    });
    const setCookies = (upstream.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() || [];
    if (setCookies.length) res.setHeader('Set-Cookie', setCookies);

    const location = upstream.headers.get('location');
    if (location) res.setHeader('Location', location.replace(backendOrigin, ''));
    return res.status(upstream.status).send(responseBody);
  } catch (error) {
    console.error('Backend proxy error:', error instanceof Error ? error.message : 'Unknown error');
    return res.status(502).json({ success: false, message: 'Backend API is unavailable.' });
  }
}
