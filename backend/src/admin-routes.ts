import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { supabaseRest } from './supabase.js';
import type { TelegramWebAppUser } from './telegram.js';

const COOKIE_NAME = 'avtodrom_admin_session';
const SESSION_TTL = 60 * 60 * 12;

function q(value: string) { return encodeURIComponent(value); }

function getCookie(request: any): string {
  const raw = String(request.headers?.cookie ?? '');
  const item = raw.split(';').map((v: string) => v.trim()).find((v: string) => v.startsWith(`${COOKIE_NAME}=`));
  if (!item) return '';
  try { return decodeURIComponent(item.slice(COOKIE_NAME.length + 1)); } catch { return ''; }
}

function validAdminSession(token: string): boolean {
  try {
    const fallback = String(process.env.ADMIN_PASSWORD ?? '').trim();
    const secret = String(process.env.ADMIN_SESSION_SECRET ?? fallback).trim();
    const expectedLogin = String(process.env.ADMIN_LOGIN ?? '').trim();
    if (!secret || !token || !expectedLogin) return false;
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const first = decoded.indexOf(':');
    const second = decoded.indexOf(':', first + 1);
    if (first <= 0 || second <= first) return false;
    const login = decoded.slice(0, first);
    const timestamp = Number(decoded.slice(first + 1, second));
    const signature = decoded.slice(second + 1);
    if (login !== expectedLogin || !Number.isFinite(timestamp) || !signature) return false;
    const age = Date.now() - timestamp;
    if (age < 0 || age > SESSION_TTL * 1000) return false;
    const expected = createHmac('sha256', secret).update(`${login}:${timestamp}`).digest('hex');
    const a = Buffer.from(signature, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch { return false; }
}

async function requireAdminSession(request: any) {
  if (!validAdminSession(getCookie(request))) throw new Error('Unauthorized');
}

async function setting(key: string) {
  const rows = await supabaseRest<any[]>('admin_settings', { query: `?key=eq.${q(key)}&select=key,value,updated_at` });
  return rows[0] || null;
}

async function saveSetting(key: string, value: any) {
  const rows = await supabaseRest<any[]>('admin_settings', {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    query: `?key=eq.${q(key)}`,
    body: JSON.stringify({ value, updated_at: new Date().toISOString() }),
  });
  if (rows[0]) return rows[0];
  const created = await supabaseRest<any[]>('admin_settings', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
  return created[0];
}

export async function registerAdminRoutes(app: FastifyInstance, _authenticate: (request: any) => Promise<TelegramWebAppUser>) {
  app.get('/api/admin/me', async (request, reply) => {
    try {
      await requireAdminSession(request);
      return { ok: true, login: String(process.env.ADMIN_LOGIN ?? '').trim() };
    } catch (e) {
      return reply.code(401).send({ ok: false, error: e instanceof Error ? e.message : 'Unauthorized' });
    }
  });

  app.post('/api/admin/logout', async (_request, reply) => {
    reply.header('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    return { ok: true };
  });

  app.get('/api/admin/stats', async (request, reply) => {
    try {
      await requireAdminSession(request);
      const [users, instructors, bookings, reviews, payments] = await Promise.all([
        supabaseRest<any[]>('users', { query: '?role=eq.customer&select=id' }),
        supabaseRest<any[]>('instructor_profiles', { query: '?select=id,is_available,rating,total_reviews' }),
        supabaseRest<any[]>('bookings', { query: '?select=id,status,booking_date' }),
        supabaseRest<any[]>('reviews', { query: '?status=eq.approved&select=rating' }),
        supabaseRest<any[]>('payments', { query: '?status=eq.paid&select=amount,paid_at,created_at' }),
      ]);
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const end = new Date(); end.setHours(24, 0, 0, 0);
      const ratings = reviews.map(r => Number(r.rating)).filter(Number.isFinite);
      const paidToday = payments.filter(p => {
        const d = new Date(p.paid_at || p.created_at);
        return d >= start && d < end;
      }).reduce((sum, p) => sum + Number(p.amount || 0), 0);
      return {
        ok: true,
        stats: {
          customers: users.length,
          instructors: instructors.filter(i => i.is_available).length,
          pendingBookings: bookings.filter(b => b.status === 'pending').length,
          todayBookings: bookings.filter(b => { const d = new Date(b.booking_date); return d >= start && d < end; }).length,
          completedBookings: bookings.filter(b => b.status === 'completed').length,
          averageRating: ratings.length ? Number((ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2)) : 0,
          paidToday,
        },
      };
    } catch (e) {
      console.error('Admin stats failed:', e);
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : 'Stats failed' });
    }
  });

  app.get('/api/admin/instructors', async (request, reply) => {
    try {
      await requireAdminSession(request);
      const rows = await supabaseRest<any[]>('instructor_profiles', {
        query: '?select=id,user_id,bio,experience_years,rating,total_reviews,is_verified,is_available,created_at,updated_at,profile:user_id(id,telegram_id,phone,full_name,role,is_active,is_blocked)&order=created_at.desc',
      });
      return { ok: true, instructors: rows.map(x => ({ ...x, active: Boolean(x.is_available) })) };
    } catch (e) {
      console.error('Admin instructors failed:', e);
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : 'Failed to load instructors' });
    }
  });

  app.post('/api/admin/instructors', async (request, reply) => {
    try {
      await requireAdminSession(request);
      const body = (request.body || {}) as any;
      const first = String(body.first_name || '').trim();
      const last = String(body.last_name || '').trim();
      const fullName = `${first} ${last}`.trim();
      if (first.length < 2) return reply.code(400).send({ ok: false, error: 'Ism kiritilishi kerak' });
      const createdUsers = await supabaseRest<any[]>('users', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          full_name: fullName,
          phone: String(body.phone || '').trim() || null,
          telegram_id: body.telegram_id ? Number(body.telegram_id) : null,
          role: 'instructor',
          is_active: true,
          is_blocked: false,
        }),
      });
      const user = createdUsers[0];
      const createdProfiles = await supabaseRest<any[]>('instructor_profiles', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          user_id: user.id,
          bio: String(body.bio || '').trim() || null,
          experience_years: Math.max(0, Number(body.experience_years || 0)),
          is_verified: false,
          is_available: true,
        }),
      });
      return reply.code(201).send({ ok: true, instructor: createdProfiles[0], profile: user });
    } catch (e) {
      console.error('Admin instructor creation failed:', e);
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : 'Instructor creation failed' });
    }
  });

  app.patch<{ Params: { id: string }; Body: { active?: boolean; bio?: string; experience_years?: number; is_verified?: boolean } }>('/api/admin/instructors/:id', async (request, reply) => {
    try {
      await requireAdminSession(request);
      const body = request.body || {};
      const patch: any = { updated_at: new Date().toISOString() };
      if (body.active !== undefined) patch.is_available = Boolean(body.active);
      if (body.bio !== undefined) patch.bio = String(body.bio || '').trim() || null;
      if (body.experience_years !== undefined) patch.experience_years = Math.max(0, Number(body.experience_years || 0));
      if (body.is_verified !== undefined) patch.is_verified = Boolean(body.is_verified);
      const rows = await supabaseRest<any[]>('instructor_profiles', {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        query: `?id=eq.${q(request.params.id)}`, body: JSON.stringify(patch),
      });
      if (!rows[0]) return reply.code(404).send({ ok: false, error: 'Instruktor topilmadi' });
      return { ok: true, instructor: { ...rows[0], active: Boolean(rows[0].is_available) } };
    } catch (e) {
      console.error('Admin instructor update failed:', e);
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : 'Instructor update failed' });
    }
  });

  app.get('/api/admin/bookings', async (request, reply) => {
    try {
      await requireAdminSession(request);
      const query = request.query as { status?: string };
      const parts = [
        'select=*,customer:customer_id(id,telegram_id,phone,full_name),instructor:instructor_id(id,rating,total_reviews,profile:user_id(id,full_name,phone,telegram_id)),course:course_id(id,name,duration_minutes,price)',
        'order=booking_date.desc',
      ];
      if (query.status) parts.push(`status=eq.${q(query.status)}`);
      return { ok: true, bookings: await supabaseRest<any[]>('bookings', { query: `?${parts.join('&')}` }) };
    } catch (e) {
      console.error('Admin bookings failed:', e);
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : 'Failed to load bookings' });
    }
  });

  app.patch<{ Params: { id: string }; Body: { status: string; reason?: string } }>('/api/admin/bookings/:id/status', async (request, reply) => {
    try {
      await requireAdminSession(request);
      const allowed = ['pending', 'confirmed', 'rejected', 'cancelled', 'completed', 'no_show'];
      const status = String(request.body?.status || '');
      if (!allowed.includes(status)) return reply.code(400).send({ ok: false, error: 'Noto‘g‘ri bron holati' });
      const patch: any = { status, updated_at: new Date().toISOString() };
      if (status === 'confirmed') patch.confirmed_at = new Date().toISOString();
      if (status === 'cancelled' || status === 'rejected') {
        patch.cancelled_at = new Date().toISOString();
        patch.cancellation_reason = String(request.body?.reason || '').trim() || null;
      }
      const rows = await supabaseRest<any[]>('bookings', {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        query: `?id=eq.${q(request.params.id)}`, body: JSON.stringify(patch),
      });
      if (!rows[0]) return reply.code(404).send({ ok: false, error: 'Bron topilmadi' });
      return { ok: true, booking: rows[0] };
    } catch (e) {
      console.error('Admin booking status failed:', e);
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : 'Booking update failed' });
    }
  });

  app.get('/api/admin/customers', async (request, reply) => {
    try {
      await requireAdminSession(request);
      return { ok: true, customers: await supabaseRest<any[]>('users', { query: '?role=eq.customer&select=id,telegram_id,phone,full_name,role,is_active,is_blocked,created_at&order=created_at.desc' }) };
    } catch (e) {
      console.error('Admin customers failed:', e);
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : 'Failed to load customers' });
    }
  });

  app.patch<{ Params: { id: string }; Body: { active?: boolean } }>('/api/admin/customers/:id', async (request, reply) => {
    try {
      await requireAdminSession(request);
      const active = Boolean(request.body?.active);
      const rows = await supabaseRest<any[]>('users', {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        query: `?id=eq.${q(request.params.id)}&role=eq.customer`,
        body: JSON.stringify({ is_active: active, is_blocked: !active, updated_at: new Date().toISOString() }),
      });
      if (!rows[0]) return reply.code(404).send({ ok: false, error: 'Foydalanuvchi topilmadi' });
      return { ok: true, customer: rows[0] };
    } catch (e) {
      console.error('Admin customer update failed:', e);
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : 'Customer update failed' });
    }
  });

  app.get('/api/admin/reviews', async (request, reply) => {
    try {
      await requireAdminSession(request);
      const reviews = await supabaseRest<any[]>('reviews', {
        query: '?select=*,customer:customer_id(id,full_name,phone,telegram_id),instructor:instructor_id(id,rating,total_reviews,profile:user_id(id,full_name,phone))&order=created_at.desc',
      });
      return { ok: true, reviews };
    } catch (e) {
      console.error('Admin reviews failed:', e);
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : 'Failed to load reviews' });
    }
  });

  app.patch<{ Params: { id: string }; Body: { status: string } }>('/api/admin/reviews/:id', async (request, reply) => {
    try {
      await requireAdminSession(request);
      const status = String(request.body?.status || '');
      if (!['pending', 'approved', 'rejected'].includes(status)) return reply.code(400).send({ ok: false, error: 'Noto‘g‘ri sharh holati' });
      const rows = await supabaseRest<any[]>('reviews', {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        query: `?id=eq.${q(request.params.id)}`,
        body: JSON.stringify({ status, moderated_at: new Date().toISOString() }),
      });
      if (!rows[0]) return reply.code(404).send({ ok: false, error: 'Sharh topilmadi' });
      return { ok: true, review: rows[0] };
    } catch (e) {
      console.error('Admin review update failed:', e);
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : 'Review update failed' });
    }
  });

  app.get('/api/admin/courses', async (request, reply) => {
    try {
      await requireAdminSession(request);
      return { ok: true, courses: await supabaseRest<any[]>('courses', { query: '?select=*&order=created_at.desc' }) };
    } catch (e) {
      console.error('Admin courses failed:', e);
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : 'Failed to load courses' });
    }
  });

  app.post('/api/admin/courses', async (request, reply) => {
    try {
      await requireAdminSession(request);
      const body = (request.body || {}) as Record<string, unknown>;
      const name = String(body.name || '').trim();
      const duration = Number(body.duration_minutes || 60);
      const price = Number(body.price || 0);
      if (!name) return reply.code(400).send({ ok: false, error: 'Mashg‘ulot nomi majburiy' });
      if (!Number.isFinite(duration) || duration < 15) return reply.code(400).send({ ok: false, error: 'Davomiylik noto‘g‘ri' });
      const rows = await supabaseRest<any[]>('courses', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ name, description: String(body.description || '').trim() || null, duration_minutes: duration, price, is_active: true }),
      });
      return reply.code(201).send({ ok: true, course: rows[0] });
    } catch (e) {
      console.error('Admin course creation failed:', e);
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : 'Course creation failed' });
    }
  });

  app.patch<{ Params: { id: string }; Body: { is_active?: boolean } }>('/api/admin/courses/:id', async (request, reply) => {
    try {
      await requireAdminSession(request);
      const rows = await supabaseRest<any[]>('courses', {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        query: `?id=eq.${q(request.params.id)}`, body: JSON.stringify({ is_active: Boolean(request.body?.is_active) }),
      });
      if (!rows[0]) return reply.code(404).send({ ok: false, error: 'Mashg‘ulot topilmadi' });
      return { ok: true, course: rows[0] };
    } catch (e) {
      console.error('Admin course update failed:', e);
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : 'Course update failed' });
    }
  });

  app.get('/api/admin/payments', async (request, reply) => {
    try {
      await requireAdminSession(request);
      const payments = await supabaseRest<any[]>('payments', { query: '?select=*,customer:customer_id(id,full_name,phone,telegram_id)&order=created_at.desc' });
      return { ok: true, payments };
    } catch (e) {
      console.error('Admin payments failed:', e);
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : 'Failed to load payments' });
    }
  });

  app.patch<{ Params: { id: string }; Body: { status: string } }>('/api/admin/payments/:id', async (request, reply) => {
    try {
      await requireAdminSession(request);
      const status = String(request.body?.status || '');
      if (!['paid', 'pending', 'failed', 'refunded'].includes(status)) return reply.code(400).send({ ok: false, error: 'Noto‘g‘ri to‘lov holati' });
      const rows = await supabaseRest<any[]>('payments', {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        query: `?id=eq.${q(request.params.id)}`,
        body: JSON.stringify({ status, paid_at: status === 'paid' ? new Date().toISOString() : null }),
      });
      if (!rows[0]) return reply.code(404).send({ ok: false, error: 'To‘lov topilmadi' });
      return { ok: true, payment: rows[0] };
    } catch (e) {
      console.error('Admin payment update failed:', e);
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : 'Payment update failed' });
    }
  });

  app.get('/api/admin/pricing', async (request, reply) => {
    try {
      await requireAdminSession(request);
      const keys = await Promise.all(['lesson_price', 'lesson_duration', 'booking_enabled'].map(setting));
      return { ok: true, settings: Object.fromEntries(keys.filter(Boolean).map((x: any) => [x.key, x.value])) };
    } catch (e) {
      console.error('Admin pricing failed:', e);
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : 'Failed to load pricing' });
    }
  });

  app.put('/api/admin/pricing', async (request, reply) => {
    try {
      await requireAdminSession(request);
      const body = (request.body || {}) as Record<string, unknown>;
      const amount = Math.max(0, Number(body.amount || 0));
      const minutes = Math.max(15, Number(body.minutes || 60));
      const enabled = body.booking_enabled !== false;
      await Promise.all([
        saveSetting('lesson_price', { amount, currency: 'UZS' }),
        saveSetting('lesson_duration', { minutes }),
        saveSetting('booking_enabled', { enabled }),
      ]);
      return { ok: true };
    } catch (e) {
      console.error('Admin pricing update failed:', e);
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : 'Pricing update failed' });
    }
  });

  app.get('/api/admin/settings', async (request, reply) => {
    try {
      await requireAdminSession(request);
      return { ok: true, settings: await supabaseRest<any[]>('admin_settings', { query: '?select=key,value,updated_at&order=key.asc' }) };
    } catch (e) {
      console.error('Admin settings failed:', e);
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : 'Failed to load settings' });
    }
  });

  app.get('/api/admin/audit-logs', async (request, reply) => {
    try {
      await requireAdminSession(request);
      return { ok: true, logs: await supabaseRest<any[]>('admin_audit_logs', { query: '?select=*&order=created_at.desc&limit=200' }) };
    } catch (e) {
      console.error('Admin audit logs failed:', e);
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : 'Failed to load audit logs' });
    }
  });
}