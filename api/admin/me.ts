import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'avtodrom_admin_session';
const SESSION_TTL = 60 * 60 * 12;

function getCookie(request: any): string {
  const raw = String(request.headers?.cookie || '');
  const item = raw.split(';').map((v: string) => v.trim()).find((v: string) => v.startsWith(COOKIE_NAME + '='));
  return item ? decodeURIComponent(item.slice(COOKIE_NAME.length + 1)) : '';
}

function validToken(token: string): boolean {
  try {
    const secret = String(process.env.ADMIN_SESSION_SECRET || '').trim();
    if (!secret || !token) return false;

    const parts = Buffer.from(token, 'base64url').toString('utf8').split(':');
    if (parts.length < 3) return false;

    const login = parts[0];
    const timestamp = Number(parts[1]);
    const signature = parts.slice(2).join(':');

    if (!login || !Number.isFinite(timestamp)) return false;
    if (Date.now() - timestamp > SESSION_TTL * 1000) return false;
    if (Date.now() - timestamp < 0) return false;

    const expected = createHmac('sha256', secret).update(`${login}:${timestamp}`).digest('hex');
    const a = Buffer.from(signature, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export default function handler(request: any, response: any) {
  if (request.method !== 'GET') {
    response.statusCode = 405;
    response.setHeader('Allow', 'GET');
    return response.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
  }

  try {
    const token = getCookie(request);
    if (!validToken(token)) {
      response.statusCode = 401;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      return response.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
    }

    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    return response.end(JSON.stringify({ ok: true, login: String(process.env.ADMIN_LOGIN || '') }));
  } catch (error) {
    console.error('Admin session error:', error);
    response.statusCode = 500;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    return response.end(JSON.stringify({ ok: false, error: 'Internal server error' }));
  }
}
