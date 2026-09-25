import { supabaseRest } from './supabase.js';

/**
 * `?col=in.(id1,id2,…)` so'rovini BO'LAKLAB yuboradi.
 *
 * Nega: uzoq davr hisobotida (masalan 1-oktabr → 3-yanvar) yuzlab bron
 * bo'ladi. Hamma ID bitta manzilga yozilsa, manzil juda uzun bo'lib
 * so'rov rad etiladi yoki PostgREST 1000 qatorda jimgina kesadi — pul
 * va soatlar noto'g'ri chiqadi. 150 tadan bo'lib yuborsak ikkalasi ham
 * bo'lmaydi.
 */
export async function selectIn<T = any>(
  table: string, column: string, ids: unknown[], select: string, extra = '', size = 150,
): Promise<T[]> {
  const uniq = [...new Set(ids.filter((x) => x !== null && x !== undefined && x !== '').map(String))];
  const out: T[] = [];
  for (let i = 0; i < uniq.length; i += size) {
    const part = uniq.slice(i, i + size).map(encodeURIComponent).join(',');
    const rows = await supabaseRest<T[]>(table, { query: `?${column}=in.(${part})&select=${select}${extra}` });
    if (Array.isArray(rows)) out.push(...rows);
  }
  return out;
}
