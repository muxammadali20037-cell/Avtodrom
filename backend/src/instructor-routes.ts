import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import type { TelegramWebAppUser } from './telegram.js';

function q(value: string) { return encodeURIComponent(value); }

async function profileForTelegram(user: TelegramWebAppUser) {
  const rows = await supabaseRest<any[]>('users', {
    query: `?telegram_id=eq.${q(String(user.id))}&select=*`,
  });
  return rows[0] || null;
}

async function approvedInstructor(profile: any) {
  if (!profile || String(profile.role).toLowerCase() !== 'instructor' || !profile.is_active || profile.is_blocked) return null;
  const rows = await supabaseRest<any[]>('instructor_profiles', {
    query: `?user_id=eq.${q(String(profile.id))}&is_verified=eq.true&is_available=eq.true&select=*`,
  });
  return rows[0] || null;
}

export async function registerInstructorRoutes(app: FastifyInstance, authenticate: (request: any) => Promise<TelegramWebAppUser>) {
  app.get('/api/instructor/me', async (request, reply) => {
    try {
      const user = await authenticate(request);
      const profile = await profileForTelegram(user);
      const instructor = await approvedInstructor(profile);
      if (!instructor) return reply.code(403).send({ ok: false, error: 'Instructor hali Admin tomonidan tasdiqlanmagan', status: 'PENDING' });
      return { ok: true, profile, instructor };
    } catch (e) {
      return reply.code(401).send({ ok: false, error: e instanceof Error ? e.message : 'Unauthorized' });
    }
  });

  app.get('/api/instructor/bookings', async (request, reply) => {
    try {
      const user = await authenticate(request);
      const profile = await profileForTelegram(user);
      const instructor = await approvedInstructor(profile);
      if (!instructor) return reply.code(403).send({ ok: false, error: 'Instructor hali Admin tomonidan tasdiqlanmagan', status: 'PENDING' });

      const query = request.query as { from?: string; to?: string };
      const parts = [
        'select=*,customer:customer_id(id,telegram_id,phone,full_name),instructor:instructor_id(id,user_id,experience_years,rating,total_reviews)',
        `instructor_id=eq.${q(String(instructor.user_id))}`,
        'order=booking_date.asc',
      ];
      if (query.from) parts.push(`booking_date=gte.${q(query.from)}`);
      if (query.to) parts.push(`booking_date=lt.${q(query.to)}`);
      const bookings = await supabaseRest<any[]>('bookings', { query: `?${parts.join('&')}` });
      return { ok: true, bookings };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Failed to load instructor bookings' });
    }
  });

  app.post('/api/instructor/bookings/:id/arrived', async (request, reply) => {
    try {
      const user = await authenticate(request);
      const profile = await profileForTelegram(user);
      const instructor = await approvedInstructor(profile);
      if (!instructor) return reply.code(403).send({ ok: false, error: 'Instructor tasdiqlanmagan' });
      const id = String((request.params as any).id);
      const rows = await supabaseRest<any[]>('rpc/instructor_mark_arrived', {
        method: 'POST',
        body: JSON.stringify({ p_booking_id: id, p_instructor_id: instructor.user_id }),
      });
      return { ok: true, booking: rows };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'KELDI amalini bajarib bo‘lmadi' });
    }
  });

  app.post('/api/instructor/bookings/:id/departed', async (request, reply) => {
    try {
      const user = await authenticate(request);
      const profile = await profileForTelegram(user);
      const instructor = await approvedInstructor(profile);
      if (!instructor) return reply.code(403).send({ ok: false, error: 'Instructor tasdiqlanmagan' });
      const id = String((request.params as any).id);
      const rows = await supabaseRest<any[]>('rpc/instructor_mark_departed', {
        method: 'POST',
        body: JSON.stringify({ p_booking_id: id, p_instructor_id: instructor.user_id }),
      });
      return { ok: true, booking: rows };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'KETDI amalini bajarib bo‘lmadi' });
    }
  });
}
