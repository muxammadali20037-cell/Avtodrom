/**
 * DARS HISOBI — admin «Instruktor nazorati» va instruktorning o'z
 * «Hisob-kitob» sahifasi AYNAN bir xil qoidadan foydalanadi. Aks holda
 * oy oxirida admin bir raqamni, instruktor boshqasini ko'rib qolardi.
 */

/** Toshkent (UTC+5) kuni boshidan: 'YYYY-MM-DD' → Date. */
export function tashkentDay(ymd: string, addDays = 0): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + addDays, 0, 0, 0) - 5 * 3600e3);
}

/** Toshkent bo'yicha sana: Date → 'YYYY-MM-DD'. */
export function tashkentYmd(v: unknown): string {
  const d = new Date(String(v || ''));
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(d);
}

/** Dars davomiyligi (daqiqa): bronda yozilgani asosiy, keyin vaqt oralig'i, keyin kurs. */
export function lessonMinutes(b: any, course?: any): number {
  const own = Number(b?.duration_minutes || 0);
  if (own > 0) return own;
  const st = b?.start_at || b?.booking_date, en = b?.end_at;
  if (st && en) {
    const d = Math.round((new Date(en).getTime() - new Date(st).getTime()) / 60000);
    if (d > 0 && d < 24 * 60) return d;
  }
  return Number(course?.duration_minutes || 0);
}

/** AVTOSHKOLA darsi (avtodrom12 cheki bilan, pul olinmaydi). Qolgani — pullik. */
export function isSchoolLesson(b: any): boolean {
  return String(b?.source || '') === 'avtodrom12' ||
    !!b?.school_receipt_code ||
    /avtoshkola/i.test(String(b?.customer_note || ''));
}
