import { supabaseRest } from './supabase.js';

/**
 * INSTRUKTOR ISH GRAFIGI — admin belgilaydi.
 *
 * Har instruktor uchun:
 *   · HAFTALIK GRAFIK — har hafta kuni (Du…Yak) uchun: ishlaydimi yoki dam
 *     olish kuni, va kun ichidagi YOPIQ oraliqlar (ishga kelguncha, tushlik,
 *     tanaffus, ketgandan keyin). Har hafta takrorlanadi.
 *   · SANA BO'YICHA — aniq bir sanaga alohida grafik (masalan 12-oktabr
 *     faqat 14:00 gacha). Shu sana uchun haftalik grafik o'rniga ishlaydi.
 *
 * Grafikdan tashqari vaqt instruktor o'zi yopgan soat kabi: Mini App'da
 * u shu vaqtda ko'rinmaydi, operator, kassa ham bron qila olmaydi.
 * Grafik saqlanmagan instruktor — butun ish vaqti (sozlamadagi) ishlaydi.
 *
 * Saqlash: admin_settings — `instructor_schedule:<instructor_id>`
 *   { week: { '1': { off: false, closed: [['13:00','14:00']] }, '0': { off: true, closed: [] } },
 *     dates: { '2026-10-12': { off: false, closed: [['14:00','24:00']] } } }
 * Hafta kuni: 0 — yakshanba, 1 — dushanba … 6 — shanba (JS getDay).
 * Migratsiya kerak emas.
 */

export type Range = [number, number];                       // daqiqa: 00:00 dan
export interface DaySpec { off: boolean; closed: Range[] }
export interface Schedule { week: Record<string, DaySpec>; dates: Record<string, DaySpec> }
export type OffBlock = { start_at: string; end_at: string; off: true };

export const SCHEDULE_PREFIX = 'instructor_schedule:';
const keyOf = (id: string) => `${SCHEDULE_PREFIX}${id}`;
const q = (v: string) => encodeURIComponent(v);
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export const emptySchedule = (): Schedule => ({ week: {}, dates: {} });

/** 'HH:MM' → daqiqa (24:00 = 1440). Noto'g'ri bo'lsa null. */
export function hmToMin(v: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]), mm = Number(m[2]);
  if (mm > 59 || h > 24 || (h === 24 && mm)) return null;
  return h * 60 + mm;
}
export const minToHm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Yopiq oraliqlarni tartiblaydi va ustma-ust / yonma-yonlarini birlashtiradi. */
export function mergeRanges(list: Range[]): Range[] {
  const s = list.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a < b)
    .map(([a, b]) => [Math.max(0, a), Math.min(1440, b)] as Range)
    .sort((x, y) => x[0] - y[0]);
  const out: Range[] = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** Kunlik qoidani tozalaydi. Noto'g'ri qiymat — null (e'tiborsiz). */
export function normDay(x: any): DaySpec | null {
  if (!x || typeof x !== 'object') return null;
  const raw = Array.isArray(x.closed) ? x.closed.slice(0, 96) : [];
  const ranges: Range[] = [];
  for (const r of raw) {
    const a = hmToMin(Array.isArray(r) ? r[0] : r?.from);
    const b = hmToMin(Array.isArray(r) ? r[1] : r?.to);
    if (a === null || b === null || a >= b) continue;
    ranges.push([a, b]);
  }
  return { off: x.off === true, closed: mergeRanges(ranges) };
}

export function normSchedule(v: any): Schedule {
  const src = v?.value?.week || v?.value?.dates ? v.value : v;
  const out = emptySchedule();
  const week = src?.week && typeof src.week === 'object' ? src.week : {};
  for (const k of ['0', '1', '2', '3', '4', '5', '6']) {
    const d = normDay(week[k]);
    if (d) out.week[k] = d;
  }
  const dates = src?.dates && typeof src.dates === 'object' ? src.dates : {};
  for (const [k, val] of Object.entries(dates).slice(0, 400)) {
    if (!YMD.test(k)) continue;
    const d = normDay(val);
    if (d) out.dates[k] = d;
  }
  return out;
}

/** Saqlash va API uchun: daqiqalar → 'HH:MM'. */
export function scheduleJson(s: Schedule) {
  const day = (d: DaySpec) => ({ off: d.off, closed: d.closed.map(([a, b]) => [minToHm(a), minToHm(b)]) });
  return {
    week: Object.fromEntries(Object.entries(s.week).map(([k, d]) => [k, day(d)])),
    dates: Object.fromEntries(Object.entries(s.dates).sort(([a], [b]) => a.localeCompare(b)).map(([k, d]) => [k, day(d)])),
  };
}

export function weekdayOf(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
export const tashkentYmdOf = (t: number | Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date(t));
export const dayStartMs = (ymd: string) => Date.parse(`${ymd}T00:00:00+05:00`);
export const addDaysYmd = (ymd: string, n: number) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/** Shu sanada qaysi qoida ishlaydi: sanaga alohida → haftalik → yo'q (butun kun ochiq). */
export function specFor(s: Schedule | null | undefined, ymd: string): DaySpec | null {
  if (!s) return null;
  return s.dates[ymd] ?? s.week[String(weekdayOf(ymd))] ?? null;
}

/** Kunning yopiq oraliqlari (daqiqa). Dam olish kuni — butun kun. */
export function offRanges(spec: DaySpec | null): Range[] {
  if (!spec) return [];
  return spec.off ? [[0, 1440]] : spec.closed;
}

export function offBlocksForDay(s: Schedule | null | undefined, ymd: string): OffBlock[] {
  const base = dayStartMs(ymd);
  return offRanges(specFor(s, ymd)).map(([a, b]) => ({
    start_at: new Date(base + a * 60000).toISOString(),
    end_at: new Date(base + b * 60000).toISOString(),
    off: true as const,
  }));
}

/** [from, to) oralig'iga tushadigan grafik bo'yicha yopiq bloklar. */
export function offBlocksBetween(s: Schedule | null | undefined, from: Date, to: Date): OffBlock[] {
  if (!s || (!Object.keys(s.week).length && !Object.keys(s.dates).length)) return [];
  const f = from.getTime(), t = to.getTime();
  if (!(t > f)) return [];
  const out: OffBlock[] = [];
  let day = tashkentYmdOf(f);
  const last = tashkentYmdOf(t - 1);
  for (let i = 0; i < 400 && day <= last; i++, day = addDaysYmd(day, 1)) {
    for (const b of offBlocksForDay(s, day)) {
      if (Date.parse(b.start_at) < t && Date.parse(b.end_at) > f) out.push(b);
    }
  }
  return out;
}

/** Bir kunning ish vaqti matni: «08:00–18:00, tanaffus 13:00–14:00» yoki «dam olish kuni». */
export function describeDay(spec: DaySpec | null, workStart = 0, workEnd = 1440): string {
  if (!spec) return 'to‘liq ish kuni';
  if (spec.off) return 'dam olish kuni';
  const open: Range[] = [];
  let cur = workStart;
  for (const [a, b] of spec.closed) {
    if (b <= cur) continue;
    if (a > cur) open.push([cur, Math.min(a, workEnd)]);
    cur = Math.max(cur, b);
    if (cur >= workEnd) break;
  }
  if (cur < workEnd) open.push([cur, workEnd]);
  const ok = open.filter(([a, b]) => b > a);
  if (!ok.length) return 'dam olish kuni';
  return ok.map(([a, b]) => `${minToHm(a)}–${minToHm(b)}`).join(', ');
}

/* ---------------------------- baza ---------------------------- */

/** Bir nechta (yoki hamma) instruktorning grafigi. Xato bo'lsa — bo'sh (bron to'xtab qolmasin). */
export async function loadSchedules(ids?: string[]): Promise<Map<string, Schedule>> {
  const out = new Map<string, Schedule>();
  try {
    const filter = ids && ids.length
      ? `key=in.(${ids.map((id) => q(keyOf(String(id)))).join(',')})`
      : `key=like.${q(SCHEDULE_PREFIX + '*')}`;
    const rows = await supabaseRest<any[]>('admin_settings', { query: `?${filter}&select=key,value&limit=1000` });
    for (const r of rows || []) {
      const key = String(r.key || '');
      if (!key.startsWith(SCHEDULE_PREFIX)) continue;
      out.set(key.slice(SCHEDULE_PREFIX.length), normSchedule(r.value));
    }
  } catch (e) {
    console.warn('instructor schedule load failed:', e instanceof Error ? e.message : e);
  }
  return out;
}

export async function scheduleFor(id: string): Promise<Schedule> {
  return (await loadSchedules([String(id)])).get(String(id)) || emptySchedule();
}

/** Grafikni yozadi. O'tib ketgan sanalar (kechagidan eski) tozalanadi. */
export async function saveSchedule(id: string, s: Schedule): Promise<Schedule> {
  const yesterday = addDaysYmd(tashkentYmdOf(Date.now()), -1);
  const clean: Schedule = { week: s.week, dates: Object.fromEntries(Object.entries(s.dates).filter(([k]) => k >= yesterday)) };
  const value = scheduleJson(clean);
  const key = keyOf(String(id));
  const now = new Date().toISOString();
  const rows = await supabaseRest<any[]>('admin_settings', {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    query: `?key=eq.${q(key)}`, body: JSON.stringify({ value, updated_at: now }),
  });
  if (!rows?.length) {
    await supabaseRest('admin_settings', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ key, value, updated_at: now }),
    });
  }
  return clean;
}
