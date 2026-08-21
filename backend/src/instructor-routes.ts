import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import type { TelegramWebAppUser } from './telegram.js';

function q(value: string) { return encodeURIComponent(value); }

async function profileForTelegram(user: TelegramWebAppUser) {
  const rows = await supabaseRest<any[]>('profiles', { query: `?telegram_id=eq.${q(String(user.id))}&select=*` });
  if (rows[0]) return rows[0];
  const created = await supabaseRest<any[]>('profiles', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ telegram_id: user.id, first_name: user.first_name, last_name: user.last_name, username: user.username, role: 'customer' }) });
  return created[0];
}

async function approvedInstructor(profile: any) {
  if (!profile || profile.role !== 'instructor') return null;
  const rows = await supabaseRest<any[]>('instructors', { query: `?profile_id=eq.${q(profile.id)}&approved=eq.true&active=eq.true&select=*` });
  return rows[0] || null;
}

export async function registerInstructorRoutes(app: FastifyInstance, authenticate: (request: any) => Promise<TelegramWebAppUser>) {
  app.get('/api/instructor/me', async (request, reply) => {
    try {
      const profile = await profileForTelegram(await authenticate(request));
      const instructor = await approvedInstructor(profile);
      if (!instructor) return reply.code(403).send({ ok: false, error: 'Instructor hali Admin tomonidan tasdiqlanmagan', status: 'PENDING' });
      return { ok: true, profile, instructor };
    } catch (e) { return reply.code(401).send({ ok: false, error: e instanceof Error ? e.message : 'Unauthorized' }); }
  });

  app.get('/api/instructor/bookings', async (request, reply) => {
    try {
      const profile = await profileForTelegram(await authenticate(request));
      const instructor = await approvedInstructor(profile);
      if (!instructor) return reply.code(403).send({ ok: false, error: 'Instructor hali Admin tomonidan tasdiqlanmagan', status: 'PENDING' });
      const query = request.query as { from?: string; to?: string };
      const parts = [`select=*,customer:customer_id(id,first_name,last_name,username,phone),car:car_id(id,plate_number,model,active)`, `instructor_id=eq.${q(instructor.id)}`, 'order=start_at.asc'];
      if (query.from) parts.push(`start_at=gte.${q(query.from)}`);
      if (query.to) parts.push(`start_at=lt.${q(query.to)}`);
      return { ok: true, bookings: await supabaseRest<any[]>('bookings', { query: `?${parts.join('&')}` }) };
    } catch (e) { return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Failed to load instructor bookings' }); }
  });

  app.post('/api/instructor/bookings/:id/arrived', async (request, reply) => {
    try {
      const profile = await profileForTelegram(await authenticate(request));
      const instructor = await approvedInstructor(profile);
      if (!instructor) return reply.code(403).send({ ok: false, error: 'Instructor tasdiqlanmagan' });
      const id = String((request.params as any).id);
      const rows = await supabaseRest<any[]>('rpc/instructor_mark_arrived', { method: 'POST', body: JSON.stringify({ p_booking_id: id, p_instructor_id: instructor.id }) });
      return { ok: true, booking: rows };
    } catch (e) { return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'KELDI amalini bajarib bo‘lmadi' }); }
  });

  app.post('/api/instructor/bookings/:id/departed', async (request, reply) => {
    try {
      const profile = await profileForTelegram(await authenticate(request));
      const instructor = await approvedInstructor(profile);
      if (!instructor) return reply.code(403).send({ ok: false, error: 'Instructor tasdiqlanmagan' });
      const id = String((request.params as any).id);
      const rows = await supabaseRest<any[]>('rpc/instructor_mark_departed', { method: 'POST', body: JSON.stringify({ p_booking_id: id, p_instructor_id: instructor.id }) });
      return { ok: true, booking: rows };
    } catch (e) { return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'KETDI amalini bajarib bo‘lmadi' }); }
  });
}
