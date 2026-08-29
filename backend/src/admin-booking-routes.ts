import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { supabaseRest } from './supabase.js';
import { sendBookingNotification } from './telegram.js';

const COOKIE = 'avtodrom_admin_session';
const TTL = 60 * 60 * 12;
const q = (v: string) => encodeURIComponent(v);

function readCookie(req: any) {
  const raw = String(req.headers?.cookie || '');
  const part = raw.split(';').map((x: string) => x.trim()).find((x: string) => x.startsWith(COOKIE + '='));
  if (!part) return '';
  try { return decodeURIComponent(part.slice(COOKIE.length + 1)); } catch { return ''; }
}

function validAdminSession(value: string) {
  try {
    const secret = String(process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || '').trim();
    const expectedLogin = String(process.env.ADMIN_LOGIN || '').trim();
    const raw = Buffer.from(value || '', 'base64url').toString('utf8');
    const a = raw.indexOf(':'), b = raw.indexOf(':', a + 1);
    if (!secret || !expectedLogin || a <= 0 || b <= a) return false;
    const login = raw.slice(0, a);
    const ts = Number(raw.slice(a + 1, b));
    const sig = raw.slice(b + 1);
    if (login !== expectedLogin || !Number.isFinite(ts) || Date.now() - ts < 0 || Date.now() - ts > TTL * 1000) return false;
    const expected = createHmac('sha256', secret).update(`${login}:${ts}`).digest('hex');
    const x = Buffer.from(sig), y = Buffer.from(expected);
    return x.length === y.length && timingSafeEqual(x, y);
  } catch { return false; }
}

async function guard(req: any, reply: any) {
  if (!validAdminSession(readCookie(req))) {
    reply.code(401).send({ ok: false, error: 'Admin sessiyasi tugagan. Qayta kiring.' });
    return false;
  }
  return true;
}

const transitions: Record<string, string[]> = {
  pending: ['confirmed', 'rejected', 'cancelled'],
  confirmed: ['in_progress', 'cancelled', 'no_show'],
  in_progress: ['completed'],
  completed: [],
  cancelled: [],
  rejected: [],
  no_show: [],
};

function humanError(e: any) {
  const m = e instanceof Error ? e.message : String(e ?? '');
  if (/bookings_no_instructor_overlap/.test(m)) return 'Bu instruktorning vaqti allaqachon band.';
  if (/bookings_no_customer_overlap/.test(m)) return 'Mijozning shu vaqtda boshqa broni bor.';
  if (/bookings_time_valid/.test(m)) return 'Bron vaqt oralig‘i noto‘g‘ri.';
  return m || 'Bronni saqlab bo‘lmadi.';
}

async function loadBookings() {
  const bookings = await supabaseRest<any[]>('bookings', {
    query: '?select=*&order=booking_date.desc,created_at.desc&limit=500',
  });
  if (!bookings.length) return [];

  const customerIds = [...new Set(bookings.map(b => b.customer_id).filter(Boolean).map(String))];
  const instructorIds = [...new Set(bookings.map(b => b.instructor_id).filter(Boolean).map(String))];
  const courseIds = [...new Set(bookings.map(b => b.course_id).filter(Boolean).map(String))];

  const instructors = instructorIds.length
    ? await supabaseRest<any[]>('instructor_profiles', { query: `?id=in.(${instructorIds.map(q).join(',')})&select=id,user_id,rating,total_reviews,is_verified,is_available` })
    : [];
  const instructorUserIds = [...new Set(instructors.map(i => i.user_id).filter(Boolean).map(String))];
  const userIds = [...new Set([...customerIds, ...instructorUserIds])];

  const [users, courses] = await Promise.all([
    userIds.length
      ? supabaseRest<any[]>('users', { query: `?id=in.(${userIds.map(q).join(',')})&select=id,full_name,phone,telegram_id,username` })
      : Promise.resolve([]),
    courseIds.length
      ? supabaseRest<any[]>('courses', { query: `?id=in.(${courseIds.map(q).join(',')})&select=id,name,duration_minutes,price` })
      : Promise.resolve([]),
  ]);

  const um = new Map(users.map(u => [String(u.id), u]));
  const im = new Map(instructors.map(i => [String(i.id), i]));
  const cm = new Map(courses.map(c => [String(c.id), c]));

  return bookings.map(b => {
    const customer = um.get(String(b.customer_id)) || null;
    const ip = im.get(String(b.instructor_id)) || null;
    const instructorUser = ip ? um.get(String(ip.user_id)) || null : null;
    return {
      ...b,
      start_at: b.start_at || b.booking_date || null,
      end_at: b.end_at || null,
      customer,
      instructor: ip ? { ...ip, user: instructorUser, profile: instructorUser ? {
        first_name: String(instructorUser.full_name || '').split(' ')[0] || '',
        last_name: String(instructorUser.full_name || '').split(' ').slice(1).join(' '),
        phone: instructorUser.phone || null,
        username: instructorUser.username || null,
        telegram_id: instructorUser.telegram_id || null,
      } : null } : null,
      course: cm.get(String(b.course_id)) || null,
    };
  });
}

async function notifyStatus(booking: any, status: string) {
  try {
    const customer = booking?.customer;
    const token = String(process.env.CUSTOMER_BOT_TOKEN || process.env.TELEGRAM_CUSTOMER_BOT_TOKEN || '');
    const url = String(process.env.CUSTOMER_MINI_APP_URL || process.env.MINI_APP_URL || 'https://avtodrom.vercel.app/');
    if (token && Number.isSafeInteger(Number(customer?.telegram_id))) {
      const labels: Record<string,string> = { confirmed: 'Tasdiqlandi', rejected: 'Rad etildi', cancelled: 'Bekor qilindi', in_progress: 'Jarayonda', completed: 'Tugadi', no_show: 'Kelmagan' };
      await sendBookingNotification(token, Number(customer.telegram_id), `🚗 AVTODROM\n\nBron holati: ${labels[status] || status}`, url, '🚗 Panelni ochish');
    }
  } catch (e) { console.error('Admin booking notification failed:', e); }
}

export async function registerAdminBookingRoutes(app: FastifyInstance) {
  app.get('/api/admin/bookings', async (req: any, reply: any) => {
    if (!(await guard(req, reply))) return;
    try {
      const bookings = await loadBookings();
      return { ok: true, bookings };
    } catch (e) {
      return reply.code(500).send({ ok: false, error: humanError(e) });
    }
  });

  app.patch('/api/admin/bookings/:id/status', async (req: any, reply: any) => {
    if (!(await guard(req, reply))) return;
    try {
      const id = String(req.params?.id || '');
      const next = String(req.body?.status || '').trim();
      const reason = String(req.body?.reason || '').trim();
      if (!id) return reply.code(400).send({ ok: false, error: 'Bron ID topilmadi.' });
      const allowed = Object.values(transitions).flat();
      if (!allowed.includes(next)) return reply.code(400).send({ ok: false, error: 'Holat noto‘g‘ri.' });

      const currentRows = await supabaseRest<any[]>('bookings', { query: `?id=eq.${q(id)}&select=*&limit=1` });
      const current = currentRows[0];
      if (!current) return reply.code(404).send({ ok: false, error: 'Bron topilmadi.' });

      const from = String(current.status || '');
      if (!(transitions[from] || []).includes(next)) {
        return reply.code(409).send({ ok: false, error: `"${from}" holatidan "${next}" ga o‘tib bo‘lmaydi.` });
      }

      const now = new Date().toISOString();
      const patch: Record<string, any> = { status: next, updated_at: now };
      if (next === 'confirmed') patch.confirmed_at = now;
      if (['cancelled', 'rejected'].includes(next)) {
        patch.cancelled_at = now;
        patch.cancellation_reason = reason || null;
      }

      const updated = await supabaseRest<any[]>('bookings', {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        query: `?id=eq.${q(id)}`,
        body: JSON.stringify(patch),
      });
      const booking = updated[0] || { ...current, ...patch };
      const enriched = (await loadBookings()).find(x => String(x.id) === id) || booking;
      await notifyStatus(enriched, next);
      return { ok: true, booking: enriched };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: humanError(e) });
    }
  });
}
