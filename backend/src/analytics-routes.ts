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
        previous: p,
        change: {
          bookings: delta(t.bookings, p.bookings),
          completed: delta(t.completed, p.completed),
          revenue: delta(t.revenue, p.revenue),
          customers: delta(t.customers, p.customers),
        },
        series: current.series || [],
        instructors: current.instructors || [],
        courses: current.courses || [],
        hours: current.hours || [],
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
      await requireAdmin(req);
      const instructorId = String(req.params.id);
      const period = String(req.query?.period || 'day');
      const { from, to, label, anchor } = periodRange(period, req.query?.date);

      const bookings = await supabaseRest<any[]>('bookings', {
        query:
          `?instructor_id=eq.${q(instructorId)}` +
          `&start_at=gte.${q(from.toISOString())}&start_at=lt.${q(to.toISOString())}` +
          '&select=*&order=start_at.asc&limit=1000',
      });

      const ids = bookings.map((b) => String(b.id));
      const uids = [...new Set(bookings.map((b) => String(b.customer_id)).filter(Boolean))];
      const cids = [...new Set(bookings.map((b) => String(b.course_id)).filter(Boolean))];

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
          customer: um.get(String(b.customer_id)) || null,
          course: c || null,
          duration_minutes: c?.duration_minutes ?? null,
          amount: p?.status === 'paid' ? Number(p.amount || 0) : 0,
          method: p?.method || null,
          receipt_code: p?.receipt_code || null,
          scanned: !!s,
          scanned_at: s?.created_at || null,
        };
      });

      const done = rows.filter((r) => r.status === 'completed');
      return {
        ok: true,
        period, label, anchor,
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
        },
        rows,
      };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Instruktor hisoboti yuklanmadi' });
    }
  });
}
