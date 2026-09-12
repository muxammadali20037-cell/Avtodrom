import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';

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

async function report(from: Date, to: Date, bucket: string) {
  const res = await supabaseRest<any>('rpc/analytics_report', {
    method: 'POST',
    body: JSON.stringify({ p_from: from.toISOString(), p_to: to.toISOString(), p_bucket: bucket }),
  });
  return res ?? {};
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
      const period = String(req.query?.period || 'day');
      const { from, to, bucket, label, anchor } = periodRange(period, req.query?.date);

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
      const { readRegisterToken } = await import('./shift-routes.js');
      const regId = readRegisterToken(String(req.query?.token || ''));
      const payFilter = regId ? `&register_id=eq.${q(regId)}` : '';

      const [users, courses, pays, scans] = await Promise.all([
        uids.length ? supabaseRest<any[]>('users', { query: `?id=in.(${uids.map(q).join(',')})&select=id,full_name,phone` }) : [],
        cids.length ? supabaseRest<any[]>('courses', { query: `?id=in.(${cids.map(q).join(',')})&select=id,name,duration_minutes,price` }) : [],
        ids.length ? supabaseRest<any[]>('payments', { query: `?booking_id=in.(${ids.map(q).join(',')})&select=booking_id,amount,method,status,receipt_code,paid_at${payFilter}` }) : [],
        ids.length ? supabaseRest<any[]>('attendance_verifications', { query: `?booking_id=in.(${ids.map(q).join(',')})&select=booking_id,method,receipt_code,created_at` }) : [],
      ]);
      const um = new Map(users.map((u) => [String(u.id), u]));
      const cm = new Map(courses.map((c) => [String(c.id), c]));
      const pm = new Map(pays.map((p) => [String(p.booking_id), p]));
      const sm = new Map(scans.map((s) => [String(s.booking_id), s]));

      /* Dars davomiyligi: bronda yozilgani ASOSIY. Ilgari faqat
         mashg'ulot (course) qiymati olinardi — kassada 90 daqiqaga
         yozilgan dars ham 60 daqiqa bo'lib hisoblanardi. */
      const minutesOf = (b: any, c: any) => {
        const own = Number(b.duration_minutes || 0);
        if (own > 0) return own;
        const st = b.start_at || b.booking_date, en = b.end_at;
        if (st && en) {
          const d = Math.round((new Date(en).getTime() - new Date(st).getTime()) / 60000);
          if (d > 0 && d < 24 * 60) return d;
        }
        return Number(c?.duration_minutes || 0);
      };

      /* AVTOSHKOLA darsi: avtodrom12 dan kelgan QR chek bilan ochilgan,
         pul olinmaydi. Qolganlari — pullik (platniy). */
      const isSchool = (b: any) =>
        String(b.source || '') === 'avtodrom12' ||
        !!b.school_receipt_code ||
        /avtoshkola/i.test(String(b.customer_note || ''));

      const rows = bookings.map((b) => {
        const c = cm.get(String(b.course_id));
        const p = pm.get(String(b.id));
        const s = sm.get(String(b.id));
        return {
          id: b.id,
          start_at: b.start_at || b.booking_date,
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
          cash: rows.filter((r) => r.method === 'cash').reduce((a, r) => a + r.amount, 0),
          card: rows.filter((r) => r.method === 'card').reduce((a, r) => a + r.amount, 0),
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
