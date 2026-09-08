import { supabaseRest } from './supabase.js';

/**
 * NARX HISOBLASH — YAGONA MANBA
 *
 * Tarif tuzilmasi:
 *   · 30 daqiqa — ALOHIDA narx (soatning yarmi emas!)
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

/** Sozlanmagan holat uchun standart tariflar. */
const DEFAULTS: Record<Category, { half: number; hour: number }> = {
  A: { half: 200000, hour: 350000 },
  B: { half: 150000, hour: 250000 },
  C: { half: 250000, hour: 400000 },
};

export interface Tariffs {
  A: { half: number; hour: number };
  B: { half: number; hour: number };
  C: { half: number; hour: number };
}

/** Sozlamalardan tariflarni o'qiydi. Xato bo'lsa standartga qaytadi. */
export async function loadTariffs(): Promise<Tariffs> {
  const out: Tariffs = JSON.parse(JSON.stringify(DEFAULTS));
  try {
    const keys = ['half_a', 'half_b', 'half_c', 'rate_a', 'rate_b', 'rate_c'];
    const rows = await supabaseRest<any[]>('admin_settings', {
      query: `?key=in.(${keys.join(',')})&select=key,value`,
    });
    for (const r of rows) {
      const raw = r?.value?.value ?? r?.value;
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) continue;
      const cat = String(r.key).slice(-1).toUpperCase() as Category;
      if (!['A', 'B', 'C'].includes(cat)) continue;
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

  // Qolgan hamma holat — soatlik tarifga proporsional
  return Math.round((t.hour * m) / 60);
}

/** Qulaylik: tariflarni o'zi o'qib narx qaytaradi. */
export async function priceFor(category: string, minutes: number): Promise<number> {
  return computePrice(category, minutes, await loadTariffs());
}
