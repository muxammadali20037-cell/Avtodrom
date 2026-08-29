import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import { sendBookingNotification } from './telegram.js';
import type { TelegramWebAppUser } from './telegram.js';
import { q, toProfile, findUserByTelegram, instructorProfileForUser, notifyUser } from './identity.js';

/** `profiles` view o'rniga kanonik `users` jadvali. */
async function profileForTelegram(user: TelegramWebAppUser) {
  return await findUserByTelegram(user.id);
}

/** `instructors` view o'rniga kanonik `instructor_profiles`. */
async function approvedInstructor(user: any) {
  if (!user) return null;
  if (String(user.role || '').toLowerCase() !== 'instructor') return null;
  if (user.is_active === false || user.is_blocked === true) return null;
  return await instructorProfileForUser(String(user.id), true);
}

async function getOwnedBooking(id: string, instructorId: string) {
  const rows = await supabaseRest<any[]>('bookings', {
    query: `?id=eq.${q(id)}&instructor_id=eq.${q(instructorId)}&select=*`,
  });
  return rows[0] || null;
}

async function getCustomer(customerId: string) {
  const rows = await supabaseRest<any[]>('users', {
    query: `?id=eq.${q(customerId)}&select=id,full_name,phone,telegram_id&limit=1`,
  });
  return rows[0] || null;
}

type NotifyStatus = 'confirmed' | 'rejected' | 'in_progress' | 'completed' | 'no_show';

const NOTIFY_TEXT: Record<NotifyStatus, { title: string; body: (id: string) => string }> = {
  confirmed:   { title: 'Bron tasdiqlandi',      body: (id) => `Bron #${id}: instruktor bronni qabul qildi.` },
  rejected:    { title: 'Bron rad etildi',       body: (id) => `Bron #${id}: instruktor bronni rad etdi. Boshqa vaqt tanlashingiz mumkin.` },
  in_progress: { title: 'Instruktor: mijoz KELDI', body: (id) => `Bron #${id}: instruktor sizni kutib oldi. Dars boshlandi.` },
  completed:   { title: 'Dars yakunlandi',       body: (id) => `Bron #${id}: dars yakunlandi. Instruktorni baholashingiz mumkin.` },
  no_show:     { title: 'Mijoz kelmadi',         body: (id) => `Bron #${id}: instruktor sizni kelmagan deb belgiladi.` },
};

async function notifyBookingStatus(booking: any, status: NotifyStatus) {
  try {
    const customerId = booking?.customer_id;
    if (!customerId) return;
    const t = NOTIFY_TEXT[status];
    const title = t.title;
    const body = t.body(String(booking.id));

    await notifyUser(String(customerId), 'booking', title, body);

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
      return { ok: true, profile: toProfile(profile), instructor };
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
        'select=*,customer:customer_id(id,full_name,phone,telegram_id),course:course_id(id,name,duration_minutes,price)',
        `instructor_id=eq.${q(String(instructor.id))}`,
        'order=booking_date.asc',
      ];
      if (query.from) parts.push(`booking_date=gte.${q(query.from)}`);
      if (query.to) parts.push(`booking_date=lt.${q(query.to)}`);
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

  /**
   * Bron holatini o'zgartirish — instruktor uchun.
   * Ruxsat etilgan o'tishlar qat'iy cheklangan; boshqasi 409 beradi.
   * arrived/departed alohida RPC orqali ketadi (atomik), bu esa
   * qabul qilish / rad etish / kelmadi uchun.
   */
  const INSTRUCTOR_TRANSITIONS: Record<string, string[]> = {
    pending:   ['confirmed', 'rejected'],
    confirmed: ['no_show'],
  };

  async function changeStatus(request: any, reply: any, target: NotifyStatus) {
    try {
      const tgUser = await authenticate(request);
      const profile = await profileForTelegram(tgUser);
      const instructor = await approvedInstructor(profile);
      if (!profile || !instructor) return reply.code(403).send({ ok: false, error: 'Instructor tasdiqlanmagan' });

      const id = String(request.params.id);
      const booking = await getOwnedBooking(id, String(instructor.id));
      if (!booking) return reply.code(404).send({ ok: false, error: 'Bron topilmadi yoki bu instruktorga biriktirilmagan' });

      const from = String(booking.status);
      if (!(INSTRUCTOR_TRANSITIONS[from] || []).includes(target)) {
        return reply.code(409).send({ ok: false, error: `"${from}" holatidagi bronni bu amalga o'tkazib bo'lmaydi` });
      }

      const now = new Date().toISOString();
      const patch: any = { status: target, updated_at: now };
      if (target === 'confirmed') { patch.confirmed_at = now; patch.confirmed_by = profile.id; }
      if (target === 'rejected') {
        patch.cancelled_at = now;
        patch.cancelled_by = profile.id;
        patch.cancellation_reason = String(request.body?.reason || '').trim() || null;
      }

      const rows = await supabaseRest<any[]>('bookings', {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        query: `?id=eq.${q(id)}`,
        body: JSON.stringify(patch),
      });
      const updated = rows[0] || { ...booking, ...patch };
      await notifyBookingStatus(updated, target);
      return { ok: true, booking: updated };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Amal bajarilmadi' });
    }
  }

  app.post('/api/instructor/bookings/:id/accept', (req, reply) => changeStatus(req, reply, 'confirmed'));
  app.post('/api/instructor/bookings/:id/reject', (req, reply) => changeStatus(req, reply, 'rejected'));
  app.post('/api/instructor/bookings/:id/no-show', (req, reply) => changeStatus(req, reply, 'no_show'));

  /** Instruktorning o'z sharhlari — faqat admin tasdiqlaganlari ko'rinadi. */
  app.get('/api/instructor/reviews', async (request, reply) => {
    try {
      const tgUser = await authenticate(request);
      const profile = await profileForTelegram(tgUser);
      const instructor = await approvedInstructor(profile);
      if (!profile || !instructor) return reply.code(403).send({ ok: false, error: 'Instructor tasdiqlanmagan' });

      const rows = await supabaseRest<any[]>('reviews', {
        query: `?instructor_id=eq.${q(String(instructor.id))}&status=eq.approved` +
               '&select=id,rating,comment,created_at,customer:customer_id(id,full_name)' +
               '&order=created_at.desc',
      });
      return { ok: true, reviews: rows };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Sharhlar yuklanmadi' });
    }
  });

  /** Dashboard ko'rsatkichlari — bugungi, kutilayotgan, tugagan, reyting. */
  app.get('/api/instructor/stats', async (request, reply) => {
    try {
      const tgUser = await authenticate(request);
      const profile = await profileForTelegram(tgUser);
      const instructor = await approvedInstructor(profile);
      if (!profile || !instructor) return reply.code(403).send({ ok: false, error: 'Instructor tasdiqlanmagan' });

      const rows = await supabaseRest<any[]>('bookings', {
        query: `?instructor_id=eq.${q(String(instructor.id))}&select=id,status,booking_date,start_at`,
      });

      // Bugun — Asia/Tashkent bo'yicha
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
      const dayOf = (v: any) => v ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date(v)) : '';
      const todays = rows.filter((b) => dayOf(b.start_at || b.booking_date) === today);

      return {
        ok: true,
        stats: {
          today: todays.length,
          todayCompleted: todays.filter((b) => b.status === 'completed').length,
          pending: rows.filter((b) => b.status === 'pending').length,
          confirmed: rows.filter((b) => b.status === 'confirmed').length,
          inProgress: rows.filter((b) => b.status === 'in_progress').length,
          completed: rows.filter((b) => b.status === 'completed').length,
          noShow: rows.filter((b) => b.status === 'no_show').length,
          total: rows.length,
          rating: Number(instructor.rating || 0),
          totalReviews: Number(instructor.total_reviews || 0),
          isAvailable: instructor.is_available !== false,
        },
      };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Statistika yuklanmadi' });
    }
  });

  /**
   * Bandlik holati — instruktor o'zini vaqtincha "mavjud emas" qila oladi.
   * DIQQAT: is_verified ga TEGILMAYDI — uni faqat admin boshqaradi.
   */
  app.patch('/api/instructor/availability', async (request, reply) => {
    try {
      const tgUser = await authenticate(request);
      const profile = await profileForTelegram(tgUser);
      const instructor = await approvedInstructor(profile);
      if (!profile || !instructor) return reply.code(403).send({ ok: false, error: 'Instructor tasdiqlanmagan' });

      const available = (request.body as any)?.is_available;
      if (typeof available !== 'boolean') {
        return reply.code(400).send({ ok: false, error: 'is_available true yoki false bo\u2018lishi kerak' });
      }

      const rows = await supabaseRest<any[]>('instructor_profiles', {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        query: `?id=eq.${q(String(instructor.id))}`,
        body: JSON.stringify({ is_available: available, updated_at: new Date().toISOString() }),
      });
      return { ok: true, instructor: rows[0] || { ...instructor, is_available: available } };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Holat saqlanmadi' });
    }
  });
}
