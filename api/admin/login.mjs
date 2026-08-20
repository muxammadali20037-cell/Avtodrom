import { createHmac } from 'node:crypto';

const COOKIE_NAME = 'avtodrom_admin_session';
const SESSION_TTL = 60 * 60 * 12;

function json(response, status, data) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  response.end(JSON.stringify(data));
}

function readBody(request) {
  if (request.body && typeof request.body === 'object' && !Buffer.isBuffer(request.body)) return request.body;
  try {
    return JSON.parse(typeof request.body === 'string' ? request.body : '');
  } catch {
    return {};
  }
}

function makeToken(login, secret) {
  const timestamp = Date.now();
  const payload = `${login}:${timestamp}`;
  const signature = createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(`${payload}:${signature}`).toString('base64url');
}

export default function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return json(response, 405, { ok: false, error: 'Method not allowed' });
  }

  try {
    const login = String(readBody(request).login ?? '').trim();
    const password = String(readBody(request).password ?? '');
    const expectedLogin = String(process.env.ADMIN_LOGIN ?? '').trim();
    const expectedPassword = String(process.env.ADMIN_PASSWORD ?? '');
    const secret = String(process.env.ADMIN_SESSION_SECRET ?? '').trim();

    if (!expectedLogin || !expectedPassword || !secret) {
      console.error('Admin env missing:', {
        ADMIN_LOGIN: Boolean(expectedLogin),
        ADMIN_PASSWORD: Boolean(expectedPassword),
        ADMIN_SESSION_SECRET: Boolean(secret)
      });
      return json(response, 500, {
        ok: false,
        error: 'Admin server sozlamalari to‘liq emas. Vercel Environment Variables ni tekshiring.'
      });
    }

    if (login !== expectedLogin || password !== expectedPassword) {
      return json(response, 401, { ok: false, error: 'Login yoki parol noto‘g‘ri.' });
    }

    const token = makeToken(expectedLogin, secret);
    response.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`
    );

    return json(response, 200, {
      ok: true,
      login: expectedLogin,
      redirect: '/admin/dashboard'
    });
  } catch (error) {
    console.error('Admin login fatal error:', error);
    return json(response, 500, { ok: false, error: 'Internal server error' });
  }
}
