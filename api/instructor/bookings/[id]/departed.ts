import app from '../../../../../backend/src/app.js';

export default async function handler(request: any, response: any) {
  try {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers || {})) {
      if (typeof value === 'string') headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.join(', ');
    }
    const rawUrl = String(request.url || '/api/instructor/bookings');
    const parsed = new URL(rawUrl, 'http://vercel.local');
    const result = await app.inject({
      method: request.method || 'POST',
      url: `${parsed.pathname}${parsed.search}`,
      headers,
      payload: request.body === undefined ? undefined : typeof request.body === 'string' ? request.body : JSON.stringify(request.body),
    });
    response.statusCode = result.statusCode;
    for (const [key, value] of Object.entries(result.headers)) if (value !== undefined) response.setHeader(key, value as string);
    response.end(result.body);
  } catch (error) {
    console.error('Instructor departed Vercel wrapper failed:', error);
    response.statusCode = 500;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: false, error: 'Instructor attendance API server error' }));
  }
}
