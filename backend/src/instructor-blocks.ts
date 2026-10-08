import { supabaseRest } from './supabase.js';
import { scheduleFor, loadSchedules, offBlocksBetween } from './instructor-schedule.js';
import { sheetBlocksBetween } from './booking-sheet.js';

/**
 * INSTRUKTORNING O'Z BAND VAQTLARI («Bo'sh vaqtlarim» → soatni yopish)
 *
 * Instruktor masalan soat 14:00 da boshqa ishi bo'lsa, shu soatni yopadi.
 * Yopiq soatga mijoz Mini App'dan ham, operator/admin qo'lda bron bilan
 * ham, kassa ko'chadan kelgan mijozga ham bron qila olmaydi. Istagan
 * paytda qayta ochadi.
 *
 * Saqlash: alohida jadval o'rniga admin_settings'da, har instruktorga
 * bitta yozuv — `instructor_busy:<instructor_id>` → { blocks: [...] }.
 * Shunday qilib bazaga migratsiya kerak emas, yuklangan zahoti ishlaydi.
 * O'tib ketgan yopiq soatlar har saqlashda tozalanadi.
 *
 * ISH GRAFIGI (instructor-schedule.ts) ham shu yerda hisobga olinadi:
 * grafik bo'yicha dam (ishga kelmagan, tanaffus, dam olish kuni) vaqtlar
 * `off: true` belgisi bilan qo'shiladi — bron qilishning hamma yo'llari
 * ularni ham yopiq deb ko'radi.
 *
 * EXCEL BRON (booking-sheet.ts) ham shu yerda: admin yozgan bronsiz katak
 * («BAND», ism, izoh) `sheet: true` belgisi bilan band vaqt hisoblanadi.
 */

export type Block = { start_at: string; end_at: string; off?: boolean; sheet?: boolean; text?: string };

const PREFIX = 'instructor_busy:';
const keyOf = (id: string) => `${PREFIX}${id}`;
const q = (v: string) => encodeURIComponent(v);

function clean(list: unknown): Block[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((b: any) => ({ start_at: String(b?.start_at || ''), end_at: String(b?.end_at || '') }))
    .filter((b) => !Number.isNaN(Date.parse(b.start_at)) && Date.parse(b.end_at) > Date.parse(b.start_at));
}

function valueBlocks(v: any): Block[] {
  return clean(v?.blocks ?? v?.value?.blocks);
}

/**
 * Bir nechta (yoki hamma) instruktorning yopiq soatlari. Xato bo'lsa — bo'sh (bron to'xtab qolmasin).
 * `range` berilsa — shu oraliqdagi ISH GRAFIGI bo'yicha dam vaqtlar (`off: true`) va
 * EXCEL BRON band kataklari (`sheet: true`, `opts.sheet === false` bo'lmasa) ham qo'shiladi.
 */
export async function loadBlocks(instructorIds?: string[], range?: { from: Date; to: Date }, opts: { sheet?: boolean } = {}): Promise<Map<string, Block[]>> {
  const out = new Map<string, Block[]>();
  const sched = range ? loadSchedules(instructorIds) : null;
  const sheet = range && opts.sheet !== false ? sheetBlocksBetween(instructorIds, range.from, range.to) : null;
  try {
    const filter = instructorIds && instructorIds.length
      ? `key=in.(${instructorIds.map((id) => q(keyOf(String(id)))).join(',')})`
      : `key=like.${q(PREFIX + '*')}`;
    const rows = await supabaseRest<any[]>('admin_settings', { query: `?${filter}&select=key,value&limit=1000` });
    for (const r of rows || []) {
      const key = String(r.key || '');
      if (!key.startsWith(PREFIX)) continue;
      out.set(key.slice(PREFIX.length), valueBlocks(r.value));
    }
  } catch (e) {
    console.warn('instructor blocks load failed:', e instanceof Error ? e.message : e);
  }
  if (sched && range) {
    for (const [id, s] of await sched) {
      const extra = offBlocksBetween(s, range.from, range.to);
      if (extra.length) out.set(id, [...(out.get(id) || []), ...extra]);
    }
  }
  if (sheet) {
    for (const [id, extra] of await sheet) out.set(id, [...(out.get(id) || []), ...extra]);
  }
  return out;
}

export async function blocksFor(instructorId: string): Promise<Block[]> {
  return (await loadBlocks([instructorId])).get(String(instructorId)) || [];
}

export function overlapping(blocks: Block[], start: Date, end: Date): Block | null {
  const s = start.getTime(), e = end.getTime();
  return blocks.find((b) => Date.parse(b.start_at) < e && Date.parse(b.end_at) > s) || null;
}

/** Instruktor shu oraliqni o'zi yopganmi, ish grafigi bo'yicha shu vaqtda ishlamaydimi
 *  yoki Excel bronda shu vaqt band qilinganmi. */
export async function instructorBlockedAt(instructorId: string, start: Date, end: Date): Promise<Block | null> {
  const [own, sched, sheet] = await Promise.all([
    blocksFor(instructorId), scheduleFor(instructorId), sheetBlocksBetween([String(instructorId)], start, end),
  ]);
  return overlapping(own, start, end) || overlapping(offBlocksBetween(sched, start, end), start, end)
    || overlapping(sheet.get(String(instructorId)) || [], start, end);
}

export const blockedMessage = (b: Block) => {
  const fmt = (v: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit' }).format(new Date(v));
  const s = fmt(b.start_at), e0 = fmt(b.end_at);
  const e = e0 === '00:00' && Date.parse(b.end_at) > Date.parse(b.start_at) ? '24:00' : e0;
  if (b.off) {
    if (Date.parse(b.end_at) - Date.parse(b.start_at) >= 864e5 - 60000) return 'Instruktor bu kuni dam oladi (ish grafigi). Boshqa kun yoki instruktorni tanlang.';
    return `Instruktor bu vaqtda ishlamaydi — ish grafigi bo‘yicha ${s}–${e} dam. Boshqa vaqt yoki instruktorni tanlang.`;
  }
  if (b.sheet) return `Instruktor bu vaqtda band (${s}–${e}). Boshqa vaqt yoki instruktorni tanlang.`;
  return `Instruktor bu vaqtni band qilgan (${s}–${e}). Boshqa vaqt yoki instruktorni tanlang.`;
};

/** Toshkent kuni: 'YYYY-MM-DD' + 'HH:MM' → Date */
export const tashkentAt = (ymd: string, hm: string) => new Date(`${ymd}T${hm}:00+05:00`);

/**
 * Bir kunning yopiq soatlarini ALMASHTIRADI (boshqa kunlarga tegmaydi).
 * O'tib ketgan bloklar (1 kundan eski) shu yerda tozalanadi.
 */
export async function saveDayBlocks(instructorId: string, day: string, dayBlocks: Block[]): Promise<Block[]> {
  const dayStart = tashkentAt(day, '00:00').getTime();
  const dayEnd = dayStart + 864e5;
  const keep = (await blocksFor(instructorId)).filter((b) => {
    const s = Date.parse(b.start_at);
    if (s >= dayStart && s < dayEnd) return false;                 // shu kun — yangisiga almashadi
    return Date.parse(b.end_at) > Date.now() - 864e5;               // eski bloklar tozalanadi
  });
  const all = [...keep, ...dayBlocks].sort((a, b) => a.start_at.localeCompare(b.start_at));
  const value = { blocks: all };
  const key = keyOf(String(instructorId));
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
  return all;
}
