import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import type { TelegramWebAppUser } from './telegram.js';

function q(value: string) { return encodeURIComponent(value); }

async function profileForTelegram(user: TelegramWebAppUser) {
  const rows = await supabaseRest<any[]>('profiles', { query: `?telegram_id=eq.${q(String(user.id))}&select=*` });
  if (rows[0]) return rows[0];
  const created = await supabaseRest<any[]>('profiles', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ telegram_id: user.id, first_name: user.first_name, last_name: user.last_name, username: user.username })
  });
  return created[0];
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  authenticate: (request: any) => Promise<TelegramWebAppUser>
) {
  async function requireAdmin(request: any) {
    const profile = await profileForTelegram(await authenticate(request));
    if (profile.role !== 'admin' || profile.status !== 'active') throw new Error('Forbidden');
    return profile;
  }

  app.get('/api/admin/dashboard', async (request, reply) => {
    try {
      await requireAdmin(request);
      const [users, instructors, bookings, cars] = await Promise.all([
        supabaseRest<any[]>('profiles', { query: '?select=id&role=eq.customer&status=eq.active' }),
        supabaseRest<any[]>('instructors', { query: '?select=id&approval_status=eq.approved&active=eq.true' }),
        supabaseRest<any[]>('bookings', { query: '?select=id,status,start_at&order=start_at.desc&limit=100' }),
        supabaseRest<any[]>('cars', { query: '?select=id,status&active=eq.true' })
      ]);
      return {
        ok: true,
        stats: {
          users: users.length,
          instructors: instructors.length,
          bookings: bookings.length,
          todayBookings: bookings.filter((b) => String(b.start_at).slice(0, 10) === new Date().toISOString().slice(0, 10)).length,
          availableCars: cars.filter((c) => c.status === 'available').length,
          cars: cars.length
        }
      };
    } catch (e) { return reply.code(403).send({ ok: false, error: e instanceof Error ? e.message : 'Forbidden' }); }
  });

  app.get('/api/admin/users', async (request, reply) => {
    try {
      await requireAdmin(request);
      const users = await supabaseRest<any[]>('profiles', { query: '?role=eq.customer&select=*&order=created_at.desc&limit=500' });
      return { ok: true, users };
    } catch (e) { return reply.code(403).send({ ok: false, error: e instanceof Error ? e.message : 'Forbidden' }); }
  });

  app.get('/api/admin/instructors', async (request, reply) => {
    try {
      await requireAdmin(request);
      const instructors = await supabaseRest<any[]>('instructors', { query: '?select=*,profile:profile_id(id,first_name,last_name,username,phone,status)&order=created_at.desc&limit=500' });
      return { ok: true, instructors };
    } catch (e) { return reply.code(403).send({ ok: false, error: e instanceof Error ? e.message : 'Forbidden' }); }
  });

  app.patch('/api/admin/instructors/:id/approval', async (request, reply) => {
    try {
      const admin = await requireAdmin(request);
      const id = (request.params as any).id as string;
      const body = request.body as { status?: 'approved' | 'rejected' | 'blocked' | 'pending' };
      if (!body.status) return reply.code(400).send({ ok: false, error: 'status is required' });
      const rows = await supabaseRest<any[]>('instructors', {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, query: `?id=eq.${q(id)}`,
        body: JSON.stringify({ approval_status: body.status, active: body.status === 'approved', updated_at: new Date().toISOString() })
      });
      if (!rows[0]) return reply.code(404).send({ ok: false, error: 'Instructor not found' });
      await supabaseRest('profiles', { method: 'PATCH', query: `?id=eq.${q(rows[0].profile_id)}`, body: JSON.stringify({ status: body.status === 'approved' ? 'active' : body.status === 'blocked' ? 'blocked' : 'pending', updated_at: new Date().toISOString() }) });
      await supabaseRest('notifications', { method: 'POST', body: JSON.stringify({ profile_id: rows[0].profile_id, title: 'Instruktor arizasi', body: `Ariza holati: ${body.status}`, channel: 'in_app', type: 'approval' }) });
      await supabaseRest('audit_logs', { method: 'POST', body: JSON.stringify({ actor_profile_id: admin.id, action: `instructor_${body.status}`, entity_type: 'instructor', entity_id: id }) });
      return { ok: true, instructor: rows[0] };
    } catch (e) { return reply.code(403).send({ ok: false, error: e instanceof Error ? e.message : 'Forbidden' }); }
  });

  app.get('/api/admin/cars', async (request, reply) => {
    try {
      await requireAdmin(request);
      const cars = await supabaseRest<any[]>('cars', { query: '?select=*,instructor:instructor_id(id,profile_id)&order=created_at.desc&limit=500' });
      return { ok: true, cars };
    } catch (e) { return reply.code(403).send({ ok: false, error: e instanceof Error ? e.message : 'Forbidden' }); }
  });

  app.get('/api/admin/bookings', async (request, reply) => {
    try {
      await requireAdmin(request);
      const bookings = await supabaseRest<any[]>('bookings', { query: '?select=*,customer:customer_id(id,first_name,last_name,username),instructor:instructor_id(id,profile_id),car:car_id(id,brand,model,plate_number)&order=start_at.desc&limit=500' });
      return { ok: true, bookings };
    } catch (e) { return reply.code(403).send({ ok: false, error: e instanceof Error ? e.message : 'Forbidden' }); }
  });

  app.patch('/api/admin/users/:id/status', async (request, reply) => {
    try {
      const admin = await requireAdmin(request);
      const id = (request.params as any).id as string;
      const body = request.body as { status?: 'active' | 'blocked' | 'pending' };
      if (!body.status) return reply.code(400).send({ ok: false, error: 'status is required' });
      const rows = await supabaseRest<any[]>('profiles', { method: 'PATCH', headers: { Prefer: 'return=representation' }, query: `?id=eq.${q(id)}&role=eq.customer`, body: JSON.stringify({ status: body.status, updated_at: new Date().toISOString() }) });
      if (!rows[0]) return reply.code(404).send({ ok: false, error: 'User not found' });
      await supabaseRest('audit_logs', { method: 'POST', body: JSON.stringify({ actor_profile_id: admin.id, action: `user_${body.status}`, entity_type: 'profile', entity_id: id }) });
      return { ok: true, user: rows[0] };
    } catch (e) { return reply.code(403).send({ ok: false, error: e instanceof Error ? e.message : 'Forbidden' }); }
  });
}
