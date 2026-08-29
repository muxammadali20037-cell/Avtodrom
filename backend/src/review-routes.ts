import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import type { TelegramWebAppUser } from './telegram.js';
import { q, findUserByTelegram } from './identity.js';

/**
 * Review qoidalari (talab 11-bo'lim):
 *  - faqat COMPLETED booking uchun
 *  - bir booking uchun bitta review (DB: reviews.booking_id UNIQUE)
 *  - instructor o'z reytingini o'zgartira olmaydi — bu yerda faqat customer yozadi
 *  - yangi review har doim 'pending' holatda boshlanadi; admin approve/reject qiladi
 *  - instructor_profiles.rating faqat admin approve qilganda qayta hisoblanadi
 *    (backend/src/admin-password-routes.ts: reviewAction)
 */
export async function registerReviewRoutes(
  app: FastifyInstance,
  authenticate: (request: any) => Promise<TelegramWebAppUser>,
) {
  app.get('/api/reviews/mine', async (request, reply) => {
    try {
      const tg = await authenticate(request);
      const user = await findUserByTelegram(tg.id);
      if (!user) return { ok: true, reviews: [] };
      const rows = await supabaseRest<any[]>('reviews', {
        query: `?customer_id=eq.${q(String(user.id))}&select=*&order=created_at.desc`,
      });
      return { ok: true, reviews: rows };
    } catch (e) {
      return reply.code(401).send({ ok: false, error: e instanceof Error ? e.message : 'Unauthorized' });
    }
  });

  app.post('/api/reviews', async (request, reply) => {
    try {
      const tg = await authenticate(request);
      const user = await findUserByTelegram(tg.id);
      if (!user) return reply.code(401).send({ ok: false, error: 'Unauthorized' });

      const body = (request.body ?? {}) as { booking_id?: string; rating?: number; comment?: string };
      const rating = Number(body.rating);
      if (!body.booking_id) return reply.code(400).send({ ok: false, error: 'booking_id majburiy' });
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return reply.code(400).send({ ok: false, error: 'Baho 1 dan 5 gacha bo‘lishi kerak' });
      }

      const bookings = await supabaseRest<any[]>('bookings', {
        query: `?id=eq.${q(body.booking_id)}&customer_id=eq.${q(String(user.id))}&select=id,status,instructor_id&limit=1`,
      });
      const booking = bookings[0];
      if (!booking) return reply.code(404).send({ ok: false, error: 'Bron topilmadi' });
      if (booking.status !== 'completed') {
        return reply.code(409).send({ ok: false, error: 'Faqat tugagan mashg‘ulot uchun sharh qoldirish mumkin' });
      }
      if (!booking.instructor_id) {
        return reply.code(409).send({ ok: false, error: 'Bu bronda instruktor biriktirilmagan' });
      }

      const existing = await supabaseRest<any[]>('reviews', {
        query: `?booking_id=eq.${q(body.booking_id)}&select=id&limit=1`,
      });
      if (existing[0]) return reply.code(409).send({ ok: false, error: 'Bu mashg‘ulot uchun sharh allaqachon yuborilgan' });

      const rows = await supabaseRest<any[]>('reviews', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          booking_id: booking.id,
          customer_id: user.id,
          instructor_id: booking.instructor_id,
          rating,
          comment: body.comment?.trim() || null,
          status: 'pending',
        }),
      });
      return reply.code(201).send({ ok: true, review: rows[0] });
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Sharh yuborilmadi' });
    }
  });
}
