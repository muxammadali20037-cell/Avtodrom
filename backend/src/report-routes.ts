import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import { rangeFromQuery } from './analytics-routes.js';
import { fetchOwnerBridge } from './boss-dashboard.js';
import { allKeys, seriesKey } from './unified-analytics.js';
import { pageAll } from './lesson-ledger.js';
import { tashkentYmd } from './lesson-math.js';
import { testDriveOf } from './pricing.js';
import { requireReport, reportErr } from './shift-routes.js';

/**
 * «HISOBOT» BO'LIMI (kassa paneli) — faqat maxsus parol bilan.
 *
 *   GET /api/admin/report/summary?period=&date= | ?from=&to=
 *       UMUMIY: Avtodrom kassalari (P1, P2 — alohida-alohida) + Platniy
 *       (avtodrom12) — jami va har biri alohida, oldingi davr bilan.
 *   GET /api/admin/report/platniy?period=&date= | ?from=&to=
 *       PLATNIY (avtodrom12, vaqt ochib kiradigan mashinalar): tushum,
 *       to'lov usullari, postlar, qarzlar, soatlar, dinamika.
 *
 * Avtodrom raqamlari boshliq ilovasi bilan bir xil qoida: to'langan
 * (qaytarilmagan) to'lovlar, to'lov vaqti bo'yicha. Platniy — avtodrom12
 * ko'prigidan (AVTODROM12_URL + RECEIPT_SHARED_KEY); u javob bermasa,
 * Avtodrom qismi baribir chiqadi.
 */

const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const q = (v: string) => encodeURIComponent(v);
const pct = (a: number, b: number) => (!b ? (a ? 100 : 0) : Math.round(((a - b) / Math.abs(b)) * 100));
const cashOf = (p: any) => (p.method === 'mixed' ? n(p.cash_amount) : p.method === 'card' ? 0 : n(p.amount));
const cardOf = (p: any) => (p.method === 'mixed' ? n(p.card_amount) : p.method === 'card' ? n(p.amount) : 0);
type Bucket = 'hour' | 'day' | 'month';

/** Davr, oldingi davr (davom etayotgan davrda — aynan shu nuqtagacha) va bucket */
function periodOf(query: any) {
  const range = rangeFromQuery(query);
  const { from, to } = range;
  const bucket: Bucket = String(range.bucket) === 'week' ? 'day' : (range.bucket as Bucket);
  const fromYmd = range.fromYmd || tashkentYmd(from.toISOString());
  const toYmd = range.toYmd || tashkentYmd(new Date(to.getTime() - 1).toISOString());
  const span = to.getTime() - from.getTime();
  const prevFrom = new Date(from.getTime() - span);
  const now = Date.now();
  const partial = now > from.getTime() && now < to.getTime();
  const prevTo = partial ? new Date(prevFrom.getTime() + (now - from.getTime())) : from;
  return { range, from, to, bucket, fromYmd, toYmd, prevFrom, prevTo, partial, now };
}

const blank = () => ({ receipts: 0, total: 0, cash: 0, card: 0, test_drive: 0, test_drive_total: 0 });

/** Avtodrom kassalari: har kassa alohida + jami (+ kassaga bog'lanmagan eski to'lovlar) */
async function avtodromKassa(from: Date, to: Date, prevFrom: Date, prevTo: Date) {
  const sel = 'id,amount,method,cash_amount,card_amount,register_id,note,paid_at';
  const [regs, pays, prev] = await Promise.all([
    supabaseRest<any[]>('cash_registers', { query: '?select=id,code,name,is_active&order=code.asc' }),
    pageAll<any>('payments', `?status=eq.paid&paid_at=gte.${q(from.toISOString())}&paid_at=lt.${q(to.toISOString())}&select=${sel}&order=paid_at.asc,id.asc`),
    pageAll<any>('payments', `?status=eq.paid&paid_at=gte.${q(prevFrom.toISOString())}&paid_at=lt.${q(prevTo.toISOString())}&select=id,amount,register_id&order=paid_at.asc,id.asc`),
  ]);
  const known = new Set(regs.map((r: any) => String(r.id)));
  const keyOf = (p: any) => (p.register_id && known.has(String(p.register_id)) ? String(p.register_id) : '-');
  const by = new Map<string, ReturnType<typeof blank>>();
  const tot = blank();
  for (const p of pays) {
    const a = by.get(keyOf(p)) || blank();
    const td = testDriveOf(p.note);
    for (const t of [a, tot]) {
      t.receipts++; t.total += n(p.amount); t.cash += cashOf(p); t.card += cardOf(p);
      if (td > 0) { t.test_drive++; t.test_drive_total += td; }
    }
    by.set(keyOf(p), a);
  }
  const prevBy = new Map<string, number>();
  let prevTotal = 0;
  for (const p of prev) { prevBy.set(keyOf(p), (prevBy.get(keyOf(p)) || 0) + n(p.amount)); prevTotal += n(p.amount); }
  const registers = regs
    .filter((r: any) => r.is_active !== false || by.has(String(r.id)))
    .map((r: any) => {
      const a = by.get(String(r.id)) || blank();
      const pv = prevBy.get(String(r.id)) || 0;
      return { id: r.id, code: r.code, name: r.name || null, ...a, previous_total: pv, change: pct(a.total, pv) };
    });
  const un = by.get('-') || blank();
  return {
    ...tot, previous_total: prevTotal, change: pct(tot.total, prevTotal), registers,
    unassigned: { ...un, previous_total: prevBy.get('-') || 0 },
  };
}

/** Platniy (avtodrom12) — ko'prik javobidan faqat kerakli qism */
function platniyOf(bridge: Awaited<ReturnType<typeof fetchOwnerBridge>>, fromYmd: string, toYmd: string, bucket: Bucket, full: boolean) {
  if (!bridge.ok) return { ok: false, error: bridge.error || 'avtodrom12 javob bermadi', hint: bridge.hint || null };
  const a12 = bridge.data || {};
  const P = a12.paid || {}, t = P.totals || {}, pv = P.previous || {};
  const base = {
    ok: true,
    total: n(t.revenue), cash: n(t.cash), terminal: n(t.terminal), click: n(t.click),
    sessions: n(t.sessions), vehicles: n(t.vehicles), minutes: n(t.minutes),
    avg_check: n(t.avg_check), avg_minutes: n(t.avg_minutes),
    debt: n(t.debt), debt_sessions: n(t.debt_sessions), auto_closed: n(t.auto_closed),
    previous_total: n(pv.revenue), previous_sessions: n(pv.sessions), change: pct(n(t.revenue), n(pv.revenue)),
  };
  if (!full) return base;
  const keys = allKeys(fromYmd, toYmd, bucket);
  const sm = new Map<string, { key: string; revenue: number; sessions: number }>(keys.map((k) => [k, { key: k, revenue: 0, sessions: 0 }]));
  for (const s of a12.series || []) {
    const k = seriesKey(s.key, bucket);
    const x = sm.get(k) || { key: k, revenue: 0, sessions: 0 };
    x.revenue += n(s.paid_revenue); x.sessions += n(s.paid); sm.set(k, x);
  }
  const hours = (a12.hours || []).map((h: any) => ({ hour: n(h.hour), sessions: n(h.paid), total: n(h.paid_revenue) }))
    .filter((h: any) => h.sessions || h.total);
  const posts = (P.operators || []).map((o: any) => ({
    name: String(o.name || ''), post: o.post ?? null, sessions: n(o.paid), minutes: n(o.minutes),
    total: n(o.revenue), cash: n(o.cash), terminal: n(o.terminal), click: n(o.click),
  }));
  return {
    ...base,
    keys,
    series: [...sm.values()].sort((a, b) => a.key.localeCompare(b.key)),
    hours,
    posts,
    durations: P.durations || null,
    plates: { total: n(P.plates?.total), new: n(P.plates?.new), returning: n(P.plates?.returning), top: (P.plates?.top || []).slice(0, 30) },
    debts: { total: n(P.debts?.total), sessions: n(P.debts?.sessions), vehicles: n(P.debts?.vehicles), top: (P.debts?.top || []).slice(0, 30) },
    live: { active: n(P.live?.active), frozen: n(P.live?.frozen), waiting: n(P.live?.waiting) },
  };
}

export async function registerReportRoutes(app: FastifyInstance) {
  const noStore = (reply: any) => reply.header('Cache-Control', 'no-store');

  app.get('/api/admin/report/summary', async (req: any, reply: any) => {
    noStore(reply);
    try {
      await requireReport(req);
      const P = periodOf(req.query);
      const [avd, bridge] = await Promise.all([
        avtodromKassa(P.from, P.to, P.prevFrom, P.prevTo),
        fetchOwnerBridge(P.fromYmd, P.toYmd, P.bucket, P.partial ? new Date(P.now) : null),
      ]);
      const pl = platniyOf(bridge, P.fromYmd, P.toYmd, P.bucket, false) as any;
      const total = avd.total + (pl.ok ? pl.total : 0);
      const prevTotal = avd.previous_total + (pl.ok ? pl.previous_total : 0);
      return {
        ok: true,
        period: P.range.period, label: P.range.label, from_day: P.fromYmd, to_day: P.toYmd,
        compare: { partial: P.partial, prev_from: P.prevFrom.toISOString(), prev_to: P.prevTo.toISOString() },
        total, previous_total: prevTotal, change: pct(total, prevTotal),
        by_method: {
          cash: avd.cash + (pl.ok ? pl.cash : 0),
          card: avd.card + (pl.ok ? pl.terminal : 0),
          click: pl.ok ? pl.click : 0,
        },
        avtodrom: avd,
        platniy: pl,
      };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send(reportErr(e, 'Umumiy hisobot yuklanmadi'));
    }
  });

  app.get('/api/admin/report/platniy', async (req: any, reply: any) => {
    noStore(reply);
    try {
      await requireReport(req);
      const P = periodOf(req.query);
      const bridge = await fetchOwnerBridge(P.fromYmd, P.toYmd, P.bucket, P.partial ? new Date(P.now) : null);
      return {
        ok: true,
        period: P.range.period, label: P.range.label, from_day: P.fromYmd, to_day: P.toYmd, bucket: P.bucket,
        platniy: platniyOf(bridge, P.fromYmd, P.toYmd, P.bucket, true),
      };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send(reportErr(e, 'Platniy hisoboti yuklanmadi'));
    }
  });
}
