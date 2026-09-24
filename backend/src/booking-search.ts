/**
 * BRON QIDIRUVI — admin «Bronlar» ro'yxati va kassa «Chek chiqarish»
 * oynasi uchun bitta joyda.
 *
 * Bitta maydonga nima yozilsa ham topiladi:
 *   · ism yoki familiya       — «Ali», «Karimov», «ali kar»
 *   · telefon (to'liq/oxiri)  — «+998901234567», «4567»
 *   · bron kodi               — «AVD-4821», «avd4821», «4821»
 *   · bron ID (UUID)
 *
 * Natija — PostgREST `or=(...)` bo'lagi. Bronlar jadvalida mijoz ismi
 * yo'q, shuning uchun avval mos mijozlar topiladi va ularning ID'lari
 * bo'yicha bronlar olinadi.
 */
import { supabaseRest } from './supabase.js';

const q = (v: string) => encodeURIComponent(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PostgREST ro'yxatini buzadigan belgilar olib tashlanadi: , ( ) " * % \ */
export function cleanSearchTerm(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[,()"*%\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/**
 * @returns
 *   ''   — qidiruv matni bo'sh, filtr qo'shilmaydi;
 *   null — hech narsa mos kelmadi, natija bo'sh bo'lishi kerak;
 *   'or=(...)' — bronlar so'roviga qo'shiladigan filtr.
 */
export async function bookingSearchFilter(raw: unknown): Promise<string | null> {
  const term = cleanSearchTerm(raw);
  if (!term) return '';

  const parts: string[] = [];
  if (UUID.test(term)) parts.push(`id.eq.${term}`);

  const compact = term.toUpperCase().replace(/\s+/g, '');
  const code = /^AVD-?(\d{1,5})$/.exec(compact);
  const onlyDigits = /^[\d\s+\-]+$/.test(term);
  const digits = term.replace(/\D/g, '');

  if (code) {
    // «AVD-48» yozilayotganda ham topilsin
    parts.push(`pickup_code.ilike.${q(`AVD-${code[1]}`)}*`);
  } else if (onlyDigits && digits.length >= 3 && digits.length <= 5) {
    // 4821 — bron kodi ham, telefon oxiri ham bo'lishi mumkin
    parts.push(`pickup_code.ilike.*${digits}*`);
  }

  /* Mijozlar: ism bo'yicha (so'zlar tartibida) yoki telefon bo'yicha */
  const userOr: string[] = [];
  if (!code && /\p{L}/u.test(term)) {
    const words = term.split(' ').filter(Boolean);
    userOr.push(`full_name.ilike.*${q(words.join('*'))}*`);
  }
  if (!code && onlyDigits && digits.length >= 3) {
    userOr.push(`phone.ilike.*${digits}*`);
  }
  if (userOr.length) {
    const users = await supabaseRest<any[]>('users', {
      query: `?or=(${userOr.join(',')})&select=id&limit=100`,
    }).catch(() => [] as any[]);
    const ids = users.map((u) => String(u.id)).filter((x) => UUID.test(x) || /^[\w-]+$/.test(x));
    if (ids.length) parts.push(`customer_id.in.(${ids.join(',')})`);
  }

  return parts.length ? `or=(${parts.join(',')})` : null;
}

/** «YYYY-MM-DD» (Toshkent) → kun boshi, ISO. Noto'g'ri bo'lsa null. */
export function tashkentDayStart(day: unknown): Date | null {
  const d = String(day ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const x = new Date(`${d}T00:00:00+05:00`);
  return Number.isNaN(x.getTime()) ? null : x;
}
