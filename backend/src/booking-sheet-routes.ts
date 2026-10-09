import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import { testInstructorIds } from './test-instructors.js';
import { selectIn } from './rest-chunks.js';
import { loadBlocks, type Block } from './instructor-blocks.js';
import { tashkentYmdOf, addDaysYmd } from './instructor-schedule.js';
import { loadTariffs } from './pricing.js';
import { loadPackagePrices, priceWithPackage, insertBookings } from './packages.js';
import type { StaffIdentity } from './staff-auth.js';
import {
  SHEET_HOURS, cellKey, parseKey, hourStartMs, cleanText, parsePhone, parseCategory, parseHalf, nameFrom,
  prettyPhone, buildRuns, loadSheet, writeSheet, type Sheet, type SheetCell, type Run, type RunInput,
} from './booking-sheet.js';

/**
 * EXCEL BRON — API (mantiq: booking-sheet.ts)
 *
 *   GET /api/admin/booking-sheet?date=YYYY-MM-DD — admin, operator, kassa (kassa faqat ko'radi)
 *   PUT /api/admin/booking-sheet { date, changes: [{ key, t, prev }] } — admin va operator
 *
 * Saqlashda har bir o'zgargan katak tekshiriladi (`prev` — xodim ko'rgan eski
 * matn; boshqa xodim o'zgartirib ulgurgan bo'lsa katak yozilmaydi). Raqamli
 * kataklardan bron yaratiladi, raqami o'chirilgan yoki almashtirilgan
 * kataklarning eski broni bekor qilinadi (to'lanmagan va boshlanmagan bo'lsa).
 */

type Deps = {
  currentStaff: (req: any) => Promise<StaffIdentity>;
  guardDesk: (req: any) => Promise<StaffIdentity>;
  adminUser: () => Promise<any>;
  audit: (adminId: string | null, action: string, entityType: string, entityId: string | null, oldData: unknown, newData: unknown) => Promise<void>;
};

const q = (v: string) => encodeURIComponent(v);
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const iso = (ms: number) => new Date(ms).toISOString();
const SHOWN = ['pending', 'confirmed', 'in_progress', 'completed', 'no_show'];
const BUSY = ['pending', 'confirmed', 'in_progress'];
/** Soat boshlanganidan keyin shuncha daqiqa ichida yozilgan raqam ham bron bo'ladi */
const GRACE_MS = 10 * 60000;
const fmtHm = (ms: number) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
const durOf = (b: any) => {
  const s = Date.parse(b.start_at), e = Date.parse(b.end_at);
  return Number.isFinite(e) && e > s ? Math.round((e - s) / 60000) : Number(b.duration_minutes) || 60;
};
const samePhone = (a: unknown, b: unknown) => {
  const d = (v: unknown) => String(v ?? '').replace(/\D/g, '').slice(-9);
  return d(a).length === 9 && d(a) === d(b);
};

/** shown — Excel bron jadvalida ko'rinadimi (sinov akkaunti faqat o'sha kuni yozuvi bo'lsa) */
type Ins = { id: string; name: string; phone: string | null; categories: string[]; group: string; active: boolean; shown: boolean };
type State = {
  date: string; dayS: number; sheet: Sheet; instructors: Ins[]; insMap: Map<string, Ins>;
  day: any[]; byId: Map<string, any>; users: Map<string, any>; paid: Set<string>;
  blocks: Map<string, Block[]>; refs: Map<string, string[]>;
};

/** Bir kunning hamma ma'lumoti: jadval, instruktorlar, bronlar, to'lovlar, yopiq/dam vaqtlar. */
async function loadState(date: string): Promise<State> {
  const dayS = hourStartMs(date, 0), dayE = dayS + 864e5;
  const [sheet, ips, day, hidden] = await Promise.all([
    loadSheet(date),
    supabaseRest<any[]>('instructor_profiles', { query: '?is_verified=eq.true&select=*&limit=500' }),
    supabaseRest<any[]>('bookings', {
      query: `?start_at=lt.${q(iso(dayE))}&end_at=gt.${q(iso(dayS))}&status=in.(${SHOWN.join(',')})&select=*&order=start_at.asc&limit=1000`,
    }),
    testInstructorIds(),
  ]);
  const refs = new Map<string, string[]>();
  for (const [k, c] of Object.entries(sheet.cells)) {
    if (!c.b) continue;
    refs.set(c.b, [...(refs.get(c.b) || []), k]);
  }
  const byId = new Map<string, any>(day.map((b) => [String(b.id), b]));
  const missing = [...refs.keys()].filter((id) => !byId.has(id));
  if (missing.length) for (const b of await selectIn<any>('bookings', 'id', missing, '*')) byId.set(String(b.id), b);
  const all = [...byId.values()];
  const [users, pays] = await Promise.all([
    selectIn<any>('users', 'id', [...all.map((b) => b.customer_id), ...ips.map((i) => i.user_id)], 'id,full_name,phone,role,is_active,is_blocked'),
    selectIn<any>('payments', 'booking_id', all.map((b) => b.id), 'booking_id,status'),
  ]);
  const um = new Map(users.map((u) => [String(u.id), u]));
  const paid = new Set(pays.filter((p) => String(p.status) === 'paid').map((p) => String(p.booking_id)));

  const usedIns = new Set<string>([...day.map((b) => String(b.instructor_id)),
    ...Object.keys(sheet.cells).map((k) => parseKey(k)?.ins || '')]);
  const instructors: Ins[] = ips.map((x) => {
    const u: any = um.get(String(x.user_id)) || null;
    const cats = (Array.isArray(x.categories) && x.categories.length ? x.categories : ['B']).map((c: any) => String(c).toUpperCase()).sort();
    const id = String(x.id), test = hidden.has(id);
    const active = Boolean(x.is_available && u?.is_active !== false && !u?.is_blocked);
    return {
      id, name: u?.full_name || x.full_name || 'Instruktor', phone: u?.phone || null,
      categories: cats, group: cats.join(', '),
      active: active && !test,
      shown: (active && !test) || usedIns.has(id),
      /* sinov akkaunti jadvalda ko'rinmasa ham o'z botidan bron yoza oladi */
      keep: test && active,
    };
  }).filter((i) => i.shown || i.keep)
    .map(({ keep: _keep, ...i }) => i)
    .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name, 'uz'));
  const insMap = new Map(instructors.map((i) => [i.id, i]));
  const blocks = await loadBlocks(instructors.map((i) => i.id), { from: new Date(dayS), to: new Date(dayE) }, { sheet: false });
  return { date, dayS, sheet, instructors, insMap, day, byId, users: um, paid, blocks, refs };
}

const lockedReason = (st: State, b: any): string | null => {
  if (!b) return null;
  if (st.paid.has(String(b.id))) return 'paid';
  if (['in_progress', 'completed', 'no_show'].includes(String(b.status))) return String(b.status);
  return null;
};
const LOCK_MSG: Record<string, string> = {
  paid: 'Bu bron to‘langan — katakni o‘zgartirib bo‘lmaydi. Bronni «Bronlar» bo‘limida ko‘ring.',
  in_progress: 'Dars boshlangan — katakni o‘zgartirib bo‘lmaydi.',
  completed: 'Dars tugagan — katakni o‘zgartirib bo‘lmaydi.',
  no_show: 'Bron «Kelmagan» deb yopilgan — katakni o‘zgartirib bo‘lmaydi.',
  bk: 'Bu soatda boshqa bron bor (Mini App, qo‘lda bron yoki kassa). Avval o‘sha bronni bekor qiling.',
  own: 'Instruktor bu soatni o‘zi yopgan.',
  off: 'Ish grafigi bo‘yicha instruktor bu vaqtda ishlamaydi.',
};

function bkOut(st: State, b: any) {
  const u = st.users.get(String(b.customer_id));
  return {
    id: String(b.id), code: b.pickup_code || null, status: b.status, name: u?.full_name || 'Mijoz', phone: u?.phone || null,
    start: b.start_at, end: b.end_at, min: durOf(b), paid: st.paid.has(String(b.id)), src: b.source || null,
    cat: String(b.category || '').toUpperCase() || null, sheet: st.refs.has(String(b.id)),
  };
}

/** Bitta katakning holati: Excel yozuvi, boshqa bron, instruktor yopgan, grafik bo'yicha dam. */
function cellInfo(st: State, ins: string, h: number) {
  const key = cellKey(ins, h);
  const s = hourStartMs(st.date, h), e = s + 3600e3;
  const sc: SheetCell | undefined = st.sheet.cells[key];
  const own = sc?.b ? st.byId.get(sc.b) : null;
  let foreign: any = null, best = 0;
  for (const b of st.day) {
    if (String(b.instructor_id) !== ins || (own && String(b.id) === String(own.id))) continue;
    if (sc?.b === String(b.id)) continue;
    if (st.refs.has(String(b.id)) && (st.refs.get(String(b.id)) || []).includes(key)) continue;
    const ov = Math.min(e, Date.parse(b.end_at)) - Math.max(s, Date.parse(b.start_at));
    if (ov > best) { best = ov; foreign = b; }
  }
  const bl = (st.blocks.get(ins) || []).filter((x) => Date.parse(x.start_at) < e && Date.parse(x.end_at) > s);
  const ownBlk = bl.find((x) => !x.off), offBlk = bl.find((x) => x.off);
  if (sc) {
    const lock = own && own.status !== 'cancelled' ? lockedReason(st, own) : null;
    return { key, s, e, sc, own, foreign, lock,
      out: { k: own && own.status !== 'cancelled' ? 'sheet' : 'note', t: sc.t, ...(sc.e ? { e: sc.e } : {}),
        ...(sc.by ? { by: sc.by } : {}), ...(sc.at ? { at: sc.at } : {}),
        ...(own ? { bk: bkOut(st, own) } : {}), ...(foreign ? { fb: bkOut(st, foreign) } : {}),
        ...(lock ? { lock } : {}), ...(!own && (ownBlk || offBlk) ? { warn: offBlk ? 'off' : 'own' } : {}) } };
  }
  if (foreign) return { key, s, e, sc, own: null, foreign, lock: 'bk', out: { k: 'bk', bk: bkOut(st, foreign), lock: 'bk' } };
  if (ownBlk) return { key, s, e, sc, own: null, foreign: null, lock: 'own', out: { k: 'own', lock: 'own' } };
  if (offBlk) return { key, s, e, sc, own: null, foreign: null, lock: 'off', out: { k: 'off', lock: 'off' } };
  return { key, s, e, sc, own: null, foreign: null, lock: null, out: null };
}

function view(st: State, me: StaffIdentity) {
  const today = tashkentYmdOf(Date.now());
  const cells: Record<string, any> = {};
  const shown = st.instructors.filter((i) => i.shown);
  for (const i of shown) {
    for (const h of SHEET_HOURS) {
      const c = cellInfo(st, i.id, h);
      if (c.out) cells[c.key] = c.out;
    }
  }
  return {
    date: st.date, today, now: new Date().toISOString(), hours: SHEET_HOURS,
    can_edit: (me.role === 'admin' || me.role === 'operator') && st.date >= today,
    instructors: shown.map(({ id, name, phone, categories, group, active }) => ({ id, name, phone, categories, group, active })),
    cells, updated_at: st.sheet.updated_at || null, updated_by: st.sheet.updated_by || null,
  };
}

/** Bron kodlari — oldindan tekshirilgan, takrorlanmaydigan (AVD-4821). */
async function codePool(n: number): Promise<() => Promise<string>> {
  const pool: string[] = [];
  for (let tries = 0; tries < 4 && pool.length < n; tries++) {
    const cand = [...new Set(Array.from({ length: (n - pool.length) * 2 + 4 }, () => 'AVD-' + String(1000 + Math.floor(Math.random() * 9000))))]
      .filter((c) => !pool.includes(c));
    const used = await selectIn<any>('bookings', 'pickup_code', cand, 'pickup_code').catch(() => []);
    const busy = new Set(used.map((r) => String(r.pickup_code)));
    for (const c of cand) if (!busy.has(c) && pool.length < n) pool.push(c);
  }
  return async () => pool.shift() || 'AVD-' + String(10000 + Math.floor(Math.random() * 90000));
}

function humanError(e: any): string {
  const m = String(e?.message || e || '');
  if (/no_instructor_overlap/.test(m)) return 'Instruktor bu vaqtda band — boshqa bron bor.';
  if (/no_customer_overlap/.test(m)) return 'Mijozda shu vaqtda boshqa bron bor.';
  if (/duplicate key.*phone/i.test(m)) return 'Bu telefon boshqa mijozda ro‘yxatdan o‘tgan.';
  return m || 'Bron yaratilmadi';
}

/** Bir instruktorning bir kunlik ustuni (instruktor boti uchun) */
export type DayCell = { h: number; key: string; start: number; end: number; sc: SheetCell | null; lock: string | null; out: any };
export type InsDay = { ins: { id: string; name: string; phone: string | null; categories: string[] } | null; cells: DayCell[] };
function dayOf(st: State, insId: string): InsDay {
  const ins = st.insMap.get(String(insId)) || null;
  const cells = SHEET_HOURS.map((h) => {
    const c = cellInfo(st, String(insId), h);
    return { h, key: c.key, start: c.s, end: c.e, sc: c.sc || null, lock: c.lock as string | null, out: c.out as any };
  });
  return { ins, cells };
}
export async function instructorDay(date: string, insId: string): Promise<InsDay> {
  return dayOf(await loadState(date), insId);
}
/** Hamma instruktorlarning bir kunlik ustunlari — bitta yuklash bilan (kunlik xabarnoma uchun) */
export async function allInstructorDays(date: string): Promise<Map<string, InsDay>> {
  const st = await loadState(date);
  return new Map(st.instructors.map((i) => [i.id, dayOf(st, i.id)]));
}
export const SHEET_LOCK_MSG = LOCK_MSG;

export type SheetActor = { login: string; role: string; bi?: string };
export type ApplyOpts = {
  date: string; changes: { key: string; t: string; prev: string }[]; actor: SheetActor;
  adminUser: Deps['adminUser']; audit: Deps['audit'];
  /** true — bron yaratilmasa katak ham yozilmaydi (instruktor boti) */
  strict?: boolean;
  /** Bron izohi boshi: «Excel bron» yoki «Instruktor boti» */
  notePrefix?: string;
};
/** Instruktorga xabar uchun: kimning ustunida nima o'zgardi */
export type SheetEvent = {
  created: { start: string; minutes: number; phone: string; name: string; code: string | null; category: string }[];
  cancelled: { start: string; minutes: number; phone: string | null; name: string; code: string | null }[];
  notes: { h: number; text: string; removed: boolean }[];
};
export type ApplyResult = {
  saved: number; created: any[]; cancelled: number; cancelledIds: string[]; errors: { key: string; error: string }[];
  events: Map<string, SheetEvent>;
};

/**
 * Kataklarni yozadi va bronlarni yaratadi/bekor qiladi. Excel bron sahifasi
 * («Saqlash») ham, instruktor boti ham shu bitta yo'ldan o'tadi.
 * Sana va o'zgarishlar ro'yxati chaqiruvchida tekshirilgan bo'lishi kerak.
 */
export async function applySheetChanges(o: ApplyOpts): Promise<ApplyResult> {
  const { date, changes } = o;
  const st = await loadState(date);
  const admin = await o.adminUser();
  const now = Date.now(), nowIso = iso(now);
  const work: Record<string, SheetCell> = {};
  for (const [k, c] of Object.entries(st.sheet.cells)) work[k] = { ...c };
  const errors: { key: string; error: string }[] = [];
  const changed = new Set<string>();

  /* 1. Kataklar matni */
  for (const ch of changes) {
    const key = String(ch?.key || '');
    const p = parseKey(key);
    if (!p || !st.insMap.has(p.ins)) { errors.push({ key, error: 'Katak topilmadi' }); continue; }
    const t = cleanText(ch?.t), prev = cleanText(ch?.prev);
    const cur = work[key]?.t || '';
    if (t === cur) continue;
    if (prev !== cur) {
      errors.push({ key, error: `Bu katakni boshqa xodim o‘zgartirgan (hozir: «${cur || 'bo‘sh'}»). Qayta yozing.` });
      continue;
    }
    const info = cellInfo(st, p.ins, p.h);
    if (info.e <= now) { errors.push({ key, error: 'Bu soat o‘tib ketgan' }); continue; }
    /* Yozuvli katakda — faqat uning broni to'langan/boshlangan bo'lsa qulf;
       yozuvsiz katakda — boshqa bron, instruktor yopgan yoki grafik bo'yicha dam */
    if (info.lock) { errors.push({ key, error: LOCK_MSG[info.lock] || 'Bu katakni o‘zgartirib bo‘lmaydi' }); continue; }
    if (t) {
      const c: SheetCell = { ...(work[key] || { t }), t, by: o.actor.login, at: nowIso, ...(o.actor.bi ? { bi: o.actor.bi } : {}) };
      delete c.e;
      work[key] = c;
    } else {
      work[key] = { ...(work[key] || { t: '' }), t: '' };
    }
    changed.add(key);
  }

  /* 2. Raqamli kataklar → bronlar (har instruktor ustuni alohida).
     Faqat o'zgargan kataklarga tegishli bronlar qayta ko'riladi: o'zgarmagan
     bron (masalan to'lanmagan, lekin hech kim tegmagan) joyida qoladi. */
  const toCancel = new Map<string, any>();
  const toCreate: (Run & { ins: string })[] = [];
  const matched: { run: Run; bid: string }[] = [];
  const defCat = (ins: Ins) => (ins.categories.includes('B') ? 'B' : ins.categories[0] || 'B');
  for (const insId of new Set([...changed].map((k) => parseKey(k)!.ins))) {
    const ins = st.insMap.get(insId)!;
    const inputs: RunInput[] = [];
    for (const h of SHEET_HOURS) {
      const key = cellKey(insId, h);
      const c = work[key];
      if (!c?.t) continue;
      if (hourStartMs(date, h) < now - GRACE_MS) continue;
      if (cellInfo(st, insId, h).lock) continue;      // to'langan / boshlangan bron — chegara
      const phone = parsePhone(c.t);
      if (!phone) continue;
      inputs.push({ h, key, phone, cat: parseCategory(c.t), half: parseHalf(c.t), text: c.t });
    }
    const runs = buildRuns(inputs);
    /* Shu ustundagi Excel bronlari — faqat o'zgartirsa bo'ladiganlari */
    const mine = [...st.refs].filter(([bid]) => {
      const b = st.byId.get(bid);
      return b && String(b.instructor_id) === insId && ['pending', 'confirmed'].includes(String(b.status)) && !lockedReason(st, b);
    });
    /* Tegilgan kataklar to'plami kengayadi: o'zgargan katak → uning bronining
       hamma kataklari → shu kataklardagi yangi bronlar → … (barqaror bo'lguncha) */
    const T = new Set([...changed].filter((k) => parseKey(k)!.ins === insId));
    for (let i = 0; i < 8; i++) {
      const before = T.size;
      for (const r of runs) if (r.keys.some((k) => T.has(k))) r.keys.forEach((k) => T.add(k));
      for (const [, keys] of mine) if (keys.some((k) => T.has(k))) keys.forEach((k) => T.add(k));
      if (T.size === before) break;
    }
    const touched = runs.filter((r) => r.keys.some((k) => T.has(k)));
    const taken = new Set<Run>();
    for (const [bid, keys] of mine) {
      if (!keys.some((k) => T.has(k))) continue;
      const b = st.byId.get(bid);
      const u = st.users.get(String(b.customer_id));
      const same = touched.find((r) => !taken.has(r)
        && Date.parse(b.start_at) === hourStartMs(date, r.h0) && durOf(b) === r.minutes
        && samePhone(u?.phone, r.phone) && String(b.category || '').toUpperCase() === (r.cat || defCat(ins)));
      if (same) { taken.add(same); matched.push({ run: same, bid }); }
      else toCancel.set(bid, b);
    }
    for (const r of touched) if (!taken.has(r)) toCreate.push({ ...r, ins: insId });
  }
  /* O'zgarmagan bron: kataklarida havola joyida tursin */
  for (const { run, bid } of matched) {
    const b = st.byId.get(bid);
    for (const k of run.keys) if (work[k]) { work[k].b = bid; work[k].s = b.start_at; work[k].m = durOf(b); delete work[k].e; }
  }

  /* 3. Eski bronlarni bekor qilish (to'lanmagan, boshlanmagan) */
  const cancelled: string[] = [];
  if (toCancel.size) {
    const ids = [...toCancel.keys()];
    const rows = await supabaseRest<any[]>('bookings', {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      query: `?id=in.(${ids.map(q).join(',')})&status=in.(pending,confirmed)`,
      body: JSON.stringify({ status: 'cancelled', cancelled_at: nowIso, cancelled_by: admin.id,
        cancellation_reason: 'Excel bron: katak o‘zgartirildi', updated_at: nowIso }),
    });
    for (const r of rows || []) cancelled.push(String(r.id));
    const gone = new Set(cancelled);
    st.day = st.day.filter((b) => !gone.has(String(b.id)));
    for (const [k, c] of Object.entries(work)) if (c.b && gone.has(c.b)) { delete c.b; delete c.s; delete c.m; }
  }

  /* 4. Yangi bronlar */
  const created: any[] = [];
  const fail = (r: Run, msg: string) => {
    for (const k of r.keys) {
      if (!work[k]) continue;
      /* Instruktor boti: bron bo'lmasa yozuv ham qolmaydi (faqat o'zi yozgan kataklar) */
      if (o.strict && changed.has(k)) { work[k] = { t: '' }; continue; }
      work[k].e = msg; delete work[k].b; delete work[k].s; delete work[k].m;
    }
    errors.push({ key: r.keys[0], error: msg });
  };
  if (toCreate.length) {
    const phones = [...new Set(toCreate.map((r) => r.phone))];
    const variants = phones.flatMap((p) => [p, p.slice(1), p.slice(4)]);
    const [found, tariffs, pkgPrices, courses, nextCode] = await Promise.all([
      selectIn<any>('users', 'phone', variants, 'id,full_name,phone,role,is_active,is_blocked'),
      loadTariffs(), loadPackagePrices(),
      supabaseRest<any[]>('courses', { query: '?is_active=eq.true&select=id,category,name&order=created_at.asc&limit=100' }),
      codePool(toCreate.length),
    ]);
    const byPhone = new Map<string, any>();
    for (const u of found) {
      const p = phones.find((x) => samePhone(x, u.phone));
      if (p && (!byPhone.has(p) || u.role === 'customer')) byPhone.set(p, u);
    }
    for (const r of toCreate) {
      const ins = st.insMap.get(r.ins)!;
      const cat = r.cat || defCat(ins);
      if (!ins.categories.includes(cat)) { fail(r, `${ins.name} ${cat} toifani o‘rgatmaydi`); continue; }
      const course = courses.find((c) => String(c.category || '').toUpperCase() === cat);
      if (!course) { fail(r, `${cat} toifa uchun mashg‘ulot topilmadi (Narxlar bo‘limida qo‘shing)`); continue; }
      const start = hourStartMs(date, r.h0), end = start + r.minutes * 60000;
      const clash = st.day.find((b) => String(b.instructor_id) === r.ins && BUSY.includes(String(b.status))
        && Date.parse(b.start_at) < end && Date.parse(b.end_at) > start);
      if (clash) { fail(r, `Instruktor ${fmtHm(Date.parse(clash.start_at))} da band — boshqa bron bor`); continue; }
      const blk = (st.blocks.get(r.ins) || []).find((x) => Date.parse(x.start_at) < end && Date.parse(x.end_at) > start);
      if (blk) { fail(r, blk.off ? LOCK_MSG.off : LOCK_MSG.own); continue; }
      let user = byPhone.get(r.phone) || null;
      if (user && user.role && user.role !== 'customer') {
        const who = user.role === 'instructor' ? 'instruktor' : user.role === 'admin' ? 'admin' : 'xodim';
        fail(r, `${prettyPhone(r.phone)} — ${who} akkauntining raqami${user.full_name ? ` (${user.full_name})` : ''}. Xodim raqamiga bron qilinmaydi — mijozning raqamini yozing.`);
        continue;
      }
      if (user?.is_blocked) { fail(r, 'Bu mijoz bloklangan'); continue; }
      if (user) {
        const mine = st.day.find((b) => String(b.customer_id) === String(user.id) && BUSY.includes(String(b.status))
          && Date.parse(b.start_at) < end && Date.parse(b.end_at) > start);
        if (mine) {
          const other = st.insMap.get(String(mine.instructor_id))?.name;
          fail(r, `Bu mijozda ${fmtHm(Date.parse(mine.start_at))} da boshqa bron bor${other ? ` (${other})` : ''}`);
          continue;
        }
      }
      try {
        if (!user) {
          const name = nameFrom(r.text) || `Mijoz ${prettyPhone(r.phone)}`;
          try {
            user = (await supabaseRest<any[]>('users', {
              method: 'POST', headers: { Prefer: 'return=representation' },
              body: JSON.stringify({ full_name: name, phone: r.phone, role: 'customer', is_active: true, is_blocked: false }),
            }))[0];
          } catch (e: any) {
            if (!/duplicate key.*phone/i.test(String(e?.message))) throw e;
            user = (await supabaseRest<any[]>('users', { query: `?phone=eq.${q(r.phone)}&select=*&limit=1` }))[0];
          }
          if (!user) throw Error('Mijoz yozilmadi');
          byPhone.set(r.phone, user);
          st.users.set(String(user.id), user);
        }
        const payload = {
          customer_id: user.id, instructor_id: r.ins, course_id: course.id,
          booking_date: iso(start), start_at: iso(start), end_at: iso(end),
          duration_minutes: r.minutes, hours: Math.max(1, Math.round(r.minutes / 60)), category: cat,
          price: priceWithPackage(cat, r.minutes, tariffs, pkgPrices),
          status: 'confirmed', source: 'admin', confirmed_at: nowIso, confirmed_by: admin.id,
          customer_note: `${o.notePrefix || 'Excel bron'}: ${r.text}`.slice(0, 300),
        };
        const [row] = await insertBookings([payload], nextCode);
        st.day.push(row);
        for (const k of r.keys) {
          if (!work[k]) continue;
          work[k].b = String(row.id); work[k].s = iso(start); work[k].m = r.minutes; delete work[k].e;
        }
        created.push({ key: r.keys[0], id: String(row.id), code: row.pickup_code || null, name: user.full_name,
          phone: user.phone || r.phone, instructor: ins.name, start: iso(start), minutes: r.minutes, category: cat });
      } catch (e: any) {
        fail(r, humanError(e));
      }
    }
  }

  /* 5. Raqamsiz bo'lib qolgan kataklarda eski bron havolasi qolmasin */
  const runKeys = new Set(matched.flatMap((m) => m.run.keys));
  for (const c of created) runKeys.add(c.key);
  for (const r of toCreate) for (const k of r.keys) if (work[k]?.b) runKeys.add(k);
  for (const k of changed) {
    const c = work[k];
    if (c && c.b && !runKeys.has(k) && !lockedReason(st, st.byId.get(c.b))) { delete c.b; delete c.s; delete c.m; }
  }

  /* 6. Yozish: faqat tegilgan kataklar — boshqa xodimning shu paytdagi o'zgarishi saqlanib qoladi */
  const touchedKeys = new Set<string>([...changed, ...toCreate.flatMap((r) => r.keys), ...matched.flatMap((m) => m.run.keys)]);
  for (const id of cancelled) for (const k of st.refs.get(id) || []) touchedKeys.add(k);
  if (touchedKeys.size) {
    const fresh = await loadSheet(date);
    for (const k of touchedKeys) {
      const c = work[k];
      if (c && c.t) fresh.cells[k] = c; else delete fresh.cells[k];
    }
    fresh.updated_at = nowIso;
    fresh.updated_by = o.actor.login;
    await writeSheet(date, fresh);
  }

  await o.audit(admin.id, 'BOOKING_SHEET_SAVED', 'admin_settings', `booking_sheet:${date}`, null, {
    date, by: o.actor.login, role: o.actor.role, cells: changed.size,
    created: created.map((c) => ({ code: c.code, phone: c.phone, instructor: c.instructor, start: c.start, minutes: c.minutes })),
    cancelled, errors: errors.slice(0, 50),
  });

  /* 7. Instruktorlarga xabar uchun o'zgarishlar */
  const events = new Map<string, SheetEvent>();
  const ev = (ins: string) => {
    let e = events.get(ins);
    if (!e) { e = { created: [], cancelled: [], notes: [] }; events.set(ins, e); }
    return e;
  };
  for (const c of created) {
    const p = parseKey(c.key);
    if (p) ev(p.ins).created.push({ start: c.start, minutes: c.minutes, phone: c.phone, name: c.name, code: c.code, category: c.category });
  }
  for (const id of cancelled) {
    const b = toCancel.get(id); if (!b) continue;
    const u = st.users.get(String(b.customer_id));
    ev(String(b.instructor_id)).cancelled.push({ start: b.start_at, minutes: durOf(b), phone: u?.phone || null, name: u?.full_name || 'Mijoz', code: b.pickup_code || null });
  }
  for (const k of changed) {
    const p = parseKey(k)!;
    const before = st.sheet.cells[k]?.t || '', after = work[k]?.t || '';
    const isNote = (t: string, c?: SheetCell) => !!t && (!parsePhone(t) || (!!c && !c.b));
    if (after && isNote(after, work[k]) && after !== before) ev(p.ins).notes.push({ h: p.h, text: after, removed: false });
    else if (!after && before && !parsePhone(before)) ev(p.ins).notes.push({ h: p.h, text: before, removed: true });
  }
  return { saved: changed.size, created, cancelled: cancelled.length, cancelledIds: cancelled, errors, events };
}

/**
 * OCHIQ HAVOLA uchun jadval (guruhdagi «📋 Jadvalni ochish»): faqat o'qish.
 * Ichki id'lar va kim yozgani o'rniga — telefonda ko'rish uchun kerakli
 * minimum: instruktor, soat, katak matni, mijoz ismi/raqami, kod, holat.
 */
export async function publicSheetData(date: string) {
  const st = await loadState(date);
  const shown = st.instructors.filter((i) => i.shown);
  const cells: Record<string, any> = {};
  let band = 0;
  const used = new Set<string>(), bronIds = new Set<string>();
  for (const i of shown) {
    for (const h of SHEET_HOURS) {
      const c = cellInfo(st, i.id, h);
      const o: any = c.out;
      if (!o) continue;
      const b = o.bk || null;
      const x: any = { k: o.k };
      if (o.t) x.t = o.t;
      if (b) {
        x.name = b.name || null; x.phone = b.phone || null; x.code = b.code || null; x.status = b.status || null;
        x.min = b.min || null; x.paid = !!b.paid; x.src = b.src || null; x.start = b.start; x.end = b.end; x.cat = b.cat || null;
      }
      cells[c.key] = x;
      /* ko'p soatlik bron bitta sanaladi */
      if (o.k === 'sheet' || o.k === 'bk') { bronIds.add(b ? String(b.id) : c.key); used.add(i.id); }
      else if (o.k === 'note') { band++; used.add(i.id); }
    }
  }
  const bron = bronIds.size;
  return {
    date: st.date, now: new Date().toISOString(), hours: SHEET_HOURS,
    updated_at: st.sheet.updated_at || null,
    instructors: shown.map(({ id, name, phone, categories, group, active }) => ({ id, name, phone, categories, group, active })),
    cells,
    stats: { instructors: shown.length, busy_instructors: used.size, bron, band },
  };
}

export async function registerBookingSheetRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/admin/booking-sheet', async (req: any, reply: any) => {
    try {
      const me = await deps.currentStaff(req);
      const raw = String(req.query?.date || '');
      const date = YMD.test(raw) ? raw : tashkentYmdOf(Date.now());
      return { ok: true, ...view(await loadState(date), me) };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Excel bron yuklanmadi' });
    }
  });

  app.put('/api/admin/booking-sheet', async (req: any, reply: any) => {
    try {
      const me = await deps.guardDesk(req);
      const body = req.body || {};
      const date = String(body.date || '');
      const today = tashkentYmdOf(Date.now());
      if (!YMD.test(date)) return reply.code(400).send({ ok: false, error: 'Sana noto‘g‘ri' });
      if (date < today) return reply.code(400).send({ ok: false, error: 'O‘tgan kunni o‘zgartirib bo‘lmaydi' });
      if (date > addDaysYmd(today, 60)) return reply.code(400).send({ ok: false, error: 'Ko‘pi bilan 60 kun oldinga yozish mumkin' });
      const changes: any[] = Array.isArray(body.changes) ? body.changes : [];
      if (!changes.length) return reply.code(400).send({ ok: false, error: 'O‘zgarish yo‘q' });
      if (changes.length > 800) return reply.code(400).send({ ok: false, error: 'Bir martada juda ko‘p katak' });

      const result = await applySheetChanges({ date, changes, actor: { login: me.login, role: me.role }, adminUser: deps.adminUser, audit: deps.audit });
      /* Instruktorlarga: nima o'zgargani + yangilangan jadval rasmi (xato bo'lsa ham saqlash buzilmaydi) */
      let notified = 0;
      try {
        const { notifySheetSave } = await import('./instructor-notify.js');
        notified = (await notifySheetSave(date, result.events)).sent;
      } catch (e) { console.error('sheet notify failed:', e); }
      /* Guruhda o'sha kun rasmi bo'lsa — joyida yangilanadi. Yangi rasmni
         admin «Guruhga tashlash» tugmasi bilan o'zi yuboradi. */
      let group: string | null = null;
      if (result.saved) {
        try {
          const { refreshGroupPost } = await import('./sheet-share.js');
          group = await refreshGroupPost(date, me.login);
        } catch (e) { console.error('sheet group refresh failed:', e); group = 'stale'; }
      }
      const after = await loadState(date);
      return {
        ok: true, ...view(after, me),
        result: { saved: result.saved, created: result.created, cancelled: result.cancelled, errors: result.errors, notified, group },
      };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Excel bron saqlanmadi' });
    }
  });
}
