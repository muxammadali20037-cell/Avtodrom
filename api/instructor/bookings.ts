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
async function rest<T>(table: string, query: string, options: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    ...options,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
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

    // Production schema:
    // users -> instructor_profiles -> bookings.instructor_id
    const users = await rest<any[]>(
      'users',
      `?telegram_id=eq.${q(String(telegramUser.id))}&select=id,telegram_id,full_name,phone,role,is_active,is_blocked&limit=1`,
    );
    const instructorUser = users[0] || null;

    if (!instructorUser || String(instructorUser.role || '').toLowerCase() !== 'instructor' || instructorUser.is_active === false || instructorUser.is_blocked === true) {
      return send(res, 403, { ok: false, error: 'Instructor hali Admin tomonidan tasdiqlanmagan', status: 'PENDING' });
    }

    const profiles = await rest<any[]>(
      'instructor_profiles',
      `?user_id=eq.${q(String(instructorUser.id))}&select=id,user_id,is_verified,is_available,experience_years,rating,total_reviews&limit=1`,
    );
    const instructorProfile = profiles[0] || null;

    if (!instructorProfile || instructorProfile.is_verified !== true || instructorProfile.is_available === false) {
      return send(res, 403, { ok: false, error: 'Instructor hali Admin tomonidan tasdiqlanmagan', status: 'PENDING' });
    }

    // IMPORTANT:
    // public.bookings.instructor_id references public.instructor_profiles.id,
    // NOT public.users.id. The old code used users.id and therefore returned
    // no bookings. The real booking time column is booking_date, not start_at.
    const from = typeof req.query?.from === 'string' ? req.query.from : '';
    const to = typeof req.query?.to === 'string' ? req.query.to : '';
    const parts = [
      'select=*',
      `instructor_id=eq.${q(String(instructorProfile.id))}`,
      'order=booking_date.asc',
    ];
    if (from) parts.push(`booking_date=gte.${q(from)}`);
    if (to) parts.push(`booking_date=lt.${q(to)}`);

    const bookings = await rest<any[]>('bookings', `?${parts.join('&')}`);

    // Customer data is stored in users, so enrich it explicitly instead of
    // relying on the old public.profiles relationship.
    const ids = [...new Set(bookings.map((b: any) => b.customer_id).filter(Boolean).map(String))];
    const customerMap = new Map<string, any>();
    if (ids.length) {
      const customers = await rest<any[]>(
        'users',
        `?id=in.(${ids.map(q).join(',')})&select=id,telegram_id,full_name,phone,role`,
      );
      for (const c of customers) customerMap.set(String(c.id), c);
    }

    const normalized = bookings.map((b: any) => {
      const customer = customerMap.get(String(b.customer_id)) || {};
      const names = String(customer.full_name || '').trim().split(/\s+/).filter(Boolean);
      const start = b.booking_date || b.created_at;

      return {
        ...b,
        // Keep the frontend contract stable even though DB uses booking_date.
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
