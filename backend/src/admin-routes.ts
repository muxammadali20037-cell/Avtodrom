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
    if (!secret || !token) return false;

    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const first = decoded.indexOf(':');
    const second = decoded.indexOf(':', first + 1);
    if (first <= 0 || second <= first) return false;

    const login = decoded.slice(0, first);
    const timestamp = Number(decoded.slice(first + 1, second));
    const signature = decoded.slice(second + 1);
    const expectedLogin = String(process.env.ADMIN_LOGIN ?? '').trim();
    if (!login || login !== expectedLogin || !Number.isFinite(timestamp) || !signature) return false;

    const age = Date.now() - timestamp;
    if (age < 0 || age > SESSION_TTL * 1000) return false;

    const expected = createHmac('sha256', secret).update(`${login}:${timestamp}`).digest('hex');
    const a = Buffer.from(signature, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function requireAdminSession(request: any) {
  const token = getCookie(request);
  if (!validAdminSession(token)) throw new Error('Unauthorized');
}

async function profileForTelegram(user: TelegramWebAppUser) {
  const rows = await supabaseRest<any[]>('profiles', { query: `?telegram_id=eq.${q(String(user.id))}&select=*` });
  return rows[0] || null;
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

  app.get('/api/admin/stats', async (request, reply) => {
    try {
      await requireAdminSession(request);
      const [profiles, instructors, bookings, cars] = await Promise.all([
        supabaseRest<any[]>('profiles', { query: '?select=id,role' }),
        supabaseRest<any[]>('instructors', { query: '?select=id,active' }),
        supabaseRest<any[]>('bookings', { query: '?select=id,status,start_at' }),
        supabaseRest<any[]>('cars', { query: '?select=id,active' }),
      ]);
      const today = new Date();
      const start = new Date(today); start.setHours(0, 0, 0, 0);
      const end = new Date(today); end.setHours(24, 0, 0, 0);
      return {
        ok: true,
        stats: {
          customers: profiles.filter(p => p.role === 'customer').length,
          instructors: instructors.filter(i => i.active).length,
          pendingBookings: bookings.filter(b => b.status === 'pending').length,
          todayBookings: bookings.filter(b => new Date(b.start_at) >= start && new Date(b.start_at) < end).length,
          completedBookings: bookings.filter(b => b.status === 'completed').length,
          activeCars: cars.filter(c => c.active).length,
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
      return {
        ok: true,
        instructors: await supabaseRest<any[]>('instructors', {
          query: '?select=id,active,created_at,profile:profile_id(id,telegram_id,first_name,last_name,username,phone,role)&order=created_at.desc',
        }),
      };
    } catch (e) {
      console.error('Admin instructors failed:', e);
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : 'Failed to load instructors' });
    }
  });

  app.patch<{ Params: { id: string }; Body: { active?: boolean } }>('/api/admin/instructors/:id', async (request, reply) => {
    try {
      await requireAdminSession(request);
      const rows = await supabaseRest<any[]>('instructors', {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        query: `?id=eq.${q(request.params.id)}`,
        body: JSON.stringify({ active: Boolean(request.body?.active) }),
      });
      if (!rows[0]) return reply.code(404).send({ ok: false, error: 'Instructor topilmadi' });
      return { ok: true, instructor: rows[0] };
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
        'select=*,customer:customer_id(id,first_name,last_name,username,phone),instructor:instructor_id(id,profile:profile_id(first_name,last_name,username)),car:car_id(id,plate_number,model)',
        'order=start_at.desc',
      ];
      if (query.status) parts.push(`status=eq.${q(query.status)}`);
      return { ok: true, bookings: await supabaseRest<any[]>('bookings', { query: `?${parts.join('&')}` }) };
    } catch (e) {
      console.error('Admin bookings failed:', e);
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : 'Failed to load bookings' });
    }
  });

  app.get('/api/admin/customers', async (request, reply) => {
    try {
      await requireAdminSession(request);
      return {
        ok: true,
        customers: await supabaseRest<any[]>('profiles', {
          query: '?role=eq.customer&select=id,telegram_id,first_name,last_name,username,phone,created_at&order=created_at.desc',
        }),
      };
    } catch (e) {
      console.error('Admin customers failed:', e);
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : 'Failed to load customers' });
    }
  });

  app.get('/api/admin/cars', async (request, reply) => {
    try {
      await requireAdminSession(request);
      return { ok: true, cars: await supabaseRest<any[]>('cars', { query: '?select=*&order=created_at.desc' }) };
    } catch (e) {
      console.error('Admin cars failed:', e);
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : 'Failed to load cars' });
    }
  });

  app.post('/api/admin/cars', async (request, reply) => {
    try {
      await requireAdminSession(request);
      const body = (request.body || {}) as { plate_number?: string; model?: string };
      const plate = String(body.plate_number || '').trim().toUpperCase();
      const model = String(body.model || '').trim();
      if (!plate || !model) return reply.code(400).send({ ok: false, error: 'Raqam va rusum majburiy' });
      const rows = await supabaseRest<any[]>('cars', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ plate_number: plate, model, active: true }),
      });
      return reply.code(201).send({ ok: true, car: rows[0] });
    } catch (e) {
      console.error('Admin car creation failed:', e);
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : 'Car creation failed' });
    }
  });
}
