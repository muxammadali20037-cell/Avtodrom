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

async function approvedInstructor(profile: any) {
  if (!profile || String(profile.role).toLowerCase() !== 'instructor') return null;
  const rows = await supabaseRest<any[]>('instructors', {
    query: `?profile_id=eq.${q(String(profile.id))}&active=eq.true&approved=eq.true&select=*`,
  });
  return rows[0] || null;
}

async function getOwnedBooking(id: string, instructorId: string) {
  const rows = await supabaseRest<any[]>('bookings', {
    query: `?id=eq.${q(id)}&instructor_id=eq.${q(instructorId)}&select=*,customer:customer_id(id,first_name,last_name,username,phone,telegram_id),instructor:instructor_id(id,profile_id,active,approved,experience_years,rating,total_reviews,profile:profile_id(id,first_name,last_name,phone))`,
  });
  return rows[0] || null;
}

export async function registerInstructorRoutes(
  app: FastifyInstance,
  authenticate: (request: any) => Promise<TelegramWebAppUser>,
) {
  app.get('/api/instructor/me', async (request, reply) => {
    try {
      const user = await authenticate(request);
      const profile = await profileForTelegram(user);
      const instructor = await approvedInstructor(profile);
      if (!instructor) {
        return reply.code(403).send({
          ok: false,
          error: 'Instructor hali Admin tomonidan tasdiqlanmagan',
          status: 'PENDING',
        });
      }
      return { ok: true, profile, instructor };
    } catch (e) {
      return reply.code(401).send({ ok: false, error: e instanceof Error ? e.message : 'Unauthorized' });
    }
  });

  // Foydalanuvchi yaratgan va Admin tasdiqlagan bronlar shu yerda ko‘rinadi.
  // Bu endpoint customer/admin ishlatadigan aynan `bookings` jadvalidan o‘qiydi.
  app.get('/api/instructor/bookings', async (request, reply) => {
    try {
      const user = await authenticate(request);
      const profile = await profileForTelegram(user);
      const instructor = await approvedInstructor(profile);
      if (!instructor) {
        return reply.code(403).send({
          ok: false,
          error: 'Instructor hali Admin tomonidan tasdiqlanmagan',
          status: 'PENDING',
        });
      }

      const query = request.query as { from?: string; to?: string };
      const parts = [
        'select=*,customer:customer_id(id,first_name,last_name,username,phone,telegram_id),instructor:instructor_id(id,profile_id,active,approved,experience_years,rating,total_reviews,profile:profile_id(id,first_name,last_name,phone))',
        `instructor_id=eq.${q(String(instructor.id))}`,
        'order=start_at.asc',
      ];
      if (query.from) parts.push(`start_at=gte.${q(query.from)}`);
      if (query.to) parts.push(`start_at=lt.${q(query.to)}`);

      const bookings = await supabaseRest<any[]>('bookings', { query: `?${parts.join('&')}` });
      return { ok: true, bookings };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Failed to load instructor bookings' });
    }
  });

  // KELDI: confirmed -> in_progress
  app.post('/api/instructor/bookings/:id/arrived', async (request, reply) => {
    try {
      const user = await authenticate(request);
      const profile = await profileForTelegram(user);
      const instructor = await approvedInstructor(profile);
      if (!instructor) return reply.code(403).send({ ok: false, error: 'Instructor tasdiqlanmagan' });

      const id = String((request.params as any).id);
      const booking = await getOwnedBooking(id, String(instructor.id));
      if (!booking) return reply.code(404).send({ ok: false, error: 'Bron topilmadi yoki bu instruktorга biriktirilmagan' });
      if (booking.status !== 'confirmed') {
        return reply.code(409).send({ ok: false, error: `KELDI faqat tasdiqlangan bron uchun mumkin. Hozirgi holat: ${booking.status}` });
      }

      const rows = await supabaseRest<any[]>('bookings', {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        query: `?id=eq.${q(id)}&instructor_id=eq.${q(String(instructor.id))}`,
        body: JSON.stringify({ status: 'in_progress', updated_at: new Date().toISOString() }),
      });
      return { ok: true, booking: rows[0] || null };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'KELDI amalini bajarib bo‘lmadi' });
    }
  });

  // KETDI: in_progress -> completed
  app.post('/api/instructor/bookings/:id/departed', async (request, reply) => {
    try {
      const user = await authenticate(request);
      const profile = await profileForTelegram(user);
      const instructor = await approvedInstructor(profile);
      if (!instructor) return reply.code(403).send({ ok: false, error: 'Instructor tasdiqlanmagan' });

      const id = String((request.params as any).id);
      const booking = await getOwnedBooking(id, String(instructor.id));
      if (!booking) return reply.code(404).send({ ok: false, error: 'Bron topilmadi yoki bu instruktorга biriktirilmagan' });
      if (booking.status !== 'in_progress') {
        return reply.code(409).send({ ok: false, error: `KETDI faqat boshlangan bron uchun mumkin. Hozirgi holat: ${booking.status}` });
      }

      const rows = await supabaseRest<any[]>('bookings', {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        query: `?id=eq.${q(id)}&instructor_id=eq.${q(String(instructor.id))}`,
        body: JSON.stringify({ status: 'completed', updated_at: new Date().toISOString() }),
      });
      return { ok: true, booking: rows[0] || null };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'KETDI amalini bajarib bo‘lmadi' });
    }
  });
}
