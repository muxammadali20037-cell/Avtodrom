import app from '../backend/src/app.js';

export default async function handler(request: any, response: any) {
  try {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers || {})) {
      if (typeof value === 'string') headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.join(', ');
    }

    const rawUrl = String(request.url || '/api');
    const parsed = new URL(rawUrl, 'http://vercel.local');
    let pathname = parsed.pathname || '/api';
    if (!pathname.startsWith('/api')) pathname = `/api${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
    const url = `${pathname}${parsed.search}`;

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

    let body = result.body;
    const contentType = String(result.headers['content-type'] || '');

    // Customer frontend historically reads /api/me.user while the canonical
    // backend returns /api/me.profile. Keep both names during the migration.
    if (pathname === '/api/me' && result.statusCode >= 200 && result.statusCode < 300 && contentType.includes('application/json')) {
      try {
        const parsedBody = JSON.parse(body || '{}');
        if (parsedBody?.profile && !parsedBody.user) {
          body = JSON.stringify({ ...parsedBody, user: parsedBody.profile });
          result.headers['content-length'] = String(Buffer.byteLength(body));
        }
      } catch {
        // Leave a non-JSON response untouched.
      }
    }

    response.statusCode = result.statusCode;
    for (const [key, value] of Object.entries(result.headers)) {
      if (value !== undefined) response.setHeader(key, value as string);
    }
    response.end(body);
  } catch (error) {
    console.error('Vercel API catch-all failed:', error);
    response.statusCode = 500;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: false, error: 'Internal server error' }));
  }
}