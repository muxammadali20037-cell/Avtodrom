import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import { selectIn } from './rest-chunks.js';
import { testInstructorIds } from './test-instructors.js';
import { loadBlocks } from './instructor-blocks.js';
import { loadSheet, loadSheets, parseKey, SHEET_HOURS } from './booking-sheet.js';
import { bookingSearchFilter, cleanSearchTerm } from './booking-search.js';
import {
  loadSchedules, specFor, mergeRanges, hmToMin, minToHm, tashkentYmdOf, addDaysYmd, dayStartMs, weekdayOf,
  type Range, type Schedule,
} from './instructor-schedule.js';

/**
 * NAZORAT PANELI — bitta maxfiy havola bilan hamma instruktorni ko'rish.
 *
 *   /nazorat?k=<token>  — sahifa (nazorat.html), faqat o'qish, parol yo'q.
 *   GET  /api/control-view?k=<token>&d=YYYY-MM-DD — ma'lumot:
 *        · tanlangan kun: har instruktor — ish vaqti (grafik), tanaffuslar,
 *          o'zi yopgan soatlar, bronlar (mijoz, telefon, kod, toifa, to'lov),
 *          Excel bron yozuvlari («BAND»), bugun bo'lsa — hozirgi holati;
 *        · o'sha hafta (Du–Yak): har instruktorning har kungi ish vaqti va bronlari;
 *        · statistika: bronlar, kelmagan, bekor, bandlik foizi.
 *   GET  /api/admin/control-link — admin: havola (yo'q bo'lsa yaratiladi)
 *   POST /api/admin/control-link { reset: true } — yangi havola, eskisi darhol ishlamay qoladi.
 *
 * Token: admin_settings → `control_link` = { token, at, by } (tasodifiy, 24 belgi).
 * Migratsiya kerak emas. Sozlamalar ro'yxatida bu kalit yashirin.
 */

export const CONTROL_KEY = 'control_link';
const q = (v: string) => encodeURIComponent(v);
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const BASE = () => String(process.env.PUBLIC_BASE_URL || 'https://avtodrom.vercel.app').replace(/\/+$/, '');
/** Joyni egallagan bronlar (bandlik hisobiga kiradi) */
const HOLD = new Set(['pending', 'confirmed', 'in_progress', 'completed', 'no_show']);
const LIVE = new Set(['pending', 'confirmed', 'in_progress']);
const CANCEL = new Set(['cancelled', 'rejected']);

/* ------------------------------------------------------------------ */
/* Havola (token)                                                      */
/* ------------------------------------------------------------------ */
async function readToken(): Promise<{ token: string; at: string | null; by: string | null } | null> {
  const rows = await supabaseRest<any[]>('admin_settings', { query: `?key=eq.${CONTROL_KEY}&select=value&limit=1` });
  const v = rows?.[0]?.value;
  const x = v?.token ? v : v?.value?.token ? v.value : null;
  return x && typeof x.token === 'string' && x.token.length >= 20 ? { token: x.token, at: x.at || null, by: x.by || null } : null;
}
async function writeToken(by: string | null) {
  const value = { token: crypto.randomBytes(18).toString('base64url'), at: new Date().toISOString(), by };
  const now = value.at;
  const rows = await supabaseRest<any[]>('admin_settings', {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, query: `?key=eq.${CONTROL_KEY}`,
    body: JSON.stringify({ value, updated_at: now }),
  });
  if (!rows?.length) await supabaseRest('admin_settings', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ key: CONTROL_KEY, value, updated_at: now }) });
  return value;
}
export const controlUrl = (token: string) => `${BASE()}/nazorat?k=${token}`;

/** Havola to'g'rimi (vaqtga bog'liq bo'lmagan solishtirish) */
export async function checkControlToken(k: string): Promise<boolean> {
  if (!k || k.length < 20 || k.length > 64) return false;
  const cur = await readToken().catch(() => null);
  if (!cur) return false;
  const a = Buffer.from(k), b = Buffer.from(cur.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/* Hisob                                                               */
/* ------------------------------------------------------------------ */
const hmOk = (v: unknown) => /^\d{1,2}:\d{2}/.test(String(v || ''));
async function workSettings() {
  const rows = await supabaseRest<any[]>('admin_settings', { query: '?key=in.(work_start,work_end)&select=key,value' }).catch(() => []);
  const sv = (k: string) => { const r = (rows || []).find((x: any) => x.key === k); return r ? (r.value?.value ?? r.value) : null; };
  const s = hmOk(sv('work_start')) ? hmToMin(String(sv('work_start')).slice(0, 5).padStart(5, '0')) : null;
  const e = hmOk(sv('work_end')) ? hmToMin(String(sv('work_end')).slice(0, 5).padStart(5, '0')) : null;
  const start = s ?? 7 * 60, end = e != null && e > start ? e : 19 * 60;
  return { start, end };
}

/** Kunning ochiq (ishlaydigan) oraliqlari: ish vaqti − grafik yopiqlari − o'zi yopgani */
export function openRanges(start: number, end: number, closed: Range[]): Range[] {
  const out: Range[] = [];
  let cur = start;
  for (const [a, b] of mergeRanges(closed)) {
    if (b <= cur) continue;
    if (a >= end) break;
    if (a > cur) out.push([cur, a]);
    cur = Math.max(cur, b);
    if (cur >= end) break;
  }
  if (cur < end) out.push([cur, end]);
  return out.filter(([a, b]) => b > a);
}
const sumR = (r: Range[]) => r.reduce((s, [a, b]) => s + (b - a), 0);
const hmR = (r: Range[]) => r.map(([a, b]) => [minToHm(a), minToHm(b)]);
/** Bir kunga tushgan oraliq (ms) → shu kunning daqiqalari */
function clipDay(ymd: string, s: number, e: number): Range | null {
  const d0 = dayStartMs(ymd);
  const a = Math.max(0, Math.round((s - d0) / 60000)), b = Math.min(1440, Math.round((e - d0) / 60000));
  return b > a ? [a, b] : null;
}

type DayPlan = { off: boolean; custom: boolean; open: Range[]; closed: Range[]; own: Range[]; work_min: number };
function planFor(s: Schedule | undefined, ymd: string, ws: { start: number; end: number }, own: Range[], active: boolean): DayPlan {
  const spec = specFor(s, ymd);
  const custom = !!s?.dates?.[ymd];
  if (!active || spec?.off) return { off: true, custom, open: [], closed: [], own: [], work_min: 0 };
  const closed = (spec?.closed || []).filter(([a, b]) => b > ws.start && a < ws.end);
  const ownIn = mergeRanges(own).filter(([a, b]) => b > ws.start && a < ws.end);
  const open = openRanges(ws.start, ws.end, [...closed, ...ownIn]);
  return { off: !open.length, custom, open, closed, own: ownIn, work_min: sumR(open) };
}

const durMin = (b: any) => {
  const s = Date.parse(b.start_at), e = Date.parse(b.end_at);
  return Number.isFinite(e) && e > s ? Math.round((e - s) / 60000) : Number(b.duration_minutes) || 60;
};
const pct = (a: number, b: number) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0);

type Who = { kind: string; by: string | null; at: string | null };
/** Bronni kim yozgan: Excel bron (xodim / instruktor boti), mijoz (Mini App), kassa, qo'lda bron */
function whoFrom(b: any, sc: { by: string | null; at: string | null } | undefined, logBy: Map<string, string>, payReg: Map<string, string>): Who {
  if (sc) return { kind: /^Bot\b/.test(String(sc.by || '')) ? 'bot' : 'sheet', by: sc.by, at: sc.at || b.created_at || null };
  const at = b.created_at || null;
  if (b.source === 'app') return { kind: 'app', by: null, at };
  if (b.source === 'walk_in') return { kind: 'kassa', by: logBy.get(String(b.id)) || payReg.get(String(b.id)) || null, at };
  if (b.source === 'admin' || b.source === 'manual') return { kind: 'manual', by: logBy.get(String(b.id)) || null, at };
  return { kind: String(b.source || 'other'), by: null, at };
}
/** Qo'lda bron / kassa — kim yozgani (audit logda `by`) va to'lov kassasi kodi */
async function whoMaps(rows: any[]) {
  const [pays, logs, regs] = await Promise.all([
    selectIn<any>('payments', 'booking_id', rows.map((b) => b.id), 'booking_id,status,register_id').catch(() => []),
    selectIn<any>('admin_audit_logs', 'entity_id', rows.filter((b) => b.source === 'admin' || b.source === 'walk_in').map((b) => b.id), 'entity_id,new_data',
      '&action=in.(MANUAL_BOOKING_CREATED,WALK_IN_CREATED)').catch(() => []),
    supabaseRest<any[]>('cash_registers', { query: '?select=id,code' }).catch(() => []),
  ]);
  const regCode = new Map((regs || []).map((r: any) => [String(r.id), String(r.code || '')]));
  return {
    paid: new Set(pays.filter((p) => String(p.status) === 'paid').map((p) => String(p.booking_id))),
    payReg: new Map(pays.filter((p) => p.register_id).map((p) => [String(p.booking_id), regCode.get(String(p.register_id)) || ''])),
    logBy: new Map<string, string>((logs || []).filter((l: any) => l?.new_data?.by).map((l: any) => [String(l.entity_id), String(l.new_data.by)])),
  };
}

/**
 * BRONNI QIDIRISH (🔍): telefon oxiri («4567»), ism yoki bron kodi («AVD-4821», «4821»).
 * Oraliq: 30 kun oldin — 60 kun keyin. Kimga (instruktor), qachon, kim yozgan.
 */
export async function searchControl(raw: unknown, nowMs = Date.now()) {
  const term = cleanSearchTerm(raw);
  const digits = term.replace(/\D/g, '');
  if (!term || (digits.length < 3 && !/\p{L}{2,}/u.test(term))) return { results: [], hint: 'Kamida 3 ta raqam (telefon oxiri) yoki ism yozing' };
  const f = await bookingSearchFilter(term);
  if (!f) return { results: [] };
  const today = tashkentYmdOf(nowMs);
  const from = new Date(dayStartMs(addDaysYmd(today, -30))).toISOString(), to = new Date(dayStartMs(addDaysYmd(today, 61))).toISOString();
  const rows = await supabaseRest<any[]>('bookings', {
    query: `?${f}&start_at=gte.${q(from)}&start_at=lt.${q(to)}`
      + '&select=id,instructor_id,customer_id,start_at,end_at,status,pickup_code,source,category,duration_minutes,customer_note,created_at'
      + '&order=start_at.desc&limit=80',
  });
  if (!rows.length) return { results: [] };
  const ips = await selectIn<any>('instructor_profiles', 'id', rows.map((b) => b.instructor_id), 'id,user_id,categories');
  const [users, wm, sheets] = await Promise.all([
    selectIn<any>('users', 'id', [...rows.map((b) => b.customer_id), ...ips.map((i) => i.user_id)], 'id,full_name,phone'),
    whoMaps(rows),
    loadSheets([...new Set(rows.map((b) => tashkentYmdOf(Date.parse(b.start_at))))]).catch(() => new Map()),
  ]);
  const um = new Map(users.map((u) => [String(u.id), u]));
  const im = new Map(ips.map((i) => [String(i.id), i]));
  const cellOf = (b: any) => {
    const sh: any = sheets.get(tashkentYmdOf(Date.parse(b.start_at)));
    const c: any = Object.values(sh?.cells || {}).find((x: any) => String(x?.b || '') === String(b.id));
    return c ? { by: c.by || null, at: c.at || null, t: String(c.t || '') } : undefined;
  };
  const soon = nowMs - 2 * 3600e3;
  const results = rows.map((b) => {
    const c: any = um.get(String(b.customer_id)) || {};
    const ip: any = im.get(String(b.instructor_id));
    const iu: any = ip ? um.get(String(ip.user_id)) || {} : null;
    const sc = cellOf(b);
    return {
      id: String(b.id), date: tashkentYmdOf(Date.parse(b.start_at)), start: b.start_at, end: b.end_at, min: durMin(b), status: String(b.status),
      code: b.pickup_code || null, name: c.full_name || 'Mijoz', phone: c.phone || null,
      cat: String(b.category || '').toUpperCase() || null, paid: wm.paid.has(String(b.id)), src: b.source || null, sheet: !!sc, t: sc?.t || null,
      note: b.customer_note ? String(b.customer_note).slice(0, 140) : null, created_at: b.created_at || null,
      ins: ip ? { id: String(ip.id), name: iu?.full_name || 'Instruktor', phone: iu?.phone || null, categories: ip.categories || [] } : null,
      who: whoFrom(b, sc, wm.logBy, wm.payReg),
    };
  })
    /* avval yaqin va kelgusi (o'sish tartibida), keyin o'tganlar (yangisi tepada); bekor qilinganlar oxirida */
    .sort((a, b) => {
      const ca = CANCEL.has(a.status) ? 1 : 0, cb = CANCEL.has(b.status) ? 1 : 0;
      if (ca !== cb) return ca - cb;
      const fa = Date.parse(a.end) >= soon ? 0 : 1, fb = Date.parse(b.end) >= soon ? 0 : 1;
      if (fa !== fb) return fa - fb;
      return fa === 0 ? Date.parse(a.start) - Date.parse(b.start) : Date.parse(b.start) - Date.parse(a.start);
    });
  return { results: results.slice(0, 40), total: results.length };
}

export async function controlData(date: string, nowMs = Date.now()) {
  const today = tashkentYmdOf(nowMs);
  const wd = weekdayOf(date);
  const mon = addDaysYmd(date, -((wd + 6) % 7));
  const days = Array.from({ length: 7 }, (_, i) => addDaysYmd(mon, i));
  const wS = dayStartMs(mon), wE = dayStartMs(addDaysYmd(mon, 7));
  const dS = dayStartMs(date), dE = dS + 864e5;

  const [ips, week, hidden, ws, sheet] = await Promise.all([
    supabaseRest<any[]>('instructor_profiles', { query: '?is_verified=eq.true&select=id,user_id,categories,vehicle_model,vehicle_plate,is_available,rating&limit=500' }),
    supabaseRest<any[]>('bookings', {
      query: `?start_at=lt.${q(new Date(wE).toISOString())}&end_at=gt.${q(new Date(wS).toISOString())}`
        + '&select=id,instructor_id,customer_id,start_at,end_at,status,pickup_code,source,category,duration_minutes,customer_note,arrived_at,created_at'
        + '&order=start_at.asc&limit=5000',
    }),
    testInstructorIds(),
    workSettings(),
    loadSheet(date).catch(() => ({ cells: {} as Record<string, any> })),
  ]);
  const dayB = week.filter((b) => Date.parse(b.start_at) < dE && Date.parse(b.end_at) > dS);
  const [users, pays, logs, regs] = await Promise.all([
    selectIn<any>('users', 'id', [...ips.map((i) => i.user_id), ...dayB.map((b) => b.customer_id)], 'id,full_name,phone,is_active,is_blocked'),
    selectIn<any>('payments', 'booking_id', dayB.map((b) => b.id), 'booking_id,status,register_id'),
    /* qo'lda bron / kassa — kim yozgani (audit logda `by`) */
    selectIn<any>('admin_audit_logs', 'entity_id', dayB.filter((b) => b.source === 'admin' || b.source === 'walk_in').map((b) => b.id), 'entity_id,new_data',
      '&action=in.(MANUAL_BOOKING_CREATED,WALK_IN_CREATED)').catch(() => []),
    supabaseRest<any[]>('cash_registers', { query: '?select=id,code' }).catch(() => []),
  ]);
  const um = new Map(users.map((u) => [String(u.id), u]));
  const paid = new Set(pays.filter((p) => String(p.status) === 'paid').map((p) => String(p.booking_id)));
  const regCode = new Map((regs || []).map((r: any) => [String(r.id), String(r.code || '')]));
  const payReg = new Map(pays.filter((p) => p.register_id).map((p) => [String(p.booking_id), regCode.get(String(p.register_id)) || '']));
  const logBy = new Map((logs || []).filter((l: any) => l?.new_data?.by).map((l: any) => [String(l.entity_id), String(l.new_data.by)]));

  const usedWeek = new Set(week.filter((b) => HOLD.has(String(b.status))).map((b) => String(b.instructor_id)));
  const cellsByIns = new Map<string, { h: number; t: string; by: string | null; at: string | null }[]>();
  /** Excel bron katagi → bron: birinchi katak (matn, kim, qachon yozgan) */
  const sheetOf = new Map<string, { t: string; by: string | null; at: string | null; h: number }>();
  for (const [k, c] of Object.entries<any>(sheet.cells || {}).sort(([a], [b]) => a.localeCompare(b))) {
    const p = parseKey(k); if (!p) continue;
    const t = String(c?.t || '').trim(); if (!t) continue;
    const bk = c?.b ? dayB.find((b) => String(b.id) === String(c.b)) : null;
    if (c?.b && !sheetOf.has(String(c.b))) sheetOf.set(String(c.b), { t, by: c.by || null, at: c.at || null, h: p.h });
    if (bk && !CANCEL.has(String(bk.status))) continue;            // bron sifatida ko'rinadi
    cellsByIns.set(p.ins, [...(cellsByIns.get(p.ins) || []), { h: p.h, t, by: c.by || null, at: c.at || null }]);
  }

  const list = ips.map((x) => {
    const u: any = um.get(String(x.user_id)) || {};
    const id = String(x.id);
    const active = Boolean(x.is_available && u.is_active !== false && !u.is_blocked) && !hidden.has(id);
    const cats = (Array.isArray(x.categories) && x.categories.length ? x.categories : ['B']).map((c: any) => String(c).toUpperCase()).sort();
    return { id, name: u.full_name || 'Instruktor', phone: u.phone || null, categories: cats, car: [x.vehicle_model, x.vehicle_plate].filter(Boolean).join(' · ') || null, active, rating: Number(x.rating) || 0 };
  }).filter((i) => i.active || usedWeek.has(i.id) || cellsByIns.has(i.id))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.categories.join().localeCompare(b.categories.join()) || a.name.localeCompare(b.name, 'uz'));
  const ids = list.map((i) => i.id);

  const [sched, own] = await Promise.all([loadSchedules(ids), ids.length ? loadBlocks(ids) : Promise.resolve(new Map())]);
  /** instruktor o'zi yopgan soatlar, kun bo'yicha */
  const ownOn = (id: string, ymd: string): Range[] =>
    ((own.get(id) || []) as any[]).filter((b) => !b.off && !b.sheet)
      .map((b) => clipDay(ymd, Date.parse(b.start_at), Date.parse(b.end_at))).filter(Boolean) as Range[];

  const nowMin = date === today ? Math.floor((nowMs - dS) / 60000) : null;
  const bOut = (b: any) => {
    const c: any = um.get(String(b.customer_id)) || {};
    return {
      id: String(b.id), start: b.start_at, end: b.end_at, min: durMin(b), status: String(b.status),
      code: b.pickup_code || null, name: c.full_name || 'Mijoz', phone: c.phone || null,
      cat: String(b.category || '').toUpperCase() || null, paid: paid.has(String(b.id)), src: b.source || null, sheet: sheetOf.has(String(b.id)),
      note: b.customer_note ? String(b.customer_note).slice(0, 140) : null, arrived: !!b.arrived_at,
      created_at: b.created_at || null, t: sheetOf.get(String(b.id))?.t || null, who: whoOf(b),
    };
  };
  const whoOf = (b: any) => whoFrom(b, sheetOf.get(String(b.id)), logBy, payReg);

  const tot = { bron: 0, booked_min: 0, work_min: 0, no_show: 0, cancelled: 0, completed: 0, paid: 0, working: 0, lesson_now: 0, free_now: 0 };
  const instructors = list.map((i) => {
    const plan = planFor(sched.get(i.id), date, ws, ownOn(i.id, date), i.active);
    const mine = dayB.filter((b) => String(b.instructor_id) === i.id);
    const held = mine.filter((b) => HOLD.has(String(b.status)));
    const bookings = mine.filter((b) => !CANCEL.has(String(b.status))).map(bOut);
    const booked = held.reduce((s, b) => { const r = clipDay(date, Date.parse(b.start_at), Date.parse(b.end_at)); return s + (r ? r[1] - r[0] : 0); }, 0);
    const st = {
      bron: held.length, booked_min: booked, work_min: plan.work_min, load: pct(booked, plan.work_min),
      no_show: mine.filter((b) => b.status === 'no_show').length,
      cancelled: mine.filter((b) => CANCEL.has(String(b.status))).length,
      completed: mine.filter((b) => b.status === 'completed').length,
      paid: held.filter((b) => paid.has(String(b.id))).length,
    };
    for (const k of ['bron', 'booked_min', 'work_min', 'no_show', 'cancelled', 'completed', 'paid'] as const) tot[k] += st[k];
    if (plan.work_min > 0) tot.working++;

    /* hozirgi holat — faqat bugun */
    let now: any = null;
    if (nowMin != null) {
      const at = nowMs;
      /* boshlangan dars (vaqtidan oshgan bo'lsa ham) ustun, keyin vaqti kelgan bron */
      const cur = held.filter((b) => b.status === 'in_progress' && Date.parse(b.start_at) <= at).sort((a, b) => Date.parse(b.start_at) - Date.parse(a.start_at))[0]
        || held.find((b) => LIVE.has(String(b.status)) && Date.parse(b.start_at) <= at && Date.parse(b.end_at) > at);
      const next = held.filter((b) => LIVE.has(String(b.status)) && Date.parse(b.start_at) > at).sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at))[0];
      const inR = (r: Range[]) => r.find(([a, b]) => nowMin >= a && nowMin < b);
      if (cur) now = { state: cur.status === 'in_progress' ? 'lesson' : 'due', booking: bOut(cur), ...(Date.parse(cur.end_at) <= at ? { over: Math.round((at - Date.parse(cur.end_at)) / 60000) } : {}) };
      else if (plan.off) now = { state: 'off' };
      else if (nowMin < (plan.open[0]?.[0] ?? 0)) now = { state: 'before', at: minToHm(plan.open[0][0]) };
      else if (nowMin >= (plan.open[plan.open.length - 1]?.[1] ?? 1440)) now = { state: 'done' };
      else if (!inR(plan.open)) {
        const nx = plan.open.find(([a]) => a > nowMin);
        now = { state: inR(plan.own) ? 'own' : 'break', until: nx ? minToHm(nx[0]) : null };
      } else now = { state: 'free' };
      if (next) now.next = bOut(next);
      if (now.state === 'lesson' || now.state === 'due') tot.lesson_now++;
      if (now.state === 'free') tot.free_now++;
    }

    /* hafta */
    const wk = days.map((d) => {
      const p = d === date ? plan : planFor(sched.get(i.id), d, ws, ownOn(i.id, d), i.active);
      const dB = week.filter((b) => String(b.instructor_id) === i.id && Date.parse(b.start_at) < dayStartMs(d) + 864e5 && Date.parse(b.end_at) > dayStartMs(d));
      const h = dB.filter((b) => HOLD.has(String(b.status)));
      const m = h.reduce((s, b) => { const r = clipDay(d, Date.parse(b.start_at), Date.parse(b.end_at)); return s + (r ? r[1] - r[0] : 0); }, 0);
      return { date: d, off: p.off, custom: p.custom, open: hmR(p.open), work_min: p.work_min, bron: h.length, booked_min: m,
        no_show: dB.filter((b) => b.status === 'no_show').length, cancelled: dB.filter((b) => CANCEL.has(String(b.status))).length };
    });

    return {
      ...i,
      day: { off: plan.off, custom: plan.custom, open: hmR(plan.open), closed: hmR(plan.closed), own: hmR(plan.own) },
      bookings, notes: (cellsByIns.get(i.id) || []).sort((a, b) => a.h - b.h), stats: st, now, week: wk,
    };
  });

  const weekTotals = days.map((d, k) => {
    const x = { date: d, bron: 0, booked_min: 0, work_min: 0, no_show: 0, cancelled: 0, working: 0 };
    for (const i of instructors) {
      const w = i.week[k];
      x.bron += w.bron; x.booked_min += w.booked_min; x.work_min += w.work_min; x.no_show += w.no_show; x.cancelled += w.cancelled;
      if (w.work_min > 0) x.working++;
    }
    return { ...x, load: pct(x.booked_min, x.work_min) };
  });

  return {
    date, today, now: new Date(nowMs).toISOString(), work: { start: minToHm(ws.start), end: minToHm(ws.end) }, hours: SHEET_HOURS,
    sheet: { updated_at: (sheet as any).updated_at || null, updated_by: (sheet as any).updated_by || null },
    stats: { ...tot, instructors: instructors.length, load: pct(tot.booked_min, tot.work_min) },
    instructors, week: { from: mon, days, totals: weekTotals },
  };
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */
type Deps = {
  guardAdmin: (req: any) => Promise<any>;
  currentStaff: (req: any) => Promise<any>;
  adminUser: () => Promise<any>;
  audit: (adminId: string | null, action: string, entityType: string, entityId: string | null, oldData: unknown, newData: unknown) => Promise<void>;
};

export async function registerControlRoutes(app: FastifyInstance, deps: Deps) {
  /* Ochiq (maxfiy havola bilan) — nazorat sahifasi shu yerdan o'qiydi */
  app.get('/api/control-view', async (req: any, reply: any) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    try {
      if (!(await checkControlToken(String(req.query?.k || '')))) {
        return reply.code(403).send({ ok: false, error: 'Havola eskirgan yoki noto‘g‘ri. Admin paneldan yangi havolani oling.' });
      }
      const today = tashkentYmdOf(Date.now());
      const raw = String(req.query?.d || '');
      const date = YMD.test(raw) ? raw : today;
      if (date < addDaysYmd(today, -92) || date > addDaysYmd(today, 92)) return reply.code(400).send({ ok: false, error: 'Sana 3 oy oralig‘ida bo‘lsin' });
      return { ok: true, ...(await controlData(date)) };
    } catch (e: any) {
      return reply.code(500).send({ ok: false, error: e?.message || 'Ma’lumot yuklanmadi' });
    }
  });

  /* Bronni qidirish (🔍) — telefon oxiri, ism yoki kod */
  app.get('/api/control-search', async (req: any, reply: any) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    try {
      if (!(await checkControlToken(String(req.query?.k || '')))) {
        return reply.code(403).send({ ok: false, error: 'Havola eskirgan yoki noto‘g‘ri. Admin paneldan yangi havolani oling.' });
      }
      return { ok: true, ...(await searchControl(req.query?.q)) };
    } catch (e: any) {
      return reply.code(500).send({ ok: false, error: e?.message || 'Qidirib bo‘lmadi' });
    }
  });

  /* Admin: havolani olish (yo'q bo'lsa yaratiladi) va yangilash */
  app.get('/api/admin/control-link', async (req: any, reply: any) => {
    try {
      await deps.guardAdmin(req);
      let t = await readToken();
      if (!t) {
        const me = await deps.currentStaff(req).catch(() => null);
        t = await writeToken(me?.login || null);
      }
      return { ok: true, url: controlUrl(t.token), at: t.at, by: t.by };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Havola olinmadi' });
    }
  });
  app.post('/api/admin/control-link', async (req: any, reply: any) => {
    try {
      await deps.guardAdmin(req);
      if (!req.body?.reset) return reply.code(400).send({ ok: false, error: 'reset: true yuboring' });
      const me = await deps.currentStaff(req).catch(() => null);
      const t = await writeToken(me?.login || null);
      try { const a = await deps.adminUser(); await deps.audit(a?.id ?? null, 'CONTROL_LINK_RESET', 'admin_settings', CONTROL_KEY, null, { by: me?.login || null, at: t.at }); } catch { /* audit ixtiyoriy */ }
      return { ok: true, url: controlUrl(t.token), at: t.at, by: t.by };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Havola yangilanmadi' });
    }
  });
}
