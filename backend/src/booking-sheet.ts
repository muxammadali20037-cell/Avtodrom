import { supabaseRest } from './supabase.js';
import { tashkentYmdOf, addDaysYmd } from './instructor-schedule.js';

/**
 * EXCEL BRON — adminlar o'rgangan Excel jadvalining o'zi, admin panel ichida.
 *
 * Ustunlar — instruktorlar, qatorlar — soatlar (06:00 … 21:00). Admin yoki
 * operator katakka yozadi va «Saqlash»ni bosadi:
 *   · katakda TELEFON RAQAM bo'lsa — shu mijozga haqiqiy bron yaratiladi
 *     (tasdiqlangan, bron kodi bilan). Kassa uni raqam yoki kod bo'yicha
 *     topib chek beradi. Bir instruktor ustunida ketma-ket soatlarga bir xil
 *     raqam yozilsa — bitta uzun bron (masalan 11:00–13:00).
 *   · raqam bo'lmasa («BAND», ism, izoh) — shu soat instruktorda BAND
 *     bo'ladi: Mini App, operator va kassa u vaqtga bron qila olmaydi.
 *
 * Saqlash: admin_settings — `booking_sheet:<YYYY-MM-DD>`:
 *   { cells: { '<instructor_id>|<HH>': { t: 'matn', b?: 'bron id', s?: 'boshlanish', m?: daqiqa, e?: 'xato' } } }
 * Migratsiya kerak emas.
 */

export const SHEET_PREFIX = 'booking_sheet:';
export const SHEET_FIRST_HOUR = 6;
export const SHEET_LAST_HOUR = 21;
export const SHEET_HOURS = Array.from({ length: SHEET_LAST_HOUR - SHEET_FIRST_HOUR + 1 }, (_, i) => SHEET_FIRST_HOUR + i);
export const SHEET_MAX_TEXT = 80;

export type SheetCell = { t: string; b?: string; s?: string; m?: number; e?: string; by?: string; at?: string };
export type Sheet = { cells: Record<string, SheetCell>; updated_at?: string | null; updated_by?: string | null };
export type SheetBlock = { start_at: string; end_at: string; sheet: true; text: string };

const q = (v: string) => encodeURIComponent(v);
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n: number) => String(n).padStart(2, '0');

export const sheetKeyOf = (day: string) => `${SHEET_PREFIX}${day}`;
export const cellKey = (ins: string, h: number) => `${ins}|${pad(h)}`;

/** '<instructor_id>|<HH>' → { ins, h }. Noto'g'ri kalit — null. */
export function parseKey(key: unknown): { ins: string; h: number } | null {
  const m = /^([^|\s]{1,64})\|(\d{2})$/.exec(String(key ?? ''));
  if (!m) return null;
  const h = Number(m[2]);
  return SHEET_HOURS.includes(h) ? { ins: m[1], h } : null;
}

/** Toshkent vaqti bilan shu kun, shu soatning boshlanishi (ms). */
export const hourStartMs = (day: string, h: number) => Date.parse(`${day}T${pad(h)}:00:00+05:00`);

/** Katak matni: bitta qator, ortiqcha bo'shliqsiz, 80 belgigacha. */
export function cleanText(v: unknown): string {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SHEET_MAX_TEXT);
}

/* ---------------- matndan ma'lumot ajratish ---------------- */

/**
 * Matndan O'zbekiston telefon raqami: «994188549», «99-313-56-26»,
 * «50 150 05 08», «+998 90 123 45 67», «947372906/C», «953905171 3/10».
 * Natija +998XXXXXXXXX. Raqam bo'lmasa — null.
 */
export function parsePhone(text: unknown): string | null {
  const s = String(text ?? '');
  const groups: { d: string; a: number; z: number }[] = [];
  for (const m of s.matchAll(/\d+/g)) groups.push({ d: m[0], a: m.index ?? 0, z: (m.index ?? 0) + m[0].length });
  /* Bir raqamning bo'laklari faqat bo'shliq, chiziqcha, nuqta yoki qavs bilan ajraladi */
  const runs: string[][] = [];
  let cur: string[] = [];
  for (let i = 0; i < groups.length; i++) {
    if (i > 0) {
      const gap = s.slice(groups[i - 1].z, groups[i].a);
      if (!/^[\s\-.()]{1,3}$/.test(gap)) { runs.push(cur); cur = []; }
    }
    cur.push(groups[i].d);
  }
  if (cur.length) runs.push(cur);
  for (const run of runs) {
    for (let i = 0; i < run.length; i++) {
      /* «998 90 123 45 67» — to'liq raqam; «998 651 363» — 99 bilan boshlanuvchi mahalliy raqam */
      let d = '', local: string | null = null;
      for (let j = i; j < run.length; j++) {
        d += run[j];
        if (d.length === 9 && !local) local = d;
        if (d.length === 12 && d.startsWith('998')) return '+' + d;
        if (d.length > 12) break;
      }
      if (local) return '+998' + local;
    }
  }
  return null;
}

const CYR: Record<string, string> = { 'А': 'A', 'В': 'B', 'С': 'C' };
/** «/C», «C toifa», «B» — toifa belgisi (kirill А/В/С ham). Yo'q bo'lsa null. */
export function parseCategory(text: unknown): 'A' | 'B' | 'C' | null {
  const s = String(text ?? '').toUpperCase();
  const m = /(?:^|[^\p{L}\p{N}])([ABCАВС])(?=$|[^\p{L}\p{N}])/u.exec(s);
  if (!m) return null;
  return (CYR[m[1]] || m[1]) as 'A' | 'B' | 'C';
}

/** «30 MIN», «30 мин», «30 daq» — yarim soatlik dars. */
export function parseHalf(text: unknown): boolean {
  return /(?:^|\D)30\s*(?:min|мин|daq|дак|дақ)/iu.test(String(text ?? ''));
}

const STOP = new Set(['band', 'банд', 'бант', 'min', 'мин', 'daq', 'дак', 'soat', 'соат', 'toifa', 'тоифа', 'avtomat', 'автомат',
  'mexanika', 'механика', 'mijoz', 'мижоз', 'paket', 'пакет', 'bron', 'брон']);
/** Katakdagi ism (raqam, toifa va izohsiz). Ism bo'lmasa — null. */
export function nameFrom(text: unknown): string | null {
  const words = String(text ?? '').split(/[^\p{L}'‘’`ʻ-]+/u).map((w) => w.replace(/^[-'‘’`ʻ]+|[-'‘’`ʻ]+$/g, ''))
    .filter((w) => w.length >= 2 && !STOP.has(w.toLowerCase()));
  if (!words.length) return null;
  return words.slice(0, 3).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** +998901234567 → +998 90 123 45 67 */
export function prettyPhone(p: string): string {
  const m = /^\+998(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(String(p || ''));
  return m ? `+998 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : String(p || '');
}

/* ---------------- ketma-ket soatlar → bitta bron ---------------- */

export type RunInput = { h: number; key: string; phone: string; cat: 'A' | 'B' | 'C' | null; half: boolean; text: string };
export type Run = { keys: string[]; h0: number; n: number; phone: string; cat: 'A' | 'B' | 'C' | null; minutes: number; text: string };

/**
 * Bir instruktor ustunidagi raqamli kataklar → bronlar. Ketma-ket soatlarda
 * bir xil raqam (va bir xil toifa) — bitta bron. Yarim soat («30 MIN») faqat
 * bitta katakli bronda hisobga olinadi.
 */
export function buildRuns(cells: RunInput[]): Run[] {
  const list = [...cells].sort((a, b) => a.h - b.h);
  const runs: Run[] = [];
  for (const c of list) {
    const last = runs[runs.length - 1];
    if (last && last.h0 + last.n === c.h && last.phone === c.phone && last.cat === c.cat) {
      last.keys.push(c.key); last.n++; last.minutes = last.n * 60;
      continue;
    }
    runs.push({ keys: [c.key], h0: c.h, n: 1, phone: c.phone, cat: c.cat, minutes: c.half ? 30 : 60, text: c.text });
  }
  return runs;
}

/* ---------------- saqlash ---------------- */

export function normSheet(v: any): Sheet {
  const src = v && typeof v === 'object' ? (v.cells && typeof v.cells === 'object' ? v.cells : (v.value?.cells || {})) : {};
  const cells: Record<string, SheetCell> = {};
  for (const [k, raw] of Object.entries<any>(src)) {
    if (!parseKey(k) || !raw || typeof raw !== 'object') continue;
    const t = cleanText(raw.t);
    if (!t) continue;
    const c: SheetCell = { t };
    if (raw.b) c.b = String(raw.b).slice(0, 64);
    if (raw.s && !Number.isNaN(Date.parse(String(raw.s)))) c.s = String(raw.s);
    if (Number(raw.m) > 0) c.m = Math.round(Number(raw.m));
    if (raw.e) c.e = String(raw.e).slice(0, 300);
    if (raw.by) c.by = String(raw.by).slice(0, 60);
    if (raw.at && !Number.isNaN(Date.parse(String(raw.at)))) c.at = String(raw.at);
    cells[k] = c;
  }
  return { cells, updated_at: v?.updated_at ?? null, updated_by: v?.updated_by ?? null };
}

/** Bir nechta kunning jadvallari (bo'sh kun — bo'sh jadval). */
export async function loadSheets(days: string[]): Promise<Map<string, Sheet>> {
  const out = new Map<string, Sheet>();
  const list = [...new Set(days.filter((d) => YMD.test(d)))];
  for (const d of list) out.set(d, { cells: {} });
  if (!list.length) return out;
  const rows = await supabaseRest<any[]>('admin_settings', {
    query: `?key=in.(${list.map((d) => q(sheetKeyOf(d))).join(',')})&select=key,value&limit=200`,
  });
  for (const r of rows || []) {
    const day = String(r.key || '').slice(SHEET_PREFIX.length);
    if (out.has(day)) out.set(day, normSheet(r.value));
  }
  return out;
}

export async function loadSheet(day: string): Promise<Sheet> {
  return (await loadSheets([day])).get(day) || { cells: {} };
}

export async function writeSheet(day: string, sheet: Sheet): Promise<void> {
  const key = sheetKeyOf(day);
  const value = { cells: sheet.cells, updated_at: sheet.updated_at ?? null, updated_by: sheet.updated_by ?? null };
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
}

/* ---------------- band vaqtlar ---------------- */

/**
 * Bir kunlik jadvaldan instruktorlarning BAND vaqtlari:
 *   · bronsiz katak (izoh, «BAND», raqam bilan bron yaratilmagan) — butun soat;
 *   · bronli katak — soatning bron qoplamagan qismi (masalan «30 MIN»
 *     bronidan keyingi yarim soat). Bronning o'zi baribir band.
 * Bron bekor qilinsa (mijoz yoki admin) — katak vaqtni ushlab turmaydi.
 */
export function sheetDayBlocks(day: string, sheet: Sheet, only?: Set<string>): Map<string, SheetBlock[]> {
  const out = new Map<string, SheetBlock[]>();
  const push = (ins: string, a: number, z: number, text: string) => {
    if (z <= a) return;
    const list = out.get(ins) || [];
    list.push({ start_at: new Date(a).toISOString(), end_at: new Date(z).toISOString(), sheet: true, text });
    out.set(ins, list);
  };
  for (const [k, c] of Object.entries(sheet.cells || {})) {
    const p = parseKey(k);
    if (!p || !c?.t) continue;
    if (only && !only.has(p.ins)) continue;
    const s = hourStartMs(day, p.h), e = s + 3600e3;
    if (!c.b) { push(p.ins, s, e, c.t); continue; }
    const bs = c.s ? Date.parse(c.s) : NaN;
    const be = bs + (Number(c.m) || 0) * 60000;
    if (!Number.isFinite(bs) || !(be > bs)) continue;
    if (bs > s) push(p.ins, s, Math.min(bs, e), c.t);
    if (be < e) push(p.ins, Math.max(be, s), e, c.t);
  }
  for (const list of out.values()) list.sort((a, b) => a.start_at.localeCompare(b.start_at));
  return out;
}

/** [from, to) oralig'idagi Toshkent kunlari (ko'pi bilan 62 kun). */
export function daysBetween(from: Date, to: Date): string[] {
  const a = from.getTime(), z = to.getTime();
  if (!Number.isFinite(a) || !Number.isFinite(z) || z <= a) return [];
  const first = tashkentYmdOf(a), last = tashkentYmdOf(z - 1);
  const out: string[] = [];
  for (let d = first; d <= last && out.length < 62; d = addDaysYmd(d, 1)) out.push(d);
  return out;
}

/** Instruktorlarning [from, to) oralig'idagi Excel bron band vaqtlari. Xato bo'lsa — bo'sh. */
export async function sheetBlocksBetween(ids: string[] | undefined, from: Date, to: Date): Promise<Map<string, SheetBlock[]>> {
  const out = new Map<string, SheetBlock[]>();
  const days = daysBetween(from, to);
  if (!days.length) return out;
  try {
    const sheets = await loadSheets(days);
    const only = ids && ids.length ? new Set(ids.map(String)) : undefined;
    const a = from.getTime(), z = to.getTime();
    for (const [day, sh] of sheets) {
      for (const [ins, list] of sheetDayBlocks(day, sh, only)) {
        const keep = list.filter((b) => Date.parse(b.start_at) < z && Date.parse(b.end_at) > a);
        if (keep.length) out.set(ins, [...(out.get(ins) || []), ...keep]);
      }
    }
  } catch (e) {
    console.warn('booking sheet blocks load failed:', e instanceof Error ? e.message : e);
  }
  return out;
}
