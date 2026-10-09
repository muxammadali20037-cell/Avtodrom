import type { FastifyInstance } from 'fastify';
import { lessonMinutes, isSchoolLesson, tashkentYmd } from './lesson-math.js';
import { supabaseRest } from './supabase.js';
import { selectIn } from './rest-chunks.js';
import { computeRetention } from './retention.js';

/**
 * HISOBOT VA ANALITIKA
 *
 * Hisob bazada (analytics_report SQL funksiyasi) bajariladi.
 * Sabab: yillik hisobot minglab qatorni o'z ichiga oladi va PostgREST
 * 1000 qator bilan cheklaydi — qatorlarni tortib olib JS'da hisoblash
 * yillik natijani jimgina noto'g'ri chiqarardi.
 */

const TZ = 'Asia/Tashkent';
const q = (v: string) => encodeURIComponent(v);
const todayTk = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

/** Davr chegaralarini Toshkent vaqti bo'yicha hisoblaydi. */
export function periodRange(period: string, anchor?: string) {
  const base = /^\d{4}-\d{2}-\d{2}$/.test(String(anchor)) ? String(anchor) : todayTk();
  const [Y, M, D] = base.split('-').map(Number);
  const at5 = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - 5 * 3600e3);

  let from: Date, to: Date, bucket: 'hour' | 'day' | 'week' | 'month', label: string;
  switch (period) {
    case 'week': {
      // Dushanbadan boshlanadi
      const ref = at5(Y, M, D);
      const dow = (new Date(ref.getTime() + 5 * 3600e3).getUTCDay() + 6) % 7;
      from = new Date(ref.getTime() - dow * 864e5);
      to = new Date(from.getTime() + 7 * 864e5);
      bucket = 'day'; label = 'Haftalik';
      break;
    }
    case 'month':
      from = at5(Y, M, 1);
      to = at5(M === 12 ? Y + 1 : Y, M === 12 ? 1 : M + 1, 1);
      bucket = 'day'; label = 'Oylik';
      break;
    case 'year':
      from = at5(Y, 1, 1); to = at5(Y + 1, 1, 1);
      bucket = 'month'; label = 'Yillik';
      break;
    default:
      from = at5(Y, M, D); to = new Date(from.getTime() + 864e5);
      bucket = 'hour'; label = 'Kunlik';
  }
  return { from, to, bucket, label, anchor: base };
}

/**
 * So'rovdan davr: `?from=YYYY-MM-DD&to=YYYY-MM-DD` berilsa — aynan shu
 * oraliq (ikkala kun ham KIRADI, Toshkent vaqti bilan; yil almashsa ham
 * to'g'ri: 1-oktabr → 3-yanvar). Berilmasa — `?period=&date=` (eski usul).
 */
export function rangeFromQuery(query: any, fallbackPeriod = 'day') {
  const isYmd = (v: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const f = String(query?.from || ''), t = String(query?.to || '');
  if (isYmd(f) && isYmd(t)) {
    /* 2025-13-45 kabi sana jimgina boshqa kunga aylanib ketmasin */
    const real = (v: string) => { const d = new Date(`${v}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; };
    if (!real(f) || !real(t)) { const e: any = new Error('Sana noto‘g‘ri'); e.statusCode = 400; throw e; }
    const [a, b] = f <= t ? [f, t] : [t, f];
    const at5 = (ymd: string) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d) - 5 * 3600e3); };
    const from = at5(a), to = new Date(at5(b).getTime() + 864e5);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      const e: any = new Error('Sana noto‘g‘ri'); e.statusCode = 400; throw e;
    }
    const days = Math.round((to.getTime() - from.getTime()) / 864e5);
    if (days > 3 * 366) { const e: any = new Error('Oraliq 3 yildan oshmasin'); e.statusCode = 400; throw e; }
    const bucket: 'hour' | 'day' | 'month' = days <= 1 ? 'hour' : days <= 62 ? 'day' : 'month';
    const fmt = (ymd: string) => { const [y, m, d] = ymd.split('-').map(Number); return `${d}.${String(m).padStart(2, '0')}.${y}`; };
    return { from, to, bucket, label: `${fmt(a)} — ${fmt(b)}`, anchor: a, period: 'range', fromYmd: a, toYmd: b, days };
  }
  const period = String(query?.period || fallbackPeriod);
  return { ...periodRange(period, query?.date), period, fromYmd: '', toYmd: '', days: 0 };
}

async function report(from: Date, to: Date, bucket: string) {
  const res = await supabaseRest<any>('rpc/analytics_report', {
    method: 'POST',
    body: JSON.stringify({ p_from: from.toISOString(), p_to: to.toISOString(), p_bucket: bucket }),
  });
  return res ?? {};
}

/** Bir bronga bir necha to'lov yozuvi bo'lishi mumkin (qaytarilgan +
 *  qayta to'langan). Hisobotda TO'LANGANI ustun turadi. */
function payMap(pays: any[]) {
  const m = new Map<string, any>();
  for (const p of pays) {
    const k = String(p.booking_id);
    const cur = m.get(k);
    if (!cur || (cur.status !== 'paid' && p.status === 'paid')) m.set(k, p);
  }
  return m;
}

export async function registerAnalyticsRoutes(
  app: FastifyInstance,
  requireAdmin: (request: any) => Promise<void>,
  /* «Instruktor nazorati» kassir menyusida ham bor — u kassirning
     kundalik ishi (kim qachon ishlagan, nechta chek urilgan). Shu sabab
     unga alohida, yumshoqroq tekshiruv beriladi: har qanday kirgan
     xodim. Umumiy biznes statistikasi (analytics) esa avvalgidek
     faqat administrator uchun qoladi.
     Berilmasa — eski xatti-harakat: hammasi faqat administrator. */
  requireStaff: (request: any) => Promise<void> = requireAdmin,
) {
  /**
   * Umumiy hisobot.
   * ?period=day|week|month|year  &date=YYYY-MM-DD
   * Oldingi davr bilan solishtirish ham qaytariladi.
   */
  app.get('/api/admin/analytics', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const { from, to, bucket, label, anchor, period } = rangeFromQuery(req.query);

      // Oldingi davr — bir xil uzunlikda
      const span = to.getTime() - from.getTime();
      const prevFrom = new Date(from.getTime() - span);

      const [current, previous] = await Promise.all([
        report(from, to, bucket),
        report(prevFrom, from, bucket),
      ]);

      const t = current.totals || {};
      const p = previous.totals || {};
      const delta = (a: any, b: any) => {
        const x = Number(a || 0), y = Number(b || 0);
        if (!y) return x ? 100 : 0;
        return Math.round(((x - y) / y) * 100);
      };

      return {
        ok: true,
        period, label, anchor,
        from: from.toISOString(), to: to.toISOString(), bucket,
        totals: t,
        previous: { totals: p },
        change: {
          bookings: delta(t.bookings, p.bookings),
          completed: delta(t.completed, p.completed),
          revenue: delta(t.revenue, p.revenue),
          customers: delta(t.customers, p.customers),
        },
        series: current.series || [],
        instructors: current.instructors || [],
        courses: current.courses || [],
        categories: current.categories || [],
        hours: current.hours || [],
        heatmap: current.heatmap || [],
      };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Hisobot yuklanmadi' });
    }
  });

  /**
   * INSTRUKTORLAR HISOBOTI — barcha instruktorlar bitta jadvalda.
   * ?from=YYYY-MM-DD&to=YYYY-MM-DD (ikkala kun kiradi) yoki ?period=&date=
   *
   * Har instruktor bo'yicha: nechta o'quvchi haydadi (noyob), nechta
   * AVTOSHKOLA darsi va nechta PULLIK dars, soat, tushum.
   * Hisob qoidasi «Instruktor nazorati» bilan AYNAN bir xil:
   *   dars (o'tilgan) — boshlangan yoki tugagan bron;
   *   soat — tugagan darslar davomiyligi; tushum — to'langan summa.
   *
   * Kassir: faqat o'z kassasida sotilgan darslar + avtoshkola darslari
   * (ular hech bir kassaga bog'liq emas). Kassa ID tokendan/sessiyadan.
   */
  app.get('/api/admin/instructor-report', async (req: any, reply: any) => {
    try {
      await requireStaff(req);
      const { from, to, label, anchor, period, fromYmd, toYmd } = rangeFromQuery(req.query);

      const { peekStaff } = await import('./admin-password-routes.js');
      const me: any = peekStaff(req);
      if (me && me.role === 'operator') return reply.code(403).send({ ok: false, error: 'Bu hisobot kassa va administrator uchun' });
      let regId: string | null = null;
      if (me && me.role === 'cashier') regId = String(me.register_id || '00000000-0000-0000-0000-000000000000');

      /* HISOB URILGAN CHEK BO'YICHA (lesson-ledger.ts): dars — chekni
         URGAN instruktorniki, kuni — chek urilgan kun, pul — o'sha chek. */
      const { loadLedger, unscannedReceipts, pageAll } = await import('./lesson-ledger.js');
      const [ledger, unscanned, events, ips] = await Promise.all([
        loadLedger({ from, to, registerId: regId }),
        unscannedReceipts({ from, to, registerId: regId }),
        /* «Kelmadi» / «bekor» — bron hodisasi (chek emas), bron instruktoriga */
        pageAll<any>('bookings',
          `?instructor_id=not.is.null&status=in.(no_show,cancelled,rejected)&start_at=gte.${q(from.toISOString())}&start_at=lt.${q(to.toISOString())}&select=id,instructor_id,status&order=start_at.asc,id.asc`),
        supabaseRest<any[]>('instructor_profiles', { query: '?select=*&limit=1000' }),
      ]);
      let evRows = events;
      if (regId && evRows.length) {
        const own = new Set((await selectIn<any>('payments', 'booking_id', evRows.map((b) => b.id), 'booking_id,register_id', `&register_id=eq.${q(regId)}`)).map((p) => String(p.booking_id)));
        evRows = evRows.filter((b) => own.has(String(b.id)));
      }
      const uids = [...new Set(ips.map((i: any) => i.user_id).filter(Boolean).map(String))];
      const users = await selectIn<any>('users', 'id', uids, 'id,full_name,phone,is_active,is_blocked');
      const um = new Map(users.map((u) => [String(u.id), u]));

      const blank = () => ({ lessons: 0, completed: 0, minutes: 0, revenue: 0, _st: new Set<string>() });
      const acc = new Map<string, any>();
      const ensure = (id: string) => {
        if (!acc.has(id)) {
          acc.set(id, {
            id, bookings: 0, lessons: 0, completed: 0, minutes: 0, revenue: 0, cash: 0, card: 0,
            no_show: 0, cancelled: 0, transferred_in: 0, _st: new Set<string>(), _days: new Set<string>(),
            school: blank(), paid: blank(),
          });
        }
        return acc.get(id);
      };
      const tot = { bookings: 0, lessons: 0, completed: 0, minutes: 0, revenue: 0, cash: 0, card: 0, no_show: 0, cancelled: 0,
        transferred_in: 0, _st: new Set<string>(), school: blank(), paid: blank() };
      const days = new Map<string, any>();

      for (const r of ledger.rows) {
        if (!r.instructor_id) continue;
        const x = ensure(r.instructor_id);
        const kind = r.school ? 'school' : 'paid';
        const who = r.customer_id || `x${r.booking_id}`;
        const done = r.status === 'completed';
        for (const t of [x, tot]) {
          t.bookings++; t.lessons++; t._st.add(who);
          t.revenue += r.amount; t.cash += r.cash; t.card += r.card;
          t.minutes += r.minutes;
          t[kind].lessons++; t[kind]._st.add(who); t[kind].revenue += r.amount; t[kind].minutes += r.minutes;
          if (done) { t.completed++; t[kind].completed++; }
          if (r.from_instructor_id) t.transferred_in++;
        }
        x._days.add(r.day);
        if (!days.has(r.day)) days.set(r.day, { day: r.day, lessons: 0, school: 0, paid: 0, minutes: 0, revenue: 0, _st: new Set<string>() });
        const d = days.get(r.day);
        d.lessons++; d[kind]++; d._st.add(who); d.minutes += r.minutes; d.revenue += r.amount;
      }
      for (const b of evRows) {
        const x = ensure(String(b.instructor_id));
        for (const t of [x, tot]) {
          if (b.status === 'no_show') t.no_show++; else t.cancelled++;
        }
      }

      const fin = (g: any) => { const { _st, ...rest } = g; return { ...rest, students: _st.size }; };
      /* Ro'yxatda HAMMA instruktor bor — shu davrda dars o'tmaganlar ham
         (0 bilan), shunda kim ishlamagani ham ko'rinadi. */
      const ipm = new Map(ips.map((i: any) => [String(i.id), i]));
      for (const i of ips) {
        const u: any = um.get(String(i.user_id));
        const active = Boolean(i.is_verified && i.is_available && u?.is_active && !u?.is_blocked);
        if (active) ensure(String(i.id));
      }
      const instructors = [...acc.values()].map((x) => {
        const i: any = ipm.get(x.id) || {};
        const u: any = um.get(String(i.user_id)) || {};
        const { _st, _days, school, paid, ...rest } = x;
        return {
          ...rest,
          name: u.full_name || i.full_name || 'Instruktor',
          phone: u.phone || null,
          vehicle_plate: i.vehicle_plate || null,
          students: _st.size,
          work_days: _days.size,
          school: fin(school),
          paid: fin(paid),
        };
      }).sort((a, b) => b.students - a.students || b.lessons - a.lessons || String(a.name).localeCompare(String(b.name), 'uz'));

      const { _st: tst, school: ts, paid: tp, ...trest } = tot;
      return {
        ok: true, period, label, anchor,
        from: from.toISOString(), to: to.toISOString(),
        from_day: fromYmd || tashkentYmd(from.toISOString()),
        to_day: toYmd || tashkentYmd(new Date(to.getTime() - 1).toISOString()),
        scoped_to_register: !!regId,
        totals: { ...trest, students: tst.size, school: fin(ts), paid: fin(tp),
          working: instructors.filter((i) => i.lessons > 0).length,
          /* To'langan, lekin hali hech kim urmagan cheklar — hech bir instruktorga yozilmagan */
          unscanned: { receipts: unscanned.receipts, amount: unscanned.amount } },
        basis: 'scanned_receipts',
        instructors,
        days: [...days.values()].map((d) => { const { _st, ...r } = d; return { ...r, students: _st.size }; })
          .sort((a, b) => a.day.localeCompare(b.day)),
      };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Instruktorlar hisoboti yuklanmadi' });
    }
  });

  /**
   * O'QUVCHINI QAYTARISH — instruktorlar reytingi (qoidasi: retention.ts).
   * ?from=YYYY-MM-DD&to=YYYY-MM-DD — BIRINCHI pullik darsi shu davrga
   * tushgan yangi o'quvchilar va ular 7 kun ichida o'sha instruktorga
   * qaytdimi. Faqat administrator.
   */
  app.get('/api/admin/retention', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const { from, to, fromYmd, toYmd } = rangeFromQuery(req.query, 'week');
      const fromDay = fromYmd || tashkentYmd(from.toISOString());
      const toDay = toYmd || tashkentYmd(new Date(to.getTime() - 1).toISOString());
      const today = todayTk();

      /* 1) O'tilgan pullik darslar — BUTUN tarix: o'quvchining birinchi
            darsi qachon va kimga bo'lganini bilish uchun kerak. */
      const raw: any[] = [];
      for (let offset = 0; offset < 200000; offset += 1000) {
        const chunk = await supabaseRest<any[]>('bookings', {
          query:
            '?instructor_id=not.is.null&customer_id=not.is.null&status=in.(in_progress,completed)' +
            '&select=id,customer_id,instructor_id,start_at,booking_date,end_at,duration_minutes,source,school_receipt_code,customer_note' +
            `&order=start_at.asc,id.asc&limit=1000&offset=${offset}`,
        });
        raw.push(...chunk);
        if (chunk.length < 1000) break;
      }
      const lessons = raw.filter((b) => !isSchoolLesson(b)).map((b) => ({
        id: String(b.id), customer_id: String(b.customer_id), instructor_id: String(b.instructor_id),
        at: String(b.start_at || b.booking_date || ''), day: tashkentYmd(b.start_at || b.booking_date), minutes: lessonMinutes(b),
      })).filter((l) => l.day);

      /* 2) Keyingi bronlar — «band qilgan» belgisi uchun */
      const upRaw = await supabaseRest<any[]>('bookings', {
        query:
          '?instructor_id=not.is.null&customer_id=not.is.null&status=in.(pending,confirmed)' +
          `&start_at=gte.${q(new Date(Date.now() - 864e5).toISOString())}` +
          '&select=id,customer_id,instructor_id,start_at,booking_date,source,school_receipt_code,customer_note&order=start_at.asc&limit=3000',
      });
      const upcoming = upRaw.filter((b) => !isSchoolLesson(b)).map((b) => ({
        customer_id: String(b.customer_id), instructor_id: String(b.instructor_id),
        at: String(b.start_at || b.booking_date || ''), day: tashkentYmd(b.start_at || b.booking_date),
      })).filter((u) => u.day);

      /* 3) Mijozlar — ism va telefon (bitta odamni telefon bo'yicha birlashtirish) */
      const cids = [...new Set([...lessons, ...upcoming].map((l) => l.customer_id))];
      const custs = await selectIn<any>('users', 'id', cids, 'id,full_name,phone');
      const people = new Map(custs.map((u) => [String(u.id), { name: u.full_name, phone: u.phone }]));

      const r = computeRetention({ lessons, upcoming, people, fromDay, toDay, today });

      /* 4) Takroriy darslardan tushum */
      const repIds = [...r.perIns.values()].flatMap((g) => g.students.flatMap((s) => s.repeat_ids));
      const pm = payMap(repIds.length ? await selectIn<any>('payments', 'booking_id', repIds, 'booking_id,amount,status') : []);
      const paidOf = (id: string) => { const p = pm.get(id); return p && p.status === 'paid' ? Number(p.amount || 0) : 0; };

      /* 5) Instruktorlar — faollari hammasi (0 bilan ham), o'chirilganlari
            faqat shu davrda yangi o'quvchisi bo'lsa */
      const ips = await supabaseRest<any[]>('instructor_profiles', { query: '?select=*&limit=1000' });
      const uids = [...new Set(ips.map((i: any) => i.user_id).filter(Boolean).map(String))];
      const iusers = await selectIn<any>('users', 'id', uids, 'id,full_name,phone,is_active,is_blocked');
      const um = new Map(iusers.map((u) => [String(u.id), u]));
      const ipm = new Map(ips.map((i: any) => [String(i.id), i]));
      const nameOf = (id: string) => {
        const i: any = ipm.get(id); const u: any = i ? um.get(String(i.user_id)) : null;
        return u?.full_name || i?.full_name || 'O‘chirilgan instruktor';
      };
      const ids = new Set<string>(r.perIns.keys());
      for (const i of ips) {
        const u: any = um.get(String(i.user_id));
        if (i.is_verified && i.is_available && u?.is_active !== false && !u?.is_blocked) ids.add(String(i.id));
      }

      let totalRevenue = 0;
      const instructors = [...ids].map((id) => {
        const g = r.perIns.get(id);
        const i: any = ipm.get(id) || {};
        const u: any = um.get(String(i.user_id)) || {};
        let revenue = 0;
        const students = (g?.students || []).map(({ repeat_ids, ...s }) => {
          const rev = repeat_ids.reduce((a, x) => a + paidOf(x), 0);
          revenue += rev;
          return { ...s, revenue: rev, moved_to_name: s.moved_to ? nameOf(s.moved_to) : null };
        });
        totalRevenue += revenue;
        return {
          id, name: nameOf(id), phone: u.phone || null, vehicle_plate: i.vehicle_plate || null,
          active: Boolean(i.is_available), ...(g?.agg || { new: 0, returned: 0, waiting: 0, booked: 0, moved: 0, lost: 0, rate: null, visits: 0, minutes: 0 }),
          revenue, students,
        };
      }).sort((a, b) =>
        (b.rate ?? -1) - (a.rate ?? -1) || b.returned - a.returned || b.new - a.new || String(a.name).localeCompare(String(b.name), 'uz'));

      return {
        ok: true, from_day: fromDay, to_day: toDay, today, window_days: r.windowDays,
        totals: { ...r.total, revenue: totalRevenue, instructors_with_new: instructors.filter((x) => x.new > 0).length },
        instructors,
      };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Qaytish hisoboti yuklanmadi' });
    }
  });

  /**
   * INSTRUKTOR NAZORATI
   * Bitta instruktor bo'yicha: nechta chek skanerlangan, soat nechada,
   * qaysi mijoz, qancha pul. Har bir dars alohida qatorda.
   */
  app.get('/api/admin/instructor-control/:id', async (req: any, reply: any) => {
    try {
      await requireStaff(req);          // kassir ham ko'radi (o'z ishi)
      const instructorId = String(req.params.id);
      const period = String(req.query?.period || 'day');

      /* YANGI: dan-gacha oraliq qo'llab-quvvatlash.
         Agar from va to berilsa, periodRange() o'rniga to'g'ridan ishlatamiz. */
      let from: Date, to: Date, label: string, anchor: string;
      const qFrom = String(req.query?.from || '');
      const qTo = String(req.query?.to || '');
      if (/^\d{4}-\d{2}-\d{2}$/.test(qFrom) && /^\d{4}-\d{2}-\d{2}$/.test(qTo)) {
        const [fY, fM, fD] = qFrom.split('-').map(Number);
        const [tY, tM, tD] = qTo.split('-').map(Number);
        from = new Date(Date.UTC(fY, fM - 1, fD, 0, 0, 0) - 5 * 3600e3);
        to = new Date(Date.UTC(tY, tM - 1, tD + 1, 0, 0, 0) - 5 * 3600e3); // keyingi kun boshigacha
        label = `${qFrom} — ${qTo}`;
        anchor = qFrom;
      } else {
        const pr = periodRange(period, req.query?.date);
        from = pr.from; to = pr.to; label = pr.label; anchor = pr.anchor;
      }


      /* Kassa rejimida faqat o'sha kassaning to'lovlari ko'rinadi —
         P1 kassiri P2 yiqqan pulni ko'rmasligi kerak. Kassa ID'si
         tokendan olinadi, so'rovdan emas. */
      const { ownRegisterFromToken } = await import('./shift-routes.js');
      let regId = await ownRegisterFromToken(req, String(req.query?.token || ''));
      /* Kassir tokensiz so'rasa ham faqat o'z kassasining pulini ko'radi */
      if (!regId) {
        const { peekStaff } = await import('./admin-password-routes.js');
        const me = peekStaff(req);
        if (me && me.role === 'cashier') regId = me.register_id || '00000000-0000-0000-0000-000000000000';
      }
      const ownOnly = !!regId && String(req.query?.own || '') === '1';

      /* HISOB URILGAN CHEK BO'YICHA: shu instruktor URGAN cheklar,
         kuni — chek urilgan kun (lesson-ledger.ts). */
      const { loadLedger, pageAll } = await import('./lesson-ledger.js');
      const [ledger, events] = await Promise.all([
        loadLedger({ from, to, instructorId, registerId: ownOnly ? regId : null }),
        pageAll<any>('bookings',
          `?instructor_id=eq.${q(instructorId)}&status=in.(no_show,cancelled,rejected)` +
          `&start_at=gte.${q(from.toISOString())}&start_at=lt.${q(to.toISOString())}&select=*&order=start_at.asc,id.asc`),
      ]);
      let evRows = events;
      if (ownOnly && evRows.length) {
        const own = new Set((await selectIn<any>('payments', 'booking_id', evRows.map((b) => b.id), 'booking_id', `&register_id=eq.${q(String(regId))}`)).map((p) => String(p.booking_id)));
        evRows = evRows.filter((b) => own.has(String(b.id)));
      }
      const uids = [...new Set([...ledger.rows.map((r) => r.customer_id), ...evRows.map((b) => b.customer_id)].filter(Boolean).map(String))];
      const fromIns = [...new Set(ledger.rows.map((r) => r.from_instructor_id).filter(Boolean).map(String))];
      const [users, fromIps] = await Promise.all([
        selectIn<any>('users', 'id', uids, 'id,full_name,phone'),
        selectIn<any>('instructor_profiles', 'id', fromIns, 'id,user_id'),
      ]);
      const fromUsers = await selectIn<any>('users', 'id', fromIps.map((i) => i.user_id), 'id,full_name');
      const um = new Map(users.map((u) => [String(u.id), u]));
      const fum = new Map(fromUsers.map((u) => [String(u.id), u.full_name]));
      const fromName = new Map(fromIps.map((i) => [String(i.id), fum.get(String(i.user_id)) || null]));

      /* Boshqa kassaning (yoki kassasiz) puli va cheki kassirga ko'rinmaydi —
         dars ko'rinadi, summa 0 */
      const hideMoney = (r: any) => !!regId && String(r.register_id || '') !== String(regId);
      const rows = ledger.rows.map((r) => {
        const b = ledger.bookings.get(r.booking_id) || {};
        const c = r.course_id ? ledger.courses.get(r.course_id) : null;
        const hid = hideMoney(r);
        return {
          id: r.booking_id,
          start_at: r.scanned_at,                  // dars boshlangan (chek urilgan) vaqt
          booked_at: r.start_at,                   // mijoz bron qilgan vaqt
          end_at: b.end_at || null,
          arrived_at: r.scanned_at,
          departed_at: b.departed_at || null,
          status: r.status,
          source: b.source || null,
          school: r.school,
          school_receipt_code: b.school_receipt_code || null,
          category: r.category,
          customer_id: r.customer_id,
          customer: (r.customer_id && um.get(r.customer_id)) || null,
          course: c || null,
          duration_minutes: r.minutes,
          amount: hid ? 0 : r.amount,
          method: hid ? null : r.method,
          cash_amount: hid ? 0 : r.cash,
          card_amount: hid ? 0 : r.card,
          receipt_code: hid && r.register_id ? null : r.receipt_code,
          scanned: true,
          scanned_at: r.scanned_at,
          basis: r.source,
          transferred_from: r.from_instructor_id ? (fromName.get(r.from_instructor_id) || 'boshqa instruktor') : null,
        };
      });
      /* «Kelmadi» / «bekor» — ma'lumot uchun (dars emas, hisobga kirmaydi) */
      const extra = evRows.map((b) => ({
        id: b.id, start_at: b.start_at || b.booking_date, booked_at: b.start_at || b.booking_date, end_at: b.end_at || null,
        arrived_at: null, departed_at: null, status: b.status, source: b.source || null, school: isSchoolLesson(b),
        school_receipt_code: b.school_receipt_code || null, category: b.category || null,
        customer_id: b.customer_id ? String(b.customer_id) : null, customer: um.get(String(b.customer_id)) || null,
        course: null, duration_minutes: lessonMinutes(b), amount: 0, method: null, cash_amount: 0, card_amount: 0,
        receipt_code: null, scanned: false, scanned_at: null, basis: 'event', transferred_from: null,
      }));

      const uniq = (list: any[]) => new Set(list.map((r) => r.customer_id || `x${r.id}`)).size;
      const group = (list: any[]) => ({
        lessons: list.length,
        completed: list.filter((r) => r.status === 'completed').length,
        students: uniq(list),
        minutes: list.reduce((a, r) => a + Number(r.duration_minutes || 0), 0),
        revenue: list.reduce((a, r) => a + r.amount, 0),
      });

      /* Har bir o'quvchi kesimida — oy oxiri hisob-kitobi uchun */
      const byStudent = new Map<string, any>();
      for (const r of rows) {
        const key = r.customer_id || `x${r.id}`;
        if (!byStudent.has(key)) {
          byStudent.set(key, {
            id: r.customer_id, name: r.customer?.full_name || 'Noma’lum',
            phone: r.customer?.phone || null,
            lessons: 0, school: 0, paid: 0, minutes: 0, amount: 0, last_at: null as string | null,
          });
        }
        const st = byStudent.get(key);
        st.lessons++;
        if (r.school) st.school++; else st.paid++;
        st.minutes += Number(r.duration_minutes || 0);
        st.amount += r.amount;
        if (!st.last_at || String(r.start_at) > st.last_at) st.last_at = r.start_at;
      }
      const students = [...byStudent.values()].sort((a, b) => b.lessons - a.lessons);

      return {
        ok: true,
        period, label, anchor,
        from: from.toISOString(), to: to.toISOString(),
        scoped_to_register: !!regId,
        basis: 'scanned_receipts',
        summary: {
          bookings: rows.length,
          completed: rows.filter((r) => r.status === 'completed').length,
          no_show: evRows.filter((b) => b.status === 'no_show').length,
          cancelled: evRows.filter((b) => ['cancelled', 'rejected'].includes(String(b.status))).length,
          scanned: rows.length,
          receipts: rows.filter((r) => r.receipt_code).length,
          transferred_in: rows.filter((r) => r.transferred_from).length,
          minutes: rows.reduce((a, r) => a + Number(r.duration_minutes || 0), 0),
          revenue: rows.reduce((a, r) => a + r.amount, 0),
          cash: rows.reduce((a, r) => a + r.cash_amount, 0),
          card: rows.reduce((a, r) => a + r.card_amount, 0),
          /* Oy oxiridagi hisob-kitob uchun */
          students: uniq(rows),
          school: group(rows.filter((r) => r.school)),
          paid: group(rows.filter((r) => !r.school)),
        },
        students,
        rows: [...rows, ...extra].sort((a, b) => String(a.start_at).localeCompare(String(b.start_at))),
      };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Instruktor hisoboti yuklanmadi' });
    }
  });
}
