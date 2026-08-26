/**
 * AVTODROM — mijoz (customer) endpointlari.
 * Kanonik jadvallar: users, instructor_profiles, bookings, notifications.
 * `profiles` / `instructors` view'lariga MUROJAAT QILINMAYDI (ular read-only).
 */
import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import { sendBookingNotification } from './telegram.js';
import type { TelegramWebAppUser } from './telegram.js';
import {
  q, joinName, splitName, toProfile, toInstructorCard,
  userForTelegram, instructorProfileForUser, notifyUser,
} from './identity.js';

const ACTIVE_STATUSES = 'pending,confirmed,in_progress';

const BOOKING_SELECT =
  'select=*,' +
  'customer:customer_id(id,full_name,phone,telegram_id),' +
  'instructor:instructor_id(id,user_id,rating,total_reviews,user:user_id(id,full_name,phone,telegram_id))';

function shapeBooking(row: any) {
  if (!row) return row;
  const insUser = row.instructor?.user ?? null;
  const { first_name, last_name } = splitName(insUser?.full_name);
  return {
    ...row,
    // Frontend start_at/end_at ko'rsatadi; admin yaratgan bronlarda bo'sh
    // bo'lishi mumkin — shunda booking_date ga tushamiz.
    start_at: row.start_at ?? row.booking_date ?? null,
    end_at: row.end_at ?? null,
    instructor: row.instructor
      ? { ...row.instructor, profile: { first_name, last_name, phone: insUser?.phone ?? null } }
      : null,
  };
}

async function telegramOf(userId?: string | null) {
  if (!userId) return null;
  const rows = await supabaseRest<any[]>('users', {
    query: `?id=eq.${q(String(userId))}&select=telegram_id,full_name&limit=1`,
  });
  return rows[0] ?? null;
}

async function notifyBookingParties(booking: any, title: string, message: string) {
  try {
    await notifyUser(booking?.customer_id, 'booking', title, message);
    const customer = await telegramOf(booking?.customer_id);
    const cToken = String(process.env.CUSTOMER_BOT_TOKEN || process.env.TELEGRAM_CUSTOMER_BOT_TOKEN || '');
    const cUrl = String(process.env.CUSTOMER_MINI_APP_URL || process.env.MINI_APP_URL || '');
    if (cToken && Number.isSafeInteger(Number(customer?.telegram_id))) {
      await sendBookingNotification(cToken, Number(customer.telegram_id),
        `🚗 AVTODROM\n\n${title}\n${message}`, cUrl, '🚗 Panelni ochish');
    }

    if (booking?.instructor_id) {
      const ip = await supabaseRest<any[]>('instructor_profiles', {
        query: `?id=eq.${q(String(booking.instructor_id))}&select=user_id&limit=1`,
      });
      const instructorUserId = ip[0]?.user_id;
      await notifyUser(instructorUserId, 'booking', title, message);
      const instructor = await telegramOf(instructorUserId);
      const iToken = String(process.env.INSTRUCTOR_BOT_TOKEN || process.env.TELEGRAM_INSTRUCTOR_BOT_TOKEN || '');
      const iUrl = String(process.env.INSTRUCTOR_MINI_APP_URL || '');
      if (iToken && Number.isSafeInteger(Number(instructor?.telegram_id))) {
        await sendBookingNotification(iToken, Number(instructor.telegram_id),
          `👨‍🏫 AVTODROM\n\n${title}\n${message}`, iUrl, '👨‍🏫 Instruktor panelini ochish');
      }
    }
  } catch (e) {
    console.error('Booking notification failed:', e);
  }
}

export async function registerBookingRoutes(
  app: FastifyInstance,
  authenticate: (request: any) => Promise<TelegramWebAppUser>,
  /** Bron holatini o'zgartirish uchun: instruktor/admin boshqa botdan keladi. */
  authenticateAny: (request: any) => Promise<TelegramWebAppUser> = authenticate,
) {
  app.get('/api/me', async (request, reply) => {
    try {
      const tg = await authenticate(request);
      const user = await userForTelegram(tg);
      return { ok: true, profile: toProfile(user, { username: (tg as any).username ?? null }) };
    } catch (e) {
      return reply.code(401).send({ ok: false, error: e instanceof Error ? e.message : 'Unauthorized' });
    }
  });

  app.patch('/api/me', async (request, reply) => {
    try {
      const tg = await authenticate(request);
      const user = await userForTelegram(tg);
      const body = (request.body ?? {}) as { first_name?: string; last_name?: string; phone?: string };
      const current = splitName(user.full_name);

      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (body.first_name !== undefined || body.last_name !== undefined) {
        const full = joinName(
          body.first_name ?? current.first_name,
          body.last_name ?? current.last_name,
        );
        if (!full) return reply.code(400).send({ ok: false, error: 'Ism majburiy' });
        patch.full_name = full;
      }
      if (body.phone !== undefined) patch.phone = String(body.phone).trim() || null;

      const rows = await supabaseRest<any[]>('users', {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        query: `?id=eq.${q(String(user.id))}`,
        body: JSON.stringify(patch),
      });
      return { ok: true, profile: toProfile(rows[0] ?? user, { username: (tg as any).username ?? null }) };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Profil saqlanmadi' });
    }
  });

  /** Faqat admin tasdiqlagan (is_verified) va faol (is_available) instruktorlar. */
  app.get('/api/instructors', async (request, reply) => {
    try {
      await authenticate(request);
      const rows = await supabaseRest<any[]>('instructor_profiles', {
        query:
          '?is_verified=eq.true&is_available=eq.true' +
          '&select=id,user_id,bio,experience_years,rating,total_reviews,is_verified,is_available,' +
          'user:user_id(id,full_name,phone,telegram_id,is_active,is_blocked)' +
          '&order=created_at.desc',
      });
      const instructors = rows.map(toInstructorCard).filter((x) => x.active);
      return { ok: true, instructors };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Instruktorlar yuklanmadi' });
    }
  });

  app.get('/api/bookings', async (request, reply) => {
    try {
      const tg = await authenticate(request);
      const user = await userForTelegram(tg);
      const query = request.query as { from?: string; to?: string; status?: string };

      const parts = [BOOKING_SELECT, 'order=booking_date.asc'];
      if (query.from) parts.push(`booking_date=gte.${q(query.from)}`);
      if (query.to) parts.push(`booking_date=lt.${q(query.to)}`);
      if (query.status) parts.push(`status=eq.${q(query.status)}`);

      if (user.role === 'instructor') {
        const ip = await instructorProfileForUser(String(user.id), false);
        if (!ip) return { ok: true, bookings: [] };
        parts.push(`instructor_id=eq.${q(String(ip.id))}`);
      } else if (user.role !== 'admin') {
        parts.push(`customer_id=eq.${q(String(user.id))}`);
      }

      const rows = await supabaseRest<any[]>('bookings', { query: `?${parts.join('&')}` });
      return { ok: true, bookings: rows.map(shapeBooking) };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Bronlar yuklanmadi' });
    }
  });

  app.post('/api/bookings', async (request, reply) => {
    try {
      const tg = await authenticate(request);
      const user = await userForTelegram(tg);
      if (user.is_blocked) return reply.code(403).send({ ok: false, error: 'Hisobingiz bloklangan' });

      const body = (request.body ?? {}) as {
        instructor_id?: string; start_at?: string; end_at?: string; customer_note?: string;
      };
      if (!body.start_at || !body.end_at) {
        return reply.code(400).send({ ok: false, error: 'start_at va end_at majburiy' });
      }
      const start = new Date(body.start_at);
      const end = new Date(body.end_at);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || !(start < end)) {
        return reply.code(400).send({ ok: false, error: 'Vaqt oralig‘i noto‘g‘ri' });
      }
      if (start.getTime() < Date.now()) {
        return reply.code(400).send({ ok: false, error: 'O‘tgan vaqtga bron qilib bo‘lmaydi' });
      }
      if (!body.instructor_id) {
        return reply.code(400).send({ ok: false, error: 'Instruktorni tanlang' });
      }

      const ip = await supabaseRest<any[]>('instructor_profiles', {
        query: `?id=eq.${q(body.instructor_id)}&is_verified=eq.true&is_available=eq.true&select=id&limit=1`,
      });
      if (!ip[0]) {
        return reply.code(400).send({ ok: false, error: 'Instruktor tasdiqlanmagan yoki faol emas' });
      }

      const conflicts = await supabaseRest<any[]>('bookings', {
        query:
          `?start_at=lt.${q(end.toISOString())}&end_at=gt.${q(start.toISOString())}` +
          `&status=in.(${ACTIVE_STATUSES})&select=id,customer_id,instructor_id`,
      });
      if (conflicts.some((x) => String(x.customer_id) === String(user.id))) {
        return reply.code(409).send({ ok: false, error: 'Sizda shu vaqtda boshqa bron bor' });
      }
      if (conflicts.some((x) => String(x.instructor_id) === String(body.instructor_id))) {
        return reply.code(409).send({ ok: false, error: 'Instruktor bu vaqtda band' });
      }

      const rows = await supabaseRest<any[]>('bookings', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          customer_id: user.id,
          instructor_id: body.instructor_id,
          booking_date: start.toISOString(),   // NOT NULL, default yo'q — majburiy
          start_at: start.toISOString(),
          end_at: end.toISOString(),
          customer_note: body.customer_note?.trim() || null,
          status: 'pending',
        }),
      });

      const booking = rows[0];
      if (booking) {
        await notifyBookingParties(booking, 'Yangi bron yaratildi', 'Admin tasdiqlashini kuting.');
      }
      return reply.code(201).send({ ok: true, booking: shapeBooking(booking) });
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Bron yaratilmadi' });
    }
  });

  app.patch('/api/bookings/:id/status', async (request, reply) => {
    try {
      const tg = await authenticateAny(request);
      const user = await userForTelegram(tg);
      if (!['admin', 'instructor'].includes(String(user.role))) {
        return reply.code(403).send({ ok: false, error: 'Ruxsat yo‘q' });
      }

      const id = String((request.params as any).id);
      const body = (request.body ?? {}) as { status?: string; reason?: string };
      const allowed = ['confirmed', 'rejected', 'cancelled', 'in_progress', 'completed', 'no_show'];
      if (!allowed.includes(String(body.status))) {
        return reply.code(400).send({ ok: false, error: 'Holat noto‘g‘ri' });
      }

      const current = await supabaseRest<any[]>('bookings', { query: `?id=eq.${q(id)}&select=*` });
      if (!current[0]) return reply.code(404).send({ ok: false, error: 'Bron topilmadi' });

      if (user.role === 'instructor') {
        const ip = await instructorProfileForUser(String(user.id), false);
        if (!ip || String(current[0].instructor_id) !== String(ip.id)) {
          return reply.code(403).send({ ok: false, error: 'Bu bron sizga biriktirilmagan' });
        }
      }

      const now = new Date().toISOString();
      const patch: Record<string, unknown> = { status: body.status, updated_at: now };
      if (body.status === 'confirmed') { patch.confirmed_at = now; patch.confirmed_by = user.id; }
      if (['cancelled', 'rejected'].includes(String(body.status))) {
        patch.cancelled_at = now;
        patch.cancelled_by = user.id;
        patch.cancellation_reason = body.reason?.trim() || null;   // `cancelled_reason` EMAS
      }

      const rows = await supabaseRest<any[]>('bookings', {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        query: `?id=eq.${q(id)}`,
        body: JSON.stringify(patch),
      });
      const booking = rows[0] ?? current[0];
      await notifyBookingParties(booking, 'Bron holati o‘zgardi', `Yangi holat: ${body.status}`);
      return { ok: true, booking: shapeBooking(booking) };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Holat yangilanmadi' });
    }
  });

  app.get('/api/notifications', async (request, reply) => {
    try {
      const tg = await authenticate(request);
      const user = await userForTelegram(tg);
      const rows = await supabaseRest<any[]>('notifications', {
        query: `?user_id=eq.${q(String(user.id))}&select=*&order=created_at.desc&limit=100`,
      });
      // Frontend `body` yoki `message` ni o'qiydi — ikkalasini ham beramiz.
      return { ok: true, notifications: rows.map((r) => ({ ...r, body: r.message })) };
    } catch (e) {
      return reply.code(401).send({ ok: false, error: e instanceof Error ? e.message : 'Unauthorized' });
    }
  });
}
