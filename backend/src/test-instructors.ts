import { supabaseRest } from './supabase.js';

/**
 * SINOV (TEST) INSTRUKTORLARI
 *
 * Egasi/dasturchi o'z instruktor akkaunti bilan botni va instruktor panelini
 * sinab ko'rishi kerak, lekin mijozlar uni Mini App'da tanlab qo'ymasligi,
 * kassa va Excel bron ro'yxatlarida ham chiqmasligi kerak.
 *
 * Ro'yxat admin_settings'da: key = 'test_instructors',
 * value = ["<instructor_profiles.id>", ...] (yoki {"ids": [...]}).
 *
 * Sinov instruktori:
 *  - instruktor boti va paneliga odatdagidek kiradi (is_verified/is_available tegilmaydi);
 *  - mijozning instruktorlar ro'yxatida yo'q, unga Mini App orqali bron qilinmaydi;
 *  - kassa ro'yxatlari va «Bo'sh instruktorlar»da yo'q;
 *  - Excel bron va kassa jadvalida faqat o'sha kuni bron/yozuv bo'lsa ko'rinadi.
 */
export const TEST_INSTRUCTORS_KEY = 'test_instructors';

export function parseTestIds(raw: unknown): Set<string> {
  let v: any = raw;
  if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) v = v.value;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { v = v.split(/[\s,;]+/); }
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) v = v.ids;
  if (!Array.isArray(v)) return new Set();
  return new Set(v.map((x: unknown) => String(x ?? '').trim()).filter((x: string) => /^[0-9a-f-]{8,}$/i.test(x)));
}

/** Sinov instruktorlari id'lari. O'qib bo'lmasa — bo'sh (hech kim yashirilmaydi). */
export async function testInstructorIds(): Promise<Set<string>> {
  try {
    const rows = await supabaseRest<any[]>('admin_settings', {
      query: `?key=eq.${TEST_INSTRUCTORS_KEY}&select=value&limit=1`,
    });
    return parseTestIds(rows?.[0]?.value);
  } catch {
    return new Set();
  }
}
