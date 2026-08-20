import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'avtodrom_admin_session';
const SESSION_TTL = 60 * 60 * 12;

function json(response, status, data) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  response.end(JSON.stringify(data));
}

function getCookie(request) {
  const raw = String(request.headers?.cookie ?? '');
  const item = raw.split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE_NAME}=`));
  if (!item) return '';
  try { return decodeURIComponent(item.slice(COOKIE_NAME.length + 1)); } catch { return ''; }
}

function validToken(token, secret) {
  try {
    if (!secret || !token) return false;
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const first = decoded.indexOf(':');
    const second = decoded.indexOf(':', first + 1);
    if (first <= 0 || second <= first) return false;
    const login = decoded.slice(0, first);
    const timestamp = Number(decoded.slice(first + 1, second));
    const signature = decoded.slice(second + 1);
    if (!login || !Number.isFinite(timestamp) || !signature) return false;
    const age = Date.now() - timestamp;
    if (age < 0 || age > SESSION_TTL * 1000) return false;
    const expected = createHmac('sha256', secret).update(`${login}:${timestamp}`).digest('hex');
    const a = Buffer.from(signature, 'utf8'), b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch { return false; }
}

export default function handler(request, response) {
  if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); return json(response, 405, { ok: false, error: 'Method not allowed' }); }
  try {
    const fallback = String(process.env.ADMIN_PASSWORD ?? '').trim();
    const secret = String(process.env.ADMIN_SESSION_SECRET ?? fallback).trim();
    const token = getCookie(request);
    if (!secret) return json(response, 500, { ok: false, error: 'ADMIN_SESSION_SECRET yoki ADMIN_PASSWORD Vercelda sozlanmagan.' });
    if (!validToken(token, secret)) return json(response, 401, { ok: false, error: 'Unauthorized' });
    return json(response, 200, { ok: true, login: String(process.env.ADMIN_LOGIN ?? '').trim() });
  } catch (error) {
    console.error('Admin session fatal error:', error);
    return json(response, 500, { ok: false, error: 'Internal server error' });
  }
}
