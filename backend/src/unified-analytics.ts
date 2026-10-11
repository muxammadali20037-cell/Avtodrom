import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import { selectIn } from './rest-chunks.js';
import { tashkentYmd } from './lesson-math.js';
import { analyticsReport, rangeFromQuery } from './analytics-routes.js';
import { loadLedger, unscannedReceipts } from './lesson-ledger.js';

/**
 * BIRLASHGAN ANALITIKA — Avtodrom + avtodrom12 bitta panelda
 *
 *   GET /api/admin/unified-analytics?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   (yoki ?period=day|week|month|year&date=YYYY-MM-DD) — faqat administrator.
 *
 * Avtodrom qismi mavjud hisobotlar bilan AYNAN bir xil hisoblanadi:
 *   • tushum, bron, mijoz — analytics_report (admin «Hisobot» sahifasi);
 *   • darslar, avtoshkola/pullik, daqiqa — urilgan chek daftari
 *     (lesson-ledger.ts, «Instruktorlar hisoboti» bilan bir xil).
 *
 * avtodrom12 qismi server tomonida olinadi: AVTODROM12_URL +
 * RECEIPT_SHARED_KEY (QR chek ko'prigi uchun allaqachon qo'yilgan).
 * avtodrom12 javob bermasa ham Avtodrom qismi to'liq qaytadi —
 * `avtodrom12.ok=false` va tushunarli sabab bilan.
 */

const q = (v: string) => encodeURIComponent(v);
const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const DAY = 864e5;

type Bucket = 'hour' | 'day' | 'week' | 'month';

/* ---------------- avtodrom12 ko'prigi ---------------- */

export type BridgeResult = { ok: boolean; status: number | null; data?: any; error?: string; hint?: string; ms?: number };

function bridgeEnv() {
  const base = String(process.env.AVTODROM12_URL || process.env.SCHOOL_RECEIPT_URL || '').replace(/\/+$/, '');
  const key = String(process.env.RECEIPT_SHARED_KEY || '');
  return { base, key };
}

export async function fetchAvtodrom12(fromYmd: string, toYmd: string, bucket: string): Promise<BridgeResult> {
  const { base, key } = bridgeEnv();
  if (!base || !key) {
    const miss = [!base && 'AVTODROM12_URL', !key && 'RECEIPT_SHARED_KEY'].filter(Boolean).join(' va ');
    return { ok: false, status: null, error: 'avtodrom12 ulanmagan', hint: `Vercel → Avtodrom → Environment Variables: ${miss} qo‘ying` };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/api/bridge/analytics?from=${q(fromYmd)}&to=${q(toYmd)}&bucket=${q(bucket)}`, {
      headers: { 'X-Receipt-Key': key, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    const ms = Date.now() - t0;
    let d: any = null;
    try { d = await r.json(); } catch { /* JSON emas */ }
    if (r.ok && d?.ok) return { ok: true, status: r.status, data: d, ms };
    const hint =
      r.status === 401 ? 'Kalitlar bir xil emas — ikkala loyihada RECEIPT_SHARED_KEY aynan bir xil bo‘lsin'
      : r.status === 503 ? 'avtodrom12 tomonida RECEIPT_SHARED_KEY qo‘yilmagan'
      : r.status === 404 || (d && !('ok' in d)) ? 'avtodrom12 da analitika ko‘prigi hali deploy qilinmagan (oxirgi versiyani chiqaring)'
      : undefined;
    return { ok: false, status: r.status, error: d?.error || `avtodrom12 javobi: ${r.status}`, hint, ms };
  } catch (e: any) {
    const aborted = e?.name === 'AbortError';
    return { ok: false, status: null, error: aborted ? 'avtodrom12 15 soniyada javob bermadi' : `avtodrom12 ga ulanib bo‘lmadi: ${e?.message || e}` };
  } finally { clearTimeout(timer); }
}

/* ---------------- kalitlar (grafik o'qi) ---------------- */

/** Hisobot yorlig'ini umumiy kalitga keltiradi: kun — YYYY-MM-DD, oy — YYYY-MM, soat — HH:00. */
export function seriesKey(label: unknown, bucket: Bucket): string {
  const x = String(label ?? '').trim();
  if (bucket === 'month') { const m = x.match(/^\d{4}-\d{2}/); return m ? m[0] : x; }
  if (bucket === 'hour') {
    const m = x.match(/(\d{1,2}):\d{2}(?::\d{2})?\s*$/) || x.match(/[T ](\d{2})/);
    return m ? `${m[1].padStart(2, '0')}:00` : x;
  }
  const m = x.match(/^\d{4}-\d{2}-\d{2}/); return m ? m[0] : x;
}

/** Davrdagi barcha kalitlar — bo'sh kunlar ham grafikda 0 bilan ko'rinsin. */
export function allKeys(fromYmd: string, toYmd: string, bucket: Bucket): string[] {
  if (bucket === 'hour') return Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
  const out: string[] = [];
  const [fy, fm, fd] = fromYmd.split('-').map(Number);
  const end = toYmd;
  if (bucket === 'month') {
    let y = fy, m = fm;
    for (let i = 0; i < 48; i++) {
      const k = `${y}-${String(m).padStart(2, '0')}`;
      out.push(k);
      if (k >= end.slice(0, 7)) break;
      m++; if (m > 12) { m = 1; y++; }
    }
    return out;
  }
  let t = Date.UTC(fy, fm - 1, fd);
  for (let i = 0; i < 1200; i++) {
    const k = new Date(t).toISOString().slice(0, 10);
    out.push(k);
    if (k >= end) break;
    t += DAY;
  }
  return out;
}

const pct = (a: number, b: number) => (!b ? (a ? 100 : 0) : Math.round(((a - b) / b) * 100));

/* ---------------- Avtodrom tomoni ---------------- */

function ledgerSummary(rows: any[]) {
  const who = (r: any) => r.customer_id || `x${r.booking_id}`;
  const all = new Set<string>(), sch = new Set<string>(), paid = new Set<string>();
  let school = 0, minutes = 0, revenue = 0;
  for (const r of rows) {
    all.add(who(r)); (r.school ? sch : paid).add(who(r));
    if (r.school) school++;
    minutes += n(r.minutes); revenue += n(r.amount);
  }
  return { lessons: rows.length, school, paid: rows.length - school, minutes, revenue,
    students: all.size, school_students: sch.size, paid_students: paid.size };
}

export async function buildUnifiedAnalytics(query: any) {
  const range = rangeFromQuery(query);
  const { from, to, label, period } = range;
  const bucket: Bucket = String(range.bucket) === 'week' ? 'day' : (range.bucket as Bucket);
  const fromYmd = range.fromYmd || tashkentYmd(from.toISOString());
  const toYmd = range.toYmd || tashkentYmd(new Date(to.getTime() - 1).toISOString());
  const span = to.getTime() - from.getTime();
  const prevFrom = new Date(from.getTime() - span);

  const warnings: Array<{ section: string; error: string }> = [];
  const safe = async <T>(section: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); }
    catch (e: any) { warnings.push({ section, error: String(e?.message || e).slice(0, 200) }); return fallback; }
  };
  const rest = <T = any[]>(table: string, qs: string) => supabaseRest<T>(table, { query: qs });
  const nowIso = new Date().toISOString();
  const todayEnd = new Date(Date.UTC(...(tashkentYmd(nowIso).split('-').map(Number) as [number, number, number])) - 5 * 3600e3 + DAY).toISOString();

  const [cur, prev, ledger, prevLedger, unscanned, bridge, inProgress, pending, upcoming, shifts,
    audits, pays, scans, newBookings] = await Promise.all([
    safe('analytics_report', () => analyticsReport(from, to, bucket), {} as any),
    safe('analytics_report_prev', () => analyticsReport(prevFrom, from, bucket), {} as any),
    safe('ledger', () => loadLedger({ from, to }), { rows: [], bookings: new Map(), courses: new Map() } as any),
    safe('ledger_prev', () => loadLedger({ from: prevFrom, to: from }), { rows: [], bookings: new Map(), courses: new Map() } as any),
    safe('unscanned', () => unscannedReceipts({ from, to }), { receipts: 0, amount: 0, list: [] } as any),
    fetchAvtodrom12(fromYmd, toYmd, bucket),
    safe('live', () => rest('bookings',
      '?status=eq.in_progress&select=id,instructor_id,instructor_name,customer_id,start_at,end_at,arrived_at,duration_minutes,category,source&order=arrived_at.asc.nullslast&limit=60'), [] as any[]),
    safe('pending', () => rest('bookings',
      `?status=eq.pending&start_at=gte.${q(new Date(Date.now() - DAY).toISOString())}&select=id&limit=1000`), [] as any[]),
    safe('upcoming', () => rest('bookings',
      `?status=in.(confirmed,customer_confirmed)&start_at=gte.${q(nowIso)}&start_at=lt.${q(todayEnd)}&select=id&limit=1000`), [] as any[]),
    safe('shifts', () => rest('cashier_shifts', '?closed_at=is.null&select=id,register_id,cashier_name,opened_at&order=opened_at.asc&limit=20'), [] as any[]),
    safe('audit', () => rest('admin_audit_logs', '?select=id,action,entity_type,staff_login,admin_id,new_data,created_at&order=created_at.desc&limit=40'), [] as any[]),
    safe('payments', () => rest('payments', '?status=eq.paid&select=id,booking_id,customer_id,amount,method,receipt_code,paid_at&order=paid_at.desc.nullslast&limit=25'), [] as any[]),
    safe('scans', () => rest('attendance_verifications', '?select=id,booking_id,customer_id,receipt_code,verification_snapshot,created_at&order=created_at.desc&limit=25'), [] as any[]),
    safe('bookings', () => rest('bookings', '?select=id,customer_id,status,source,start_at,created_at,category,instructor_name&order=created_at.desc&limit=25'), [] as any[]),
  ]);

  /* --- ism-familiyalar (lenta va jonli ro'yxat uchun) --- */
  const regIds = [...new Set(shifts.map((s: any) => s.register_id).filter(Boolean))];
  const insIds = [...new Set(inProgress.map((b: any) => b.instructor_id).filter(Boolean))];
  const [regs, ips] = await Promise.all([
    safe('registers', () => selectIn<any>('cash_registers', 'id', regIds, 'id,code,name'), [] as any[]),
    safe('instructor_profiles', () => selectIn<any>('instructor_profiles', 'id', insIds, 'id,user_id'), [] as any[]),
  ]);
  const userIds = [
    ...inProgress.map((b: any) => b.customer_id), ...ips.map((i: any) => i.user_id),
    ...audits.map((a: any) => a.admin_id), ...pays.map((p: any) => p.customer_id),
    ...scans.map((s: any) => s.customer_id), ...newBookings.map((b: any) => b.customer_id),
  ];
  const users = await safe('users', () => selectIn<any>('users', 'id', userIds, 'id,full_name'), [] as any[]);
  const um = new Map(users.map((u: any) => [String(u.id), u.full_name as string]));
  const regm = new Map(regs.map((r: any) => [String(r.id), r]));
  const insName = new Map(ips.map((i: any) => [String(i.id), um.get(String(i.user_id)) || null]));

  /* --- Avtodrom jami --- */
  const t = cur?.totals || {}, p = prev?.totals || {};
  const L = ledgerSummary(ledger.rows || []);
  const PL = ledgerSummary(prevLedger.rows || []);
  const avd = {
    revenue: n(t.revenue), bookings: n(t.bookings), completed: n(t.completed), no_show: n(t.no_show),
    cancelled: n(t.cancelled), customers: n(t.customers), avg_check: n(t.avg_check),
    revenue_cash: n(t.revenue_cash), revenue_card: n(t.revenue_card), revenue_mixed: n(t.revenue_mixed),
    lessons: L.lessons, school_lessons: L.school, paid_lessons: L.paid, minutes: L.minutes,
    students: L.students, school_students: L.school_students, paid_students: L.paid_students,
  };
  const avdPrev = {
    revenue: n(p.revenue), bookings: n(p.bookings), completed: n(p.completed), no_show: n(p.no_show),
    cancelled: n(p.cancelled), customers: n(p.customers),
    lessons: PL.lessons, school_lessons: PL.school, paid_lessons: PL.paid, minutes: PL.minutes, students: PL.students,
  };

  /* --- avtodrom12 --- */
  const a12 = bridge.ok ? bridge.data : null;
  const a12t = a12?.totals || {}, a12p = a12?.previous || {};

  /* --- birlashgan jami --- */
  const comb = (x: any, y: any) => ({
    revenue: n(x.revenue) + n(y.revenue),
    lessons: n(x.lessons) + n(y.sessions),
    school_lessons: n(x.school_lessons) + n(y.school_sessions),
    paid_lessons: n(x.paid_lessons) + n(y.paid_sessions),
    minutes: n(x.minutes) + n(y.minutes),
  });
  const totals = comb(avd, a12t);
  const previous = comb(avdPrev, a12p);
  const change = Object.fromEntries(Object.keys(totals).map((k) => [k, pct((totals as any)[k], (previous as any)[k])]));

  /* --- dinamika: bir o'qda ikkala loyiha --- */
  const keys = allKeys(fromYmd, toYmd, bucket);
  const row = () => ({ avtodrom_revenue: 0, avtodrom_bookings: 0, avtodrom_lessons: 0, avtodrom12_revenue: 0, avtodrom12_sessions: 0, avtodrom12_school: 0 });
  const sm = new Map<string, any>(keys.map((k) => [k, row()]));
  const at = (k: string) => { if (!sm.has(k)) sm.set(k, row()); return sm.get(k); };
  for (const s of cur?.series || []) {
    const r = at(seriesKey(s.label ?? s.bucket ?? s.day ?? s.date, bucket));
    r.avtodrom_revenue += n(s.revenue); r.avtodrom_bookings += n(s.bookings);
  }
  for (const r of ledger.rows || []) {
    const k = bucket === 'hour'
      ? `${new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', hourCycle: 'h23' }).format(new Date(r.scanned_at))}:00`
      : bucket === 'month' ? String(r.day).slice(0, 7) : String(r.day);
    at(k).avtodrom_lessons++;
  }
  for (const s of a12?.series || []) {
    const r = at(seriesKey(s.key, bucket));
    r.avtodrom12_revenue += n(s.revenue); r.avtodrom12_sessions += n(s.sessions); r.avtodrom12_school += n(s.school);
  }
  const series = [...sm.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, v]) => ({ key, ...v }));

  /* --- soatlar va issiqlik xaritasi (ikkala loyiha) --- */
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, avtodrom: 0, avtodrom12: 0 }));
  for (const h of cur?.hours || []) { const i = n(h.hour); if (hours[i]) hours[i].avtodrom += n(h.bookings); }
  for (const h of a12?.hours || []) { const i = n(h.hour); if (hours[i]) hours[i].avtodrom12 += n(h.sessions); }
  const heat = new Map<string, { dow: number; hour: number; avtodrom: number; avtodrom12: number }>();
  const hc = (dow: number, hour: number) => { const k = `${dow}_${hour}`; if (!heat.has(k)) heat.set(k, { dow, hour, avtodrom: 0, avtodrom12: 0 }); return heat.get(k)!; };
  for (const c of cur?.heatmap || []) hc(n(c.dow), n(c.hour)).avtodrom += n(c.n);
  for (const c of a12?.heatmap || []) hc(n(c.dow), n(c.hour)).avtodrom12 += n(c.n);

  /* --- jonli holat --- */
  const now = Date.now();
  const live = inProgress.map((b: any) => {
    const start = Date.parse(b.arrived_at || b.start_at);
    return {
      id: b.id, instructor: insName.get(String(b.instructor_id)) || b.instructor_name || null,
      customer: um.get(String(b.customer_id)) || null, category: b.category || null, source: b.source || null,
      started_at: b.arrived_at || b.start_at, end_at: b.end_at,
      minutes: Number.isFinite(start) ? Math.max(0, Math.round((now - start) / 60000)) : null,
      planned_minutes: n(b.duration_minutes) || null,
    };
  });

  /* --- amallar lentasi --- */
  const feed: any[] = [];
  for (const a of audits) {
    const nd = a.new_data && typeof a.new_data === 'object' ? a.new_data : {};
    feed.push({ at: a.created_at, source: 'avtodrom', kind: 'audit', action: a.action, entity: a.entity_type || null,
      title: a.action, detail: nd.status || nd.login || nd.code || nd.receipt_code || nd.name || nd.entity_key || '',
      actor: a.staff_login || um.get(String(a.admin_id)) || null });
  }
  for (const x of pays) {
    feed.push({ at: x.paid_at, source: 'avtodrom', kind: 'payment', title: x.receipt_code || 'To‘lov',
      detail: um.get(String(x.customer_id)) || '', amount: n(x.amount), method: x.method || null, actor: null });
  }
  for (const s of scans) {
    const snap = s.verification_snapshot || {};
    feed.push({ at: s.created_at, source: 'avtodrom', kind: snap.kind === 'school_receipt' ? 'scan_school' : 'scan',
      title: s.receipt_code || 'Chek', detail: um.get(String(s.customer_id)) || '',
      amount: n(snap.amount) || undefined, actor: snap.instructor_name || null });
  }
  for (const b of newBookings) {
    feed.push({ at: b.created_at, source: 'avtodrom', kind: 'booking', title: um.get(String(b.customer_id)) || 'Bron',
      detail: [b.instructor_name, b.category, b.source].filter(Boolean).join(' · '), status: b.status, start_at: b.start_at, actor: null });
  }
  for (const f of a12?.feed || []) feed.push({ ...f, source: 'avtodrom12' });
  feed.sort((x, y) => (Date.parse(y.at) || 0) - (Date.parse(x.at) || 0));

  const { feed: _omit, ...a12data } = a12 || {};
  const { base } = bridgeEnv();
  let host = '';
  try { host = base ? new URL(base).host : ''; } catch { host = base; }

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    period, label, bucket, from: from.toISOString(), to: to.toISOString(), from_day: fromYmd, to_day: toYmd,
    combined: { totals, previous, change, series, hours, heatmap: [...heat.values()] },
    avtodrom: {
      ok: !warnings.some((w) => w.section === 'analytics_report' || w.section === 'ledger'),
      totals: avd, previous: avdPrev,
      change: Object.fromEntries(['revenue', 'bookings', 'completed', 'customers', 'lessons'].map((k) => [k, pct((avd as any)[k], (avdPrev as any)[k])])),
      categories: cur?.categories || [], instructors: cur?.instructors || [], courses: cur?.courses || [],
      unscanned: { receipts: n(unscanned.receipts), amount: n(unscanned.amount) },
      live: {
        in_progress: live,
        pending: pending.length,
        upcoming_today: upcoming.length,
        open_shifts: shifts.map((s: any) => ({ id: s.id, opened_at: s.opened_at, cashier: s.cashier_name || null,
          register: regm.get(String(s.register_id))?.name || regm.get(String(s.register_id))?.code || null })),
      },
      warnings,
    },
    avtodrom12: bridge.ok
      ? { ok: true, ms: bridge.ms, host, ...a12data }
      : { ok: false, host, status: bridge.status, error: bridge.error, hint: bridge.hint || null },
    feed: feed.slice(0, 140),
  };
}

export async function registerUnifiedAnalyticsRoutes(app: FastifyInstance, guardAdmin: (req: any) => Promise<void>) {
  app.get('/api/admin/unified-analytics', async (req: any, reply: any) => {
    try {
      await guardAdmin(req);
      reply.header('Cache-Control', 'no-store');
      return await buildUnifiedAnalytics(req.query || {});
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Analitika yuklanmadi' });
    }
  });
}
