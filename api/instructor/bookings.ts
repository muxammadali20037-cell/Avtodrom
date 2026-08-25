import type { VercelRequest, VercelResponse } from '@vercel/node';
import { validateTelegramInitData, type TelegramWebAppUser } from '../../backend/src/telegram.js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BOT_TOKEN = process.env.INSTRUCTOR_BOT_TOKEN || process.env.TELEGRAM_INSTRUCTOR_BOT_TOKEN || '';

function send(res: VercelResponse, status: number, body: unknown) {
  return res.status(status).setHeader('Content-Type', 'application/json').json(body);
}
function q(v: string) { return encodeURIComponent(v); }
function getInit(req: VercelRequest) {
  const h = req.headers['x-telegram-init-data'];
  if (typeof h === 'string' && h.trim()) return h.trim();
  const a = req.headers.authorization;
  if (typeof a === 'string' && a.toLowerCase().startsWith('tma ')) return a.slice(4).trim();
  return typeof req.query?.initData === 'string' ? req.query.initData.trim() : '';
}
async function auth(req: VercelRequest): Promise<TelegramWebAppUser> {
  if (!BOT_TOKEN) throw new Error('Instructor bot token is not configured');
  const d = getInit(req);
  if (!d) throw new Error('Telegram initData topilmadi');
  return validateTelegramInitData(d, BOT_TOKEN);
}
async function rest<T>(table: string, query: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  const t = await r.text();
  let d: any = null;
  try { d = t ? JSON.parse(t) : null; } catch { d = { message: t }; }
  if (!r.ok) throw new Error(d?.message || d?.hint || d?.details || `Supabase HTTP ${r.status}`);
  return d as T;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  try {
    const telegramUser = await auth(req);

    // Current production schema uses users + instructor_profiles.
    const users = await rest<any[]>('users', `?telegram_id=eq.${q(String(telegramUser.id))}&select=id,telegram_id,full_name,phone,role,is_active,is_blocked&limit=1`);
    const instructorUser = users[0] || null;
    if (!instructorUser || String(instructorUser.role || '').toLowerCase() !== 'instructor' || instructorUser.is_active === false || instructorUser.is_blocked === true) {
      return send(res, 403, { ok: false, error: 'Instructor hali Admin tomonidan tasdiqlanmagan', status: 'PENDING' });
    }

    const profiles = await rest<any[]>('instructor_profiles', `?user_id=eq.${q(String(instructorUser.id))}&select=user_id,is_verified,is_available&limit=1`);
    const instructorProfile = profiles[0] || null;
    if (!instructorProfile || instructorProfile.is_verified !== true || instructorProfile.is_available === false) {
      return send(res, 403, { ok: false, error: 'Instructor hali Admin tomonidan tasdiqlanmagan', status: 'PENDING' });
    }

    const from = typeof req.query?.from === 'string' ? req.query.from : '';
    const to = typeof req.query?.to === 'string' ? req.query.to : '';
    const parts = [
      'select=*',
      `instructor_id=eq.${q(String(instructorUser.id))}`,
      'order=start_at.asc',
    ];
    if (from) parts.push(`start_at=gte.${q(from)}`);
    if (to) parts.push(`start_at=lt.${q(to)}`);

    const bookings = await rest<any[]>('bookings', `?${parts.join('&')}`);

    // Enrich customers from the canonical users table. This avoids the old
    // profiles foreign-key relation which caused the Mini App schema error.
    const ids = [...new Set(bookings.map((b: any) => b.customer_id).filter(Boolean).map(String))];
    const customerMap = new Map<string, any>();
    if (ids.length) {
      const customers = await rest<any[]>('users', `?id=in.(${ids.map(q).join(',')})&select=id,telegram_id,full_name,phone,role`);
      for (const c of customers) customerMap.set(String(c.id), c);
    }

    const normalized = bookings.map((b: any) => {
      const customer = customerMap.get(String(b.customer_id)) || {};
      const names = String(customer.full_name || '').trim().split(/\s+/);
      const start = b.start_at || (b.date && b.time ? `${b.date}T${b.time}` : b.booking_date || b.start_time || b.created_at);
      return {
        ...b,
        start_at: start,
        booking_date: b.booking_date || start,
        customer: {
          ...customer,
          first_name: names[0] || '',
          last_name: names.slice(1).join(' '),
        },
      };
    });

    return send(res, 200, { ok: true, bookings: normalized });
  } catch (e: any) {
    console.error('Instructor bookings API failed:', e);
    return send(res, 400, { ok: false, error: String(e?.message || 'Failed to load instructor bookings') });
  }
}
