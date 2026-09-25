import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import { loadBookingDetails, bookingMessage, inAppMessage, type BookingEvent } from './notify.js';
import { periodRange } from './analytics-routes.js';
import { sendBookingNotification } from './telegram.js';
import type { TelegramWebAppUser } from './telegram.js';
import { q, toProfile, findUserByTelegram, instructorProfileForUser, notifyUser } from './identity.js';
import { completeSchoolReceipt, isSchoolReceiptCode } from './school-receipt.js';
import { isStoragePublicUrl } from './storage-url.js';
import { lessonMinutes, isSchoolLesson, tashkentDay, tashkentYmd } from './lesson-math.js';

/** Avtoshkola cheki bo'yicha ochilgan bron bo'lsa, kodini qaytaradi.
 *  FAQAT o'z ustunidan yoki (migratsiya hali yurmagan bo'lsa) izohdan —
 *  lekin izohdan olishda `source` ham 'avtodrom12' bo'lishi shart. Aks
 *  holda mijoz izohida tasodifan kod uchrasa, begona chek yopilardi. */
function schoolReceiptCodeOf(booking: any): string | null {
  const direct = String(booking?.school_receipt_code || '').trim().toUpperCase();
  if (isSchoolReceiptCode(direct)) return direct;
  if (String(booking?.source || '') !== 'avtodrom12') return null;
  const m = String(booking?.customer_note || '').toUpperCase().match(/AVS-\d{5}/);
  return m ? m[0] : null;
}

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

/** Sharhlar va reyting instruktorga ko'rsatilmaydi — faqat admin ko'radi. */
function noReviews<T extends Record<string, any> | null | undefined>(ins: T): T {
  if (!ins) return ins;
  const { rating, total_reviews, reviews_count, ...rest } = ins as any;
  return rest as T;
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

type NotifyStatus = BookingEvent;

/** Mijozga (va DB notifications'ga) chiroyli xabar yuboradi. */
async function notifyBookingStatus(booking: any, status: NotifyStatus) {
  try {
    const customerId = booking?.customer_id;
    if (!customerId) return;
    const d = await loadBookingDetails(booking);
    const msg = bookingMessage(booking, status, 'customer', d);

    await supabaseRest('notifications', {
      method: 'POST',
      body: JSON.stringify({
        user_id: customerId, type: 'booking',
        title: msg.title, message: inAppMessage(status, d, booking),
      }),
    }).catch((e) => console.error('notification insert failed', e));

    const u = (await supabaseRest<any[]>('users', {
      query: `?id=eq.${q(String(customerId))}&select=telegram_id&limit=1`,
    }))[0];
    const token = String(process.env.CUSTOMER_BOT_TOKEN || process.env.TELEGRAM_CUSTOMER_BOT_TOKEN || '');
    const miniAppUrl = String(process.env.CUSTOMER_MINI_APP_URL || process.env.MINI_APP_URL || '');
    if (token && Number.isSafeInteger(Number(u?.telegram_id))) {
      await sendBookingNotification(token, Number(u.telegram_id), msg.full, miniAppUrl, '🚗 Mini Appni ochish');
    }
  } catch (e) {
    console.error('Instructor booking notification failed:', e);
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
      return { ok: true, profile: toProfile(profile), instructor: noReviews(instructor) };
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
      const query = request.query as { from?: string; to?: string; date?: string; status?: string };
      const parts = [
        'select=*,customer:customer_id(id,full_name,phone,telegram_id),course:course_id(id,name,duration_minutes,price)',
        `instructor_id=eq.${q(String(instructor.id))}`,
        'order=booking_date.asc',
      ];

      // ?date=today | YYYY-MM-DD — Asia/Tashkent kuni bo'yicha
      if (query.date) {
        const day = query.date === 'today'
          ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date())
          : String(query.date);
        if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
          const start = new Date(`${day}T00:00:00+05:00`);
          const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
          parts.push(`booking_date=gte.${q(start.toISOString())}`);
          parts.push(`booking_date=lt.${q(end.toISOString())}`);
        }
      }
      if (query.status) parts.push(`status=eq.${q(query.status)}`);
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

      /* Bir vaqtda bitta dars. Bazada ham unique indeks bor —
         bu tekshiruv tushunarli xabar berish uchun. */
      const active = (await supabaseRest<any[]>('bookings', {
        query: `?instructor_id=eq.${q(String(instructor.id))}&status=eq.in_progress&select=id,customer_id&limit=1`,
      }))[0];
      if (active && String(active.id) !== String(id)) {
        const who = active.customer_id
          ? (await supabaseRest<any[]>('users', {
              query: `?id=eq.${q(String(active.customer_id))}&select=full_name&limit=1`,
            }).catch(() => []))[0]?.full_name
          : null;
        return reply.code(409).send({
          ok: false,
          error: `Avvalgi dars yakunlanmagan${who ? ` (${who})` : ''}. Avval uni yakunlang.`,
        });
      }

      const rows = await supabaseRest<any[]>('rpc/instructor_mark_arrived', { method: 'POST', body: JSON.stringify({ p_booking_id: id, p_instructor_id: instructor.id }) });
      const updated = Array.isArray(rows) ? rows[0] : rows;
      await notifyBookingStatus(updated || booking, 'in_progress');
      return { ok: true, booking: updated || booking };
    } catch (e) {
      const message = e instanceof Error ? e.message : 'KELDI amalini bajarib bo‘lmadi';
      if (/bookings_one_active_lesson/i.test(message)) {
        return reply.code(409).send({ ok: false, error: 'Avvalgi dars yakunlanmagan. Avval uni yakunlang.' });
      }
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

      /* Avtoshkola darsi bo'lsa avtodrom12 dagi sessiyani ham yopamiz.
         Xato bo'lsa dars baribir yakunlangan — faqat log yoziladi. */
      const schoolCode = schoolReceiptCodeOf(updated || booking);
      if (schoolCode) {
        const b = updated || booking;
        const startedAt = b?.arrived_at || b?.start_at;
        const seconds = startedAt ? Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000)) : undefined;
        /* Kutmaymiz: avtodrom12 sekin javob bersa instruktorning
           "Yakunlash" tugmasi osilib qolmasin. Dars baribir yakunlangan. */
        void completeSchoolReceipt(schoolCode, seconds);
      }

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
  /**
   * Instruktor bronni QABUL QILMAYDI va RAD ETMAYDI — buni faqat Admin qiladi.
   * Instruktor panelida kutilayotgan bron faqat KO'RINADI.
   * Instruktorga qolgan yagona holat: tasdiqlangan bronga mijoz kelmasa,
   * uni "kelmagan" deb belgilash (dars vaqti o'tib ketmasin).
   * Dars boshlash/yakunlash alohida RPC orqali (arrived / departed).
   */
  const INSTRUCTOR_TRANSITIONS: Record<string, string[]> = {
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

  // accept / reject ATAYLAB YO'Q — bronni faqat Admin tasdiqlaydi yoki rad etadi.
  // Eski panellar chaqirsa, sababi tushunarli bo'lsin:
  const adminOnly = async (_req: any, reply: any) => reply.code(403).send({
    ok: false,
    error: 'Bronni qabul qilish yoki rad etish faqat Admin huquqida. Siz uni panelda kuzatib turasiz.',
  });
  app.post('/api/instructor/bookings/:id/accept', adminOnly);
  app.post('/api/instructor/bookings/:id/reject', adminOnly);

  app.post('/api/instructor/bookings/:id/no-show', (req, reply) => changeStatus(req, reply, 'no_show'));

  /** Sharhlar instruktorlarga ko'rsatilmaydi — ularni faqat admin ko'radi. */
  app.get('/api/instructor/reviews', async (_request, reply) =>
    reply.code(403).send({ ok: false, error: 'Sharhlarni faqat admin ko‘radi' }));

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

  /* ==========================================================
     ALIAS ENDPOINTLAR
     Instruktor paneli tarixiy sabablarga ko'ra boshqa nomlarni
     chaqiradi (profile / statistics / dashboard / logout).
     Panelni qayta yozish o'rniga backend shu nomlarni ham qabul
     qiladi — mantiq takrorlanmaydi, mavjud handlerlarga uzatiladi.
     ========================================================== */

  /** /api/instructor/profile → /api/instructor/me bilan bir xil */
  app.get('/api/instructor/profile', async (request, reply) => {
    const res = await app.inject({
      method: 'GET', url: '/api/instructor/me',
      headers: request.headers as any,
    });
    reply.code(res.statusCode);
    return JSON.parse(res.body || '{}');
  });

  /** /api/instructor/statistics → /api/instructor/stats bilan bir xil */
  app.get('/api/instructor/statistics', async (request, reply) => {
    const res = await app.inject({
      method: 'GET', url: '/api/instructor/stats',
      headers: request.headers as any,
    });
    reply.code(res.statusCode);
    return JSON.parse(res.body || '{}');
  });

  /**
   * /api/instructor/dashboard — profil + statistika + bugungi bronlar
   * bitta so'rovda. Panel uch marta so'rov yubormasligi uchun.
   */
  app.get('/api/instructor/dashboard', async (request, reply) => {
    try {
      const tgUser = await authenticate(request);
      const profile = await profileForTelegram(tgUser);
      const instructor = await approvedInstructor(profile);
      if (!profile || !instructor) {
        return reply.code(403).send({ ok: false, error: 'Instructor hali Admin tomonidan tasdiqlanmagan', status: 'PENDING' });
      }

      const [statsRes, todayRes] = await Promise.all([
        app.inject({ method: 'GET', url: '/api/instructor/stats', headers: request.headers as any }),
        app.inject({ method: 'GET', url: '/api/instructor/bookings?date=today', headers: request.headers as any }),
      ]);
      const stats = JSON.parse(statsRes.body || '{}');
      const today = JSON.parse(todayRes.body || '{}');

      return {
        ok: true,
        profile: toProfile(profile),
        instructor: noReviews(instructor),
        stats: stats.stats ?? {},
        // Panel turli nomlarni kutishi mumkin — ikkalasini ham beramiz
        today: today.bookings ?? [],
        todayBookings: today.bookings ?? [],
        bookings: today.bookings ?? [],
      };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Dashboard yuklanmadi' });
    }
  });

  /**
   * HISOB-KITOB: «shu sanadan shu sanagacha».
   * ?from=YYYY-MM-DD&to=YYYY-MM-DD (Toshkent kuni, ikkalasi ham kiradi).
   * Nechta avtoshkola darsi, nechta pullik, necha soat haydagan.
   * Hisob admin «Instruktor nazorati» bilan AYNAN bir xil (lesson-math.ts),
   * pul summalari instruktorga ko'rsatilmaydi.
   */
  app.get('/api/instructor/summary', async (request, reply) => {
    try {
      const tgUser = await authenticate(request);
      const profile = await profileForTelegram(tgUser);
      const instructor = await approvedInstructor(profile);
      if (!profile || !instructor) return reply.code(403).send({ ok: false, error: 'Instructor tasdiqlanmagan' });

      const qy = (request.query ?? {}) as any;
      const isYmd = (v: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
      const today = tashkentYmd(new Date());
      let fromY = isYmd(qy.from) ? String(qy.from) : `${today.slice(0, 8)}01`;
      let toY = isYmd(qy.to) ? String(qy.to) : today;
      if (fromY > toY) [fromY, toY] = [toY, fromY];
      const from = tashkentDay(fromY), to = tashkentDay(toY, 1);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        return reply.code(400).send({ ok: false, error: 'Sana noto‘g‘ri' });
      }
      if (to.getTime() - from.getTime() > 367 * 86400e3) {
        return reply.code(400).send({ ok: false, error: 'Oraliq 1 yildan oshmasin' });
      }

      const bookings: any[] = [];
      for (let offset = 0; offset < 10000; offset += 1000) {
        const chunk = await supabaseRest<any[]>('bookings', {
          query:
            `?instructor_id=eq.${q(String(instructor.id))}` +
            `&start_at=gte.${q(from.toISOString())}&start_at=lt.${q(to.toISOString())}` +
            `&select=*&order=start_at.asc&limit=1000&offset=${offset}`,
        });
        bookings.push(...chunk);
        if (chunk.length < 1000) break;
      }

      const uids = [...new Set(bookings.map((b) => b.customer_id).filter(Boolean).map(String))];
      const cids = [...new Set(bookings.map((b) => b.course_id).filter(Boolean).map(String))];
      const [users, courses] = await Promise.all([
        uids.length ? supabaseRest<any[]>('users', { query: `?id=in.(${uids.map(q).join(',')})&select=id,full_name,phone` }) : [],
        cids.length ? supabaseRest<any[]>('courses', { query: `?id=in.(${cids.map(q).join(',')})&select=id,name,duration_minutes` }) : [],
      ]);
      const um = new Map(users.map((u) => [String(u.id), u]));
      const cm = new Map(courses.map((c) => [String(c.id), c]));

      const rows = bookings.map((b) => {
        const c = cm.get(String(b.course_id));
        const u = um.get(String(b.customer_id));
        return {
          id: b.id,
          start_at: b.start_at || b.booking_date,
          status: String(b.status || ''),
          school: isSchoolLesson(b),
          category: b.category || null,
          minutes: lessonMinutes(b, c),
          course: c?.name || null,
          customer_id: b.customer_id ? String(b.customer_id) : null,
          customer: u ? { full_name: u.full_name, phone: u.phone } : null,
        };
      });

      const attended = rows.filter((r) => r.status === 'in_progress' || r.status === 'completed');
      const uniq = (list: any[]) => new Set(list.map((r) => r.customer_id || `x${r.id}`)).size;
      const group = (list: any[]) => {
        const done = list.filter((r) => r.status === 'completed');
        return {
          lessons: list.length,
          completed: done.length,
          in_progress: list.length - done.length,
          minutes: done.reduce((a, r) => a + r.minutes, 0),
          students: uniq(list),
        };
      };
      const school = group(attended.filter((r) => r.school));
      const paid = group(attended.filter((r) => !r.school));

      // Kunma-kun: qaysi kuni nechta dars, necha daqiqa
      const byDay = new Map<string, { date: string; school: number; paid: number; minutes: number }>();
      for (const r of attended) {
        const day = tashkentYmd(r.start_at);
        if (!byDay.has(day)) byDay.set(day, { date: day, school: 0, paid: 0, minutes: 0 });
        const x = byDay.get(day)!;
        if (r.school) x.school++; else x.paid++;
        if (r.status === 'completed') x.minutes += r.minutes;
      }

      const MAX_ROWS = 600;
      return {
        ok: true,
        from: fromY, to: toY,
        summary: {
          lessons: attended.length,
          completed: school.completed + paid.completed,
          in_progress: school.in_progress + paid.in_progress,
          minutes: school.minutes + paid.minutes,
          students: uniq(attended),
          school, paid,
          no_show: rows.filter((r) => r.status === 'no_show').length,
          cancelled: rows.filter((r) => r.status === 'cancelled' || r.status === 'rejected').length,
          upcoming: rows.filter((r) => r.status === 'pending' || r.status === 'confirmed').length,
        },
        days: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
        rows: rows.slice(-MAX_ROWS),
        rows_truncated: rows.length > MAX_ROWS,
      };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Hisob-kitob yuklanmadi' });
    }
  });

  /* =====================================================================
     BO'SH VAQTLARIM — instruktor soatlarni o'zi yopadi / ochadi.
     GET  /api/instructor/blocks?from=YYYY-MM-DD&to=YYYY-MM-DD
     PUT  /api/instructor/blocks  { date, slots: [{ from: 'HH:MM', to: 'HH:MM' }] }
          — shu kunning yopiq soatlarini ALMASHTIRADI (bo'sh ro'yxat = hammasi ochiq).
     ===================================================================== */
  app.get('/api/instructor/blocks', async (request, reply) => {
    try {
      const tgUser = await authenticate(request);
      const profile = await profileForTelegram(tgUser);
      const instructor = await approvedInstructor(profile);
      if (!profile || !instructor) return reply.code(403).send({ ok: false, error: 'Instructor tasdiqlanmagan' });
      const { blocksFor, tashkentAt } = await import('./instructor-blocks.js');
      const qy = (request.query ?? {}) as any;
      const isYmd = (v: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
      const today = tashkentYmd(new Date());
      const from = tashkentAt(isYmd(qy.from) ? qy.from : today, '00:00').getTime();
      const to = tashkentAt(isYmd(qy.to) ? qy.to : today, '00:00').getTime() + 864e5;
      const blocks = (await blocksFor(String(instructor.id)))
        .filter((b) => Date.parse(b.end_at) > from && Date.parse(b.start_at) < to);
      return { ok: true, blocks };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Yopiq soatlar yuklanmadi' });
    }
  });

  app.put('/api/instructor/blocks', async (request, reply) => {
    try {
      const tgUser = await authenticate(request);
      const profile = await profileForTelegram(tgUser);
      const instructor = await approvedInstructor(profile);
      if (!profile || !instructor) return reply.code(403).send({ ok: false, error: 'Instructor tasdiqlanmagan' });
      const { saveDayBlocks, tashkentAt } = await import('./instructor-blocks.js');
      const b = (request.body ?? {}) as any;
      const day = String(b.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return reply.code(400).send({ ok: false, error: 'Sana noto‘g‘ri' });
      const today = tashkentYmd(new Date());
      const dayStart = tashkentAt(day, '00:00');
      if (Number.isNaN(dayStart.getTime())) return reply.code(400).send({ ok: false, error: 'Sana noto‘g‘ri' });
      if (day < today) return reply.code(400).send({ ok: false, error: 'O‘tgan kunni o‘zgartirib bo‘lmaydi' });
      if (dayStart.getTime() - tashkentAt(today, '00:00').getTime() > 60 * 864e5) {
        return reply.code(400).send({ ok: false, error: 'Faqat 60 kun oldinga yopish mumkin' });
      }

      const raw = Array.isArray(b.slots) ? b.slots : [];
      if (raw.length > 48) return reply.code(400).send({ ok: false, error: 'Juda ko‘p soat' });
      const hm = (v: any) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
      const slots = [] as { start_at: string; end_at: string }[];
      for (const x of raw) {
        if (!hm(x?.from) || !hm(x?.to) || String(x.from) >= String(x.to)) {
          return reply.code(400).send({ ok: false, error: 'Soat noto‘g‘ri' });
        }
        slots.push({ start_at: tashkentAt(day, x.from).toISOString(), end_at: tashkentAt(day, x.to).toISOString() });
      }

      /* Bron bor soatni yopib bo'lmaydi — mijoz kutib qoladi */
      if (slots.length) {
        const dayEnd = new Date(dayStart.getTime() + 864e5);
        const rows = await supabaseRest<any[]>('bookings', {
          query: `?instructor_id=eq.${q(String(instructor.id))}&status=in.(pending,confirmed,in_progress)` +
                 `&start_at=lt.${q(dayEnd.toISOString())}&end_at=gt.${q(dayStart.toISOString())}&select=id,start_at,end_at&limit=100`,
        });
        const hit = rows.find((r) => slots.some((x) => Date.parse(r.start_at) < Date.parse(x.end_at) && Date.parse(r.end_at) > Date.parse(x.start_at)));
        if (hit) {
          const t = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit' }).format(new Date(hit.start_at));
          return reply.code(409).send({ ok: false, error: `${t} da sizga bron bor — bu soatni yopib bo‘lmaydi. Admin bilan kelishing.` });
        }
      }

      const all = await saveDayBlocks(String(instructor.id), day, slots);
      const dEnd = dayStart.getTime() + 864e5;
      return { ok: true, date: day, blocks: all.filter((x) => Date.parse(x.start_at) >= dayStart.getTime() && Date.parse(x.start_at) < dEnd) };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Saqlanmadi' });
    }
  });

  /** «🔔 Eslatish» — instruktor mijozga dars eslatmasini qo'lda yuboradi. */
  app.post('/api/instructor/bookings/:id/remind', async (request, reply) => {
    try {
      const tgUser = await authenticate(request);
      const profile = await profileForTelegram(tgUser);
      const instructor = await approvedInstructor(profile);
      if (!profile || !instructor) return reply.code(403).send({ ok: false, error: 'Instructor tasdiqlanmagan' });
      const booking = await getOwnedBooking(String((request.params as any).id), String(instructor.id));
      if (!booking) return reply.code(404).send({ ok: false, error: 'Bron topilmadi' });
      const { sendManualReminder } = await import('./reminders.js');
      const r = await sendManualReminder(booking, String(profile.full_name || '').trim());
      if (!r.ok) return reply.code(r.code).send({ ok: false, error: r.error, phone: (r as any).phone ?? null });
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Eslatma yuborilmadi' });
    }
  });

  /** Ochiq turgan instruktor paneli ham avtomatik eslatmalarni «turtadi». */
  app.post('/api/instructor/reminders/tick', async (request, reply) => {
    try {
      const tgUser = await authenticate(request);
      const profile = await profileForTelegram(tgUser);
      const instructor = await approvedInstructor(profile);
      if (!profile || !instructor) return reply.code(403).send({ ok: false, error: 'Instructor tasdiqlanmagan' });
      const { tickReminders } = await import('./reminders.js');
      return { ok: true, ...(await tickReminders('instruktor')) };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Eslatma tekshiruvi xatosi' });
    }
  });

  /**
   * /api/instructor/logout — Telegram Mini App'da server sessiyasi yo'q
   * (har so'rov initData bilan tekshiriladi), shuning uchun bu shunchaki
   * muvaffaqiyat qaytaradi. Panel tugmasi 404 bermasligi uchun.
   */
  app.post('/api/instructor/logout', async () => ({ ok: true }));
  app.get('/api/instructor/logout', async () => ({ ok: true }));

  /**
   * Instruktorning o'z hisoboti: kunlik / haftalik / oylik / yillik.
   * Hisob bazada bajariladi (analytics_instructor) — yillik natija
   * qator chegarasi tufayli buzilmasin.
   */
  app.get('/api/instructor/report', async (request, reply) => {
    try {
      const tgUser = await authenticate(request);
      const profile = await profileForTelegram(tgUser);
      const instructor = await approvedInstructor(profile);
      if (!profile || !instructor) return reply.code(403).send({ ok: false, error: 'Instructor tasdiqlanmagan' });

      const period = String((request.query as any)?.period || 'day');
      const { from, to, bucket, label, anchor } = periodRange(period, (request.query as any)?.date);

      // Oldingi davr bilan solishtirish
      const span = to.getTime() - from.getTime();
      const prevFrom = new Date(from.getTime() - span);
      const call = (f: Date, t: Date) => supabaseRest<any>('rpc/analytics_instructor', {
        method: 'POST',
        body: JSON.stringify({
          p_instructor: String(instructor.id),
          p_from: f.toISOString(), p_to: t.toISOString(), p_bucket: bucket,
        }),
      });
      const [cur, prev] = await Promise.all([call(from, to), call(prevFrom, from)]);

      const t0 = cur?.totals || {}, p0 = prev?.totals || {};
      const delta = (a: any, b: any) => {
        const x = Number(a || 0), y = Number(b || 0);
        if (!y) return x ? 100 : 0;
        return Math.round(((x - y) / y) * 100);
      };

      return {
        ok: true, period, label, anchor, bucket,
        from: from.toISOString(), to: to.toISOString(),
        totals: t0,
        previous: p0,
        change: {
          completed: delta(t0.completed, p0.completed),
          minutes: delta(t0.minutes, p0.minutes),
          customers: delta(t0.customers, p0.customers),
        },
        series: cur?.series || [],
        courses: cur?.courses || [],
        hours: cur?.hours || [],
      };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Hisobot yuklanmadi' });
    }
  });

  /**
   * INSTRUKTOR O'Z PROFILINI TAHRIRLAYDI
   *
   * O'zgartira oladi: ism, familiya, telefon, tajriba, bio, rasm.
   * O'zgartira OLMAYDI: reyting (sharhlardan), tasdiqlangan holati (admin).
   */
  app.patch('/api/instructor/profile', async (request, reply) => {
    try {
      const tgUser = await authenticate(request);
      const profile = await profileForTelegram(tgUser);
      const instructor = await approvedInstructor(profile);
      if (!profile || !instructor) return reply.code(403).send({ ok: false, error: 'Instruktor tasdiqlanmagan' });

      const b = (request.body ?? {}) as any;
      const userPatch: Record<string, unknown> = {};
      const insPatch: Record<string, unknown> = {};

      const first = String(b.first_name ?? '').trim();
      const last  = String(b.last_name ?? '').trim();
      if (first || last) {
        const full = [first, last].filter(Boolean).join(' ');
        if (full.length < 2) return reply.code(400).send({ ok: false, error: 'Ism juda qisqa' });
        userPatch.full_name = full;
      }
      if (b.phone !== undefined) {
        const phone = String(b.phone).trim();
        if (phone && !/^\+?\d[\d\s()-]{6,}$/.test(phone)) {
          return reply.code(400).send({ ok: false, error: 'Telefon raqami noto‘g‘ri' });
        }
        userPatch.phone = phone || null;
      }
      if (b.experience_years !== undefined) {
        const y = Math.trunc(Number(b.experience_years));
        if (!Number.isFinite(y) || y < 0 || y > 60) {
          return reply.code(400).send({ ok: false, error: 'Tajriba 0 dan 60 yilgacha bo‘lsin' });
        }
        insPatch.experience_years = y;
      }
      if (b.bio !== undefined) {
        const bio = String(b.bio).trim();
        // Instruktorlar tavsifni batafsil yozadi (xizmatlar ro'yxati bilan),
        // shuning uchun chegara keng: 2000 belgi.
        if (bio.length > 2000) {
          return reply.code(400).send({ ok: false, error: `Bio juda uzun: ${bio.length} belgi. Eng ko'pi 2000.` });
        }
        insPatch.bio = bio || null;
      }
      if (b.avatar_url !== undefined) {
        const u = String(b.avatar_url).trim();
        // Faqat o'z storage'imizdagi manzil — tashqi havola qo'yib bo'lmaydi
        if (u && !isStoragePublicUrl(u)) {
          return reply.code(400).send({ ok: false, error: 'Rasm manzili noto‘g‘ri' });
        }
        insPatch.avatar_url = u || null;
      }

      if (Object.keys(userPatch).length) {
        userPatch.updated_at = new Date().toISOString();
        await supabaseRest('users', {
          method: 'PATCH', query: `?id=eq.${q(String(profile.id))}`, body: JSON.stringify(userPatch),
        });
      }
      if (Object.keys(insPatch).length) {
        insPatch.updated_at = new Date().toISOString();
        await supabaseRest('instructor_profiles', {
          method: 'PATCH', query: `?id=eq.${q(String(instructor.id))}`, body: JSON.stringify(insPatch),
        });
      }

      const [u2] = await supabaseRest<any[]>('users', { query: `?id=eq.${q(String(profile.id))}&select=*&limit=1` });
      const [i2] = await supabaseRest<any[]>('instructor_profiles', { query: `?id=eq.${q(String(instructor.id))}&select=*&limit=1` });
      return { ok: true, profile: u2 ?? profile, instructor: noReviews(i2 ?? instructor) };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Saqlanmadi' });
    }
  });

  /**
   * RASM YUKLASH — imzolangan manzil.
   * Fayl brauzerdan to'g'ridan-to'g'ri Supabase Storage'ga ketadi,
   * shuning uchun Vercel'ning 4.5 MB cheklovi tegishli emas.
   */
  app.post('/api/instructor/avatar/sign', async (request, reply) => {
    try {
      const tgUser = await authenticate(request);
      const profile = await profileForTelegram(tgUser);
      const instructor = await approvedInstructor(profile);
      if (!profile || !instructor) return reply.code(403).send({ ok: false, error: 'Instruktor tasdiqlanmagan' });

      const b = (request.body ?? {}) as any;
      const contentType = String(b.content_type || '').toLowerCase();
      const size = Number(b.size || 0);
      if (!/^image\/(jpeg|png|webp)$/.test(contentType)) {
        return reply.code(400).send({ ok: false, error: 'Faqat JPG, PNG yoki WEBP' });
      }
      if (!(size > 0) || size > 5 * 1024 * 1024) {
        return reply.code(400).send({ ok: false, error: 'Rasm 5 MB dan oshmasin' });
      }

      const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
      const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
      const BUCKET = 'customer-media';
      const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
      const path = `avatars/${instructor.id}-${Date.now()}.${ext}`;

      const res = await fetch(`${url}/storage/v1/object/upload/sign/${BUCKET}/${path}`, {
        method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 600 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.token) {
        return reply.code(502).send({ ok: false, error: `Storage imzo xatosi ${res.status}` });
      }
      return {
        ok: true,
        path,
        upload_url: `${url}/storage/v1/object/upload/sign/${BUCKET}/${path}?token=${encodeURIComponent(data.token)}`,
        public_url: `${url}/storage/v1/object/public/${BUCKET}/${path}`,
      };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Imzo olinmadi' });
    }
  });

}
