import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import type { TelegramWebAppUser } from './telegram.js';

function q(value: string) { return encodeURIComponent(value); }

async function profileForTelegram(user: TelegramWebAppUser) {
  const rows = await supabaseRest<any[]>('profiles', {
    query: `?telegram_id=eq.${q(String(user.id))}&select=*`,
  });
  return rows[0] || null;
}

async function requireAdmin(request: any, authenticate: (request: any) => Promise<TelegramWebAppUser>) {
  const user = await authenticate(request);
  const profile = await profileForTelegram(user);
  const configuredAdminId = String(process.env.ADMIN_TELEGRAM_ID || '').trim();
  if (!profile) throw new Error('Admin profili topilmadi');
  if (profile.role !== 'admin' && String(user.id) !== configuredAdminId) throw new Error('Admin ruxsati mavjud emas');
  return { user, profile };
}

export async function registerAdminRoutes(app: FastifyInstance, authenticate: (request: any) => Promise<TelegramWebAppUser>) {
  app.get('/api/admin/me', async (request, reply) => {
    try { const { user, profile } = await requireAdmin(request, authenticate); return { ok: true, user, profile }; }
    catch (e) { return reply.code(403).send({ ok: false, error: e instanceof Error ? e.message : 'Admin access denied' }); }
  });

  app.get('/api/admin/stats', async (request, reply) => {
    try {
      await requireAdmin(request, authenticate);
      const [profiles, instructors, bookings, cars] = await Promise.all([
        supabaseRest<any[]>('profiles', { query: '?select=id,role' }),
        supabaseRest<any[]>('instructors', { query: '?select=id,active' }),
        supabaseRest<any[]>('bookings', { query: '?select=id,status,start_at' }),
        supabaseRest<any[]>('cars', { query: '?select=id,active' }),
      ]);
      const today = new Date();
      const start = new Date(today); start.setHours(0, 0, 0, 0);
      const end = new Date(today); end.setHours(24, 0, 0, 0);
      return { ok: true, stats: {
        customers: profiles.filter(p => p.role === 'customer').length,
        instructors: instructors.filter(i => i.active).length,
        pendingBookings: bookings.filter(b => b.status === 'pending').length,
        todayBookings: bookings.filter(b => new Date(b.start_at) >= start && new Date(b.start_at) < end).length,
        completedBookings: bookings.filter(b => b.status === 'completed').length,
        activeCars: cars.filter(c => c.active).length,
      }};
    } catch (e) { return reply.code(403).send({ ok: false, error: e instanceof Error ? e.message : 'Stats failed' }); }
  });

  app.get('/api/admin/instructors', async (request, reply) => {
    try {
      await requireAdmin(request, authenticate);
      const rows = await supabaseRest<any[]>('instructors', { query: '?select=id,active,created_at,profile:profile_id(id,telegram_id,first_name,last_name,username,phone,role)&order=created_at.desc' });
      return { ok: true, instructors: rows };
    } catch (e) { return reply.code(403).send({ ok: false, error: e instanceof Error ? e.message : 'Failed to load instructors' }); }
  });

  app.patch<{ Params: { id: string }; Body: { active?: boolean } }>('/api/admin/instructors/:id', async (request, reply) => {
    try {
      await requireAdmin(request, authenticate);
      const rows = await supabaseRest<any[]>('instructors', { method: 'PATCH', headers: { Prefer: 'return=representation' }, query: `?id=eq.${q(request.params.id)}`, body: JSON.stringify({ active: Boolean(request.body?.active) }) });
      if (!rows[0]) return reply.code(404).send({ ok: false, error: 'Instructor topilmadi' });
      return { ok: true, instructor: rows[0] };
    } catch (e) { return reply.code(403).send({ ok: false, error: e instanceof Error ? e.message : 'Instructor update failed' }); }
  });

  app.get('/api/admin/bookings', async (request, reply) => {
    try {
      await requireAdmin(request, authenticate);
      const query = request.query as { status?: string };
      const parts = ['select=*,customer:customer_id(id,first_name,last_name,username,phone),instructor:instructor_id(id,profile:profile_id(first_name,last_name,username)),car:car_id(id,plate_number,model)', 'order=start_at.desc'];
      if (query.status) parts.push(`status=eq.${q(query.status)}`);
      return { ok: true, bookings: await supabaseRest<any[]>('bookings', { query: `?${parts.join('&')}` }) };
    } catch (e) { return reply.code(403).send({ ok: false, error: e instanceof Error ? e.message : 'Failed to load bookings' }); }
  });

  app.get('/api/admin/customers', async (request, reply) => {
    try {
      await requireAdmin(request, authenticate);
      return { ok: true, customers: await supabaseRest<any[]>('profiles', { query: '?role=eq.customer&select=id,telegram_id,first_name,last_name,username,phone,created_at&order=created_at.desc' }) };
    } catch (e) { return reply.code(403).send({ ok: false, error: e instanceof Error ? e.message : 'Failed to load customers' }); }
  });

  app.get('/api/admin/cars', async (request, reply) => {
    try { await requireAdmin(request, authenticate); return { ok: true, cars: await supabaseRest<any[]>('cars', { query: '?select=*&order=created_at.desc' }) }; }
    catch (e) { return reply.code(403).send({ ok: false, error: e instanceof Error ? e.message : 'Failed to load cars' }); }
  });

  app.post('/api/admin/cars', async (request, reply) => {
    try {
      await requireAdmin(request, authenticate);
      const body = (request.body || {}) as { plate_number?: string; model?: string };
      const plate = String(body.plate_number || '').trim().toUpperCase();
      const model = String(body.model || '').trim();
      if (!plate || !model) return reply.code(400).send({ ok: false, error: 'Raqam va rusum majburiy' });
      const rows = await supabaseRest<any[]>('cars', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ plate_number: plate, model, active: true }) });
      return reply.code(201).send({ ok: true, car: rows[0] });
    } catch (e) { return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Car creation failed' }); }
  });
}
