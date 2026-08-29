import app from '../../../backend/src/app.js';

export default async function handler(request: any, response: any) {
  try {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers || {})) {
      if (typeof value === 'string') headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.join(', ');
    }

    const id = String(request.query?.id || '').trim();
    const date = String(request.query?.date || '').trim();
    if (!id) {
      response.statusCode = 400;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: false, error: 'Instructor ID missing' }));
      return;
    }

    const url = `/api/instructors/${encodeURIComponent(id)}/availability?date=${encodeURIComponent(date)}`;
    const result = await app.inject({ method: 'GET', url, headers });

    response.statusCode = result.statusCode;
    for (const [key, value] of Object.entries(result.headers)) {
      if (value !== undefined) response.setHeader(key, value as string);
    }
    response.end(result.body);
  } catch (error) {
    console.error('Availability function failed:', error);
    response.statusCode = 500;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: false, error: 'Internal server error' }));
  }
}
