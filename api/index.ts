import app from '../backend/src/app.js';

await app.ready();

function normalizeApiUrl(rawUrl: string) {
  const value = String(rawUrl || '/');
  const parsed = new URL(value, 'http://vercel.local');
  let pathname = parsed.pathname || '/';

  // Vercel rewrites can pass either /api/... or the rewritten /... path.
  // Fastify routes in this project are intentionally registered under /api/.
  if (!pathname.startsWith('/api/')) {
    pathname = pathname === '/api' ? '/api' : `/api${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
  }

  return `${pathname}${parsed.search}`;
}

export default async function handler(request: any, response: any) {
  try {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers || {})) {
      if (typeof value === 'string') headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.join(', ');
    }

    const url = normalizeApiUrl(request.url || '/');

    const result = await app.inject({
      method: request.method || 'GET',
      url,
      headers,
      payload: request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : request.body === undefined
          ? undefined
          : typeof request.body === 'string'
            ? request.body
            : JSON.stringify(request.body),
    });

    response.statusCode = result.statusCode;
    for (const [key, value] of Object.entries(result.headers)) {
      if (value !== undefined) response.setHeader(key, value as string);
    }
    response.end(result.body);
  } catch (error) {
    console.error('Vercel Fastify handler failed:', error);
    response.statusCode = 500;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: false, error: 'Internal server error' }));
  }
}
