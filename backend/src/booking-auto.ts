import { supabaseRest } from './supabase.js';

/**
 * AVTOMATIK TASDIQLASH
 *
 * Mini App orqali qilingan bron darhol «Tasdiqlangan» bo'ladi — mijoz admin
 * javobini kutmaydi, belgilangan vaqtda kelib to'g'ri mashinaga chiqadi.
 * Bandlik, instruktor bloklari, to'qnashuv — hammasi bron yaratilishidan
 * OLDIN tekshiriladi, shuning uchun admin qo'lda tasdiqlashi shart emas.
 *
 * Admin panel → Narxlar va ish vaqti → «Ilovadagi bronlar avtomatik
 * tasdiqlanadi» (admin_settings.booking_auto_confirm). Sozlama yo'q bo'lsa —
 * YOQIQ. O'chirilsa, eski tartib: bron «Kutilmoqda», admin tasdiqlaydi.
 */
export const AUTO_CONFIRM_KEY = 'booking_auto_confirm';
const OFF = [false, 'false', 0, '0', 'off', 'no'];

export async function autoConfirmOn(): Promise<boolean> {
  try {
    const r = (await supabaseRest<any[]>('admin_settings', { query: `?key=eq.${AUTO_CONFIRM_KEY}&select=value&limit=1` }))[0];
    if (!r) return true;
    const v = r.value && typeof r.value === 'object' && !Array.isArray(r.value) && 'value' in r.value ? r.value.value : r.value;
    if (v === null || v === undefined || v === '') return true;
    return !OFF.includes(v);
  } catch { return true; }
}

/**
 * Avtomatik tasdiqlangan va hali xodim tegmagan bron: hech kim qo'lda
 * tasdiqlamagan, kassada chek urilmagan, Mini App'dan kelgan. Bunday bronni
 * mijoz (ilgari «Kutilmoqda»dagidek) o'zi DARHOL bekor qila oladi — admin
 * so'rov ko'rib o'tirishi shart emas. To'lov bo'lsa — baribir so'rov orqali.
 */
export function autoConfirmedUntouched(b: any): boolean {
  return String(b?.status) === 'confirmed'
    && !b?.confirmed_by
    && !b?.school_receipt_code
    && String(b?.source ?? 'app') === 'app';
}

/** Qaysi bronlar uchun kassada to'lov qabul qilingan (status = paid) */
export async function paidBookingIds(ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const list = [...new Set(ids.filter(Boolean).map(String))];
  for (let i = 0; i < list.length; i += 100) {
    const part = list.slice(i, i + 100);
    const rows = await supabaseRest<any[]>('payments', {
      query: `?booking_id=in.(${part.map(encodeURIComponent).join(',')})&status=eq.paid&select=booking_id`,
    }).catch(() => [] as any[]);
    (rows || []).forEach((r) => out.add(String(r.booking_id)));
  }
  return out;
}

/** Mijoz shu bronni hozir o'zi darhol bekor qila oladimi */
export function canCancelNow(b: any, paid: Set<string>, nowMs = Date.now()): boolean {
  if (String(b?.status) === 'pending') return true;
  if (!autoConfirmedUntouched(b) || paid.has(String(b?.id))) return false;
  const start = Date.parse(b?.start_at || b?.booking_date);
  return !Number.isFinite(start) || start > nowMs;
}
