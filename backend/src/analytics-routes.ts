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

      const bookings: any[] = [];
      for (let offset = 0; offset < 60000; offset += 1000) {
        const chunk = await supabaseRest<any[]>('bookings', {
          query:
            `?instructor_id=not.is.null&start_at=gte.${q(from.toISOString())}&start_at=lt.${q(to.toISOString())}` +
            `&select=*&order=start_at.asc,id.asc&limit=1000&offset=${offset}`,
        });
        bookings.push(...chunk);
        if (chunk.length < 1000) break;
      }

      const ids = bookings.map((b) => String(b.id));
      const cids = [...new Set(bookings.map((b) => b.course_id).filter(Boolean).map(String))];
      const payFilter = regId ? `&register_id=eq.${q(regId)}` : '';
      const [ips, courses, pays] = await Promise.all([
        supabaseRest<any[]>('instructor_profiles', { query: '?select=*&limit=1000' }),
        selectIn<any>('courses', 'id', cids, 'id,duration_minutes'),
        selectIn<any>('payments', 'booking_id', ids, 'booking_id,amount,method,status,cash_amount,card_amount,register_id', payFilter),
      ]);
      const uids = [...new Set(ips.map((i: any) => i.user_id).filter(Boolean).map(String))];
      const users = await selectIn<any>('users', 'id', uids, 'id,full_name,phone,is_active,is_blocked');
      const um = new Map(users.map((u) => [String(u.id), u]));
      const cm = new Map(courses.map((c) => [String(c.id), c]));
      const pm = payMap(pays);

      /* Kassir uchun: P2 sotgan dars P1 hisobotiga umuman tushmaydi */
      const scoped = regId ? bookings.filter((b) => isSchoolLesson(b) || pm.has(String(b.id))) : bookings;

      const blank = () => ({ lessons: 0, completed: 0, minutes: 0, revenue: 0, _st: new Set<string>() });
      const acc = new Map<string, any>();
      const ensure = (id: string) => {
        if (!acc.has(id)) {
          acc.set(id, {
            id, bookings: 0, lessons: 0, completed: 0, minutes: 0, revenue: 0, cash: 0, card: 0,
            no_show: 0, cancelled: 0, _st: new Set<string>(), _days: new Set<string>(),
            school: blank(), paid: blank(),
          });
        }
        return acc.get(id);
      };
      const tot = { bookings: 0, lessons: 0, completed: 0, minutes: 0, revenue: 0, cash: 0, card: 0, no_show: 0, cancelled: 0,
        _st: new Set<string>(), school: blank(), paid: blank() };
      const days = new Map<string, any>();

      for (const b of scoped) {
        const x = ensure(String(b.instructor_id));
        const p = pm.get(String(b.id));
        const amount = p && p.status === 'paid' ? Number(p.amount || 0) : 0;
        const st = String(b.status || '');
        const school = isSchoolLesson(b);
        const kind = school ? 'school' : 'paid';
        const who = b.customer_id ? String(b.customer_id) : `x${b.id}`;
        const attended = st === 'in_progress' || st === 'completed';
        const mins = st === 'completed' ? lessonMinutes(b, cm.get(String(b.course_id))) : 0;
        let cash = 0, card = 0;
        if (amount) {
          if (p.method === 'mixed') { cash = Number(p.cash_amount || 0); card = Number(p.card_amount || 0); }
          else if (p.method === 'card') card = amount; else cash = amount;
        }
        for (const t of [x, tot]) {
          t.bookings++; t.revenue += amount; t.cash += cash; t.card += card;
          if (st === 'no_show') t.no_show++;
          if (st === 'cancelled' || st === 'rejected') t.cancelled++;
          if (attended) {
            t.lessons++; t._st.add(who);
            t[kind].lessons++; t[kind]._st.add(who); t[kind].revenue += amount;
            if (st === 'completed') { t.completed++; t.minutes += mins; t[kind].completed++; t[kind].minutes += mins; }
          }
        }
        const dk = tashkentYmd(b.start_at || b.booking_date);
        if (attended && dk) x._days.add(dk);
        if (dk) {
          if (!days.has(dk)) days.set(dk, { day: dk, lessons: 0, school: 0, paid: 0, minutes: 0, revenue: 0, _st: new Set<string>() });
          const d = days.get(dk);
          d.revenue += amount;
          if (attended) { d.lessons++; d[kind]++; d._st.add(who); d.minutes += mins; }
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
          working: instructors.filter((i) => i.lessons > 0).length },
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


      /* PostgREST bir so'rovda 1000 qator qaytaradi. Oylik hisobotda
         shu chegara jim turib natijani kamaytirib qo'ymasin — to'lgunicha
         sahifalab olamiz. */
      const bookings: any[] = [];
      for (let offset = 0; offset < 10000; offset += 1000) {
        const chunk = await supabaseRest<any[]>('bookings', {
          query:
            `?instructor_id=eq.${q(instructorId)}` +
            `&start_at=gte.${q(from.toISOString())}&start_at=lt.${q(to.toISOString())}` +
            `&select=*&order=start_at.asc&limit=1000&offset=${offset}`,
        });
        bookings.push(...chunk);
        if (chunk.length < 1000) break;
      }

      const ids = bookings.map((b) => String(b.id));
      const uids = [...new Set(bookings.map((b) => b.customer_id).filter(Boolean).map(String))];
      const cids = [...new Set(bookings.map((b) => b.course_id).filter(Boolean).map(String))];

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
      const payFilter = regId ? `&register_id=eq.${q(regId)}` : '';

      /* Bo'laklab — uzoq davrda ham hech bir to'lov yoki skaner tushib qolmaydi */
      const [users, courses, pays, scans] = await Promise.all([
        selectIn<any>('users', 'id', uids, 'id,full_name,phone'),
        selectIn<any>('courses', 'id', cids, 'id,name,duration_minutes,price'),
        selectIn<any>('payments', 'booking_id', ids, 'booking_id,amount,method,status,receipt_code,paid_at,cash_amount,card_amount', payFilter),
        selectIn<any>('attendance_verifications', 'booking_id', ids, 'booking_id,method,receipt_code,created_at'),
      ]);
      const um = new Map(users.map((u) => [String(u.id), u]));
      const cm = new Map(courses.map((c) => [String(c.id), c]));
      const pm = payMap(pays);
      const sm = new Map(scans.map((s) => [String(s.booking_id), s]));

      /* ?own=1 — kassa rejimida faqat SHU kassada sotilgan darslar
         (va kassaga bog'liq bo'lmagan avtoshkola darslari) qoladi:
         P1 kassiri P2 sotgan darslarni umuman ko'rmaydi. */
      if (regId && String(req.query?.own || '') === '1') {
        const keep = bookings.filter((b) => isSchoolLesson(b) || pm.has(String(b.id)));
        bookings.length = 0; bookings.push(...keep);
      }

      /* Dars davomiyligi: bronda yozilgani ASOSIY. Ilgari faqat
         mashg'ulot (course) qiymati olinardi — kassada 90 daqiqaga
         yozilgan dars ham 60 daqiqa bo'lib hisoblanardi. */
      const minutesOf = (b: any, c: any) => lessonMinutes(b, c);

      /* AVTOSHKOLA darsi: avtodrom12 dan kelgan QR chek bilan ochilgan,
         pul olinmaydi. Qolganlari — pullik (platniy). */
      const isSchool = (b: any) => isSchoolLesson(b);

      const rows = bookings.map((b) => {
        const c = cm.get(String(b.course_id));
        const p = pm.get(String(b.id));
        const s = sm.get(String(b.id));
        return {
          id: b.id,
          start_at: b.start_at || b.booking_date,
          end_at: b.end_at || null,
          arrived_at: b.arrived_at,
          departed_at: b.departed_at,
          status: b.status,
          source: b.source,
          school: isSchool(b),
          school_receipt_code: b.school_receipt_code || null,
          category: b.category || c?.category || null,
          customer_id: b.customer_id ? String(b.customer_id) : null,
          customer: um.get(String(b.customer_id)) || null,
          course: c || null,
          duration_minutes: minutesOf(b, c),
          amount: p?.status === 'paid' ? Number(p.amount || 0) : 0,
          method: p?.method || null,
          cash_amount: p?.status === 'paid' ? Number(p.cash_amount || 0) : 0,
          card_amount: p?.status === 'paid' ? Number(p.card_amount || 0) : 0,
          receipt_code: p?.receipt_code || null,
          scanned: !!s,
          scanned_at: s?.created_at || null,
        };
      });

      const done = rows.filter((r) => r.status === 'completed');
      /* «Kelgan» dars: boshlangan yoki tugagan. O'quvchi sonini shu
         bo'yicha sanaymiz — bekor qilingan bron o'quvchi emas. */
      const attended = rows.filter((r) => ['in_progress', 'completed'].includes(String(r.status)));
      const uniq = (list: any[]) =>
        new Set(list.map((r) => r.customer_id || `x${r.id}`)).size;

      const group = (list: any[]) => ({
        lessons: list.length,
        completed: list.filter((r) => r.status === 'completed').length,
        students: uniq(list),
        minutes: list.filter((r) => r.status === 'completed')
          .reduce((a, r) => a + Number(r.duration_minutes || 0), 0),
        revenue: list.reduce((a, r) => a + r.amount, 0),
      });

      /* Har bir o'quvchi kesimida — oy oxiri hisob-kitobi uchun */
      const byStudent = new Map<string, any>();
      for (const r of attended) {
        const key = r.customer_id || `x${r.id}`;
        if (!byStudent.has(key)) {
          byStudent.set(key, {
            id: r.customer_id, name: r.customer?.full_name || 'Noma’lum',
            phone: r.customer?.phone || null,
            lessons: 0, school: 0, paid: 0, minutes: 0, amount: 0, last_at: null as string | null,
          });
        }
        const s = byStudent.get(key);
        s.lessons++;
        if (r.school) s.school++; else s.paid++;
        if (r.status === 'completed') s.minutes += Number(r.duration_minutes || 0);
        s.amount += r.amount;
        if (!s.last_at || String(r.start_at) > s.last_at) s.last_at = r.start_at;
      }
      const students = [...byStudent.values()].sort((a, b) => b.lessons - a.lessons);

      return {
        ok: true,
        period, label, anchor,
        from: from.toISOString(), to: to.toISOString(),
        scoped_to_register: !!regId,
        summary: {
          bookings: rows.length,
          completed: done.length,
          no_show: rows.filter((r) => r.status === 'no_show').length,
          cancelled: rows.filter((r) => ['cancelled', 'rejected'].includes(String(r.status))).length,
          scanned: rows.filter((r) => r.scanned).length,
          receipts: rows.filter((r) => r.receipt_code).length,
          minutes: done.reduce((a, r) => a + Number(r.duration_minutes || 0), 0),
          revenue: rows.reduce((a, r) => a + r.amount, 0),
          /* Aralash (naqd + karta) to'lov ham ikkiga bo'linadi — ilgari tushib qolardi */
          cash: rows.reduce((a, r) => a + (r.method === 'mixed' ? r.cash_amount : r.method === 'card' ? 0 : r.amount), 0),
          card: rows.reduce((a, r) => a + (r.method === 'mixed' ? r.card_amount : r.method === 'card' ? r.amount : 0), 0),
          /* Oy oxiridagi hisob-kitob uchun */
          students: uniq(attended),
          school: group(attended.filter((r) => r.school)),
          paid: group(attended.filter((r) => !r.school)),
        },
        students,
        rows,
      };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Instruktor hisoboti yuklanmadi' });
    }
  });
}
