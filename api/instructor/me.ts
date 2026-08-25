import type { VercelRequest, VercelResponse } from '@vercel/node';
import { validateTelegramInitData, type TelegramWebAppUser } from '../../backend/src/telegram.js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BOT_TOKEN = process.env.INSTRUCTOR_BOT_TOKEN || process.env.TELEGRAM_INSTRUCTOR_BOT_TOKEN || '';

function send(res: VercelResponse, status: number, body: unknown) {
  return res.status(status).setHeader('Content-Type', 'application/json').json(body);
}
function initData(req: VercelRequest) {
  const h = req.headers['x-telegram-init-data'];
  if (typeof h === 'string' && h.trim()) return h.trim();
  const a = req.headers.authorization;
  if (typeof a === 'string' && a.toLowerCase().startsWith('tma ')) return a.slice(4).trim();
  return typeof req.query?.initData === 'string' ? req.query.initData.trim() : '';
}
async function auth(req: VercelRequest): Promise<TelegramWebAppUser> {
  if (!BOT_TOKEN) throw new Error('Instructor bot token is not configured');
  const data = initData(req);
  if (!data) throw new Error('Telegram initData topilmadi. Mini Appni Telegram bot ichidan oching.');
  return validateTelegramInitData(data, BOT_TOKEN);
}
function q(v: string) { return encodeURIComponent(v); }
async function rest<T>(table: string, query: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` }
  });
  const text = await r.text();
  let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (!r.ok) throw new Error(data?.message || data?.hint || data?.details || `Supabase HTTP ${r.status}`);
  return data as T;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  try {
    const user = await auth(req);
    const profiles = await rest<any[]>('profiles', `?telegram_id=eq.${q(String(user.id))}&select=*&limit=1`);
    const profile = profiles[0] || null;
    if (!profile || String(profile.role || '').toLowerCase() !== 'instructor' || profile.active === false) {
      return send(res, 403, { ok: false, error: 'Instructor hali Admin tomonidan tasdiqlanmagan', status: 'PENDING' });
    }
    const instructors = await rest<any[]>('instructors', `?profile_id=eq.${q(String(profile.id))}&approved=eq.true&active=eq.true&select=*&limit=1`);
    const instructor = instructors[0] || null;
    if (!instructor) return send(res, 403, { ok: false, error: 'Instructor hali Admin tomonidan tasdiqlanmagan', status: 'PENDING' });
    return send(res, 200, { ok: true, profile, instructor });
  } catch (e: any) {
    console.error('Instructor me API failed:', e);
    return send(res, 401, { ok: false, error: String(e?.message || 'Unauthorized') });
  }
}
