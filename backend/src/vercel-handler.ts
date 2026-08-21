import app from './app.js';

export default async function vercelHandler(request: any, response: any) {
  try {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers || {})) {
      if (typeof value === 'string') headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.join(', ');
    }

    const rawUrl = String(request.url || '/api');
    const parsed = new URL(rawUrl, 'http://vercel.local');
    const url = `${parsed.pathname}${parsed.search}`;

    let payload: any = undefined;
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.body !== undefined) {
      payload = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    }

    const result = await app.inject({
      method: request.method || 'GET',
      url,
      headers,
      payload,
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
