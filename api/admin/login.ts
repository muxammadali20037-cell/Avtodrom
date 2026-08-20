import { createHmac } from 'node:crypto';

const COOKIE_NAME = 'avtodrom_admin_session';
const SESSION_TTL = 60 * 60 * 12;

function makeToken(login: string) {
  const secret = String(process.env.ADMIN_SESSION_SECRET || '').trim();
  if (!secret) throw new Error('ADMIN_SESSION_SECRET is not configured');
  const timestamp = Date.now();
  const payload = `${login}:${timestamp}`;
  const signature = createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(`${payload}:${signature}`).toString('base64url');
}

function readBody(request: any): { login?: string; password?: string } {
  if (!request.body) return {};
  if (typeof request.body === 'object') return request.body;
  try { return JSON.parse(String(request.body)); } catch { return {}; }
}

export default function handler(request: any, response: any) {
  if (request.method !== 'POST') {
    response.statusCode = 405;
    response.setHeader('Allow', 'POST');
    return response.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
  }

  try {
    const { login = '', password = '' } = readBody(request);
    const expectedLogin = String(process.env.ADMIN_LOGIN || '').trim();
    const expectedPassword = String(process.env.ADMIN_PASSWORD || '');
    const secret = String(process.env.ADMIN_SESSION_SECRET || '').trim();

    if (!expectedLogin || !expectedPassword || !secret) {
      response.statusCode = 500;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      return response.end(JSON.stringify({ ok: false, error: 'ADMIN_LOGIN, ADMIN_PASSWORD yoki ADMIN_SESSION_SECRET sozlanmagan' }));
    }

    if (String(login).trim() !== expectedLogin || String(password) !== expectedPassword) {
      response.statusCode = 401;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      return response.end(JSON.stringify({ ok: false, error: 'Login yoki parol noto‘g‘ri' }));
    }

    const token = makeToken(expectedLogin);
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`);
    return response.end(JSON.stringify({ ok: true, login: expectedLogin, redirect: '/admin/dashboard.html' }));
  } catch (error) {
    console.error('Admin login error:', error);
    response.statusCode = 500;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    return response.end(JSON.stringify({ ok: false, error: 'Internal server error' }));
  }
}
