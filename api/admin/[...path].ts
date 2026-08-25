import app from '../../backend/src/app';

export default async function handler(request: any, response: any) {
  try {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers || {})) {
      if (typeof value === 'string') headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.join(', ');
    }

    const rawUrl = String(request.url || '/api/admin');
    const parsed = new URL(rawUrl, 'http://vercel.local');
    const pathname = parsed.pathname || '/api/admin';
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

    response.statusCode = result.statusCode;
    for (const [key, value] of Object.entries(result.headers)) {
      if (value !== undefined) response.setHeader(key, value as string);
    }
    response.end(result.body);
  } catch (error) {
    console.error('Admin API failed:', error);
    response.statusCode = 500;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ ok: false, error: 'Internal server error' }));
  }
}
