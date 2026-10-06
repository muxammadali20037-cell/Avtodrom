import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import { selectIn } from './rest-chunks.js';
import { loadTariffs, computePrice, loadKrug } from './pricing.js';
import { q, findUserByTelegram, toProfile } from './identity.js';
import { fmtWhen, fmtMoney } from './notify.js';
import { readRegisterToken, ownRegisterFromToken, reportScope, openShiftId, priceGuard } from './shift-routes.js';
import { bookingSearchFilter } from './booking-search.js';
import { loadBlocks, overlapping, instructorBlockedAt, blockedMessage } from './instructor-blocks.js';
import { tashkentYmdOf } from './instructor-schedule.js';
import {
  PACKAGE_MINUTES, loadPackagePrices, priceWithPackage, packagePriceOf, parseSessions, sessionConflict, createPackage,
  packagesFor, packageOf, type Session,
} from './packages.js';
import type { TelegramWebAppUser } from './telegram.js';
import {
  isSchoolReceiptCode, normalizeSchoolCode, schoolBridgeReady,
  schoolBridgeMissing, schoolBridgeDiagnose,
  verifySchoolReceipt, redeemSchoolReceipt, releaseSchoolReceipt,
} from './school-receipt.js';

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

const tkYmd = (iso: unknown) => {
  const d = new Date(String(iso || ''));
  return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
};

function dayRange(date: string) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today();
  const start = new Date(`${d}T00:00:00+05:00`);
  return { start: start.toISOString(), end: new Date(start.getTime() + 864e5).toISOString(), day: d };
}

/** total ni og'irliklarga proporsional bo'ladi; qoldiq birinchisiga. */
function splitBy(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const out = weights.map((w) => Math.floor((total * w) / sum));
  out[0] += Math.round(total) - out.reduce((a, b) => a + b, 0);
  return out;
}
/** amount ni qismlarga bo'ladi — hech biri o'z chegarasidan (caps) oshmaydi. */
function splitCapped(amount: number, caps: number[]): number[] {
  const sum = caps.reduce((a, b) => a + b, 0) || 1;
  const out = caps.map((c) => Math.min(c, Math.floor((amount * c) / sum)));
  let rest = Math.round(amount) - out.reduce((a, b) => a + b, 0);
  for (let i = 0; rest > 0 && i < out.length; i++) {
    const add = Math.min(caps[i] - out[i], rest);
    if (add > 0) { out[i] += add; rest -= add; }
  }
  return out;
}

async function loadMaps(bookings: any[]) {
  const uids = [...new Set(bookings.map((b) => b.customer_id).filter(Boolean).map(String))];
  const iids = [...new Set(bookings.map((b) => b.instructor_id).filter(Boolean).map(String))];
  const cids = [...new Set(bookings.map((b) => b.course_id).filter(Boolean).map(String))];
  const bids = bookings.map((b) => String(b.id));

  const [users, ips, courses, pays, tariffs, pkgPrices] = await Promise.all([
    selectIn<any>('users', 'id', uids, 'id,full_name,phone,telegram_id'),
    selectIn<any>('instructor_profiles', 'id', iids, 'id,user_id'),
    selectIn<any>('courses', 'id', cids, 'id,name,duration_minutes,price,category'),
    selectIn<any>('payments', 'booking_id', bids, '*'),
    loadTariffs().catch(() => null),
    loadPackagePrices().catch(() => null),
  ]);
  const um = new Map(users.map((u) => [String(u.id), u]));
  const iuids = [...new Set(ips.map((i) => i.user_id).filter(Boolean).map(String))];
  const iu = await selectIn<any>('users', 'id', iuids, 'id,full_name,phone');
  const ium = new Map(iu.map((u) => [String(u.id), u]));
  return {
    um,
    im: new Map(ips.map((i) => [String(i.id), { ...i, profile: ium.get(String(i.user_id)) || null }])),
    cm: new Map(courses.map((c) => [String(c.id), c])),
    pm: new Map(pays.map((p) => [String(p.booking_id), p])),
    tariffs, pkgPrices,
  };
}

/**
 * BRONNING TO'LANISHI KERAK BO'LGAN SUMMASI — kassada ham, serverda ham
 * bitta qoida: bron yaratilganda saqlangan narx; bo'lmasa — tarif
 * (toifa + daqiqa, 5 soat — paket). Kutilayotgan to'lov yozuvidagi eski
 * summa (kurs narxi) hisobga olinmaydi: 30 daqiqalik bronga 250 000
 * chiqib qolardi.
 */
function bookingDue(b: any, tariffs: any, pkgPrices: any, courseFallback = 0): number {
  if (Number(b?.price) > 0) return Math.round(Number(b.price));
  const mins = Number(b?.duration_minutes) > 0 ? Number(b.duration_minutes) : 60 * (Number(b?.hours ?? 1) || 1);
  const cat = String(b?.category || '').toUpperCase();
  if (tariffs && /^[ABC]$/.test(cat)) return priceWithPackage(cat, mins, tariffs, pkgPrices || {});
  return Math.round(courseFallback);
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
    /* To'lov bo'lsa — to'langan summa; bo'lmasa bron yaratilganda
       SAQLANGAN narx (paket mashg'uloti 660 000 bo'lishi mumkin); eng
       oxiri kurs narxidan hisoblangani. */
    /* To'langan bo'lsa — to'langan summa; aks holda bron narxi / tarif */
    price: String(p?.status) === 'paid' ? Number(p.amount) : bookingDue({ ...b, category: b.category || c?.category, duration_minutes: mins }, m.tariffs, m.pkgPrices, expected),
    is_paid: String(p?.status) === 'paid',
  };
}

/* =======================================================================
   AVTOSHKOLA CHEKI (avtodrom12 da chiqariladi, shu yerda skanerlanadi)

   Chek tekin va unda instruktor yozilmagan — kim skanerlasa o'sha
   biriktiriladi. Skanerlanganda shu yerda bron ochiladi, shuning uchun
   dars instruktor jadvalida va hisobotda ko'rinadi. Pul yo'q: bron
   bo'yicha to'lov yozuvi (payments) yaratilmaydi.
   ======================================================================= */

/** Bron kodi — mijoz kassada shuni aytadi (AVD-4821).
    Telefon orqali qo'lda bron qilinganda ham beriladi, aks holda mijoz
    kassaga kelib "bron qilganman" deydi-yu, kassir uni topolmaydi. */
async function nextPickupCode(): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const code = 'AVD-' + String(1000 + Math.floor(Math.random() * 9000));
    const busy = await supabaseRest<any[]>('bookings', {
      query: `?pickup_code=eq.${q(code)}&select=id&limit=1`,
    }).catch(() => null);
    if (busy === null) return code;      // ustun yo'q — baribir qaytaramiz
    if (!busy.length) return code;
  }
  return 'AVD-' + String(10000 + Math.floor(Math.random() * 90000));
}

/** Instruktorning shu oraliqda boshqa broni bormi.
    Bazadagi no_instructor_overlap cheklovi baribir to'sadi, lekin
    OLDINDAN bilsak chekni ishlatmaymiz va u yonib ketmaydi. */
async function instructorBusyAt(instructorId: string, start: Date, minutes: number): Promise<string | null> {
  const end = new Date(start.getTime() + minutes * 60000);
  /* Kun chegarasi bilan cheklaymiz — ro'yxat kichik bo'lsin */
  const from = new Date(start.getTime() - 12 * 3600e3).toISOString();
  const to = new Date(end.getTime() + 12 * 3600e3).toISOString();
  const rows = await supabaseRest<any[]>('bookings', {
    query: `?instructor_id=eq.${q(instructorId)}&status=in.(pending,confirmed,in_progress)` +
           `&start_at=gte.${q(from)}&start_at=lt.${q(to)}&select=id,start_at,end_at,status&limit=50`,
  }).catch(() => []);
  const hit = rows.find(b => {
    const s0 = new Date(b.start_at).getTime();
    const e0 = new Date(b.end_at || b.start_at).getTime();
    return s0 < end.getTime() && e0 > start.getTime();
  });
  if (!hit) return null;
  const t = new Intl.DateTimeFormat('uz-UZ', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
    .format(new Date(hit.start_at));
  return `Bu vaqtda sizda boshqa bron bor (${t}). Avval uni yakunlang yoki boshqa vaqtda skanerlang.`;
}

/** Avtoshkola o'quvchisi uchun mijoz yozuvi. Har o'quvchi bitta yozuv
 *  bo'lishi uchun external_ref ishlatiladi; bazada u ustun bo'lmasa
 *  telefon yoki ism bo'yicha topiladi (migratsiyasiz ham ishlaydi). */
async function schoolCustomer(rec: { student_name: string | null; student_phone: string | null; code: string }) {
  const name = String(rec.student_name || 'Avtoshkola o‘quvchisi').trim();
  const phone = String(rec.student_phone || '').trim();
  const ref = `avtodrom12:${phone || name.toLowerCase().replace(/\s+/g, ' ')}`;

  const byRef = await supabaseRest<any[]>('users', {
    query: `?external_ref=eq.${q(ref)}&select=*&limit=1`,
  }).catch(() => null);          // ustun hali yo'q bo'lsa null
  if (byRef && byRef[0]) return byRef[0];

  if (phone) {
    /* Faqat mijozlar orasidan — bir xil telefonli instruktor yoki
       admin yozuviga bron biriktirib qo'ymaslik uchun. */
    const byPhone = await supabaseRest<any[]>('users', {
      query: `?phone=eq.${q(phone)}&role=eq.customer&select=*&limit=1`,
    }).catch(() => []);
    if (byPhone[0]) return byPhone[0];
  }

  const base: any = { full_name: name, phone: phone || null, role: 'customer', is_active: true, is_blocked: false };
  try {
    return (await supabaseRest<any[]>('users', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ ...base, external_ref: ref }),
    }))[0];
  } catch {
    /* external_ref ustuni yo'q — ustunsiz yaratamiz */
    return (await supabaseRest<any[]>('users', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify(base),
    }))[0];
  }
}

/** Kod bo'yicha avtoshkola broni. Ustun bo'lmasa izohdan qidiriladi. */
async function findSchoolBooking(code: string) {
  const byCol = await supabaseRest<any[]>('bookings', {
    query: `?school_receipt_code=eq.${q(code)}&select=*&order=created_at.desc&limit=1`,
  }).catch(() => null);
  if (byCol && byCol[0]) return byCol[0];
  const byNote = await supabaseRest<any[]>('bookings', {
    query: `?customer_note=like.*${q(code)}*&select=*&order=created_at.desc&limit=1`,
  }).catch(() => []);
  return byNote[0] || null;
}

/** Instruktorning avtoshkola darsi uchun bron yaratadi. */
async function createSchoolBooking(ip: any, rec: any, code: string) {
  const start = new Date();
  const minutes = Math.max(15, Math.min(600, Math.round(Number(rec.planned_minutes || 60))));
  const end = new Date(start.getTime() + minutes * 60000);
  const customer = await schoolCustomer({ ...rec, code });

  const note = `Avtoshkola${rec.school_name ? ' · ' + rec.school_name : ''}`
    + `${rec.group_name ? ' · ' + rec.group_name : ''} · chek ${code} · to‘lovsiz`;

  const payload: any = {
    customer_id: customer.id,
    instructor_id: ip.id,
    booking_date: start.toISOString(),
    start_at: start.toISOString(),
    end_at: end.toISOString(),
    duration_minutes: minutes,
    status: 'in_progress',
    source: 'avtodrom12',
    arrived_at: start.toISOString(),
    customer_note: note,
  };

  /* Bazaning sxemasi loyihalarda biroz farq qiladi (migratsiyalar
     to'liq bajarilmagan bo'lishi mumkin). Shu sabab yozishni bosqichma-
     bosqich qayta urinamiz: baza qaysi ustundan norozi bo'lsa, o'shani
     tashlab yuboramiz. Darsning o'zi yozilishi muhim — izoh yoki
     kategoriya tushib qolsa ham mayli. */
  const body: any = { ...payload, school_receipt_code: code };
  /* Tashlab yuborilsa dars baribir to'g'ri yoziladigan ustunlar */
  const OPTIONAL = ['school_receipt_code', 'customer_note', 'arrived_at',
                    'duration_minutes', 'category', 'instructor_name'];
  let lastErr: any = null;

  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return (await supabaseRest<any[]>('bookings', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify(body),
      }))[0];
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || '');

      /* 1) Yo'q ustun — nomini xabardan ajratib, tashlaymiz */
      const dropped = OPTIONAL.find(c => msg.includes(c) && c in body);
      if (dropped) { delete body[dropped]; continue; }

      /* 2) source ustuniga CHECK qo'yilgan bo'lsa — ruxsat etilgan
            qiymatga tushamiz. Dars avtoshkolaniki ekani izohda va
            chek kodida qoladi. */
      if (/source/i.test(msg) && body.source === 'avtodrom12') {
        body.source = 'walk_in';
        continue;
      }

      /* 3) status enum'ida in_progress bo'lmasa — confirmed bilan */
      if (/status|booking_status|invalid input value for enum/i.test(msg)
          && body.status === 'in_progress') {
        body.status = 'confirmed';
        continue;
      }

      throw e;   // boshqa xato — tepaga chiqaramiz
    }
  }
  throw lastErr || new Error('Bron yozilmadi');
}

/** Skaner javobining avtoshkola ko'rinishi — frontend bir xil o'qiydi. */
function shapeSchool(rec: any, code: string, booking: any | null) {
  return {
    id: booking?.id || null,
    school_lesson: true,
    receipt_code: code,
    status: booking?.status || 'confirmed',
    start_at: booking?.start_at || null,
    duration_minutes: Number(rec.planned_minutes || 60),
    total_minutes: Number(rec.planned_minutes || 60),
    price: 0,
    is_paid: true,          // tekin — kassada to'lov kutilmaydi
    is_free: true,
    customer: { full_name: rec.student_name || 'Avtoshkola o‘quvchisi', phone: rec.student_phone || '' },
    school_name: rec.school_name || null,
    group_name: rec.group_name || null,
    course: { name: 'Avtoshkola amaliyoti' },
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
  /* =====================================================================
     AVTOSHKOLA KO'PRIGI — TASHXIS
     Instruktorga "sozlanmagan" chiqsa, administrator shu yerdan
     nima yetishmayotganini o'zi ko'radi.
     ===================================================================== */
  app.get('/api/admin/school-bridge/status', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const d = await schoolBridgeDiagnose();
      return { ok: true, bridge: d };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Tekshirib bo‘lmadi' });
    }
  });

  /* =====================================================================
     KASSIR UCHUN INSTRUKTORLAR RO'YXATI

     `/api/admin/instructors` FAQAT administrator uchun (kassirga 403).
     Shu sabab kassirda "Kunlik jadval" dagi instruktor ro'yxati va
     "Instruktor nazorati" dagi tugmalar BO'SH chiqardi — ro'yxat
     hech qachon yuklanmasdi.

     Bu yerda kassirga kerakli minimum beriladi: ismi, telefoni,
     kategoriyasi, faolligi, avtomobili. Reyting, bron tarixi va
     moliyaviy ma'lumot bu yerda yo'q.
     ===================================================================== */
  app.get('/api/admin/cashier/instructors', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);          // har qanday kirgan xodim (kassir ham)
      /* select=* — ustunlar to'plami bazadan bazaga farq qiladi;
         aniq ro'yxat yozilsa, yo'q ustun butun so'rovni yiqitardi. */
      const ips = await supabaseRest<any[]>('instructor_profiles', {
        query: '?select=*&limit=500',
      });
      const uids = [...new Set(ips.map((i: any) => i.user_id).filter(Boolean).map(String))];
      const users = uids.length
        ? await supabaseRest<any[]>('users', {
            query: `?id=in.(${uids.map(q).join(',')})&select=id,full_name,phone,is_active,is_blocked`,
          })
        : [];
      const um = new Map(users.map((u: any) => [String(u.id), u]));

      const instructors = ips.map((x: any) => {
        const u: any = um.get(String(x.user_id)) || null;
        return {
          id: x.id,
          user_id: x.user_id,
          full_name: u?.full_name || x.full_name || 'Instruktor',
          categories: Array.isArray(x.categories) ? x.categories : ['B'],
          vehicle_plate: x.vehicle_plate || null,
          vehicle_model: x.vehicle_model || null,
          active: Boolean(x.is_verified && x.is_available && u?.is_active && !u?.is_blocked),
          profile: u ? { id: u.id, full_name: u.full_name, phone: u.phone } : null,
        };
      });
      /* Ism bo'yicha tartib — ro'yxatdan ko'z bilan topish uchun. */
      instructors.sort((a: any, b: any) =>
        String(a.full_name).localeCompare(String(b.full_name), 'uz'));
      return { ok: true, instructors };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500)
        .send({ ok: false, error: e?.message || 'Instruktorlar yuklanmadi' });
    }
  });

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
      const packs = await packagesFor(bookings.map((b) => b.id));
      return { ok: true, date: day, bookings: bookings.map((b) => {
        const pk = packs.get(String(b.id));
        return { ...shape(b, m), package: pk ? { id: pk.id, n: pk.n, of: pk.of, price: pk.price } : null };
      }) };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Kunlik bronlar yuklanmadi' });
    }
  });

  /* =====================================================================
     INSTRUKTORLAR KUNLIK JADVALI (admin, operator, kassa)
     Har instruktor — bir qator, kun — ish vaqti bo'yicha. Bron qancha
     davom etsa (1 soat, 2 soat, 5 soat) — shuncha vaqt BAND ko'rinadi.
     Instruktor o'zi yopgan soatlar ham alohida belgilanadi.
     ===================================================================== */
  app.get('/api/admin/schedule', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const { start, end, day } = dayRange(String(req.query?.date || ''));
      const [ips, setRows, rows] = await Promise.all([
        supabaseRest<any[]>('instructor_profiles', { query: '?select=*&limit=500' }),
        supabaseRest<any[]>('admin_settings', { query: '?key=in.(work_start,work_end,slot_step_min)&select=key,value' }).catch(() => []),
        supabaseRest<any[]>('bookings', {
          query: `?start_at=lt.${q(end)}&end_at=gt.${q(start)}` +
                 '&status=in.(pending,confirmed,in_progress,completed,no_show)' +
                 '&select=*&order=start_at.asc&limit=1000',
        }),
      ]);
      const uids = [...new Set(ips.map((i) => i.user_id).filter(Boolean).map(String))];
      const users = await selectIn<any>('users', 'id', uids, 'id,full_name,phone,is_active,is_blocked');
      const um = new Map(users.map((u) => [String(u.id), u]));
      const withBookings = new Set(rows.map((b) => String(b.instructor_id)));
      const instructors = ips
        .map((x) => {
          const u: any = um.get(String(x.user_id)) || null;
          return {
            id: String(x.id),
            name: u?.full_name || x.full_name || 'Instruktor',
            phone: u?.phone || null,
            categories: Array.isArray(x.categories) && x.categories.length ? x.categories : ['B'],
            vehicle: [x.vehicle_model, x.vehicle_plate].filter(Boolean).join(' · ') || null,
            active: Boolean(x.is_verified && x.is_available && u?.is_active !== false && !u?.is_blocked),
          };
        })
        .filter((i) => i.active || withBookings.has(i.id))
        .sort((a, b) => a.name.localeCompare(b.name, 'uz'));

      const m = await loadMaps(rows);
      const packs = await packagesFor(rows.map((b) => b.id));
      const bookings = rows.map((raw) => {
        const b: any = shape(raw, m);
        const s = Date.parse(b.start_at);
        const e = Date.parse(raw.end_at) || s + (Number(b.duration_minutes) || 60) * 60000;
        const pk = packs.get(String(b.id));
        return {
          id: b.id, instructor_id: b.instructor_id ? String(b.instructor_id) : null,
          start_at: new Date(s).toISOString(), end_at: new Date(e).toISOString(),
          minutes: Math.round((e - s) / 60000), status: b.status, source: b.source || null,
          customer_name: b.customer?.full_name || 'Mijoz', customer_phone: b.customer?.phone || null,
          category: String(b.category || b.course?.category || '').toUpperCase() || null,
          pickup_code: b.pickup_code || null, price: b.price || 0, is_paid: !!b.is_paid,
          cancel_requested: !!(raw.cancel_requested_at && !raw.cancel_reviewed_at),
          package: pk ? { n: pk.n, of: pk.of } : null,
        };
      });

      const dayS = Date.parse(start), dayE = Date.parse(end);
      /* Instruktor o'zi yopgan soatlar + ish grafigi bo'yicha dam (off: true) */
      const bm = await loadBlocks(instructors.map((i) => i.id), { from: new Date(dayS), to: new Date(dayE) });
      const blocks: any[] = [];
      for (const [iid, list] of bm) {
        for (const x of list) {
          if (Date.parse(x.start_at) < dayE && Date.parse(x.end_at) > dayS) blocks.push({ instructor_id: iid, start_at: x.start_at, end_at: x.end_at, ...(x.off ? { off: true } : {}) });
        }
      }
      const sv = (k: string) => { const r = setRows.find((x: any) => x.key === k); return r ? (r.value?.value ?? r.value) : null; };
      const hm = (v: unknown, d: string) => /^\d{1,2}:\d{2}/.test(String(v || '')) ? String(v).slice(0, 5).padStart(5, '0') : d;
      return {
        ok: true, date: day,
        work_start: hm(sv('work_start'), '07:00'), work_end: hm(sv('work_end'), '19:00'),
        slot_step_min: Number(sv('slot_step_min')) || 60,
        instructors, bookings, blocks,
      };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Jadval yuklanmadi' });
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
     KASSA: BITTA QIDIRUV MAYDONI
     Kassir «bronli / bronsiz» tanlamaydi — bitta maydonga ism, familiya,
     telefon oxiri yoki bron kodini yozadi va to'lanmagan bronlar
     chiqadi. Topilmasa — bronsiz mijoz sifatida davom etadi.
     Bir hafta oldingidan boshlab (kechikib kelganlar ham topilsin).
     ===================================================================== */
  app.get('/api/admin/cashier/find', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const filter = await bookingSearchFilter(req.query?.q);
      if (!filter) return { ok: true, bookings: [] };
      const since = new Date(new Date(`${today()}T00:00:00+05:00`).getTime() - 7 * 864e5).toISOString();
      const rows = await supabaseRest<any[]>('bookings', {
        query: `?${filter}&booking_date=gte.${q(since)}` +
               '&status=in.(pending,confirmed,in_progress)' +
               '&select=*&order=booking_date.asc&limit=40',
      });
      const m = await loadMaps(rows);
      /* Narx: bron yaratilganda saqlangan summa (mijozga aytilgani).
         Yo'q bo'lsa — kurs narxidan hisoblangani. */
      const bookings = rows.map((raw) => {
        const b: any = shape(raw, m);
        const stored = Number(raw.price);
        return { ...b, price: Number.isFinite(stored) && stored > 0 ? stored : b.price };
      })
        .filter((b: any) => !b.is_paid)
        .slice(0, 15)
        .map((b: any) => ({
          ...b,
          category: String(b.category || b.course?.category || '').toUpperCase() || null,
        }));
      const packs = await packagesFor(bookings.map((b: any) => b.id));
      /* Paketning qaysi mashg'ulotlari to'langan — kassir «butun paketni
         to'lash» da faqat qolganini oladi. */
      const sids = [...new Set([...packs.values()].flatMap((pk) => pk.sessions.map((x) => String(x.booking_id))))];
      const paidPays = sids.length ? await selectIn<any>('payments', 'booking_id', sids, 'booking_id,status') : [];
      const paidSet = new Set(paidPays.filter((x) => String(x.status) === 'paid').map((x) => String(x.booking_id)));
      const liveRows = sids.length ? await selectIn<any>('bookings', 'id', sids, 'id,status') : [];
      const dead = new Set(liveRows.filter((x) => ['cancelled', 'rejected'].includes(String(x.status))).map((x) => String(x.id)));
      for (const b of bookings as any[]) {
        const pk = packs.get(String(b.id));
        if (pk) b.package = { id: pk.id, n: pk.n, of: pk.of, price: pk.price, list_price: pk.list_price,
          sessions: pk.sessions.filter((x) => !dead.has(String(x.booking_id)))
            .map((x) => ({ ...x, paid: paidSet.has(String(x.booking_id)) })) };
      }
      return { ok: true, bookings };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Qidiruv ishlamadi' });
    }
  });

  /* =====================================================================
     BRON KODI BO'YICHA TOPISH
     Mijoz bron qilganda AVD-XXXX kodini oladi. Kassaga kelib shu kodni
     aytadi — kassir kiritadi, hamma ma'lumot avtomatik chiqadi.
     Ism yozish, telefon qidirish shart emas.
     ===================================================================== */
  app.get('/api/admin/cashier/by-code', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      let code = String(req.query?.code || '').trim().toUpperCase();
      if (!code) return reply.code(400).send({ ok: false, error: 'Kodni kiriting' });

      // Foydalanuvchi faqat raqam yozsa ham topamiz: "4821" -> "AVD-4821"
      if (/^\d{4,5}$/.test(code)) code = `AVD-${code}`;
      if (!/^AVD-\d{4,5}$/.test(code)) {
        return reply.code(400).send({ ok: false, error: 'Kod formati: AVD-4821' });
      }

      const rows = await supabaseRest<any[]>('bookings', {
        query: `?pickup_code=eq.${q(code)}&select=*&limit=1`,
      });
      const b = rows[0];
      if (!b) return reply.code(404).send({ ok: false, error: `${code} — bunday bron topilmadi` });

      // Allaqachon to'langanmi?
      const paid = (await supabaseRest<any[]>('payments', {
        query: `?booking_id=eq.${q(String(b.id))}&status=eq.paid&select=id,receipt_code&limit=1`,
      }).catch(() => []))[0];
      if (paid) {
        return reply.code(409).send({
          ok: false,
          error: `Bu bron uchun chek allaqachon chiqarilgan (${paid.receipt_code || 'to‘langan'})`,
        });
      }

      // Bog'liq ma'lumotlar
      const [cust, ip, course] = await Promise.all([
        b.customer_id ? supabaseRest<any[]>('users', { query: `?id=eq.${q(String(b.customer_id))}&select=id,full_name,phone&limit=1` }) : Promise.resolve([]),
        b.instructor_id ? supabaseRest<any[]>('instructor_profiles', { query: `?id=eq.${q(String(b.instructor_id))}&select=id,user_id&limit=1` }) : Promise.resolve([]),
        b.course_id ? supabaseRest<any[]>('courses', { query: `?id=eq.${q(String(b.course_id))}&select=id,name,category,price,duration_minutes&limit=1` }) : Promise.resolve([]),
      ]);
      const insUser = ip[0]?.user_id
        ? (await supabaseRest<any[]>('users', { query: `?id=eq.${q(String(ip[0].user_id))}&select=full_name&limit=1` }).catch(() => []))[0]
        : null;

      return {
        ok: true,
        booking: {
          id: b.id,
          pickup_code: b.pickup_code,
          status: b.status,
          start_at: b.start_at,
          duration_minutes: b.duration_minutes || course[0]?.duration_minutes || 60,
          category: String(b.category || course[0]?.category || '').toUpperCase(),
          customer: cust[0] || (b.customer_name ? { full_name: b.customer_name } : null),
          instructor_id: b.instructor_id,
          instructor: insUser ? { profile: { full_name: insUser.full_name } } : null,
          course: course[0] || null,
          price: course[0]?.price ?? null,
        },
      };
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
      {
        const blk = await instructorBlockedAt(instructorId, start,
          new Date(start.getTime() + Number(course.duration_minutes || 60) * (Number(b.hours || 1) || 1) * 60000));
        if (blk) return reply.code(409).send({ ok: false, error: blockedMessage(blk) });
      }

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
      /* To'lov QAYSI KASSAga tushgani majburiy — aks holda u P1/P2
         hisobotlarining hech birida ko'rinmaydi. Token — kassa tanlanganda
         beriladi; kassirda o'z kassasi. */
      let registerId = await ownRegisterFromToken(req, String(req.body?.register_token || ''));
      if (!registerId) {
        const { peekStaff } = await import('./admin-password-routes.js');
        const me = peekStaff(req);
        if (me?.role === 'cashier' && me.register_id) registerId = String(me.register_id);
      }
      if (!registerId) return reply.code(400).send({ ok: false, error: 'Kassa tanlanmagan — avval kassani (P1 / P2) oching, keyin to‘lov qabul qiling.' });

      const booking = (await supabaseRest<any[]>('bookings', { query: `?id=eq.${q(bookingId)}&select=*&limit=1` }))[0];
      if (!booking) return reply.code(404).send({ ok: false, error: 'Bron topilmadi' });
      if (['cancelled', 'rejected'].includes(String(booking.status))) {
        return reply.code(409).send({ ok: false, error: 'Bekor qilingan bron uchun to‘lov qabul qilinmaydi' });
      }

      const course = booking.course_id
        ? (await supabaseRest<any[]>('courses', { query: `?id=eq.${q(String(booking.course_id))}&select=price,name,duration_minutes&limit=1` }))[0]
        : null;
      /* Standart summa: bron narxi (yoki tarif). O'zgartirish — faqat maxsus parol bilan. */
      const [tariffs, pkgPrices] = await Promise.all([loadTariffs(), loadPackagePrices()]);
      const bookedHours = Number(booking.hours ?? 1) || 1;
      const due = bookingDue(booking, tariffs, pkgPrices, Number(course?.price ?? 0) * bookedHours);
      const amount = Math.round(Number(amountRaw ?? due));
      if (!Number.isFinite(amount) || amount <= 0) return reply.code(400).send({ ok: false, error: 'Summa noto‘g‘ri' });
      const pg = await priceGuard(req, req.body?.price_token, amount, due);
      if (pg) return reply.code(pg.code).send({ ok: false, error: pg.error, needs_price_pin: true, expected: due });

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
        register_id: registerId, shift_id: await openShiftId(registerId),
        cash_amount: method === 'cash' ? amount : 0, card_amount: method === 'card' ? amount : 0,
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

  /** Chekni qayta chop etish uchun. Kassir faqat O'Z kassasining chekini. */
  app.get('/api/admin/cashier/receipt/:code', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const code = String(req.params.code || '').trim().toUpperCase();
      const payment = (await supabaseRest<any[]>('payments', { query: `?receipt_code=eq.${q(code)}&select=*&limit=1` }))[0];
      if (!payment) return reply.code(404).send({ ok: false, error: 'Chek topilmadi' });
      const { peekStaff } = await import('./admin-password-routes.js');
      const me = peekStaff(req);
      if (me && me.role === 'cashier' && payment.register_id && String(payment.register_id) !== String(me.register_id || '')) {
        return reply.code(403).send({ ok: false, error: 'Bu chek boshqa kassada chiqarilgan' });
      }
      const booking = (await supabaseRest<any[]>('bookings', { query: `?id=eq.${q(String(payment.booking_id))}&select=*&limit=1` }))[0];
      if (!booking) return reply.code(404).send({ ok: false, error: 'Bron topilmadi' });
      const m = await loadMaps([booking]);
      return { ok: true, receipt: buildReceipt(shape(booking, m), payment) };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Chek yuklanmadi' });
    }
  });


  /* =====================================================================
     CHIQARILGAN CHEKLAR — faqat shu kassaning cheklari.
     Har bir chek: qachon chiqqan, summa, mijoz, instruktor va HOLATI:
       active    — to'langan, hali ishlatilmagan (instruktor skanerlamagan)
       used      — ishlatilgan: instruktor skanerlagan / dars boshlangan
       no_show   — mijoz kelmagan
       cancelled — bekor qilingan yoki pul qaytarilgan
     Kassa tokeni orqali: kassir faqat o'z kassasini, P1 P2 ni ko'rmaydi.
     ===================================================================== */
  app.get('/api/admin/cashier/receipts', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const scope = await reportScope(req, req.query);
      if (!scope) return reply.code(401).send({ ok: false, error: 'Kassa ochilmagan — qayta kiring' });
      const registerId = scope.ids[0];
      const regCode = new Map(scope.regs.map((r) => [String(r.id), String(r.code)]));
      /* Hamma kassa: kassaga bog'lanmagan eski to'lovlar ham kiradi (hech qayerda yo'qolmasin) */
      const regFilter = scope.all
        ? `&or=(register_id.in.(${scope.ids.map(q).join(',')}),register_id.is.null)`
        : `&register_id=eq.${q(registerId)}`;
      /* DAVR: bitta kun (?date=), davr (?period=week|month|year&date=)
         yoki oraliq (?from=YYYY-MM-DD&to=YYYY-MM-DD, ikkala kun kiradi).
         Cheklar ro'yxati uchun eng uzog'i — 1 yil. */
      const { rangeFromQuery } = await import('./analytics-routes.js');
      const rq: any = { ...(req.query || {}) };
      if (!rq.date && !rq.from) rq.date = dayRange('').day;
      const rg = rangeFromQuery(rq, 'day');
      if (rg.to.getTime() - rg.from.getTime() > 367 * 864e5) {
        return reply.code(400).send({ ok: false, error: 'Cheklar uchun oraliq 1 yildan oshmasin' });
      }
      const start = rg.from.toISOString(), end = rg.to.toISOString();
      const day = rg.fromYmd || rg.anchor;

      /* PostgREST 1000 qatordan ortig'ini jimgina kesadi — sahifalab olamiz */
      const pays: any[] = [];
      for (let offset = 0; offset < 30000; offset += 1000) {
        const chunk = await supabaseRest<any[]>('payments', {
          query: `?paid_at=gte.${q(start)}&paid_at=lt.${q(end)}${regFilter}` +
                 `&select=*&order=paid_at.desc,id.desc&limit=1000&offset=${offset}`,
        });
        pays.push(...chunk);
        if (chunk.length < 1000) break;
      }
      const withCode = pays.filter((p) => p.receipt_code);
      const bids = [...new Set(withCode.map((p) => p.booking_id).filter(Boolean).map(String))];
      const bookings = await selectIn<any>('bookings', 'id', bids, '*');
      const scans = await selectIn<any>('attendance_verifications', 'booking_id', bids, 'booking_id,receipt_code,created_at', '&order=created_at.asc').catch(() => []);
      const m = await loadMaps(bookings);
      const bm = new Map(bookings.map((b) => [String(b.id), b]));
      const sm = new Map<string, any>();
      for (const x of scans) if (!sm.has(String(x.booking_id))) sm.set(String(x.booking_id), x);

      const rows = withCode.map((p) => {
        const b = bm.get(String(p.booking_id)) || null;
        const sh = b ? shape(b, m) : null;
        const scan = sm.get(String(p.booking_id)) || null;
        const bst = String(b?.status || '');
        const pst = String(p.status || '');
        /* «Bekor» — faqat PUL qaytarilgan / to'lov bekor bo'lgan chek. Bron
           bekor bo'lsa-yu pul qaytarilmagan bo'lsa — pul kassada, chek
           hisobda qoladi (kassa hisoboti bilan bir xil). */
        let state: 'active' | 'used' | 'no_show' | 'cancelled' = 'active';
        if (['refunded', 'cancelled', 'failed'].includes(pst)) state = 'cancelled';
        else if (pst !== 'paid') state = 'cancelled';
        else if (bst === 'no_show') state = 'no_show';
        else if (['in_progress', 'completed'].includes(bst) || scan) state = 'used';
        return {
          code: p.receipt_code,
          register: regCode.get(String(p.register_id)) || (p.register_id ? '?' : '—'),
          booking_cancelled: ['cancelled', 'rejected'].includes(bst),
          paid_at: p.paid_at,
          amount: Number(p.amount || 0),
          method: p.method,
          cash_amount: Number(p.cash_amount || 0),
          card_amount: Number(p.card_amount || 0),
          payment_status: pst,
          krug: /krug/i.test(String(p.note || '')),
          state,
          used_at: scan?.created_at || b?.arrived_at || null,
          finished_at: b?.departed_at || null,
          booking_id: p.booking_id,
          booking_status: bst || null,
          start_at: sh?.start_at || null,
          duration_minutes: sh?.duration_minutes || null,
          category: b?.category || sh?.course?.category || null,
          customer: sh?.customer ? { full_name: sh.customer.full_name, phone: sh.customer.phone } : null,
          instructor_name: sh?.instructor?.profile?.full_name || null,
        };
      });

      rows.sort((a, b) => String(b.paid_at || '').localeCompare(String(a.paid_at || '')));
      const count = (st: string) => rows.filter((r) => r.state === st).length;
      const paidRows = rows.filter((r) => r.state !== 'cancelled');

      /* Kunlar kesimida — uzun davrda har kun sarlavhasida jami ko'rinadi */
      const dm = new Map<string, any>();
      for (const r of rows) {
        const k = tkYmd(r.paid_at);
        if (!dm.has(k)) dm.set(k, { day: k, count: 0, cancelled: 0, amount: 0, cash: 0, card: 0 });
        const x = dm.get(k);
        if (r.state === 'cancelled') { x.cancelled++; continue; }
        x.count++; x.amount += r.amount;
        if (r.method === 'mixed') { x.cash += r.cash_amount; x.card += r.card_amount; }
        else if (r.method === 'card') x.card += r.amount; else x.cash += r.amount;
      }

      /* Qidiruv va holat filtri (uzun davrda ro'yxat qisqartirilganda
         brauzer butun davr bo'yicha serverdan qidiradi). */
      const needle = String(req.query?.q || '').trim().toLowerCase();
      const stF = String(req.query?.state || '');
      let list = stF ? rows.filter((r) => r.state === stF) : rows;
      if (needle) {
        list = list.filter((r) => [r.code, r.customer?.full_name, r.customer?.phone, r.instructor_name]
          .some((v) => String(v || '').toLowerCase().includes(needle)));
      }
      /* Javob hajmi chegarasi (Vercel ~4.5 MB): eng yangi 1500 ta chek
         qaytadi, jami raqamlar esa BUTUN davr bo'yicha hisoblanadi. */
      const LIMIT = 1500;
      return {
        ok: true, date: day, register_id: scope.all ? 'all' : registerId, scope: scope.all ? 'all' : 'one', registers: scope.regs,
        from: rg.fromYmd || rg.anchor, to: rg.toYmd || tkYmd(new Date(rg.to.getTime() - 1).toISOString()),
        summary: {
          total: rows.length, active: count('active'), used: count('used'),
          no_show: count('no_show'), cancelled: count('cancelled'),
          amount: paidRows.reduce((a, r) => a + r.amount, 0),
          cash: [...dm.values()].reduce((a, x) => a + x.cash, 0),
          card: [...dm.values()].reduce((a, x) => a + x.card, 0),
        },
        days: [...dm.values()].sort((a, b) => b.day.localeCompare(a.day)),
        matched: list.length,
        truncated: list.length > LIMIT,
        receipts: list.slice(0, LIMIT),
      };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Cheklar yuklanmadi' });
    }
  });

  /* =====================================================================
     BO'SH INSTRUKTORLAR
     Berilgan vaqt oralig'ida kim bo'sh. Hech kim bo'sh bo'lmasa — kim
     eng tez bo'shashini ham qaytaradi, kassir kutish vaqtini ko'radi.
     ===================================================================== */

  /* Narx taklifi — kassa va mijoz paneli shundan foydalanadi.
     Narx BITTA joyда hisoblanadi, shuning uchun uch panel bir xil
     raqamни ko'rsatadi. */
  app.get('/api/admin/price', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const category = String(req.query?.category || 'B');
      const minutes = Math.max(1, Math.min(600, Math.round(Number(req.query?.minutes || 60))));
      const [tariffs, packages] = await Promise.all([loadTariffs(), loadPackagePrices()]);
      return { ok: true, category: category.toUpperCase(), minutes, price: priceWithPackage(category, minutes, tariffs, packages), tariffs, packages };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: e?.message || 'Narx hisoblanmadi' });
    }
  });

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

      const uids = [...new Set(ips.map((i) => i.user_id).filter(Boolean).map(String))];
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

      /* Instruktor o'zi yopgan soatlar va ish grafigi bo'yicha dam vaqtlar ham band hisoblanadi */
      const blocks = await loadBlocks(ips.map((i) => String(i.id)), { from: new Date(dayStart), to: new Date(dayEnd) });
      /* Grafik bo'yicha dam bo'lsa «qachon bo'shaydi» — faqat shu ish kuni ichida */
      const atDay = tashkentYmdOf(at);
      const wsRow = await supabaseRest<any[]>('admin_settings', { query: '?key=eq.work_end&select=value&limit=1' }).catch(() => []);
      const weRaw = String(wsRow?.[0]?.value?.value ?? wsRow?.[0]?.value ?? '19:00');
      const workEndMs = Date.parse(`${atDay}T${/^\d{1,2}:\d{2}/.test(weRaw) ? weRaw.slice(0, 5).padStart(5, '0') : '19:00'}:00+05:00`);

      const free: any[] = [], busy: any[] = [];
      for (const ip of ips) {
        const own = (blocks.get(String(ip.id)) || []).map((x) => ({ instructor_id: ip.id, start_at: x.start_at, end_at: x.end_at, blocked: true, off: !!x.off }));
        const mine = [...busyRows.filter((b) => String(b.instructor_id) === String(ip.id)), ...own];
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
        const off = !!(clash as any).off;
        const backToday = !off || (tashkentYmdOf(freeAt) === atDay && freeAt.getTime() < workEndMs);
        busy.push({ ...info, free_at: backToday ? freeAt.toISOString() : null,
          wait_minutes: backToday ? Math.round((freeAt.getTime() - at.getTime()) / 60000) : 24 * 60,
          blocked: !!(clash as any).blocked, ...(off ? { off: true } : {}) });
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
      const b = req.body || {};
      /* Kassani ENG BOSHIDA tekshiramiz: begona yoki eskirgan kassa
         tokeni bilan kelsa, hech narsa (ko'chadan kelgan mijoz broni
         ham) yaratilmaydi. */
      if (!(await ownRegisterFromToken(req, String(b.register_token || '')))) {
        return reply.code(401).send({ ok: false, error: 'Kassa ochilmagan yoki muddati tugagan. P1 yoki P2 ni PIN bilan qayta oching.' });
      }
      const admin = await adminUser();

      const mode = b.booking_id ? 'booked' : 'walk_in';
      /* 1 KRUG — bronsiz, bitta aylana: narxi va vaqti sozlamadan */
      const krug = mode === 'walk_in' && (b.krug === true || b.krug === 'true');
      const krugCfg = krug ? await loadKrug() : null;
      if (krug && !(krugCfg!.price > 0)) return reply.code(400).send({ ok: false, error: '«1 krug» o‘chirilgan (Narxlar bo‘limida narxini kiriting)' });
      if (krug && Array.isArray(b.sessions) && b.sessions.length) return reply.code(400).send({ ok: false, error: '1 krug paket bo‘la olmaydi' });
      const minutes = krug ? krugCfg!.minutes : Math.max(15, Math.min(600, Math.round(Number(b.duration_minutes || 60))));
      const cash = Math.max(0, Number(b.cash_amount || 0));
      const card = Math.max(0, Number(b.card_amount || 0));
      /* Server narxni O'ZI hisoblaydi. Kassir summani o'zgartirishi
         mumkin (chegirma, qo'shimcha), lekin katta farq bo'lsa
         bu xato belgisi — yozib qo'yamiz va javobda qaytaramiz.
         5 soat — paket narxi (standart 1 100 000). */
      const [tariffs, pkgPrices] = await Promise.all([loadTariffs(), loadPackagePrices()]);
      const suggested = krug ? krugCfg!.price : priceWithPackage(String(b.category || 'B'), minutes, tariffs, pkgPrices);
      const total = Math.round(Number(b.amount ?? suggested));

      if (!(total > 0)) return reply.code(400).send({ ok: false, error: 'Summani kiriting' });
      if (cash + card !== total) {
        return reply.code(400).send({ ok: false, error: `Naqd (${cash}) + terminal (${card}) = ${cash + card}, jami esa ${total}. Mos kelmadi.` });
      }
      /* NARXNI O'ZGARTIRISH — faqat maxsus parol bilan (token). Bronsiz
         chekda tekshiruv HECH NARSA yaratilmasidan oldin. */
      let expected = Math.round(suggested);

      /* Chek qaysi KASSAdan chiqarilgani — mijoz yuborgan qiymatdan EMAS,
         imzolangan TOKENdan olinadi. */
      const registerId = await ownRegisterFromToken(req, String(b.register_token || ''));
      const register = registerId ? (await supabaseRest<any[]>('cash_registers', {
        query: `?id=eq.${q(registerId)}&is_active=eq.true&select=id,code,name&limit=1`,
      }))[0] : null;
      if (!register) return reply.code(404).send({ ok: false, error: 'Kassa topilmadi' });

      /* Chek chiqadigan bronlar. Odatda bitta; paketda — har mashg'ulotga
         alohida chek (instruktor har darsda o'z chekini skanerlaydi). */
      let targets: any[] = [];
      let packageInfo: { id: string; price: number; list_price: number; of: number } | null = null;

      if (mode === 'booked') {
        const booking = (await supabaseRest<any[]>('bookings', { query: `?id=eq.${q(String(b.booking_id))}&select=*&limit=1` }))[0];
        if (!booking) return reply.code(404).send({ ok: false, error: 'Bron topilmadi' });
        if (['cancelled', 'rejected'].includes(String(booking.status))) {
          return reply.code(409).send({ ok: false, error: 'Bekor qilingan bron uchun chek chiqarilmaydi' });
        }
        if (b.pay_package) {
          /* Butun paketni bir marta to'lash — to'lanmagan hamma mashg'ulotlar */
          const pk = await packageOf(String(booking.id));
          if (!pk) return reply.code(400).send({ ok: false, error: 'Bu bron paketga tegishli emas' });
          const ids = pk.sessions.map((s) => s.booking_id);
          const [rows, pays] = await Promise.all([
            selectIn<any>('bookings', 'id', ids, '*'),
            selectIn<any>('payments', 'booking_id', ids, 'booking_id,status'),
          ]);
          const paid = new Set(pays.filter((p) => String(p.status) === 'paid').map((p) => String(p.booking_id)));
          targets = rows
            .filter((r) => !paid.has(String(r.id)) && !['cancelled', 'rejected'].includes(String(r.status)))
            .sort((x, y) => String(x.start_at).localeCompare(String(y.start_at)));
          if (!targets.length) return reply.code(409).send({ ok: false, error: 'Paketning hamma mashg‘ulotlari allaqachon to‘langan' });
          packageInfo = { id: pk.id, price: pk.price, list_price: pk.list_price, of: pk.of };
          expected = targets.reduce((a, t) => a + bookingDue(t, tariffs, pkgPrices), 0);
          const g = await priceGuard(req, b.price_token, total, expected);
          if (g) return reply.code(g.code).send({ ok: false, error: g.error, needs_price_pin: true, expected });
        } else {
          /* Kassada davomiylik o'zgartirilsa — yangi davomiylik tarifi; aks holda bron narxi */
          const sameLen = Number(booking.duration_minutes || 0) === minutes;
          expected = sameLen ? bookingDue(booking, tariffs, pkgPrices) : priceWithPackage(String(b.category || booking.category || 'B').toUpperCase(), minutes, tariffs, pkgPrices);
          const g = await priceGuard(req, b.price_token, total, expected);
          if (g) return reply.code(g.code).send({ ok: false, error: g.error, needs_price_pin: true, expected });
          targets = [booking];
          // Bronli holatda ham davomiylik/kategoriya kassada aniqlanishi mumkin
          if (Number(booking.duration_minutes || 0) !== minutes || b.category) {
            const start = new Date(booking.start_at || booking.booking_date);
            targets = [(await supabaseRest<any[]>('bookings', {
              method: 'PATCH', headers: { Prefer: 'return=representation' }, query: `?id=eq.${q(String(booking.id))}`,
              body: JSON.stringify({
                duration_minutes: minutes,
                end_at: new Date(start.getTime() + minutes * 60000).toISOString(),
                category: b.category || booking.category || null,
                status: booking.status === 'pending' ? 'confirmed' : booking.status,
                updated_at: new Date().toISOString(),
              }),
            }))[0] ?? booking];
          }
        }
      } else {
        const fullName = String(b.full_name || '').trim();
        const phone = String(b.phone || '').trim();
        const instructorId = String(b.instructor_id || '').trim();
        const courseId = String(b.course_id || '').trim();
        /* BRONSIZ CHEK — mijoz HOZIR keldi, bron qilmayapti. Shuning uchun
           dars doim serverdagi REAL hozirgi vaqt bilan boshlanadi: brauzer
           yuborgan start_at hisobga olinmaydi (soati noto'g'ri kompyuter
           yoki eski oynadan kelgan vaqt chekka tushmasin). Kelajakdagi vaqt
           kerak bo'lsa — bu bron: operator «Qo'lda bron» qiladi. */
        const start = new Date();
        if (fullName.length < 2) return reply.code(400).send({ ok: false, error: 'Ism familiyani kiriting' });
        if (!instructorId) return reply.code(400).send({ ok: false, error: 'Instruktor tanlanmagan' });
        if (!courseId) return reply.code(400).send({ ok: false, error: 'Mashg‘ulot tanlanmagan' });

        /* 5 soat — paket (faqat B toifa): bir kunda yoki bir necha kunga bo'lingan.
           A va C da 5 soat — oddiy bron, soatlik tarif bilan. */
        const pkgOn = packagePriceOf(String(b.category || ''), pkgPrices) > 0;
        const isPackage = !krug && ((minutes === PACKAGE_MINUTES && pkgOn) || (Array.isArray(b.sessions) && b.sessions.length > 0));
        if (isPackage && !pkgOn) return reply.code(400).send({ ok: false, error: '5 soatlik paket faqat B toifa uchun' });
        let sessions: Session[] = [{ start, end: new Date(start.getTime() + minutes * 60000), minutes }];
        if (isPackage) {
          /* Paketda ham 1-mashg'ulot — HOZIR; keyingilari (boshqa kunlar)
             kassir tanlagan vaqtda, lekin o'tmishda bo'lolmaydi. */
          const raw = Array.isArray(b.sessions) && b.sessions.length
            ? b.sessions.map((x: any, i: number) => (i === 0 ? { ...x, start_at: start.toISOString() } : x))
            : [{ start_at: start.toISOString(), minutes: PACKAGE_MINUTES }];
          const parsed = parseSessions(raw, { rejectPast: true, graceMs: 120000 });
          if ('error' in parsed) return reply.code(400).send({ ok: false, error: parsed.error });
          sessions = parsed.sessions;
        }
        for (const s of sessions) {
          const blk = await instructorBlockedAt(instructorId, s.start, s.end);
          if (blk) return reply.code(409).send({ ok: false, error: blockedMessage(blk) });
        }
        /* Bronsiz chekda narx tekshiruvi — mijoz ham, bron ham hali yaratilmagan */
        {
          const g = await priceGuard(req, b.price_token, total, expected);
          if (g) return reply.code(g.code).send({ ok: false, error: g.error, needs_price_pin: true, expected });
        }

        let customer: any = b.customer_id
          ? (await supabaseRest<any[]>('users', { query: `?id=eq.${q(String(b.customer_id))}&select=*&limit=1` }))[0]
          : null;
        if (!customer && phone) {
          customer = (await supabaseRest<any[]>('users', { query: `?phone=eq.${q(phone)}&select=*&limit=1` }))[0];
        }
        /* Band vaqtga chek chiqmasin: instruktor yoki mijoz shu paytda band */
        const clash = await sessionConflict(instructorId, customer?.id ? String(customer.id) : null, sessions);
        if (clash) return reply.code(409).send({ ok: false, error: clash });
        if (!customer) {
          customer = (await supabaseRest<any[]>('users', {
            method: 'POST', headers: { Prefer: 'return=representation' },
            body: JSON.stringify({ full_name: fullName, phone: phone || null, role: 'customer', is_active: true, is_blocked: false }),
          }))[0];
        }

        const now = new Date().toISOString();
        if (isPackage) {
          const cat = String(b.category || '').toUpperCase();
          if (!/^[ABC]$/.test(cat)) return reply.code(400).send({ ok: false, error: 'Paket uchun kategoriyani tanlang' });
          const { bookings, record } = await createPackage({
            customerId: String(customer.id), instructorId, courseId, category: cat, sessions,
            status: 'confirmed', source: 'walk_in', extra: { confirmed_at: now, confirmed_by: admin.id },
            total, tariffs, prices: pkgPrices, newCode: nextPickupCode,
          });
          targets = bookings;
          packageInfo = { id: record.id, price: record.price, list_price: record.list_price, of: bookings.length };
        } else {
          targets = [(await supabaseRest<any[]>('bookings', {
            method: 'POST', headers: { Prefer: 'return=representation' },
            body: JSON.stringify({
              customer_id: customer.id, instructor_id: instructorId, course_id: courseId,
              booking_date: start.toISOString(), start_at: start.toISOString(),
              end_at: new Date(start.getTime() + minutes * 60000).toISOString(),
              duration_minutes: minutes, category: b.category || null,
              status: 'confirmed', source: 'walk_in', confirmed_at: now, confirmed_by: admin.id,
              ...(krug ? { customer_note: '1 krug' } : {}),
            }),
          }))[0]];
        }
      }

      /* Bitta bronda — o'sha bron allaqachon to'langanmi */
      const existingAll = await selectIn<any>('payments', 'booking_id', targets.map((t) => t.id), '*');
      const existingBy = new Map(existingAll.map((p) => [String(p.booking_id), p]));
      if (targets.length === 1) {
        const ex = existingBy.get(String(targets[0].id));
        if (ex && String(ex.status) === 'paid') {
          return reply.code(409).send({ ok: false, error: `Bu bron allaqachon to‘langan. Chek: ${ex.receipt_code || '—'}` });
        }
      }

      /* Summani bronlarga bo'lamiz: har bronning o'z narxiga qarab
         (paket 3+2 → 660 000 + 440 000). Naqd/terminal ham shu nisbatda. */
      const shiftId = await openShiftId(String(register.id));
      const base = targets.map((t) => Number(t.price) > 0 ? Number(t.price) : 1);
      const amounts = targets.length === 1 ? [total] : splitBy(total, base);
      const cashParts = splitCapped(cash, amounts);

      const receipts: any[] = [], payments: any[] = [], shapedAll: any[] = [];
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        if (t.status === 'pending') {
          await supabaseRest('bookings', {
            method: 'PATCH', query: `?id=eq.${q(String(t.id))}`,
            body: JSON.stringify({ status: 'confirmed', confirmed_at: new Date().toISOString(), confirmed_by: admin.id, updated_at: new Date().toISOString() }),
          }).catch(() => null);
        }
        const codeRes = await supabaseRest<any>('rpc/generate_receipt_code', { method: 'POST', body: '{}' });
        const receiptCode = typeof codeRes === 'string' ? codeRes : String(codeRes ?? '');
        if (!receiptCode) throw new Error('Chek kodi yaratilmadi');
        const c = cashParts[i], k = amounts[i] - cashParts[i];
        const method = c > 0 && k > 0 ? 'mixed' : (k > 0 ? 'card' : 'cash');
        const payload = {
          booking_id: t.id, customer_id: t.customer_id, amount: amounts[i], currency: 'UZS',
          status: 'paid', method, cash_amount: c, card_amount: k,
          paid_at: new Date().toISOString(), receipt_code: receiptCode, cashier_id: admin.id, register_id: register.id, shift_id: shiftId,
          note: krug ? '1 krug' : (String(b.note || '').trim() || (packageInfo ? `5 soatlik paket · ${i + 1}/${targets.length}` : null)),
        };
        const existing = existingBy.get(String(t.id));
        const payment = existing
          ? (await supabaseRest<any[]>('payments', {
              method: 'PATCH', headers: { Prefer: 'return=representation' },
              query: `?id=eq.${q(String(existing.id))}`, body: JSON.stringify(payload) }))[0]
          : (await supabaseRest<any[]>('payments', {
              method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(payload) }))[0];
        await audit(admin.id, 'RECEIPT_ISSUED', 'payments', payment?.id ?? null, null,
          { amount: amounts[i], suggested: expected, price_override: total !== expected ? { expected, total } : undefined, method, cash: c, card: k, receipt_code: receiptCode, booking_id: t.id, mode, krug,
            register: register.code, package: packageInfo?.id || null });
        payments.push(payment);
      }

      const fresh = await selectIn<any>('bookings', 'id', targets.map((t) => t.id), '*');
      const fm = new Map(fresh.map((x) => [String(x.id), x]));
      const m = await loadMaps(fresh);
      targets.forEach((t, i) => {
        const shaped: any = shape(fm.get(String(t.id)) || t, m);
        shaped.__register = register.name;
        if (packageInfo) shaped.package = { ...packageInfo, n: i + 1 };
        shapedAll.push(shaped);
        const r: any = buildReceipt(shaped, payments[i]);
        if (packageInfo) r.package_text = `5 soatlik paket · ${i + 1}/${targets.length}`;
        receipts.push(r);
      });
      return reply.code(201).send({
        ok: true, mode, booking: shapedAll[0], payment: payments[0], receipt: receipts[0],
        bookings: shapedAll, payments, receipts, package: packageInfo,
      });
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

      /* 5 soat — paket (faqat B toifa): bir kunda yoki bir necha kunga bo'lingan.
         A va C da 5 soat — oddiy bron, soatlik tarif bilan. */
      const [tariffs, pkgPrices] = await Promise.all([loadTariffs(), loadPackagePrices()]);
      const isPackage = (minutes === PACKAGE_MINUTES && packagePriceOf(category, pkgPrices) > 0)
        || (Array.isArray(b.sessions) && b.sessions.length > 0);
      if (isPackage && !(packagePriceOf(category, pkgPrices) > 0)) {
        return reply.code(400).send({ ok: false, error: '5 soatlik paket faqat B toifa uchun' });
      }
      let sessions: Session[] = [{ start, end: new Date(start.getTime() + minutes * 60000), minutes }];
      if (isPackage) {
        const raw = Array.isArray(b.sessions) && b.sessions.length ? b.sessions : [{ start_at: start.toISOString(), minutes: PACKAGE_MINUTES }];
        const parsed = parseSessions(raw);
        if ('error' in parsed) return reply.code(400).send({ ok: false, error: parsed.error });
        sessions = parsed.sessions;
      }

      // Instruktor shu kategoriyani o'rgatadimi?
      const ins = (await supabaseRest<any[]>('instructor_profiles', {
        query: `?id=eq.${q(instructorId)}&select=id,categories,is_verified,is_available&limit=1`,
      }))[0];
      if (!ins) return reply.code(404).send({ ok: false, error: 'Instruktor topilmadi' });
      const cats: string[] = Array.isArray(ins.categories) ? ins.categories : ['B'];
      if (!cats.includes(category)) {
        return reply.code(409).send({ ok: false, error: `Bu instruktor ${category} kategoriyani o‘rgatmaydi` });
      }
      /* Instruktor bu soatni o'zi yopgan bo'lsa — qo'lda bron ham qilinmaydi */
      for (const s of sessions) {
        const blk = await instructorBlockedAt(instructorId, s.start, s.end);
        if (blk) return reply.code(409).send({ ok: false, error: blockedMessage(blk) });
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
      /* Band vaqtga bron yozilmasin. Ilgari faqat bazadagi cheklovga
         tayanilardi — u bo'lmasa, 2 soatlik bronning ikkinchi soatiga
         boshqa mijoz yozilib qolardi. */
      const clash = await sessionConflict(instructorId, customer?.id ? String(customer.id) : null, sessions);
      if (clash) return reply.code(409).send({ ok: false, error: clash });
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

      const now = new Date().toISOString();
      const note = String(b.note || '').trim();

      if (isPackage) {
        const { bookings, record } = await createPackage({
          customerId: String(customer.id), instructorId, courseId: String(course.id), category, sessions,
          status: 'confirmed', source: 'admin', extra: { confirmed_at: now, confirmed_by: admin.id },
          note: note || 'Telefon orqali qo‘lda bron', tariffs, prices: pkgPrices, newCode: nextPickupCode,
        });
        await audit(admin.id, 'MANUAL_BOOKING_CREATED', 'bookings', bookings[0]?.id ?? null, null,
          { customer: fullName, phone, category, minutes: PACKAGE_MINUTES, package: record.id, sessions: bookings.length });
        const pkg = { id: record.id, price: record.price, list_price: record.list_price, of: bookings.length };
        return reply.code(201).send({
          ok: true, booking: bookings[0], bookings, customer, course, package: pkg,
          pickup_code: bookings[0]?.pickup_code || null,
          pickup_codes: bookings.map((x) => x.pickup_code).filter(Boolean),
        });
      }

      const end = new Date(start.getTime() + minutes * 60000);
      const pickupCode = await nextPickupCode();
      const price = priceWithPackage(category, minutes, tariffs, pkgPrices);
      const base = {
        customer_id: customer.id, instructor_id: instructorId, course_id: course.id,
        booking_date: start.toISOString(), start_at: start.toISOString(), end_at: end.toISOString(),
        duration_minutes: minutes, hours: Math.max(1, Math.round(minutes / 60)), category, price,
        status: 'confirmed', source: 'admin',
        confirmed_at: now, confirmed_by: admin.id,
        customer_note: note || 'Telefon orqali qo‘lda bron',
      };
      const rows = await supabaseRest<any[]>('bookings', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ ...base, pickup_code: pickupCode }),
      }).catch(async (e: any) => {
        /* pickup_code ustuni hali yo'q bo'lsa — kodsiz yozamiz */
        if (/pickup_code/i.test(String(e?.message || ''))) {
          return await supabaseRest<any[]>('bookings', {
            method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(base),
          });
        }
        throw e;
      });
      const booking = rows[0];
      await audit(admin.id, 'MANUAL_BOOKING_CREATED', 'bookings', booking?.id ?? null, null,
        { customer: fullName, phone, category, minutes });

      return reply.code(201).send({
        ok: true, booking, customer, course,
        pickup_code: booking?.pickup_code || pickupCode,
      });
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
      const code = match ? match[0] : normalizeSchoolCode(raw);
      if (!code) return reply.code(400).send({ ok: false, error: 'Kod bo‘sh' });

      /* AVTOSHKOLA CHEKI (AVS-12345) — avtodrom12 da chiqarilgan.
         Uni shu yerdagi payments emas, o'sha server tekshiradi. */
      if (isSchoolReceiptCode(code)) {
        if (!schoolBridgeReady()) {
          return reply.code(503).send({ ok: false,
            error: `Avtoshkola cheklari hali sozlanmagan (${schoolBridgeMissing()}). `
                 + 'Administrator: Boshqaruv → Sozlamalar → «Avtoshkola cheklari» bo‘limiga qarang.' });
        }
        const rec = await verifySchoolReceipt(code);
        if (rec.status === 'cancelled') return reply.code(409).send({ ok: false, error: 'Bu chek bekor qilingan' });
        if (rec.status === 'scanned') {
          const existing = await findSchoolBooking(code);
          const mine = existing && String(existing.instructor_id) === String(ip.id);
          return reply.code(409).send({
            ok: false,
            error: mine
              ? 'Bu chek bo‘yicha darsingiz allaqachon boshlangan'
              : `Bu chek allaqachon ishlatilgan${rec.scanned_by_name ? ` (${rec.scanned_by_name})` : ''}`,
          });
        }
        return {
          ok: true,
          booking: shapeSchool(rec, code, null),
          can_start: true,
          can_finish: false,
          already: null,
          receipt_code: code,
          school_lesson: true,
        };
      }

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

      const rawStart = String((request.body as any)?.code || '').trim().toUpperCase();
      const code = /AVD-\d{6}-[0-9A-Z]{5}/.test(rawStart)
        ? (rawStart.match(/AVD-\d{6}-[0-9A-Z]{5}/) as RegExpMatchArray)[0]
        : normalizeSchoolCode(rawStart);

      /* AVTOSHKOLA CHEKI — avtodrom12 da "ishlatilgan" deb belgilanadi,
         shu yerda esa bron ochiladi. Chek bir marta ishlaydi: redeem
         tranzaksiya ichida, ikkinchi urinishda 409 qaytadi. */
      if (isSchoolReceiptCode(code)) {
        if (!schoolBridgeReady()) {
          return reply.code(503).send({ ok: false,
            error: `Avtoshkola cheklari hali sozlanmagan (${schoolBridgeMissing()}). `
                 + 'Administrator: Boshqaruv → Sozlamalar → «Avtoshkola cheklari» bo‘limiga qarang.' });
        }
        const active = (await supabaseRest<any[]>('bookings', {
          query: `?instructor_id=eq.${q(String(ip.id))}&status=eq.in_progress&select=id&limit=1`,
        }))[0];
        if (active) {
          return reply.code(409).send({
            ok: false,
            error: 'Avvalgi dars yakunlanmagan. Avval uni yakunlang, keyin yangisini boshlang.',
            active_booking_id: active.id,
          });
        }

        /* Chekni ISHLATISHDAN OLDIN vaqt bo'shligini tekshiramiz.
           Avval tekshirmasdan ishlatardik: instruktorning yaqin soatda
           boshqa broni bo'lsa bron yozilmay, chek esa yonib ketardi. */
        const peek = await verifySchoolReceipt(code);
        const mins = Math.max(15, Math.min(600, Math.round(Number(peek.planned_minutes || 60))));
        const clash = await instructorBusyAt(String(ip.id), new Date(), mins);
        if (clash) {
          return reply.code(409).send({ ok: false, error: clash });
        }

        const insName = String(user?.full_name || '').trim() || null;
        const { receipt: rec, note } = await redeemSchoolReceipt({
          code,
          instructorName: insName,
          instructorRef: String(ip.id),
          vehiclePlate: ip.vehicle_plate || null,
        });

        let booking: any = null;
        try {
          booking = await createSchoolBooking(ip, rec, code);
        } catch (e: any) {
          /* Bron yozilmadi — chekni QAYTARAMIZ, aks holda o'quvchining
             tekin darsi yo'qolib ketadi va uni tiklab bo'lmaydi. */
          const msg = String(e?.message || '');
          console.error('[school-receipt] booking create failed:', msg);
          const back = await releaseSchoolReceipt({ code, receiptId: rec.id, reason: 'Bron yozilmadi: ' + msg.slice(0, 120) });
          const why = /no_instructor_overlap|instructor_overlap/i.test(msg)
            ? 'Bu vaqtda sizda boshqa bron bor.'
            : /no_customer_overlap|customer_overlap/i.test(msg)
            ? 'Bu o‘quvchining shu vaqtda boshqa darsi bor.'
            : /bookings_one_active_lesson/i.test(msg)
            ? 'Avvalgi dars yakunlanmagan.'
            : 'Dars yozilmadi.';
          /* Texnik sababni ham qaytaramiz: bo'lmasa administrator
             nimani tuzatishni bilmaydi va xato qayta-qayta takrorlanadi. */
          return reply.code(409).send({
            ok: false,
            error: why + (back
              ? ' Chek saqlanib qoldi — muammo hal bo‘lgach qayta skanerlang.'
              : ' Chekni qaytarib bo‘lmadi, administratorga ayting: ' + code),
            detail: msg.slice(0, 300),
            code,
          });
        }

        /* attendance_verifications ga yozmaymiz: bu jadval customer_id,
           telegram_user_id va token_epoch ni majburiy talab qiladi,
           bizda ular yo'q. Skaner izi bookings.school_receipt_code va
           avtodrom12 dagi scanned_by_name da qoladi. */

        return { ok: true, school_lesson: true, booking: shapeSchool(rec, code, booking), note: note || null };
      }

      const payment = (await supabaseRest<any[]>('payments', { query: `?receipt_code=eq.${q(code)}&status=eq.paid&select=*&limit=1` }))[0];
      if (!payment) return reply.code(404).send({ ok: false, error: 'To‘langan chek topilmadi' });

      const booking = (await supabaseRest<any[]>('bookings', { query: `?id=eq.${q(String(payment.booking_id))}&select=*&limit=1` }))[0];
      if (!booking) return reply.code(404).send({ ok: false, error: 'Bron topilmadi' });
      if (String(booking.instructor_id) !== String(ip.id)) return reply.code(403).send({ ok: false, error: 'Bu bron sizga tegishli emas' });
      if (String(booking.status) !== 'confirmed') {
        const st = String(booking.status);
        /* Mijoz kech qoldi — bron avtomatik yopilgan. Instruktor nima
           qilishni bilsin: kassadan yangi chek. */
        const why = st === 'no_show' || st === 'cancelled'
          ? 'Bron yopilgan: mijoz dars vaqtidan kech qoldi yoki bron bekor qilingan. Kassadan yangi chek oling.'
          : st === 'in_progress' ? 'Bu chek bilan dars allaqachon boshlangan'
          : st === 'completed' ? 'Bu chek bilan dars allaqachon o‘tgan'
          : `Bron holati "${st}" — boshlab bo‘lmaydi`;
        return reply.code(409).send({ ok: false, error: why, status: st });
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
    krug_text: /krug/i.test(String(p.note || '')) ? '1 krug' : null,
    cash_amount: Number(p.cash_amount || 0),
    card_amount: Number(p.card_amount || 0),
    paid_at: p.paid_at,
    paid_at_text: fmtWhen(p.paid_at),
    booking_id: b.id,
    register: b.__register || null,
  };
}
