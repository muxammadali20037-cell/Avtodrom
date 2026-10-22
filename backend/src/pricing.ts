import { supabaseRest } from './supabase.js';

/**
 * NARX HISOBLASH — YAGONA MANBA
 *
 * Tarif tuzilmasi:
 *   · 30 daqiqa — ALOHIDA narx (soatning yarmi emas!)
 *   · 3 soat — ALOHIDA tarif (tarif3_a/b/c; B uchun standart 700 000).
 *     0 yoki yo'q — oddiy soatlik narx × 3
 *   · Undan uzun vaqt — soatlik tarifga proporsional
 *
 * Misol (A kategoriya, 30daq=200k, 1soat=350k):
 *   30 daq  -> 200 000   (maxsus narx)
 *   1 soat  -> 350 000
 *   1.5 soat-> 525 000   (350 000 x 1.5)
 *   2 soat  -> 700 000
 *
 * Nima uchun serverda: narx mijoz brauzerida hisoblanса,
 * uni o'zgartirib yuborish mumkin. Bu yerda hisoblanган qiymat
 * yakuniy — chek va to'lov shunga tayanadi.
 */

export type Category = 'A' | 'B' | 'C';

/** 3 soatlik tarif — davomiylik (daqiqa) */
export const H3_MINUTES = 180;

/** Sozlanmagan holat uchun standart tariflar. h3 — 3 soatlik tarif (0 — yo'q, soatlik × 3). */
const DEFAULTS: Record<Category, { half: number; hour: number; h3: number }> = {
  A: { half: 200000, hour: 350000, h3: 0 },
  B: { half: 150000, hour: 250000, h3: 700000 },
  C: { half: 250000, hour: 400000, h3: 0 },
};

export interface Tariffs {
  A: { half: number; hour: number; h3?: number };
  B: { half: number; hour: number; h3?: number };
  C: { half: number; hour: number; h3?: number };
}

/** Sozlamalardan tariflarni o'qiydi. Xato bo'lsa standartga qaytadi. */
export async function loadTariffs(): Promise<Tariffs> {
  const out: Tariffs = JSON.parse(JSON.stringify(DEFAULTS));
  try {
    const keys = ['half_a', 'half_b', 'half_c', 'rate_a', 'rate_b', 'rate_c', 'tarif3_a', 'tarif3_b', 'tarif3_c'];
    const rows = await supabaseRest<any[]>('admin_settings', {
      query: `?key=in.(${keys.join(',')})&select=key,value`,
    });
    for (const r of rows) {
      const raw = r?.value?.value ?? r?.value;
      const n = Number(raw);
      const cat = String(r.key).slice(-1).toUpperCase() as Category;
      if (!['A', 'B', 'C'].includes(cat)) continue;
      /* 3 soatlik tarif: 0 ham qiymat — «o'chiq, soatlik narx» */
      if (String(r.key).startsWith('tarif3_')) {
        if (raw !== null && raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0) out[cat].h3 = Math.round(n);
        continue;
      }
      if (!Number.isFinite(n) || n <= 0) continue;
      if (String(r.key).startsWith('half_')) out[cat].half = n;
      else out[cat].hour = n;
    }
  } catch (e) {
    console.warn('Tariflar o‘qilmadi, standart ishlatiladi:', e instanceof Error ? e.message : e);
  }
  return out;
}

/**
 * Narxni hisoblaydi.
 * @param category A / B / C
 * @param minutes  davomiylik (daqiqa)
 * @param tariffs  loadTariffs() natijasi
 */
export function computePrice(category: string, minutes: number, tariffs: Tariffs): number {
  const cat = String(category || '').trim().toUpperCase() as Category;
  const t = tariffs[cat] || tariffs.B;   // noma'lum kategoriya -> B
  const m = Math.max(1, Math.round(Number(minutes) || 0));

  // 30 daqiqa — maxsus narx
  if (m === 30) return Math.round(t.half);

  // 3 soat — alohida tarif (sozlangan bo'lsa)
  if (m === H3_MINUTES && Number(t.h3) > 0) return Math.round(Number(t.h3));

  // Qolgan hamma holat — soatlik tarifga proporsional
  return Math.round((t.hour * m) / 60);
}

/**
 * 1 KRUG (avtodrom bo'ylab bir aylana) — kassada sotiladi.
 * Narxi va davomiyligi sozlamada: krug_price (standart 80 000),
 * krug_min (standart 15 daqiqa — instruktor shuncha vaqt band bo'ladi).
 */
export const KRUG_DEFAULT = { price: 80000, minutes: 15 };
export async function loadKrug(): Promise<{ price: number; minutes: number }> {
  const out = { ...KRUG_DEFAULT };
  try {
    const rows = await supabaseRest<any[]>('admin_settings', { query: '?key=in.(krug_price,krug_min)&select=key,value' });
    for (const r of rows) {
      const n = Number(r?.value?.value ?? r?.value);
      if (!Number.isFinite(n)) continue;
      if (r.key === 'krug_price' && n >= 0) out.price = Math.round(n);
      if (r.key === 'krug_min' && n >= 15 && n <= 60) out.minutes = Math.round(n);
    }
  } catch { /* standart */ }
  return out;
}

/** Qulaylik: tariflarni o'zi o'qib narx qaytaradi. */
export async function priceFor(category: string, minutes: number): Promise<number> {
  return computePrice(category, minutes, await loadTariffs());
}
