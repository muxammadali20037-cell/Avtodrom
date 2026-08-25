import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import { sendBookingNotification } from './telegram.js';
import type { TelegramWebAppUser } from './telegram.js';

function q(value: string) { return encodeURIComponent(value); }

async function profileForTelegram(user: TelegramWebAppUser) {
  const rows = await supabaseRest<any[]>('profiles', {
    query: `?telegram_id=eq.${q(String(user.id))}&select=*&limit=1`,
  });
  return rows[0] || null;
}

async function approvedInstructor(profile: any) {
  if (!profile || String(profile.role || '').toLowerCase() !== 'instructor') return null;
  if (profile.active === false) return null;
  const rows = await supabaseRest<any[]>('instructors', {
    query: `?profile_id=eq.${q(String(profile.id))}&approved=eq.true&active=eq.true&select=*&limit=1`,
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
  const rows = await supabaseRest<any[]>('profiles', {
    query: `?id=eq.${q(customerId)}&select=id,first_name,last_name,username,phone,telegram_id&limit=1`,
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
      : `Bron #${booking.id}: dars yakunlandi. Instruktor va Avtodromni baholashingiz mumkin.`;

    await supabaseRest('notifications', {
      method: 'POST',
      body: JSON.stringify({ profile_id: customerId, booking_id: booking.id, title, body, channel: 'in_app' }),
    });

    const customer = await getCustomer(String(customerId));
    const chatId = Number(customer?.telegram_id);
    const token = String(process.env.CUSTOMER_BOT_TOKEN || process.env.TELEGRAM_CUSTOMER_BOT_TOKEN || '');
    const miniAppUrl = String(process.env.CUSTOMER_MINI_APP_URL || process.env.MINI_APP_URL || '');
    if (token && Number.isSafeInteger(chatId) && chatId > 0) {
      await sendBookingNotification(token, chatId, `🚗 AVTODROM INDEX\n\n${title}\n${body}`, miniAppUrl, '🚗 Foydalanuvchi panelini ochish');
    }
  } catch (e) {
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
      const profile = await profileForTelegram(tgUser);
      const instructor = await approvedInstructor(profile);
      if (!profile || !instructor) {
        return reply.code(403).send({ ok: false, error: 'Instructor hali Admin tomonidan tasdiqlanmagan', status: 'PENDING' });
      }
      return { ok: true, profile, instructor };
    } catch (e) {
      return reply.code(401).send({ ok: false, error: e instanceof Error ? e.message : 'Unauthorized' });
    }
  });

  app.get('/api/instructor/bookings', async (request, reply) => {
    try {
      const tgUser = await authenticate(request);
      const profile = await profileForTelegram(tgUser);
      const instructor = await approvedInstructor(profile);
      if (!profile || !instructor) return reply.code(403).send({ ok: false, error: 'Instructor hali Admin tomonidan tasdiqlanmagan', status: 'PENDING' });
      const query = request.query as { from?: string; to?: string };
      const parts = [
        'select=*,customer:customer_id(id,first_name,last_name,username,phone,telegram_id)',
        `instructor_id=eq.${q(String(instructor.id))}`,
        'order=start_at.asc',
      ];
      if (query.from) parts.push(`start_at=gte.${q(query.from)}`);
      if (query.to) parts.push(`start_at=lt.${q(query.to)}`);
      return { ok: true, bookings: await supabaseRest<any[]>('bookings', { query: `?${parts.join('&')}` }) };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Failed to load instructor bookings' });
    }
  });

  app.post('/api/instructor/bookings/:id/arrived', async (request, reply) => {
    try {
      const tgUser = await authenticate(request);
      const profile = await profileForTelegram(tgUser);
      const instructor = await approvedInstructor(profile);
      if (!profile || !instructor) return reply.code(403).send({ ok: false, error: 'Instructor tasdiqlanmagan' });
      const id = String((request.params as any).id);
      const booking = await getOwnedBooking(id, String(instructor.id));
      if (!booking) return reply.code(404).send({ ok: false, error: 'Bron topilmadi yoki bu instruktorga biriktirilmagan' });
      const rows = await supabaseRest<any[]>('rpc/instructor_mark_arrived', { method: 'POST', body: JSON.stringify({ p_booking_id: id, p_instructor_id: instructor.id }) });
      const updated = Array.isArray(rows) ? rows[0] : rows;
      await notifyBookingStatus(updated || booking, 'in_progress');
      return { ok: true, booking: updated || booking };
    } catch (e) {
      const message = e instanceof Error ? e.message : 'KELDI amalini bajarib bo‘lmadi';
      if (/BOOKING_NOT_FOUND/i.test(message)) return reply.code(404).send({ ok: false, error: 'Bron topilmadi yoki bu instruktorga biriktirilmagan' });
      if (/BOOKING_NOT_CONFIRMED/i.test(message)) return reply.code(409).send({ ok: false, error: 'KELDI faqat tasdiqlangan bron uchun mumkin.' });
      return reply.code(400).send({ ok: false, error: message });
    }
  });

  app.post('/api/instructor/bookings/:id/departed', async (request, reply) => {
    try {
      const tgUser = await authenticate(request);
      const profile = await profileForTelegram(tgUser);
      const instructor = await approvedInstructor(profile);
      if (!profile || !instructor) return reply.code(403).send({ ok: false, error: 'Instructor tasdiqlanmagan' });
      const id = String((request.params as any).id);
      const booking = await getOwnedBooking(id, String(instructor.id));
      if (!booking) return reply.code(404).send({ ok: false, error: 'Bron topilmadi yoki bu instruktorga biriktirilmagan' });
      const rows = await supabaseRest<any[]>('rpc/instructor_mark_departed', { method: 'POST', body: JSON.stringify({ p_booking_id: id, p_instructor_id: instructor.id }) });
      const updated = Array.isArray(rows) ? rows[0] : rows;
      await notifyBookingStatus(updated || booking, 'completed');
      return { ok: true, booking: updated || booking };
    } catch (e) {
      const message = e instanceof Error ? e.message : 'KETDI amalini bajarib bo‘lmadi';
      if (/BOOKING_NOT_FOUND/i.test(message)) return reply.code(404).send({ ok: false, error: 'Bron topilmadi yoki bu instruktorga biriktirilmagan' });
      if (/BOOKING_NOT_IN_PROGRESS/i.test(message)) return reply.code(409).send({ ok: false, error: 'KETDI faqat boshlangan bron uchun mumkin.' });
      return reply.code(400).send({ ok: false, error: message });
    }
  });
}
