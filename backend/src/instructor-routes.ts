import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import { sendBookingNotification } from './telegram.js';
import type { TelegramWebAppUser } from './telegram.js';

function q(value: string) { return encodeURIComponent(value); }

/**
 * Production schema uses:
 *   users -> instructor_profiles -> bookings.instructor_id
 * There is no public `profiles` or `instructors` table.
 */
async function userForTelegram(user: TelegramWebAppUser) {
  const rows = await supabaseRest<any[]>('users', {
    query: `?telegram_id=eq.${q(String(user.id))}&select=id,telegram_id,phone,full_name,role,is_active,is_blocked&limit=1`,
  });
  return rows[0] || null;
}

async function approvedInstructor(user: any) {
  if (!user || String(user.role || '').toLowerCase() !== 'instructor') return null;
  if (user.is_active !== true || user.is_blocked === true) return null;

  const rows = await supabaseRest<any[]>('instructor_profiles', {
    query: `?user_id=eq.${q(String(user.id))}&is_verified=eq.true&is_available=eq.true&select=*`,
  });
  return rows[0] || null;
}

async function getOwnedBooking(id: string, instructorId: string) {
  const rows = await supabaseRest<any[]>('bookings', {
    query: `?id=eq.${q(id)}&instructor_id=eq.${q(instructorId)}&select=*`,
  });
  return rows[0] || null;
}

async function getCustomer(customerId: string) {
  const rows = await supabaseRest<any[]>('users', {
    query: `?id=eq.${q(customerId)}&select=id,first_name,last_name,full_name,username,phone,telegram_id`,
  });
  return rows[0] || null;
}

async function notifyBookingStatus(booking: any, status: 'in_progress' | 'completed') {
  try {
    const customerId = booking?.customer_id;
    if (!customerId) return;

    const title = status === 'in_progress' ? 'Instruktor: mijoz KELDI' : 'Dars yakunlandi';
    const body = status === 'in_progress'
      ? `Bron #${booking.id}: instruktor sizni kutib oldi. Dars boshlandi.`
      : `Bron #${booking.id}: dars yakunlandi. Instruktor bilan dars tugadi.`;

    // Production notifications schema uses user_id/type/title/message.
    await supabaseRest('notifications', {
      method: 'POST',
      body: JSON.stringify({
        user_id: customerId,
        type: status === 'in_progress' ? 'booking_started' : 'booking_completed',
        title,
        message: body,
        telegram_sent: false,
        is_read: false,
      }),
    });

    const customer = await getCustomer(String(customerId));
    const chatId = Number(customer?.telegram_id);
    const token = String(process.env.CUSTOMER_BOT_TOKEN || process.env.TELEGRAM_CUSTOMER_BOT_TOKEN || '');
    const miniAppUrl = String(process.env.CUSTOMER_MINI_APP_URL || process.env.MINI_APP_URL || '');

    if (token && Number.isSafeInteger(chatId) && chatId > 0) {
      await sendBookingNotification(
        token,
        chatId,
        `🚗 AVTODROM INDEX\n\n${title}\n${body}`,
        miniAppUrl,
        '🚗 Foydalanuvchi panelini ochish',
      );
    }
  } catch (e) {
    // Notification failure must never undo the booking status update.
    console.error('Instructor -> customer notification failed:', e);
  }
}

export async function registerInstructorRoutes(
  app: FastifyInstance,
  authenticate: (request: any) => Promise<TelegramWebAppUser>,
) {
  app.get('/api/instructor/me', async (request, reply) => {
    try {
      const tgUser = await authenticate(request);
      const user = await userForTelegram(tgUser);
      const instructor = await approvedInstructor(user);

      if (!user || !instructor) {
        return reply.code(403).send({
          ok: false,
          error: 'Instructor hali Admin tomonidan tasdiqlanmagan',
          status: 'PENDING',
        });
      }

      return { ok: true, profile: user, instructor };
    } catch (e) {
      return reply.code(401).send({ ok: false, error: e instanceof Error ? e.message : 'Unauthorized' });
    }
  });

  app.get('/api/instructor/bookings', async (request, reply) => {
    try {
      const tgUser = await authenticate(request);
      const user = await userForTelegram(tgUser);
      const instructor = await approvedInstructor(user);
      if (!user || !instructor) {
        return reply.code(403).send({ ok: false, error: 'Instructor hali Admin tomonidan tasdiqlanmagan', status: 'PENDING' });
      }

      const query = request.query as { from?: string; to?: string };
      const parts = [
        'select=*',
        `instructor_id=eq.${q(String(instructor.id))}`,
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
      const tgUser = await authenticate(request);
      const user = await userForTelegram(tgUser);
      const instructor = await approvedInstructor(user);
      if (!user || !instructor) return reply.code(403).send({ ok: false, error: 'Instructor tasdiqlanmagan' });

      const id = String((request.params as any).id);
      const booking = await getOwnedBooking(id, String(instructor.id));
      if (!booking) return reply.code(404).send({ ok: false, error: 'Bron topilmadi yoki bu instruktorga biriktirilmagan' });
      if (String(booking.status) !== 'confirmed') {
        return reply.code(409).send({ ok: false, error: `KELDI faqat tasdiqlangan bron uchun mumkin. Hozirgi holat: ${booking.status}` });
      }

      const rows = await supabaseRest<any[]>('bookings', {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        query: `?id=eq.${q(id)}&instructor_id=eq.${q(String(instructor.id))}`,
        body: JSON.stringify({ status: 'in_progress', updated_at: new Date().toISOString() }),
      });
      const updated = rows[0] || null;
      await notifyBookingStatus(updated || booking, 'in_progress');
      return { ok: true, booking: updated };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'KELDI amalini bajarib bo‘lmadi' });
    }
  });

  app.post('/api/instructor/bookings/:id/departed', async (request, reply) => {
    try {
      const tgUser = await authenticate(request);
      const user = await userForTelegram(tgUser);
      const instructor = await approvedInstructor(user);
      if (!user || !instructor) return reply.code(403).send({ ok: false, error: 'Instructor tasdiqlanmagan' });

      const id = String((request.params as any).id);
      const booking = await getOwnedBooking(id, String(instructor.id));
      if (!booking) return reply.code(404).send({ ok: false, error: 'Bron topilmadi yoki bu instruktorga biriktirilmagan' });
      if (String(booking.status) !== 'in_progress') {
        return reply.code(409).send({ ok: false, error: `KETDI faqat boshlangan bron uchun mumkin. Hozirgi holat: ${booking.status}` });
      }

      const rows = await supabaseRest<any[]>('bookings', {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        query: `?id=eq.${q(id)}&instructor_id=eq.${q(String(instructor.id))}`,
        body: JSON.stringify({ status: 'completed', updated_at: new Date().toISOString() }),
      });
      const updated = rows[0] || null;
      await notifyBookingStatus(updated || booking, 'completed');
      return { ok: true, booking: updated };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'KETDI amalini bajarib bo‘lmadi' });
    }
  });
}
