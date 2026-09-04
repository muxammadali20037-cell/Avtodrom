import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import { q, findUserByTelegram, toProfile } from './identity.js';
import { fmtWhen, fmtMoney } from './notify.js';
import { readRegisterToken } from './shift-routes.js';
import type { TelegramWebAppUser } from './telegram.js';

/**
 * KASSA — barcha to'lovlar shu yerdan o'tadi.
 *
 * Bron bilan kelgan ham, ko'chadan kelgan ham bir xil qabul qilinadi:
 *   - bron bilan  -> mavjud bron topiladi
 *   - bronsiz     -> kassada joyida bron yaratiladi (source = 'walk_in')
 * Ikkalasida ham to'lovdan keyin chek chiqadi va unda QR kod bo'ladi.
 * Instruktor QR ni skanerlab, darsni boshlaydi.
 *
 * QR ichida FAQAT chek kodi turadi — ism, telefon yoki summa emas.
 * Chek yo'qolsa, uni topgan odam shaxsiy ma'lumotni ko'rmaydi.
 */

const TZ = 'Asia/Tashkent';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

function dayRange(date: string) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today();
  const start = new Date(`${d}T00:00:00+05:00`);
  return { start: start.toISOString(), end: new Date(start.getTime() + 864e5).toISOString(), day: d };
}

async function loadMaps(bookings: any[]) {
  const uids = [...new Set(bookings.map((b) => String(b.customer_id)).filter(Boolean))];
  const iids = [...new Set(bookings.map((b) => String(b.instructor_id)).filter(Boolean))];
  const cids = [...new Set(bookings.map((b) => String(b.course_id)).filter(Boolean))];
  const bids = bookings.map((b) => String(b.id));

  const [users, ips, courses, pays] = await Promise.all([
    uids.length ? supabaseRest<any[]>('users', { query: `?id=in.(${uids.map(q).join(',')})&select=id,full_name,phone,telegram_id` }) : [],
    iids.length ? supabaseRest<any[]>('instructor_profiles', { query: `?id=in.(${iids.map(q).join(',')})&select=id,user_id` }) : [],
    cids.length ? supabaseRest<any[]>('courses', { query: `?id=in.(${cids.map(q).join(',')})&select=id,name,duration_minutes,price` }) : [],
    bids.length ? supabaseRest<any[]>('payments', { query: `?booking_id=in.(${bids.map(q).join(',')})&select=*` }) : [],
  ]);
  const um = new Map(users.map((u) => [String(u.id), u]));
  const iuids = [...new Set(ips.map((i) => String(i.user_id)).filter(Boolean))];
  const iu = iuids.length
    ? await supabaseRest<any[]>('users', { query: `?id=in.(${iuids.map(q).join(',')})&select=id,full_name,phone` })
    : [];
  const ium = new Map(iu.map((u) => [String(u.id), u]));
  return {
    um,
    im: new Map(ips.map((i) => [String(i.id), { ...i, profile: ium.get(String(i.user_id)) || null }])),
    cm: new Map(courses.map((c) => [String(c.id), c])),
    pm: new Map(pays.map((p) => [String(p.booking_id), p])),
  };
}

function shape(b: any, m: any) {
  const c = m.cm.get(String(b.course_id));
  const i = m.im.get(String(b.instructor_id));
  const p = m.pm.get(String(b.id));
  /* Davomiylik endi daqiqada saqlanadi. Narx nisbatan hisoblanadi:
     60 daqiqalik kurs 250 000 bo'lsa, 30 daqiqa = 125 000.
     To'lov o'tgan bo'lsa, tarix uchun to'langan summa ustun turadi. */
  const unit = Number(c?.duration_minutes || 60) || 60;
  const mins = Number(b.duration_minutes || 0) || unit * (Number(b.hours ?? 1) || 1);
  const expected = Math.round((Number(c?.price ?? 0) * mins) / unit);
  return {
    ...b,
    start_at: b.start_at || b.booking_date,
    customer: m.um.get(String(b.customer_id)) || null,
    instructor: i || null,
    course: c || null,
    payment: p || null,
    duration_minutes: mins,
    total_minutes: mins,
    price: p?.amount ?? expected,
    is_paid: String(p?.status) === 'paid',
  };
}

export async function registerCashierRoutes(
  app: FastifyInstance,
  requireAdmin: (request: any) => Promise<void>,
  adminUser: () => Promise<any>,
  audit: (adminId: string | null, action: string, entity: string, id: string | null, oldD: unknown, newD: unknown) => Promise<void>,
  authenticateInstructor: (request: any) => Promise<TelegramWebAppUser>,
) {
  /* =====================================================================
     1. KASSA — kunlik bronlar (instruktor bo'yicha guruhlangan)
     ===================================================================== */
  app.get('/api/admin/cashier/day', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const { start, end, day } = dayRange(String(req.query?.date || ''));
      const instructorId = String(req.query?.instructor_id || '').trim();

      const filter = instructorId ? `&instructor_id=eq.${q(instructorId)}` : '';
      const bookings = await supabaseRest<any[]>('bookings', {
        query: `?start_at=gte.${q(start)}&start_at=lt.${q(end)}${filter}` +
               '&status=in.(pending,confirmed,in_progress,completed,no_show)' +
               '&select=*&order=start_at.asc&limit=500',
      });
      const m = await loadMaps(bookings);
      return { ok: true, date: day, bookings: bookings.map((b) => shape(b, m)) };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Kunlik bronlar yuklanmadi' });
    }
  });

  /** Mijozni ism yoki telefon bo'yicha qidirish (kassada tez topish uchun). */
  app.get('/api/admin/cashier/search', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const term = String(req.query?.q || '').trim();
      if (term.length < 2) return { ok: true, customers: [] };
      const like = `*${term}*`;
      const rows = await supabaseRest<any[]>('users', {
        query: `?role=eq.customer&or=(full_name.ilike.${q(like)},phone.ilike.${q(like)})` +
               '&select=id,full_name,phone,telegram_id&limit=20',
      });
      return { ok: true, customers: rows };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Qidiruv ishlamadi' });
    }
  });

  /* =====================================================================
     2. BRONSIZ MIJOZ — kassada joyida bron yaratish
     ===================================================================== */
  app.post('/api/admin/cashier/walk-in', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const admin = await adminUser();
      const b = req.body || {};
      const fullName = String(b.full_name || '').trim();
      const phone = String(b.phone || '').trim();
      const instructorId = String(b.instructor_id || '').trim();
      const courseId = String(b.course_id || '').trim();
      const startAt = String(b.start_at || '').trim();
      const hours = Math.min(8, Math.max(1, Math.trunc(Number(b.hours ?? 1)) || 1));

      if (fullName.length < 2) return reply.code(400).send({ ok: false, error: 'Mijoz ismini kiriting' });
      if (!instructorId) return reply.code(400).send({ ok: false, error: 'Instruktorni tanlang' });
      if (!courseId) return reply.code(400).send({ ok: false, error: 'Mashg‘ulotni tanlang' });
      const start = new Date(startAt);
      if (Number.isNaN(start.getTime())) return reply.code(400).send({ ok: false, error: 'Vaqt noto‘g‘ri' });

      const course = (await supabaseRest<any[]>('courses', {
        query: `?id=eq.${q(courseId)}&select=id,name,duration_minutes,price&limit=1`,
      }))[0];
      if (!course) return reply.code(400).send({ ok: false, error: 'Mashg‘ulot topilmadi' });

      // Mijoz: mavjud bo'lsa topamiz (telefon bo'yicha), bo'lmasa yaratamiz
      let customer: any = null;
      if (b.customer_id) {
        customer = (await supabaseRest<any[]>('users', { query: `?id=eq.${q(String(b.customer_id))}&select=*&limit=1` }))[0];
      }
      if (!customer && phone) {
        customer = (await supabaseRest<any[]>('users', { query: `?phone=eq.${q(phone)}&select=*&limit=1` }))[0];
      }
      if (!customer) {
        try {
          customer = (await supabaseRest<any[]>('users', {
            method: 'POST', headers: { Prefer: 'return=representation' },
            body: JSON.stringify({ full_name: fullName, phone: phone || null, role: 'customer', is_active: true, is_blocked: false }),
          }))[0];
        } catch (e: any) {
          if (/duplicate key.*phone/i.test(String(e?.message))) {
            return reply.code(409).send({ ok: false, error: 'Bu telefon boshqa mijozda ro‘yxatdan o‘tgan' });
          }
          throw e;
        }
      }
      if (!customer) throw new Error('Mijoz yaratilmadi');

      const end = new Date(start.getTime() + Number(course.duration_minutes || 60) * hours * 60000);
      const rows = await supabaseRest<any[]>('bookings', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          customer_id: customer.id, instructor_id: instructorId, course_id: course.id,
          booking_date: start.toISOString(), start_at: start.toISOString(), end_at: end.toISOString(),
          hours, status: 'confirmed', source: 'walk_in',
          confirmed_at: new Date().toISOString(), confirmed_by: admin.id,
        }),
      });
      const booking = rows[0];
      await audit(admin.id, 'WALK_IN_CREATED', 'bookings', booking?.id ?? null, null, { customer: customer.full_name });
      const m = await loadMaps([booking]);
      return reply.code(201).send({ ok: true, booking: shape(booking, m) });
    } catch (e: any) {
      const msg = String(e?.message || '');
      if (/no_instructor_overlap/.test(msg)) return reply.code(409).send({ ok: false, error: 'Instruktor bu vaqtda band' });
      if (/no_customer_overlap/.test(msg)) return reply.code(409).send({ ok: false, error: 'Mijozda shu vaqtda boshqa bron bor' });
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: msg || 'Bron yaratilmadi' });
    }
  });

  /* =====================================================================
     3. TO'LOV QABUL QILISH -> CHEK KODI
     ===================================================================== */
  app.post('/api/admin/cashier/pay', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const admin = await adminUser();
      const bookingId = String(req.body?.booking_id || '').trim();
      const method = String(req.body?.method || '').trim();
      const amountRaw = req.body?.amount;

      if (!bookingId) return reply.code(400).send({ ok: false, error: 'Bron tanlanmagan' });
      if (!['cash', 'card'].includes(method)) return reply.code(400).send({ ok: false, error: 'To‘lov turini tanlang: naqd yoki karta' });

      const booking = (await supabaseRest<any[]>('bookings', { query: `?id=eq.${q(bookingId)}&select=*&limit=1` }))[0];
      if (!booking) return reply.code(404).send({ ok: false, error: 'Bron topilmadi' });
      if (['cancelled', 'rejected'].includes(String(booking.status))) {
        return reply.code(409).send({ ok: false, error: 'Bekor qilingan bron uchun to‘lov qabul qilinmaydi' });
      }

      const course = booking.course_id
        ? (await supabaseRest<any[]>('courses', { query: `?id=eq.${q(String(booking.course_id))}&select=price,name,duration_minutes&limit=1` }))[0]
        : null;
      const bookedHours = Number(booking.hours ?? 1) || 1;
      // Standart summa: kurs narxi × soat soni. Kassir uni o'zgartira oladi.
      const amount = Number(amountRaw ?? (Number(course?.price ?? 0) * bookedHours));
      if (!Number.isFinite(amount) || amount <= 0) return reply.code(400).send({ ok: false, error: 'Summa noto‘g‘ri' });

      const existing = (await supabaseRest<any[]>('payments', { query: `?booking_id=eq.${q(bookingId)}&select=*&limit=1` }))[0];
      if (existing && String(existing.status) === 'paid') {
        return reply.code(409).send({ ok: false, error: `Bu bron allaqachon to‘langan. Chek: ${existing.receipt_code || '—'}` });
      }

      // Chek kodi bazada yaratiladi — noyobligi UNIQUE indeks bilan kafolatlanadi
      const code = (await supabaseRest<any[]>('rpc/generate_receipt_code', { method: 'POST', body: '{}' })) as unknown as string;
      const receiptCode = typeof code === 'string' ? code : String((code as any) ?? '');
      if (!receiptCode) throw new Error('Chek kodi yaratilmadi');

      const now = new Date().toISOString();
      const payload = {
        booking_id: bookingId, customer_id: booking.customer_id, amount, currency: 'UZS',
        status: 'paid', method, paid_at: now, receipt_code: receiptCode, cashier_id: admin.id,
        note: String(req.body?.note || '').trim() || null,
      };
      const payment = existing
        ? (await supabaseRest<any[]>('payments', {
            method: 'PATCH', headers: { Prefer: 'return=representation' },
            query: `?id=eq.${q(String(existing.id))}`, body: JSON.stringify(payload),
          }))[0]
        : (await supabaseRest<any[]>('payments', {
            method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(payload),
          }))[0];

      // Bron hali tasdiqlanmagan bo'lsa, to'lov uni tasdiqlaydi
      if (String(booking.status) === 'pending') {
        await supabaseRest('bookings', {
          method: 'PATCH', query: `?id=eq.${q(bookingId)}`,
          body: JSON.stringify({ status: 'confirmed', confirmed_at: now, confirmed_by: admin.id, updated_at: now }),
        }).catch(() => {});
      }

      await audit(admin.id, 'PAYMENT_RECEIVED', 'payments', payment?.id ?? null, null,
        { amount, method, receipt_code: receiptCode, booking_id: bookingId });

      const fresh = (await supabaseRest<any[]>('bookings', { query: `?id=eq.${q(bookingId)}&select=*&limit=1` }))[0];
      const m = await loadMaps([fresh]);
      return reply.code(201).send({ ok: true, payment, receipt: buildReceipt(shape(fresh, m), payment) });
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: e?.message || 'To‘lov qabul qilinmadi' });
    }
  });

  /** Chekni qayta chop etish uchun. */
  app.get('/api/admin/cashier/receipt/:code', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const code = String(req.params.code || '').trim().toUpperCase();
      const payment = (await supabaseRest<any[]>('payments', { query: `?receipt_code=eq.${q(code)}&select=*&limit=1` }))[0];
      if (!payment) return reply.code(404).send({ ok: false, error: 'Chek topilmadi' });
      const booking = (await supabaseRest<any[]>('bookings', { query: `?id=eq.${q(String(payment.booking_id))}&select=*&limit=1` }))[0];
      if (!booking) return reply.code(404).send({ ok: false, error: 'Bron topilmadi' });
      const m = await loadMaps([booking]);
      return { ok: true, receipt: buildReceipt(shape(booking, m), payment) };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Chek yuklanmadi' });
    }
  });


  /* =====================================================================
     BO'SH INSTRUKTORLAR
     Berilgan vaqt oralig'ida kim bo'sh. Hech kim bo'sh bo'lmasa — kim
     eng tez bo'shashini ham qaytaradi, kassir kutish vaqtini ko'radi.
     ===================================================================== */
  app.get('/api/admin/cashier/free-instructors', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const at = new Date(String(req.query?.at || ''));
      const minutes = Math.max(15, Math.min(600, Number(req.query?.minutes || 60)));
      if (Number.isNaN(at.getTime())) return reply.code(400).send({ ok: false, error: 'Vaqt noto‘g‘ri' });
      const end = new Date(at.getTime() + minutes * 60000);

      /* Kategoriya berilsa — faqat o'sha kategoriyani o'rgatadiganlar. */
      const cat = String(req.query?.category || '').trim().toUpperCase();
      const catFilter = /^[ABC]$/.test(cat) ? `&categories=cs.{${cat}}` : '';
      const ips = await supabaseRest<any[]>('instructor_profiles', {
        query: `?is_verified=eq.true&is_available=eq.true&select=id,user_id,rating,categories${catFilter}&limit=200`,
      });
      if (!ips.length) return { ok: true, free: [], busy: [] };

      const uids = [...new Set(ips.map((i) => String(i.user_id)).filter(Boolean))];
      const users = uids.length
        ? await supabaseRest<any[]>('users', { query: `?id=in.(${uids.map(q).join(',')})&select=id,full_name,phone` })
        : [];
      const um = new Map(users.map((u) => [String(u.id), u]));

      // Shu kunning bronlari — kim band ekanini aniqlash uchun
      const dayStart = new Date(at.getTime() - 12 * 3600e3).toISOString();
      const dayEnd = new Date(at.getTime() + 12 * 3600e3).toISOString();
      const busyRows = await supabaseRest<any[]>('bookings', {
        query:
          `?start_at=gte.${q(dayStart)}&start_at=lt.${q(dayEnd)}` +
          '&status=in.(pending,confirmed,in_progress)' +
          '&select=instructor_id,start_at,end_at&limit=1000',
      });

      const free: any[] = [], busy: any[] = [];
      for (const ip of ips) {
        const mine = busyRows.filter((b) => String(b.instructor_id) === String(ip.id));
        const clash = mine.find((b) => new Date(b.start_at) < end && new Date(b.end_at) > at);
        const info = {
          id: ip.id,
          name: um.get(String(ip.user_id))?.full_name || 'Instruktor',
          phone: um.get(String(ip.user_id))?.phone || null,
          rating: Number(ip.rating || 0),
          categories: Array.isArray(ip.categories) ? ip.categories : ['B'],
        };
        if (!clash) { free.push(info); continue; }
        // Qachon bo'shaydi: ketma-ket bandliklar oxiri
        let freeAt = new Date(clash.end_at);
        let moved = true;
        while (moved) {
          moved = false;
          for (const b of mine) {
            if (new Date(b.start_at) <= freeAt && new Date(b.end_at) > freeAt) {
              freeAt = new Date(b.end_at); moved = true;
            }
          }
        }
        busy.push({ ...info, free_at: freeAt.toISOString(), wait_minutes: Math.round((freeAt.getTime() - at.getTime()) / 60000) });
      }
      free.sort((a, b) => b.rating - a.rating);
      busy.sort((a, b) => a.wait_minutes - b.wait_minutes);
      return { ok: true, at: at.toISOString(), minutes, free, busy, suggestion: free[0] || busy[0] || null };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Instruktorlar yuklanmadi' });
    }
  });

  /* =====================================================================
     CHEK CHIQARISH — bitta amalda
     Bronli bo'lsa mavjud bron ishlatiladi; bronsiz bo'lsa joyida yaratiladi.
     Keyin to'lov yoziladi va chek kodi qaytariladi.
     ===================================================================== */
  app.post('/api/admin/cashier/issue', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const admin = await adminUser();
      const b = req.body || {};

      const mode = b.booking_id ? 'booked' : 'walk_in';
      const minutes = Math.max(15, Math.min(600, Math.round(Number(b.duration_minutes || 60))));
      const cash = Math.max(0, Number(b.cash_amount || 0));
      const card = Math.max(0, Number(b.card_amount || 0));
      const total = Number(b.amount ?? (cash + card));

      if (!(total > 0)) return reply.code(400).send({ ok: false, error: 'Summani kiriting' });
      if (cash + card !== total) {
        return reply.code(400).send({ ok: false, error: `Naqd (${cash}) + terminal (${card}) = ${cash + card}, jami esa ${total}. Mos kelmadi.` });
      }
      const method = cash > 0 && card > 0 ? 'mixed' : (card > 0 ? 'card' : 'cash');

      let booking: any = null;

      if (mode === 'booked') {
        booking = (await supabaseRest<any[]>('bookings', { query: `?id=eq.${q(String(b.booking_id))}&select=*&limit=1` }))[0];
        if (!booking) return reply.code(404).send({ ok: false, error: 'Bron topilmadi' });
        if (['cancelled', 'rejected'].includes(String(booking.status))) {
          return reply.code(409).send({ ok: false, error: 'Bekor qilingan bron uchun chek chiqarilmaydi' });
        }
      } else {
        const fullName = String(b.full_name || '').trim();
        const phone = String(b.phone || '').trim();
        const instructorId = String(b.instructor_id || '').trim();
        const courseId = String(b.course_id || '').trim();
        const start = new Date(String(b.start_at || ''));
        if (fullName.length < 2) return reply.code(400).send({ ok: false, error: 'Ism familiyani kiriting' });
        if (!instructorId) return reply.code(400).send({ ok: false, error: 'Instruktor tanlanmagan' });
        if (!courseId) return reply.code(400).send({ ok: false, error: 'Mashg‘ulot tanlanmagan' });
        if (Number.isNaN(start.getTime())) return reply.code(400).send({ ok: false, error: 'Vaqt noto‘g‘ri' });

        let customer: any = b.customer_id
          ? (await supabaseRest<any[]>('users', { query: `?id=eq.${q(String(b.customer_id))}&select=*&limit=1` }))[0]
          : null;
        if (!customer && phone) {
          customer = (await supabaseRest<any[]>('users', { query: `?phone=eq.${q(phone)}&select=*&limit=1` }))[0];
        }
        if (!customer) {
          customer = (await supabaseRest<any[]>('users', {
            method: 'POST', headers: { Prefer: 'return=representation' },
            body: JSON.stringify({ full_name: fullName, phone: phone || null, role: 'customer', is_active: true, is_blocked: false }),
          }))[0];
        }

        const now = new Date().toISOString();
        booking = (await supabaseRest<any[]>('bookings', {
          method: 'POST', headers: { Prefer: 'return=representation' },
          body: JSON.stringify({
            customer_id: customer.id, instructor_id: instructorId, course_id: courseId,
            booking_date: start.toISOString(), start_at: start.toISOString(),
            end_at: new Date(start.getTime() + minutes * 60000).toISOString(),
            duration_minutes: minutes, category: b.category || null,
            status: 'confirmed', source: 'walk_in', confirmed_at: now, confirmed_by: admin.id,
          }),
        }))[0];
      }

      // Bronli holatda ham davomiylik/kategoriya kassada aniqlanishi mumkin
      if (mode === 'booked' && (Number(booking.duration_minutes || 0) !== minutes || b.category)) {
        const start = new Date(booking.start_at || booking.booking_date);
        booking = (await supabaseRest<any[]>('bookings', {
          method: 'PATCH', headers: { Prefer: 'return=representation' }, query: `?id=eq.${q(String(booking.id))}`,
          body: JSON.stringify({
            duration_minutes: minutes,
            end_at: new Date(start.getTime() + minutes * 60000).toISOString(),
            category: b.category || booking.category || null,
            status: booking.status === 'pending' ? 'confirmed' : booking.status,
            updated_at: new Date().toISOString(),
          }),
        }))[0] ?? booking;
      }

      const existing = (await supabaseRest<any[]>('payments', { query: `?booking_id=eq.${q(String(booking.id))}&select=*&limit=1` }))[0];
      if (existing && String(existing.status) === 'paid') {
        return reply.code(409).send({ ok: false, error: `Bu bron allaqachon to‘langan. Chek: ${existing.receipt_code || '—'}` });
      }

      const codeRes = await supabaseRest<any>('rpc/generate_receipt_code', { method: 'POST', body: '{}' });
      const receiptCode = typeof codeRes === 'string' ? codeRes : String(codeRes ?? '');
      if (!receiptCode) throw new Error('Chek kodi yaratilmadi');

      /* Chek qaysi KASSAdan chiqarilgani.
         Kassa ID'si mijoz yuborgan qiymatdan EMAS, imzolangan TOKENdan
         olinadi. Shunday qilib brauzerni o'zgartirib boshqa kassa
         nomidan chek chiqarib bo'lmaydi. */
      const registerId = readRegisterToken(String(b.register_token || ''));
      if (!registerId) {
        return reply.code(401).send({ ok: false, error: 'Kassa ochilmagan yoki muddati tugagan. P1 yoki P2 ni PIN bilan qayta oching.' });
      }
      const register = (await supabaseRest<any[]>('cash_registers', {
        query: `?id=eq.${q(registerId)}&is_active=eq.true&select=id,code,name&limit=1`,
      }))[0];
      if (!register) return reply.code(404).send({ ok: false, error: 'Kassa topilmadi' });

      const now2 = new Date().toISOString();
      const payload = {
        booking_id: booking.id, customer_id: booking.customer_id, amount: total, currency: 'UZS',
        status: 'paid', method, cash_amount: cash, card_amount: card,
        paid_at: now2, receipt_code: receiptCode, cashier_id: admin.id, register_id: registerId,
        note: String(b.note || '').trim() || null,
      };
      const payment = existing
        ? (await supabaseRest<any[]>('payments', {
            method: 'PATCH', headers: { Prefer: 'return=representation' },
            query: `?id=eq.${q(String(existing.id))}`, body: JSON.stringify(payload) }))[0]
        : (await supabaseRest<any[]>('payments', {
            method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(payload) }))[0];

      await audit(admin.id, 'RECEIPT_ISSUED', 'payments', payment?.id ?? null, null,
        { amount: total, method, cash, card, receipt_code: receiptCode, booking_id: booking.id, mode, register: register.code });

      const fresh = (await supabaseRest<any[]>('bookings', { query: `?id=eq.${q(String(booking.id))}&select=*&limit=1` }))[0];
      const m = await loadMaps([fresh]);
      const shaped = shape(fresh, m); (shaped as any).__register = register.name;
      return reply.code(201).send({ ok: true, mode, booking: shaped, payment, receipt: buildReceipt(shaped, payment) });
    } catch (e: any) {
      const msg = String(e?.message || '');
      if (/no_instructor_overlap/.test(msg)) return reply.code(409).send({ ok: false, error: 'Instruktor bu vaqtda band' });
      if (/no_customer_overlap/.test(msg)) return reply.code(409).send({ ok: false, error: 'Mijozda shu vaqtda boshqa bron bor' });
      if (/duplicate key.*phone/i.test(msg)) return reply.code(409).send({ ok: false, error: 'Bu telefon boshqa mijozda ro‘yxatdan o‘tgan' });
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: msg || 'Chek chiqarilmadi' });
    }
  });


  /**
   * QO'LDA BRON — telefon orqali murojaat qilganlar uchun
   *
   * Telegram ishlatmaydigan mijozlar qo'ng'iroq qiladi, admin ularni
   * shu yerdan yozib qo'yadi. Bron yaratilgach o'sha vaqt onlayn
   * bron qilayotganlarga BAND ko'rinadi — ikkalasi bitta jadvalda.
   *
   * To'lov bu yerda olinmaydi: mijoz kelib kassada to'laydi.
   */
  app.post('/api/admin/manual-booking', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const admin = await adminUser();
      const b = req.body || {};

      const fullName = String(b.full_name || '').trim();
      const phone = String(b.phone || '').trim();
      const instructorId = String(b.instructor_id || '').trim();
      const category = String(b.category || '').trim().toUpperCase();
      const minutes = Math.max(15, Math.min(600, Math.round(Number(b.duration_minutes || 60))));
      const start = new Date(String(b.start_at || ''));

      if (fullName.length < 2) return reply.code(400).send({ ok: false, error: 'Mijoz ismini kiriting' });
      if (!instructorId) return reply.code(400).send({ ok: false, error: 'Instruktorni tanlang' });
      if (Number.isNaN(start.getTime())) return reply.code(400).send({ ok: false, error: 'Sana yoki vaqt noto‘g‘ri' });
      if (!/^[ABC]$/.test(category)) return reply.code(400).send({ ok: false, error: 'Kategoriyani tanlang' });

      // Instruktor shu kategoriyani o'rgatadimi?
      const ins = (await supabaseRest<any[]>('instructor_profiles', {
        query: `?id=eq.${q(instructorId)}&select=id,categories,is_verified,is_available&limit=1`,
      }))[0];
      if (!ins) return reply.code(404).send({ ok: false, error: 'Instruktor topilmadi' });
      const cats: string[] = Array.isArray(ins.categories) ? ins.categories : ['B'];
      if (!cats.includes(category)) {
        return reply.code(409).send({ ok: false, error: `Bu instruktor ${category} kategoriyani o‘rgatmaydi` });
      }

      // Kategoriyaga mos kurs
      const course = (await supabaseRest<any[]>('courses', {
        query: `?category=eq.${q(category)}&is_active=eq.true&select=id,name,duration_minutes,price&limit=1`,
      }))[0];
      if (!course) {
        return reply.code(400).send({ ok: false, error: `${category} kategoriya uchun mashg‘ulot topilmadi. Mashg‘ulotlar bo‘limida qo‘shing.` });
      }

      // Mijoz: telefon bo'yicha topamiz, bo'lmasa yaratamiz
      let customer: any = null;
      if (phone) {
        customer = (await supabaseRest<any[]>('users', { query: `?phone=eq.${q(phone)}&select=*&limit=1` }))[0];
      }
      if (!customer) {
        try {
          customer = (await supabaseRest<any[]>('users', {
            method: 'POST', headers: { Prefer: 'return=representation' },
            body: JSON.stringify({ full_name: fullName, phone: phone || null, role: 'customer', is_active: true, is_blocked: false }),
          }))[0];
        } catch (e: any) {
          if (/duplicate key.*phone/i.test(String(e?.message))) {
            return reply.code(409).send({ ok: false, error: 'Bu telefon boshqa mijozda ro‘yxatdan o‘tgan' });
          }
          throw e;
        }
      }

      const end = new Date(start.getTime() + minutes * 60000);
      const now = new Date().toISOString();
      const rows = await supabaseRest<any[]>('bookings', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          customer_id: customer.id, instructor_id: instructorId, course_id: course.id,
          booking_date: start.toISOString(), start_at: start.toISOString(), end_at: end.toISOString(),
          duration_minutes: minutes, category,
          status: 'confirmed', source: 'admin',
          confirmed_at: now, confirmed_by: admin.id,
          customer_note: String(b.note || '').trim() || 'Telefon orqali qo‘lda bron',
        }),
      });
      const booking = rows[0];
      await audit(admin.id, 'MANUAL_BOOKING_CREATED', 'bookings', booking?.id ?? null, null,
        { customer: fullName, phone, category, minutes });

      return reply.code(201).send({ ok: true, booking, customer, course });
    } catch (e: any) {
      const msg = String(e?.message || '');
      if (/no_instructor_overlap/.test(msg)) return reply.code(409).send({ ok: false, error: 'Instruktor bu vaqtda band' });
      if (/no_customer_overlap/.test(msg)) return reply.code(409).send({ ok: false, error: 'Mijozda shu vaqtda boshqa bron bor' });
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: msg || 'Bron yaratilmadi' });
    }
  });

  /* =====================================================================
     4. INSTRUKTOR SKANERI
     ===================================================================== */
  app.post('/api/instructor/scan', async (request, reply) => {
    try {
      const tgUser = await authenticateInstructor(request);
      const user = await findUserByTelegram(tgUser.id);
      const ip = user
        ? (await supabaseRest<any[]>('instructor_profiles', {
            query: `?user_id=eq.${q(String(user.id))}&select=*&limit=1`,
          }))[0]
        : null;
      if (!ip || ip.is_verified === false) {
        return reply.code(403).send({ ok: false, error: 'Instruktor tasdiqlanmagan' });
      }

      const raw = String((request.body as any)?.code || '').trim().toUpperCase();
      // QR dan to'liq URL kelishi ham mumkin — faqat kodni ajratamiz
      const match = raw.match(/AVD-\d{6}-[0-9A-Z]{5}/);
      const code = match ? match[0] : raw;
      if (!code) return reply.code(400).send({ ok: false, error: 'Kod bo‘sh' });

      const payment = (await supabaseRest<any[]>('payments', { query: `?receipt_code=eq.${q(code)}&select=*&limit=1` }))[0];
      if (!payment) return reply.code(404).send({ ok: false, error: 'Bunday chek topilmadi. Kodni tekshiring.' });
      if (String(payment.status) !== 'paid') return reply.code(409).send({ ok: false, error: 'Bu chek bo‘yicha to‘lov o‘tmagan' });

      const booking = (await supabaseRest<any[]>('bookings', { query: `?id=eq.${q(String(payment.booking_id))}&select=*&limit=1` }))[0];
      if (!booking) return reply.code(404).send({ ok: false, error: 'Bron topilmadi' });
      if (String(booking.instructor_id) !== String(ip.id)) {
        return reply.code(403).send({ ok: false, error: 'Bu bron boshqa instruktorga biriktirilgan' });
      }

      const m = await loadMaps([booking]);
      const shaped = shape(booking, m);
      const status = String(booking.status);

      return {
        ok: true,
        booking: shaped,
        // Frontend shu bo'yicha qaysi tugmani ko'rsatishni hal qiladi
        can_start: status === 'confirmed',
        can_finish: status === 'in_progress',
        already: ['completed', 'no_show', 'cancelled', 'rejected'].includes(status) ? status : null,
        receipt_code: code,
      };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: e?.message || 'Skanerlash amalga oshmadi' });
    }
  });

  /** Skanerdan keyin darsni boshlash — kelganlik yozuvi ham qoldiriladi. */
  app.post('/api/instructor/scan/start', async (request, reply) => {
    try {
      const tgUser = await authenticateInstructor(request);
      const user = await findUserByTelegram(tgUser.id);
      const ip = user
        ? (await supabaseRest<any[]>('instructor_profiles', { query: `?user_id=eq.${q(String(user.id))}&select=*&limit=1` }))[0]
        : null;
      if (!ip) return reply.code(403).send({ ok: false, error: 'Instruktor topilmadi' });

      const code = String((request.body as any)?.code || '').trim().toUpperCase();
      const payment = (await supabaseRest<any[]>('payments', { query: `?receipt_code=eq.${q(code)}&status=eq.paid&select=*&limit=1` }))[0];
      if (!payment) return reply.code(404).send({ ok: false, error: 'To‘langan chek topilmadi' });

      const booking = (await supabaseRest<any[]>('bookings', { query: `?id=eq.${q(String(payment.booking_id))}&select=*&limit=1` }))[0];
      if (!booking) return reply.code(404).send({ ok: false, error: 'Bron topilmadi' });
      if (String(booking.instructor_id) !== String(ip.id)) return reply.code(403).send({ ok: false, error: 'Bu bron sizga tegishli emas' });
      if (String(booking.status) !== 'confirmed') {
        return reply.code(409).send({ ok: false, error: `Bron holati "${booking.status}" — boshlab bo‘lmaydi` });
      }

      /* Oldingi dars yakunlanmagan bo'lsa yangisini boshlab bo'lmaydi.
         Bazada ham unique indeks bor — bu yerdagi tekshiruv shunchaki
         tushunarli xabar berish uchun. */
      const active = (await supabaseRest<any[]>('bookings', {
        query: `?instructor_id=eq.${q(String(ip.id))}&status=eq.in_progress&select=id,start_at,customer_id&limit=1`,
      }))[0];
      if (active && String(active.id) !== String(booking.id)) {
        const who = active.customer_id
          ? (await supabaseRest<any[]>('users', {
              query: `?id=eq.${q(String(active.customer_id))}&select=full_name&limit=1`,
            }).catch(() => []))[0]?.full_name
          : null;
        return reply.code(409).send({
          ok: false,
          error: `Avvalgi dars yakunlanmagan${who ? ` (${who})` : ''}. Avval uni yakunlang, keyin yangisini boshlang.`,
          active_booking_id: active.id,
        });
      }

      const now = new Date().toISOString();
      const rows = await supabaseRest<any[]>('bookings', {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, query: `?id=eq.${q(String(booking.id))}`,
        body: JSON.stringify({ status: 'in_progress', arrived_at: booking.arrived_at || now, updated_at: now }),
      });

      // Kelganlik yozuvi — o'zgartirib bo'lmaydi (DB trigger himoyalaydi)
      await supabaseRest('attendance_verifications', {
        method: 'POST',
        body: JSON.stringify({ booking_id: booking.id, method: 'qr', scanned_by: user?.id ?? null, receipt_code: code }),
      }).catch((e) => console.error('attendance write failed:', e));

      return { ok: true, booking: rows[0] ?? booking };
    } catch (e: any) {
      const msg = String(e?.message || '');
      if (/bookings_one_active_lesson/i.test(msg)) {
        return reply.code(409).send({ ok: false, error: 'Avvalgi dars yakunlanmagan. Avval uni yakunlang.' });
      }
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: msg || 'Dars boshlanmadi' });
    }
  });
}

/** Chek uchun tayyor ma'lumot. QR ga faqat `code` yoziladi. */
function buildReceipt(b: any, p: any) {
  return {
    code: p.receipt_code,
    customer_name: b.customer?.full_name || 'Mijoz',
    customer_phone: b.customer?.phone || '',
    instructor_name: b.instructor?.profile?.full_name || '',
    course_name: b.course?.name || 'Mashg‘ulot',
    duration_minutes: b.total_minutes ?? b.duration_minutes ?? null,
    category: b.category || null,
    starts_at: b.start_at,
    starts_at_text: fmtWhen(b.start_at),
    amount: Number(p.amount || 0),
    amount_text: fmtMoney(p.amount),
    method: p.method,
    method_text: p.method === 'mixed' ? 'Naqd + Terminal' : p.method === 'card' ? 'Terminal' : 'Naqd',
    cash_amount: Number(p.cash_amount || 0),
    card_amount: Number(p.card_amount || 0),
    paid_at: p.paid_at,
    paid_at_text: fmtWhen(p.paid_at),
    booking_id: b.id,
    register: b.__register || null,
  };
}
