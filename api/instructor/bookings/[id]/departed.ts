import type { VercelRequest, VercelResponse } from '@vercel/node';
import { validateTelegramInitData } from '../../../../backend/src/telegram.js';

const U = process.env.SUPABASE_URL || '';
const K = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const T = process.env.INSTRUCTOR_BOT_TOKEN || process.env.TELEGRAM_INSTRUCTOR_BOT_TOKEN || '';
const out = (r: VercelResponse, s: number, b: any) => r.status(s).setHeader('Content-Type', 'application/json').json(b);
const q = (v: string) => encodeURIComponent(v);
function init(r: VercelRequest) {
  const h = r.headers['x-telegram-init-data'];
  if (typeof h === 'string' && h.trim()) return h.trim();
  const a = r.headers.authorization;
  if (typeof a === 'string' && a.toLowerCase().startsWith('tma ')) return a.slice(4).trim();
  return typeof r.query?.initData === 'string' ? r.query.initData.trim() : '';
}
async function auth(r: VercelRequest) {
  if (!T) throw new Error('Instructor bot token is not configured');
  const d = init(r);
  if (!d) throw new Error('Telegram initData topilmadi');
  return validateTelegramInitData(d, T);
}
async function rest(table: string, query: string, options: RequestInit = {}) {
  const x = await fetch(`${U}/rest/v1/${table}${query}`, {
    ...options,
    headers: {
      apikey: K,
      Authorization: `Bearer ${K}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const t = await x.text();
  let d: any = null;
  try { d = t ? JSON.parse(t) : null; } catch { d = { message: t }; }
  if (!x.ok) throw new Error(d?.message || d?.hint || d?.details || `Supabase HTTP ${x.status}`);
  return d;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return out(res, 405, { ok: false, error: 'Method not allowed' });
  try {
    const u = await auth(req);
    const users = await rest('users', `?telegram_id=eq.${q(String(u.id))}&select=id,role,is_active,is_blocked&limit=1`);
    const instructor = users[0];
    if (!instructor || instructor.role !== 'instructor' || instructor.is_active === false || instructor.is_blocked === true) {
      return out(res, 403, { ok: false, error: 'Instructor tasdiqlanmagan' });
    }
    const profiles = await rest('instructor_profiles', `?user_id=eq.${q(String(instructor.id))}&select=is_verified,is_available&limit=1`);
    if (!profiles[0] || profiles[0].is_verified !== true || profiles[0].is_available === false) {
      return out(res, 403, { ok: false, error: 'Instructor tasdiqlanmagan' });
    }

    const id = String((req.query as any).id || '').trim();
    if (!id) return out(res, 400, { ok: false, error: 'Bron ID kerak' });

    const current = await rest('bookings', `?id=eq.${q(id)}&instructor_id=eq.${q(String(instructor.id))}&select=*&limit=1`);
    const booking = current[0];
    if (!booking) return out(res, 404, { ok: false, error: 'Bron topilmadi yoki bu instruktorga biriktirilmagan' });
    if (String(booking.status) !== 'in_progress') return out(res, 409, { ok: false, error: 'KETDI faqat boshlangan bron uchun mumkin.' });

    const updated = await rest('bookings', `?id=eq.${q(id)}&instructor_id=eq.${q(String(instructor.id))}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'completed', departed_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
    });
    return out(res, 200, { ok: true, booking: updated[0] || booking });
  } catch (e: any) {
    return out(res, 400, { ok: false, error: String(e?.message || 'KETDI amalini bajarib bo‘lmadi') });
  }
}
