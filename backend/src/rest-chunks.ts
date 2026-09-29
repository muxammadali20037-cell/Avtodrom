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
  const parts: string[] = [];
  for (let i = 0; i < uniq.length; i += size) parts.push(uniq.slice(i, i + size).map(encodeURIComponent).join(','));
  /* Bo'laklar 4 tadan PARALLEL yuboriladi: yillik hisobotda yuzlab
     bo'lak bo'ladi va ketma-ket yuborilsa so'rov vaqt chegarasiga
     (60 s) yetib qolardi. Natija tartibi saqlanadi. */
  const res: T[][] = new Array(parts.length);
  let next = 0;
  const worker = async () => {
    while (next < parts.length) {
      const i = next++;
      const rows = await supabaseRest<T[]>(table, { query: `?${column}=in.(${parts[i]})&select=${select}${extra}` });
      res[i] = Array.isArray(rows) ? rows : [];
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, parts.length) }, worker));
  return res.flat();
}
