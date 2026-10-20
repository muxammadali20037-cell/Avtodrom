import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { supabaseRest, supabaseRestPaged } from './supabase.js';
import { selectIn } from './rest-chunks.js';
import { tashkentYmd } from './lesson-math.js';
import { rangeFromQuery } from './analytics-routes.js';
import { loadLedger, unscannedReceipts, pageAll } from './lesson-ledger.js';
import { allKeys, seriesKey } from './unified-analytics.js';

/**
 * BOSHLIQ ILOVASI — rahbar telefoniga (iPhone) o'rnatiladigan panel.
 *
 *   /boshliq?k=<kalit>  — sahifa (boshliq.html, «Ekranga qo'shish» bilan ilova bo'ladi)
 *   GET  /api/boss-hello?k=          — havola to'g'rimi, PIN qo'yilganmi
 *   POST /api/boss-login {k, pin}    — PIN to'g'ri bo'lsa 60 kunlik token
 *   GET  /api/boss-data?from=&to=    — hamma raqamlar (Authorization: Bearer <token>)
 *   GET  /api/admin/boss-link        — admin: havola va holat (yo'q bo'lsa yaratiladi)
 *   POST /api/admin/boss-link {pin?, reset?} — admin: PIN qo'yish / havolani yangilash
 *
 * Uch asosiy bo'lim + umumiy + xarajatlar:
 *   1. AVTOSHKOLA — avtodrom12 (shartnoma bo'yicha o'quvchilar)
 *   2. PLATNIY (oddiy mijoz) — avtodrom12 (vaqt ochib kiradigan mashinalar)
 *   3. AVTODROM — shu loyiha: bronlar, kassa P1/P2, instruktorlar
 *   UMUMIY — uchalasi birga; XARAJATLAR — avtodrom12 «Rasxod».
 *
 * avtodrom12 qismi server tomonida olinadi (AVTODROM12_URL + RECEIPT_SHARED_KEY,
 * Analitika ko'prigi bilan bir xil). U javob bermasa ham Avtodrom qismi chiqadi.
 *
 * Kirish — IKKI narsa birga: maxfiy havola (kalit) + PIN. Havola yangilansa
 * yoki PIN o'zgarsa, hamma telefondagi token darhol ishlamay qoladi (token
 * imzosiga kalit va PIN xeshi kiradi). Saqlanadi: admin_settings → `boss_link`.
 *
 * Takroriy dars yo'q: Avtodromdagi avtoshkola darslari (AVS cheki) avtodrom12
 * da allaqachon davomat bo'lib yozilgan — ular faqat AVTOSHKOLA bo'limida
 * sanaladi, Avtodrom bo'limida ma'lumot sifatida ko'rsatiladi.
 */

export const BOSS_KEY = 'boss_link';
const TOKEN_TTL_MS = 60 * 24 * 3600e3;          // 60 kun; har ochilganda yangilanadi
const q = (v: string) => encodeURIComponent(v);
const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const nf = (v: number) => String(Math.round(Number(v) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const pct = (a: number, b: number) => (!b ? (a ? 100 : 0) : Math.round(((a - b) / b) * 100));
const BASE = () => String(process.env.PUBLIC_BASE_URL || 'https://avtodrom.vercel.app').replace(/\/+$/, '');
const err = (code: number, message: string) => Object.assign(new Error(message), { statusCode: code });

/* ------------------------------------------------------------------ */
/* Havola, PIN, token                                                  */
/* ------------------------------------------------------------------ */
type BossLink = { key: string; pin_hash: string | null; at: string | null; by: string | null; pin_at: string | null };

function secret(): string {
  const s = String(process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || '').trim();
  if (!s) throw err(503, 'ADMIN_SESSION_SECRET sozlanmagan');
  return s;
}
const hmac = (data: string) => crypto.createHmac('sha256', secret()).update(data).digest('hex');
export const bossPinHash = (pin: string) => hmac(`boss-pin:${pin}`);
const safeEq = (a: string, b: string) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
export const bossUrl = (key: string) => `${BASE()}/boshliq?k=${key}`;

export async function readBossLink(): Promise<BossLink | null> {
  const rows = await supabaseRest<any[]>('admin_settings', { query: `?key=eq.${BOSS_KEY}&select=value&limit=1` });
  const v = rows?.[0]?.value;
  const x = v?.key ? v : v?.value?.key ? v.value : null;
  if (!x || typeof x.key !== 'string' || x.key.length < 20) return null;
  return { key: x.key, pin_hash: x.pin_hash || null, at: x.at || null, by: x.by || null, pin_at: x.pin_at || null };
}
async function writeBossLink(v: BossLink) {
  const now = new Date().toISOString();
  const rows = await supabaseRest<any[]>('admin_settings', {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, query: `?key=eq.${BOSS_KEY}`,
    body: JSON.stringify({ value: v, updated_at: now }),
  });
  if (!rows?.length) {
    await supabaseRest('admin_settings', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ key: BOSS_KEY, value: v, updated_at: now }) });
  }
  return v;
}
const newKey = () => crypto.randomBytes(18).toString('base64url');

function checkKey(link: BossLink | null, k: string): boolean {
  if (!link || !k || k.length < 20 || k.length > 64) return false;
  return safeEq(k, link.key);
}

export function makeBossToken(link: BossLink, now = Date.now()) {
  const exp = now + TOKEN_TTL_MS;
  return { token: `bs1.${exp}.${hmac(`boss:${link.key}:${link.pin_hash || ''}:${exp}`)}`, expires_at: new Date(exp).toISOString() };
}
export function verifyBossToken(link: BossLink | null, token: string, now = Date.now()): boolean {
  if (!link || !link.pin_hash) return false;
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'bs1') return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < now) return false;
  return safeEq(parts[2], hmac(`boss:${link.key}:${link.pin_hash}:${parts[1]}`));
}
const bearer = (req: any) => {
  const h = String(req.headers?.authorization || '').trim();
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
};

/* ------------------------------------------------------------------ */
/* avtodrom12 — boshliq ko'prigi                                       */
/* ------------------------------------------------------------------ */
export type OwnerBridge = { ok: boolean; status: number | null; data?: any; error?: string; hint?: string; ms?: number };

export async function fetchOwnerBridge(fromYmd: string, toYmd: string, bucket: string): Promise<OwnerBridge> {
  const base = String(process.env.AVTODROM12_URL || process.env.SCHOOL_RECEIPT_URL || '').replace(/\/+$/, '');
  const key = String(process.env.RECEIPT_SHARED_KEY || '');
  if (!base || !key) {
    const miss = [!base && 'AVTODROM12_URL', !key && 'RECEIPT_SHARED_KEY'].filter(Boolean).join(' va ');
    return { ok: false, status: null, error: 'avtodrom12 ulanmagan', hint: `Vercel → Avtodrom → Environment Variables: ${miss} qo‘ying` };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/api/bridge/owner?from=${q(fromYmd)}&to=${q(toYmd)}&bucket=${q(bucket)}`, {
      headers: { 'X-Receipt-Key': key, Accept: 'application/json' }, signal: ctrl.signal,
    });
    const ms = Date.now() - t0;
    let d: any = null;
    try { d = await r.json(); } catch { /* JSON emas */ }
    if (r.ok && d?.ok && d?.kind === 'owner') return { ok: true, status: r.status, data: d, ms };
    const hint =
      r.status === 401 ? 'Kalitlar bir xil emas — ikkala loyihada RECEIPT_SHARED_KEY aynan bir xil bo‘lsin'
      : r.status === 503 ? 'avtodrom12 tomonida RECEIPT_SHARED_KEY qo‘yilmagan'
      : r.status === 404 || (d && d.kind !== 'owner') ? 'avtodrom12 yangilanmagan — boshliq ko‘prigi (api/bridge-owner.js) bilan yangi versiyani chiqaring'
      : undefined;
    return { ok: false, status: r.status, error: d?.error || `avtodrom12 javobi: ${r.status}`, hint, ms };
  } catch (e: any) {
    const aborted = e?.name === 'AbortError';
    return { ok: false, status: null, error: aborted ? 'avtodrom12 20 soniyada javob bermadi' : `avtodrom12 ga ulanib bo‘lmadi: ${e?.message || e}` };
  } finally { clearTimeout(timer); }
}

/* ------------------------------------------------------------------ */
/* Avtodrom qismi                                                      */
/* ------------------------------------------------------------------ */
const SOURCE_NAME: Record<string, string> = {
  app: 'Mini App (mijoz o‘zi)',
  admin: 'Admin · Excel · bot',
  manual: 'Operator (qo‘lda)',
  walk_in: 'Kassa (bronsiz mijoz)',
  avtodrom12: 'Avtoshkola cheki',
};
const STATUS_KEYS = ['pending', 'confirmed', 'in_progress', 'completed', 'no_show', 'cancelled'];

const cashOf = (p: any) => {
  const amount = n(p.amount), m = String(p.method || 'cash');
  return m === 'mixed' ? n(p.cash_amount) : m === 'card' ? 0 : amount;
};
const cardOf = (p: any) => {
  const amount = n(p.amount), m = String(p.method || 'cash');
  return m === 'mixed' ? n(p.card_amount) : m === 'card' ? amount : 0;
};
const durName = (min: number) => (!min ? 'Noma’lum' : min <= 30 ? '30 daqiqa' : min % 60 === 0 ? `${min / 60} soat` : `${min} daqiqa`);

type Bucket = 'hour' | 'day' | 'month';
const keyOf = (iso: string, bucket: Bucket) => {
  const d = new Date(iso);
  if (bucket === 'hour') return `${new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', hourCycle: 'h23' }).format(d)}:00`;
  const ymd = tashkentYmd(iso);
  return bucket === 'month' ? ymd.slice(0, 7) : ymd;
};

export async function buildAvtodrom(from: Date, to: Date, prevFrom: Date, bucket: Bucket) {
  const warnings: Array<{ section: string; error: string }> = [];
  const safe = async <T>(section: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); }
    catch (e: any) { warnings.push({ section, error: String(e?.message || e).slice(0, 200) }); return fallback; }
  };
  const F = q(from.toISOString()), T = q(to.toISOString()), PF = q(prevFrom.toISOString());
  const nowIso = new Date().toISOString();
  const todayYmd = tashkentYmd(nowIso);
  const [ty, tm, td] = todayYmd.split('-').map(Number);
  const todayEnd = new Date(Date.UTC(ty, tm - 1, td) - 5 * 3600e3 + 864e5).toISOString();

  const [regs, pays, prevPays, bookings, prevBookings, newCustomers, ledger, unscanned, inProgress, pending, upcoming, shifts] = await Promise.all([
    safe('registers', () => supabaseRest<any[]>('cash_registers', { query: '?select=id,code,name,is_active&order=code.asc' }), [] as any[]),
    safe('payments', () => pageAll<any>('payments',
      `?status=eq.paid&paid_at=gte.${F}&paid_at=lt.${T}&select=id,booking_id,customer_id,amount,method,cash_amount,card_amount,register_id,receipt_code,paid_at&order=paid_at.asc,id.asc`), [] as any[]),
    safe('payments_prev', () => pageAll<any>('payments',
      `?status=eq.paid&paid_at=gte.${PF}&paid_at=lt.${F}&select=id,amount,register_id&order=paid_at.asc,id.asc`), [] as any[]),
    safe('bookings', () => pageAll<any>('bookings',
      `?start_at=gte.${F}&start_at=lt.${T}&select=id,status,source,category,customer_id,instructor_id,duration_minutes,school_receipt_code,customer_note&order=start_at.asc,id.asc`), [] as any[]),
    safe('bookings_prev', async () => (await supabaseRestPaged<any>('bookings', `?start_at=gte.${PF}&start_at=lt.${F}&select=id`, 1, 1)).total, 0),
    safe('new_customers', async () => (await supabaseRestPaged<any>('users', `?role=eq.customer&created_at=gte.${F}&created_at=lt.${T}&select=id`, 1, 1)).total, 0),
    safe('ledger', () => loadLedger({ from, to }), { rows: [], bookings: new Map(), courses: new Map() } as any),
    safe('unscanned', () => unscannedReceipts({ from, to }), { receipts: 0, amount: 0, list: [] } as any),
    safe('live', () => supabaseRest<any[]>('bookings',
      { query: '?status=eq.in_progress&select=id,instructor_id,instructor_name,customer_id,start_at,end_at,arrived_at,duration_minutes,category,source&order=arrived_at.asc.nullslast&limit=60' }), [] as any[]),
    safe('pending', async () => (await supabaseRestPaged<any>('bookings', `?status=eq.pending&start_at=gte.${q(nowIso)}&select=id`, 1, 1)).total, 0),
    safe('upcoming', async () => (await supabaseRestPaged<any>('bookings',
      `?status=in.(confirmed,customer_confirmed)&start_at=gte.${q(nowIso)}&start_at=lt.${q(todayEnd)}&select=id`, 1, 1)).total, 0),
    safe('shifts', () => supabaseRest<any[]>('cashier_shifts', { query: '?closed_at=is.null&select=id,register_id,cashier_name,opened_at&order=opened_at.asc&limit=20' }), [] as any[]),
  ]);

  /* --- ismlar: to'lov bronlari, instruktorlar, mijozlar --- */
  const payBookingIds = [...new Set(pays.map((p: any) => p.booking_id).filter(Boolean).map(String))];
  const bkFromPay = await safe('payment_bookings', () => selectIn<any>('bookings', 'id', payBookingIds, 'id,category,duration_minutes,instructor_id,source,school_receipt_code,customer_note'), [] as any[]);
  const bkm = new Map(bkFromPay.map((b: any) => [String(b.id), b]));
  const insIds = [...new Set([
    ...ledger.rows.map((r: any) => r.instructor_id), ...inProgress.map((b: any) => b.instructor_id), ...bkFromPay.map((b: any) => b.instructor_id),
  ].filter(Boolean).map(String))];
  const ips = await safe('instructor_profiles', () => selectIn<any>('instructor_profiles', 'id', insIds, 'id,user_id'), [] as any[]);
  const recentPays = pays.slice(-40).reverse();
  const userIds = [...ips.map((i: any) => i.user_id), ...inProgress.map((b: any) => b.customer_id), ...recentPays.map((p: any) => p.customer_id)];
  const users = await safe('users', () => selectIn<any>('users', 'id', userIds, 'id,full_name'), [] as any[]);
  const um = new Map(users.map((u: any) => [String(u.id), String(u.full_name || '')]));
  const insName = (id: unknown) => {
    const ip = ips.find((i: any) => String(i.id) === String(id));
    return (ip && um.get(String(ip.user_id))) || null;
  };

  /* --- KASSA: P1, P2 (+ kassaga bog'lanmagan eski to'lovlar) --- */
  const regm = new Map(regs.map((r: any) => [String(r.id), r]));
  const blank = () => ({ receipts: 0, total: 0, cash: 0, card: 0 });
  const byReg = new Map<string, any>();
  const tot = blank();
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, total: 0, receipts: 0 }));
  const series = new Map<string, number>();
  const cats = new Map<string, { name: string; total: number; receipts: number }>();
  const durs = new Map<string, { name: string; total: number; receipts: number; min: number }>();
  for (const p of pays) {
    const rk = p.register_id ? String(p.register_id) : '-';
    const a = byReg.get(rk) || blank();
    for (const t of [a, tot]) { t.receipts++; t.total += n(p.amount); t.cash += cashOf(p); t.card += cardOf(p); }
    byReg.set(rk, a);
    const h = Number(keyOf(p.paid_at, 'hour').slice(0, 2));
    if (hours[h]) { hours[h].total += n(p.amount); hours[h].receipts++; }
    const k = keyOf(p.paid_at, bucket);
    series.set(k, (series.get(k) || 0) + n(p.amount));
    const b: any = bkm.get(String(p.booking_id)) || {};
    const cn = `${String(b.category || 'B').toUpperCase()} toifa`;
    const c = cats.get(cn) || { name: cn, total: 0, receipts: 0 }; c.total += n(p.amount); c.receipts++; cats.set(cn, c);
    const min = n(b.duration_minutes), dn = durName(min);
    const d = durs.get(dn) || { name: dn, total: 0, receipts: 0, min }; d.total += n(p.amount); d.receipts++; durs.set(dn, d);
  }
  const prevByReg = new Map<string, number>();
  let prevTotal = 0;
  for (const p of prevPays) {
    const rk = p.register_id ? String(p.register_id) : '-';
    prevByReg.set(rk, (prevByReg.get(rk) || 0) + n(p.amount)); prevTotal += n(p.amount);
  }
  const shiftOf = (rid: string) => shifts.find((s: any) => String(s.register_id) === rid) || null;
  const registers = regs
    .filter((r: any) => r.is_active !== false || byReg.has(String(r.id)))
    .map((r: any) => {
      const a = byReg.get(String(r.id)) || blank();
      const pv = prevByReg.get(String(r.id)) || 0;
      const sh: any = shiftOf(String(r.id));
      return { id: r.id, code: r.code, name: r.name || null, ...a, previous_total: pv, change: pct(a.total, pv),
        shift: sh ? { open: true, cashier: sh.cashier_name || null, opened_at: sh.opened_at } : { open: false } };
    });
  const unassigned = byReg.get('-') || blank();

  const recent = recentPays.slice(0, 30).map((p: any) => {
    const b: any = bkm.get(String(p.booking_id)) || {};
    return {
      at: p.paid_at, code: p.receipt_code || null, amount: n(p.amount), method: p.method || 'cash',
      register: (regm.get(String(p.register_id)) as any)?.code || null,
      customer: um.get(String(p.customer_id)) || null, instructor: insName(b.instructor_id),
      category: b.category || null, minutes: n(b.duration_minutes) || null,
    };
  });

  /* --- BRONLAR (dars kuni shu davrda) --- */
  const by_status: Record<string, number> = Object.fromEntries(STATUS_KEYS.map((k) => [k, 0]));
  by_status.other = 0;
  const srcCount = new Map<string, number>(), catCount = new Map<string, number>();
  const customers = new Set<string>();
  for (const b of bookings) {
    const st = String(b.status || '');
    const s = st === 'customer_confirmed' ? 'confirmed' : st === 'rejected' ? 'cancelled' : st;
    if (s in by_status) by_status[s]++; else by_status.other++;
    const src = String(b.source || 'boshqa');
    srcCount.set(src, (srcCount.get(src) || 0) + 1);
    const cat = String(b.category || 'B').toUpperCase();
    catCount.set(cat, (catCount.get(cat) || 0) + 1);
    if (b.customer_id) customers.add(String(b.customer_id));
  }
  const bTotal = bookings.length;
  const closed = by_status.completed + by_status.no_show;
  const bookingsOut = {
    total: bTotal, previous_total: n(prevBookings), change: pct(bTotal, n(prevBookings)),
    by_status, customers: customers.size, new_customers: n(newCustomers),
    no_show_rate: closed ? Math.round((by_status.no_show / closed) * 100) : 0,
    cancel_rate: bTotal ? Math.round((by_status.cancelled / bTotal) * 100) : 0,
    by_source: [...srcCount.entries()].sort((a, b) => b[1] - a[1]).map(([key, v]) => ({ key, name: SOURCE_NAME[key] || key, n: v })),
    by_category: [...catCount.entries()].sort((a, b) => b[1] - a[1]).map(([key, v]) => ({ name: `${key} toifa`, n: v })),
  };

  /* --- DARSLAR (urilgan chek bo'yicha — Instruktorlar hisoboti bilan bir xil) --- */
  const lrows: any[] = ledger.rows || [];
  const paidRows = lrows.filter((r) => !r.school), schoolRows = lrows.filter((r) => r.school);
  const who = (r: any) => r.customer_id || `x${r.booking_id}`;
  const lessons = {
    paid: paidRows.length, school: schoolRows.length,
    minutes: paidRows.reduce((a, r) => a + n(r.minutes), 0),
    school_minutes: schoolRows.reduce((a, r) => a + n(r.minutes), 0),
    students: new Set(paidRows.map(who)).size,
    unscanned: { receipts: n(unscanned.receipts), amount: n(unscanned.amount) },
  };
  const im = new Map<string, any>();
  for (const r of lrows) {
    const id = String(r.instructor_id || '-');
    const x = im.get(id) || { id, name: r.instructor_id ? insName(r.instructor_id) || 'Instruktor' : 'Instruktorsiz',
      lessons: 0, paid: 0, school: 0, minutes: 0, revenue: 0, _st: new Set<string>() };
    x.lessons++; x[r.school ? 'school' : 'paid']++; x.minutes += n(r.minutes); x.revenue += n(r.amount); x._st.add(who(r));
    im.set(id, x);
  }
  const instructors = [...im.values()]
    .map(({ _st, ...x }) => ({ ...x, students: _st.size }))
    .sort((a, b) => b.lessons - a.lessons || b.revenue - a.revenue);

  /* --- HOZIR --- */
  const now = Date.now();
  const live = {
    in_progress: inProgress.map((b: any) => {
      const start = Date.parse(b.arrived_at || b.start_at);
      return { id: b.id, instructor: insName(b.instructor_id) || b.instructor_name || null, customer: um.get(String(b.customer_id)) || null,
        category: b.category || null, source: b.source || null, started_at: b.arrived_at || b.start_at, end_at: b.end_at,
        minutes: Number.isFinite(start) ? Math.max(0, Math.round((now - start) / 60000)) : null, planned_minutes: n(b.duration_minutes) || null };
    }),
    pending: n(pending), upcoming_today: n(upcoming),
    open_shifts: shifts.map((s: any) => ({ cashier: s.cashier_name || null, opened_at: s.opened_at,
      register: (regm.get(String(s.register_id)) as any)?.code || null })),
  };

  return {
    ok: !warnings.some((w) => w.section === 'payments' || w.section === 'bookings'),
    kassa: {
      totals: tot, previous_total: prevTotal, change: pct(tot.total, prevTotal), registers, unassigned,
      hours: hours.filter((h) => h.receipts), series: [...series.entries()].map(([key, total]) => ({ key, total })),
      categories: [...cats.values()].sort((a, b) => b.total - a.total),
      durations: [...durs.values()].sort((a, b) => a.min - b.min).map(({ min: _m, ...x }) => x),
      avg_check: tot.receipts ? Math.round(tot.total / tot.receipts) : 0,
      recent,
    },
    bookings: bookingsOut,
    lessons,
    instructors,
    live,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Hammasi birga                                                       */
/* ------------------------------------------------------------------ */
export async function buildBossData(query: any) {
  const range = rangeFromQuery(query);
  const { from, to, label, period } = range;
  const bucket: Bucket = String(range.bucket) === 'week' ? 'day' : (range.bucket as Bucket);
  const fromYmd = range.fromYmd || tashkentYmd(from.toISOString());
  const toYmd = range.toYmd || tashkentYmd(new Date(to.getTime() - 1).toISOString());
  const span = to.getTime() - from.getTime();
  const prevFrom = new Date(from.getTime() - span);

  const [avd, bridge] = await Promise.all([
    buildAvtodrom(from, to, prevFrom, bucket),
    fetchOwnerBridge(fromYmd, toYmd, bucket),
  ]);
  const a12 = bridge.ok ? bridge.data : null;
  const P = a12?.paid?.totals || {}, PP = a12?.paid?.previous || {};
  const S = a12?.school?.totals || {}, SP = a12?.school?.previous || {};
  const E = a12?.expenses || {};

  /* --- UMUMIY --- */
  const revenue = {
    avtodrom: n(avd.kassa.totals.total), paid: n(P.revenue), school: n(S.revenue),
  };
  const prevRevenue = { avtodrom: n(avd.kassa.previous_total), paid: n(PP.revenue), school: n(SP.revenue) };
  const total = revenue.avtodrom + revenue.paid + revenue.school;
  const prevTotal = prevRevenue.avtodrom + prevRevenue.paid + prevRevenue.school;
  const expenses = n(E.total), prevExpenses = n(E.previous_total);

  const keys = allKeys(fromYmd, toYmd, bucket);
  const sm = new Map<string, any>(keys.map((k) => [k, { key: k, avtodrom: 0, paid: 0, school: 0, expenses: 0 }]));
  const at = (k: string) => { if (!sm.has(k)) sm.set(k, { key: k, avtodrom: 0, paid: 0, school: 0, expenses: 0 }); return sm.get(k); };
  for (const s of avd.kassa.series) at(s.key).avtodrom += n(s.total);
  for (const s of a12?.series || []) { const r = at(seriesKey(s.key, bucket)); r.paid += n(s.paid_revenue); r.school += n(s.school_revenue); }
  for (const s of E.series || []) { if (bucket !== 'hour') at(seriesKey(s.key, bucket)).expenses += n(s.total); }
  const series = [...sm.values()].sort((a, b) => a.key.localeCompare(b.key));

  const visits = {
    avtodrom: avd.lessons.paid, paid: n(P.sessions), school: n(S.sessions),
    total: avd.lessons.paid + n(P.sessions) + n(S.sessions),
  };
  const minutes = avd.lessons.minutes + n(P.minutes) + n(S.minutes);

  /* --- e'tibor talab qiladiganlar --- */
  const alerts: Array<{ level: 'warn' | 'info' | 'bad'; text: string }> = [];
  if (!bridge.ok) alerts.push({ level: 'bad', text: `Avtoshkola, platniy va xarajatlar ko‘rinmayapti: ${bridge.error}${bridge.hint ? ` — ${bridge.hint}` : ''}` });
  if (avd.lessons.unscanned.receipts) alerts.push({ level: 'warn', text: `${avd.lessons.unscanned.receipts} ta to‘langan chek instruktor tomonidan urilmagan (${nf(avd.lessons.unscanned.amount)} so‘m)` });
  if (n(a12?.paid?.debts?.total)) alerts.push({ level: 'warn', text: `Platniy qarzlar: ${nf(n(a12.paid.debts.total))} so‘m (${n(a12.paid.debts.sessions)} ta yozuv)` });
  if (n(a12?.school?.over_limit?.lessons)) alerts.push({ level: 'info', text: `Avtoshkola: ${n(a12.school.over_limit.lessons)} ta dars shartnoma limitidan oshgan — to‘lov kerak (${nf(n(a12.school.over_limit.due))} so‘m)` });
  if (n(avd.kassa.unassigned.receipts)) alerts.push({ level: 'info', text: `Kassaga bog‘lanmagan to‘lovlar: ${avd.kassa.unassigned.receipts} ta (${nf(avd.kassa.unassigned.total)} so‘m)` });
  if (avd.warnings.length) alerts.push({ level: 'bad', text: `Avtodrom ma’lumotining bir qismi yuklanmadi: ${avd.warnings.map((w) => w.section).join(', ')}` });

  let host = '';
  try { host = new URL(String(process.env.AVTODROM12_URL || process.env.SCHOOL_RECEIPT_URL || '')).host; } catch { /* yo'q */ }
  const { kind: _k, source: _s, ...a12data } = a12 || {};

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    period, label, bucket, from: from.toISOString(), to: to.toISOString(), from_day: fromYmd, to_day: toYmd,
    combined: {
      revenue: total, previous_revenue: prevTotal, change: pct(total, prevTotal),
      by_part: revenue, previous_by_part: prevRevenue,
      by_method: {
        cash: n(avd.kassa.totals.cash) + n(P.cash),
        card: n(avd.kassa.totals.card) + n(P.terminal),
        click: n(P.click),
      },
      visits, minutes,
      expenses, previous_expenses: prevExpenses, expenses_change: pct(expenses, prevExpenses),
      net: total - expenses, previous_net: prevTotal - prevExpenses, net_change: pct(total - expenses, prevTotal - prevExpenses),
      expenses_known: bridge.ok,
      series,
      alerts,
    },
    avtodrom: avd,
    avtodrom12: bridge.ok
      ? { ok: true, ms: bridge.ms, host, ...a12data }
      : { ok: false, host, status: bridge.status, error: bridge.error, hint: bridge.hint || null },
  };
}

/* ------------------------------------------------------------------ */
/* Marshrutlar                                                         */
/* ------------------------------------------------------------------ */
type Deps = {
  guardAdmin: (req: any) => Promise<void>;
  currentStaff: (req: any) => Promise<any>;
  adminUser: () => Promise<any>;
  audit: (adminId: string | null, action: string, entity: string, id: string | null, oldD: unknown, newD: unknown) => Promise<void>;
};

const PIN_RE = /^\d{4,8}$/;
const loginMax = () => Math.max(1, Number(process.env.BOSS_LOGIN_RATE_MAX) || 8);

export async function registerBossRoutes(app: FastifyInstance, deps: Deps) {
  const noStore = (reply: any) => { reply.header('Cache-Control', 'no-store'); reply.header('X-Robots-Tag', 'noindex, nofollow'); };
  const BAD_LINK = 'Havola eskirgan yoki noto‘g‘ri. Admin paneldan yangi havolani oling.';

  /* Havola to'g'rimi va PIN qo'yilganmi — sahifa ochilganda */
  app.get('/api/boss-hello', async (req: any, reply: any) => {
    noStore(reply);
    try {
      const link = await readBossLink();
      if (!checkKey(link, String(req.query?.k || ''))) return reply.code(403).send({ ok: false, error: BAD_LINK });
      return { ok: true, pin_set: !!link!.pin_hash };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Tekshirib bo‘lmadi' });
    }
  });

  /* PIN bilan kirish — IP bo'yicha qattiq chegara */
  app.post('/api/boss-login', { config: { rateLimit: { max: loginMax(), timeWindow: '15 minutes' } } }, async (req: any, reply: any) => {
    noStore(reply);
    try {
      const b = req.body || {};
      const link = await readBossLink();
      if (!checkKey(link, String(b.k || ''))) return reply.code(403).send({ ok: false, error: BAD_LINK });
      if (!link!.pin_hash) return reply.code(409).send({ ok: false, error: 'PIN hali qo‘yilmagan. Admin panel → Boshqaruv → Boshliq ilovasi.' });
      const pin = String(b.pin ?? '').trim();
      if (!PIN_RE.test(pin) || !safeEq(bossPinHash(pin), link!.pin_hash)) {
        return reply.code(401).send({ ok: false, error: 'PIN noto‘g‘ri' });
      }
      try { const a = await deps.adminUser(); await deps.audit(a?.id ?? null, 'BOSS_LOGIN', 'admin_settings', BOSS_KEY, null, { ua: String(req.headers?.['user-agent'] || '').slice(0, 120) }); } catch { /* audit ixtiyoriy */ }
      return { ok: true, ...makeBossToken(link!) };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Kirib bo‘lmadi' });
    }
  });

  /* Hamma raqamlar. Har muvaffaqiyatli so'rovda token yangilanadi (60 kun). */
  app.get('/api/boss-data', async (req: any, reply: any) => {
    noStore(reply);
    try {
      const link = await readBossLink();
      if (!verifyBossToken(link, bearer(req))) {
        return reply.code(401).send({ ok: false, error: 'Qayta kiring — PIN kerak', relogin: true });
      }
      const data = await buildBossData(req.query || {});
      return { ...data, session: makeBossToken(link!) };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Ma’lumot yuklanmadi' });
    }
  });

  /* Admin: havola holati (yo'q bo'lsa yaratiladi) */
  app.get('/api/admin/boss-link', async (req: any, reply: any) => {
    try {
      await deps.guardAdmin(req);
      let link = await readBossLink();
      if (!link) {
        const me = await deps.currentStaff(req).catch(() => null);
        link = await writeBossLink({ key: newKey(), pin_hash: null, at: new Date().toISOString(), by: me?.login || null, pin_at: null });
      }
      return { ok: true, url: bossUrl(link.key), pin_set: !!link.pin_hash, at: link.at, by: link.by, pin_at: link.pin_at };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Havola olinmadi' });
    }
  });

  /* Admin: PIN qo'yish/almashtirish va (yoki) havolani yangilash.
     Ikkalasi ham eski tokenlarni bekor qiladi — telefonda qayta PIN so'raladi. */
  app.post('/api/admin/boss-link', async (req: any, reply: any) => {
    try {
      await deps.guardAdmin(req);
      const b = req.body || {};
      const pin = b.pin === undefined || b.pin === null || b.pin === '' ? null : String(b.pin).trim();
      if (!b.reset && pin === null) return reply.code(400).send({ ok: false, error: 'pin yoki reset: true yuboring' });
      if (pin !== null && !PIN_RE.test(pin)) return reply.code(400).send({ ok: false, error: 'PIN 4–8 ta raqam bo‘lsin' });
      const me = await deps.currentStaff(req).catch(() => null);
      const cur = await readBossLink();
      const now = new Date().toISOString();
      const link: BossLink = {
        key: b.reset || !cur ? newKey() : cur.key,
        pin_hash: pin !== null ? bossPinHash(pin) : cur?.pin_hash || null,
        at: b.reset || !cur ? now : cur.at,
        by: b.reset || !cur ? me?.login || null : cur.by,
        pin_at: pin !== null ? now : cur?.pin_at || null,
      };
      await writeBossLink(link);
      try {
        const a = await deps.adminUser();
        await deps.audit(a?.id ?? null, b.reset ? 'BOSS_LINK_RESET' : 'BOSS_PIN_SET', 'admin_settings', BOSS_KEY, null, { by: me?.login || null, at: now, pin_changed: pin !== null });
      } catch { /* audit ixtiyoriy */ }
      return { ok: true, url: bossUrl(link.key), pin_set: !!link.pin_hash, at: link.at, by: link.by, pin_at: link.pin_at };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Saqlanmadi' });
    }
  });
}
