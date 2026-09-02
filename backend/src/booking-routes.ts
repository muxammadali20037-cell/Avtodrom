/**
 * AVTODROM — mijoz (customer) endpointlari.
 * Kanonik jadvallar: users, instructor_profiles, bookings, notifications.
 * `profiles` / `instructors` view'lariga MUROJAAT QILINMAYDI (ular read-only).
 */
import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import { loadBookingDetails, bookingMessage, inAppMessage, fmtWhen, type BookingEvent } from './notify.js';
import { sendBookingNotification } from './telegram.js';
import type { TelegramWebAppUser } from './telegram.js';
import {
  q, joinName, splitName, toProfile, toInstructorCard,
  userForTelegram, instructorProfileForUser, notifyUser,
} from './identity.js';

const ACTIVE_STATUSES = 'pending,confirmed,in_progress';

/**
 * Postgres constraint xatolarini foydalanuvchi tushunadigan xabarga aylantiradi.
 * Phase 4 migratsiyasi qo'shgan EXCLUDE constraint'lar xom holda
 * "conflicting key value violates exclusion constraint ..." deb chiqadi.
 */
export function humanizeDbError(e: unknown, fallback: string): string {
  const m = e instanceof Error ? e.message : String(e ?? '');
  if (/bookings_no_instructor_overlap/.test(m)) return 'Bu vaqt allaqachon band. Boshqa vaqtni tanlang.';
  if (/bookings_no_customer_overlap/.test(m))   return 'Sizda shu vaqtda boshqa bron bor.';
  if (/bookings_time_valid/.test(m))            return 'Vaqt oralig‘i noto‘g‘ri.';
  if (/BOOKING_NOT_COMPLETED/.test(m))          return 'Faqat tugagan mashg‘ulot uchun sharh qoldirish mumkin.';
  if (/BOOKING_NOT_FOUND/.test(m))              return 'Bron topilmadi.';
  if (/REVIEW_CUSTOMER_MISMATCH/.test(m))       return 'Bu bron sizga tegishli emas.';
  if (/reviews_booking_id_key/.test(m))         return 'Bu mashg‘ulot uchun sharh allaqachon yuborilgan.';
  if (/users_phone_key/.test(m))                return 'Bu telefon raqami boshqa foydalanuvchida ro‘yxatdan o‘tgan.';
  return m || fallback;
}

const BOOKING_SELECT =
  'select=*,' +
  'customer:customer_id(id,full_name,phone,telegram_id),' +
  'instructor:instructor_id(id,user_id,rating,total_reviews,user:user_id(id,full_name,phone,telegram_id)),' +
  'course:course_id(id,name,duration_minutes,price)';

/** Ruxsat etilgan status o'tishlari. Bu yerda bo'lmagan o'tish har doim rad etiladi. */
const STATUS_TRANSITIONS: Record<string, string[]> = {
  pending: ['confirmed', 'rejected', 'cancelled'],
  confirmed: ['in_progress', 'cancelled', 'no_show'],
  in_progress: ['completed'],
  completed: [],
  cancelled: [],
  rejected: [],
  no_show: [],
};

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
    /* Soat soni bilan hisoblangan qiymatlar — frontend qayta hisoblamasin.
       Kurs bir birlik (odatda 60 daqiqa), hours esa nechta birlik olingani. */
    hours: Number(row.hours ?? 1),
    /* Davomiylik daqiqada. Narx nisbatan: 60 daq kurs 250 000 bo'lsa,
       30 daqiqa 125 000 bo'ladi. */
    duration_minutes: Number(row.duration_minutes ?? 0)
      || Number(row.course?.duration_minutes ?? 0) * Number(row.hours ?? 1) || null,
    total_minutes: Number(row.duration_minutes ?? 0)
      || Number(row.course?.duration_minutes ?? 0) * Number(row.hours ?? 1) || null,
    total_price: (() => {
      const unit = Number(row.course?.duration_minutes ?? 60) || 60;
      const mins = Number(row.duration_minutes ?? 0) || unit * Number(row.hours ?? 1);
      return Math.round((Number(row.course?.price ?? 0) * mins) / unit) || 0;
    })(),
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

async function notifyBookingParties(booking: any, event: BookingEvent) {
  try {
    const d = await loadBookingDetails(booking);

    // --- Mijoz ---
    const cMsg = bookingMessage(booking, event, 'customer', d);
    await notifyUser(booking?.customer_id, 'booking', cMsg.title, inAppMessage(event, d, booking));
    const customer = await telegramOf(booking?.customer_id);
    const cToken = String(process.env.CUSTOMER_BOT_TOKEN || process.env.TELEGRAM_CUSTOMER_BOT_TOKEN || '');
    const cUrl = String(process.env.CUSTOMER_MINI_APP_URL || process.env.MINI_APP_URL || '');
    if (cToken && Number.isSafeInteger(Number(customer?.telegram_id))) {
      await sendBookingNotification(cToken, Number(customer.telegram_id), cMsg.full, cUrl, '🚗 Mini Appni ochish');
    }

    // --- Instruktor ---
    if (booking?.instructor_id) {
      const ip = await supabaseRest<any[]>('instructor_profiles', {
        query: `?id=eq.${q(String(booking.instructor_id))}&select=user_id&limit=1`,
      });
      const instructorUserId = ip[0]?.user_id;
      const iMsg = bookingMessage(booking, event, 'instructor', d);
      await notifyUser(instructorUserId, 'booking', iMsg.title, inAppMessage(event, d, booking));
      const instructor = await telegramOf(instructorUserId);
      const iToken = String(process.env.INSTRUCTOR_BOT_TOKEN || process.env.TELEGRAM_INSTRUCTOR_BOT_TOKEN || '');
      const iUrl = String(process.env.INSTRUCTOR_MINI_APP_URL || '');
      if (iToken && Number.isSafeInteger(Number(instructor?.telegram_id))) {
        await sendBookingNotification(iToken, Number(instructor.telegram_id), iMsg.full, iUrl, '👨‍🏫 Instruktor paneli');
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

  /**
   * Instruktorning bir kunlik band vaqtlari — customer_id/ism/telefon FOSH QILINMAYDI,
   * faqat vaqt oralig'i. Eski kod bo'sh vaqtni /api/bookings orqali hisoblardi,
   * u esa faqat SO'ROVCHINING o'z bronlarini qaytaradi — boshqa mijozlarning
   * bandligi umuman ko'rinmasdi.
   */
  app.get('/api/instructors/:id/availability', async (request, reply) => {
    try {
      await authenticate(request);
      const instructorId = String((request.params as any).id);
      const date = String((request.query as any)?.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return reply.code(400).send({ ok: false, error: 'date=YYYY-MM-DD formatida bo‘lishi kerak' });
      }
      const dayStart = new Date(`${date}T00:00:00+05:00`);
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
      const rows = await supabaseRest<any[]>('bookings', {
        query:
          `?instructor_id=eq.${q(instructorId)}` +
          `&start_at=lt.${q(dayEnd.toISOString())}&end_at=gt.${q(dayStart.toISOString())}` +
          `&status=in.(${ACTIVE_STATUSES})&select=start_at,end_at`,
      });
      return { ok: true, busy: rows };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Band vaqtlar yuklanmadi' });
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
      const completedIds = rows.filter((b) => b.status === 'completed').map((b) => String(b.id));
      const reviewed = new Set<string>();
      if (completedIds.length) {
        const reviews = await supabaseRest<any[]>('reviews', {
          query: `?booking_id=in.(${completedIds.map(q).join(',')})&select=booking_id`,
        });
        reviews.forEach((r) => reviewed.add(String(r.booking_id)));
      }
      return { ok: true, bookings: rows.map((b) => ({ ...shapeBooking(b), reviewed: reviewed.has(String(b.id)) })) };
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
        instructor_id?: string; course_id?: string; hours?: number;
        start_at?: string; end_at?: string; customer_note?: string;
      };
      // Necha birlik (soat) olinayotgani. Kurs — bir birlik, narx soatlik.
      const hours = Math.trunc(Number(body.hours ?? 1));
      if (!Number.isInteger(hours) || hours < 1 || hours > 8) {
        return reply.code(400).send({ ok: false, error: 'Soat soni 1 dan 8 gacha bo‘lishi kerak' });
      }
      if (!body.instructor_id) return reply.code(400).send({ ok: false, error: 'Instruktorni tanlang' });
      if (!body.course_id) return reply.code(400).send({ ok: false, error: 'Mashg‘ulot turini tanlang' });
      if (!body.start_at) return reply.code(400).send({ ok: false, error: 'start_at majburiy' });

      const start = new Date(body.start_at);
      if (Number.isNaN(start.getTime())) {
        return reply.code(400).send({ ok: false, error: 'Sana/vaqt noto‘g‘ri' });
      }
      if (start.getTime() < Date.now()) {
        return reply.code(400).send({ ok: false, error: 'O‘tgan vaqtga bron qilib bo‘lmaydi' });
      }

      const courses = await supabaseRest<any[]>('courses', {
        query: `?id=eq.${q(body.course_id)}&is_active=eq.true&select=id,duration_minutes,price&limit=1`,
      });
      const course = courses[0];
      if (!course) return reply.code(400).send({ ok: false, error: 'Mashg‘ulot topilmadi yoki faol emas' });

      /* end_at har doim SERVERDA hisoblanadi: kurs davomiyligi × soat soni.
         Frontend yuborgan end_at e'tiborga olinmaydi — aks holda mijoz
         2 soatlik narxga 4 soat band qilib qo'yishi mumkin edi. */
      const totalMinutes = Number(course.duration_minutes || 60) * hours;
      const end = new Date(start.getTime() + totalMinutes * 60000);
      if (Number.isNaN(end.getTime()) || !(start < end)) {
        return reply.code(400).send({ ok: false, error: 'Vaqt oralig‘i noto‘g‘ri' });
      }

      const ip = await supabaseRest<any[]>('instructor_profiles', {
        query: `?id=eq.${q(body.instructor_id)}&is_verified=eq.true&is_available=eq.true&select=id&limit=1`,
      });
      if (!ip[0]) {
        return reply.code(400).send({ ok: false, error: 'Instruktor tasdiqlanmagan yoki faol emas' });
      }

      // Race condition'ga to'liq chidamli emas (DB-level EXCLUDE constraint hali qo'yilmagan —
      // Phase 3 migration), lekin oddiy holatlarning aksariyatini shu yerda tutamiz.
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
          course_id: course.id,
          booking_date: start.toISOString(),   // NOT NULL, default yo'q — majburiy
          start_at: start.toISOString(),
          end_at: end.toISOString(),
          hours,
          duration_minutes: totalMinutes,
          customer_note: body.customer_note?.trim() || null,
          status: 'pending',
        }),
      });

      const booking = rows[0];
      if (booking) {
        await notifyBookingParties(booking, 'created');
      }
      return reply.code(201).send({ ok: true, booking: shapeBooking(booking) });
    } catch (e) {
      const msg = humanizeDbError(e, 'Bron yaratilmadi');
      const code = /band|boshqa bron/.test(msg) ? 409 : 400;
      return reply.code(code).send({ ok: false, error: msg });
    }
  });

  /** Mijoz o'z bronini bekor qiladi — faqat hali boshlanmagan (pending/confirmed) bronlar. */
  /**
   * Mijoz bronni bekor qilmoqchi.
   *
   *  pending   -> darhol bekor qilinadi (admin hali tasdiqlamagan, yo'qotadigan narsa yo'q)
   *  confirmed -> BEKOR QILINMAYDI, admin uchun SO'ROV yaratiladi.
   *               Bron `confirmed` holatida qoladi, admin ko'rib chiqadi.
   *               Sabab majburiy (kamida 3 belgi) — DB constraint ham buni talab qiladi.
   */
  app.patch('/api/bookings/:id/cancel', async (request, reply) => {
    try {
      const tg = await authenticate(request);
      const user = await userForTelegram(tg);
      const id = String((request.params as any).id);
      const reason = String((request.body as any)?.reason ?? '').trim();

      const current = await supabaseRest<any[]>('bookings', {
        query: `?id=eq.${q(id)}&customer_id=eq.${q(String(user.id))}&select=*&limit=1`,
      });
      const booking = current[0];
      if (!booking) return reply.code(404).send({ ok: false, error: 'Bron topilmadi' });

      const status = String(booking.status);
      if (!['pending', 'confirmed'].includes(status)) {
        return reply.code(409).send({ ok: false, error: 'Bu bronni endi bekor qilib bo‘lmaydi' });
      }
      if (reason.length < 3) {
        return reply.code(400).send({ ok: false, error: 'Bekor qilish sababini yozing (kamida 3 belgi)' });
      }

      const now = new Date().toISOString();

      // --- pending: darhol bekor ---
      if (status === 'pending') {
        const rows = await supabaseRest<any[]>('bookings', {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          query: `?id=eq.${q(id)}`,
          body: JSON.stringify({
            status: 'cancelled', cancelled_at: now, cancelled_by: user.id,
            cancellation_reason: reason, updated_at: now,
          }),
        });
        const updated = rows[0] ?? booking;
        await notifyBookingParties(updated, 'cancelled');
        return { ok: true, mode: 'cancelled', booking: shapeBooking(updated) };
      }

      // --- confirmed: admin uchun so'rov ---
      if (booking.cancel_requested_at && !booking.cancel_reviewed_at) {
        return reply.code(409).send({ ok: false, error: 'So‘rovingiz allaqachon yuborilgan. Admin javobini kuting.' });
      }

      const rows = await supabaseRest<any[]>('bookings', {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        query: `?id=eq.${q(id)}`,
        body: JSON.stringify({
          cancel_requested_at: now,
          cancel_request_reason: reason,
          cancel_requested_by: user.id,
          cancel_reviewed_at: null,
          cancel_reviewed_by: null,
          updated_at: now,
        }),
      });
      const updated = rows[0] ?? booking;

      // Adminga xabar
      try {
        const d = await loadBookingDetails(updated);
        const when = fmtWhen(updated.start_at || updated.booking_date);
        const text =
          `🚫 Bekor qilish so‘rovi\n\n` +
          `👤 ${user.full_name || 'Mijoz'}\n` +
          (d.courseName ? `📚 ${d.courseName}\n` : '') +
          (when ? `📅 ${when}\n` : '') +
          `\n💬 Sabab: ${reason}\n\nAdmin panelda tasdiqlang yoki rad eting.`;
        const token = String(process.env.ADMIN_BOT_TOKEN || process.env.TELEGRAM_ADMIN_BOT_TOKEN || '');
        if (token) {
          const admins = await supabaseRest<any[]>('telegram_admins', { query: '?select=telegram_chat_id' });
          for (const a of admins) {
            const chatId = Number(a.telegram_chat_id);
            if (Number.isSafeInteger(chatId) && chatId > 0) {
              await sendBookingNotification(token, chatId, text, String(process.env.ADMIN_MINI_APP_URL || ''), '⚙️ Admin panel');
            }
          }
        }
      } catch (e) { console.error('Cancel-request admin notify failed:', e); }

      return {
        ok: true,
        mode: 'requested',
        message: 'So‘rov Adminga yuborildi. Javobni kuting.',
        booking: shapeBooking(updated),
      };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: humanizeDbError(e, 'Bekor qilish so‘rovi yuborilmadi') });
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

      const from = String(current[0].status);
      if (!(STATUS_TRANSITIONS[from] || []).includes(String(body.status))) {
        return reply.code(409).send({ ok: false, error: `"${from}" holatidan "${body.status}" ga o‘tib bo‘lmaydi` });
      }

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
      await notifyBookingParties(booking, String(body.status) as BookingEvent);
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
