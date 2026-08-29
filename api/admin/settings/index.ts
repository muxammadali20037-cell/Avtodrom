import { createHmac, timingSafeEqual } from 'node:crypto';
import { supabaseRest } from '../../../backend/src/supabase.js';

const COOKIE = 'avtodrom_admin_session';
const TTL = 60 * 60 * 12;

function getCookie(req: any) {
  const raw = String(req.headers?.cookie || '');
  const item = raw.split(';').map((v: string) => v.trim()).find((v: string) => v.startsWith(COOKIE + '='));
  if (!item) return '';
  try { return decodeURIComponent(item.slice(COOKIE.length + 1)); } catch { return ''; }
}

function sessionSecret() {
  return String(process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || '').trim();
}

function validSession(token: string) {
  try {
    const secret = sessionSecret();
    const expectedLogin = String(process.env.ADMIN_LOGIN || '').trim();
    const decoded = Buffer.from(token || '', 'base64url').toString('utf8');
    const a = decoded.indexOf(':'), b = decoded.indexOf(':', a + 1);
    if (!secret || !expectedLogin || a <= 0 || b <= a) return false;
    const login = decoded.slice(0, a);
    const ts = Number(decoded.slice(a + 1, b));
    const sig = decoded.slice(b + 1);
    if (login !== expectedLogin || !Number.isFinite(ts) || Date.now() - ts < 0 || Date.now() - ts > TTL * 1000) return false;
    const expected = createHmac('sha256', secret).update(`${login}:${ts}`).digest('hex');
    const x = Buffer.from(sig), y = Buffer.from(expected);
    return x.length === y.length && timingSafeEqual(x, y);
  } catch { return false; }
}

async function requireAdmin(req: any, res: any) {
  if (!validSession(getCookie(req))) {
    res.statusCode = 401;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: 'Admin sessiyasi tugagan. Qayta kiring.' }));
    return false;
  }
  return true;
}

export default async function handler(req: any, res: any) {
  if (!(await requireAdmin(req, res))) return;
  try {
    const rows = await supabaseRest<any[]>('admin_settings', {
      query: '?select=key,value,updated_at&order=key.asc',
    });
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ ok: true, settings: rows }));
  } catch (error: any) {
    console.error('Admin settings read failed:', error);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: error?.message || 'Sozlamalarni yuklashda xato' }));
  }
}
