import { supabaseRest } from './supabase.js';

/**
 * Bildirishnoma matnlari — bitta manba.
 *
 * Muammo: avval mijozga xom ma'lumot ketardi —
 *   Bron #9cb6110c-7e32-4f27-a3da-f808e9c4ad28
 *   Holati: confirmed
 *   Sana: 2026-08-30T00:00+00:00
 * To'liq UUID, inglizcha status va UTC vaqt. Endi hammasi odam o'qiydigan
 * ko'rinishda, Asia/Tashkent vaqti bilan.
 */

const TZ = 'Asia/Tashkent';
const MONTHS = ['yanvar','fevral','mart','aprel','may','iyun','iyul','avgust','sentabr','oktabr','noyabr','dekabr'];
const WEEKDAYS = ['yakshanba','dushanba','seshanba','chorshanba','payshanba','juma','shanba'];

/** "30-avgust, shanba · 10:00" — Toshkent vaqtida. */
export function fmtWhen(value: unknown): string {
  if (!value) return '';
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return '';
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  const day = Number(get('day'));
  const month = MONTHS[Number(get('month')) - 1] ?? '';
  // Hafta kunini UTC emas, Toshkent sanasidan hisoblaymiz
  const wd = WEEKDAYS[new Date(`${get('year')}-${get('month')}-${get('day')}T12:00:00+05:00`).getUTCDay()] ?? '';
  return `${day}-${month}${wd ? ', ' + wd : ''} · ${get('hour')}:${get('minute')}`;
}

export function fmtMoney(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Intl.NumberFormat('uz-UZ').format(n) + ' so‘m';
}

/** UUID o'rniga qisqa, o'qish mumkin bo'lgan kod: #9CB6110C */
export function shortCode(id: unknown): string {
  const s = String(id ?? '').replace(/-/g, '');
  return s ? '#' + s.slice(0, 8).toUpperCase() : '';
}

export type BookingEvent =
  | 'created' | 'confirmed' | 'rejected' | 'cancelled'
  | 'in_progress' | 'completed' | 'no_show';

const HEAD: Record<BookingEvent, { customer: string; instructor: string }> = {
  created:     { customer: '📝 Broningiz qabul qilindi',     instructor: '📝 Yangi bron keldi' },
  confirmed:   { customer: '✅ Broningiz tasdiqlandi',        instructor: '✅ Bron tasdiqlandi' },
  rejected:    { customer: '❌ Broningiz rad etildi',         instructor: '❌ Bron rad etildi' },
  cancelled:   { customer: '🚫 Bron bekor qilindi',           instructor: '🚫 Bron bekor qilindi' },
  in_progress: { customer: '🚗 Darsingiz boshlandi',          instructor: '🚗 Dars boshlandi' },
  completed:   { customer: '🏁 Darsingiz yakunlandi',         instructor: '🏁 Dars yakunlandi' },
  no_show:     { customer: 'ℹ️ Siz kelmagan deb belgilandingiz', instructor: 'ℹ️ Mijoz kelmadi' },
};

const TAIL: Partial<Record<BookingEvent, { customer?: string; instructor?: string }>> = {
  created:     { customer: 'Admin tasdiqlashini kuting.' },
  confirmed:   { customer: 'Belgilangan vaqtda avtodromga keling.' },
  rejected:    { customer: 'Boshqa vaqt yoki instruktorni tanlashingiz mumkin.' },
  completed:   { customer: 'Instruktorni baholashingiz mumkin — Mini Appni oching.' },
  no_show:     { customer: 'Xatolik bo‘lsa, Chat orqali bizga yozing.' },
};

export interface BookingDetails {
  courseName?: string | null;
  durationMinutes?: number | null;
  price?: number | null;
  instructorName?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  reason?: string | null;
}

/** Bron ma'lumotini bazadan to'ldiradi (kurs nomi, instruktor ismi, narx). */
export async function loadBookingDetails(booking: any): Promise<BookingDetails> {
  const out: BookingDetails = { reason: booking?.cancellation_reason ?? null };
  try {
    if (booking?.course_id) {
      const c = (await supabaseRest<any[]>('courses', {
        query: `?id=eq.${encodeURIComponent(String(booking.course_id))}&select=name,duration_minutes,price&limit=1`,
      }))[0];
      if (c) { out.courseName = c.name; out.durationMinutes = c.duration_minutes; out.price = c.price; }
    }
    if (booking?.instructor_id) {
      const ip = (await supabaseRest<any[]>('instructor_profiles', {
        query: `?id=eq.${encodeURIComponent(String(booking.instructor_id))}&select=user_id&limit=1`,
      }))[0];
      if (ip?.user_id) {
        const u = (await supabaseRest<any[]>('users', {
          query: `?id=eq.${encodeURIComponent(String(ip.user_id))}&select=full_name&limit=1`,
        }))[0];
        out.instructorName = u?.full_name ?? null;
      }
    }
    if (booking?.customer_id) {
      const u = (await supabaseRest<any[]>('users', {
        query: `?id=eq.${encodeURIComponent(String(booking.customer_id))}&select=full_name,phone&limit=1`,
      }))[0];
      out.customerName = u?.full_name ?? null;
      out.customerPhone = u?.phone ?? null;
    }
  } catch (e) {
    console.error('loadBookingDetails failed:', e);
  }
  return out;
}

/**
 * Telegram uchun tayyor matn. `audience` — kimga yuborilayotgani:
 * mijozga instruktor ismi, instruktorga mijoz ismi va telefoni ko'rsatiladi.
 */
export function bookingMessage(
  booking: any,
  event: BookingEvent,
  audience: 'customer' | 'instructor',
  d: BookingDetails = {},
): { title: string; body: string; full: string } {
  const title = HEAD[event][audience];
  const lines: string[] = [];

  const course = [d.courseName, d.durationMinutes ? `${d.durationMinutes} daqiqa` : '']
    .filter(Boolean).join(' · ');
  if (course) lines.push(`📚 ${course}`);

  if (audience === 'customer') {
    if (d.instructorName) lines.push(`👨‍🏫 ${d.instructorName}`);
  } else {
    if (d.customerName) lines.push(`👤 ${d.customerName}`);
    if (d.customerPhone) lines.push(`📞 ${d.customerPhone}`);
  }

  const when = fmtWhen(booking?.start_at || booking?.booking_date);
  if (when) lines.push(`📅 ${when}`);

  const money = fmtMoney(d.price);
  if (money) lines.push(`💵 ${money}`);

  if (booking?.customer_note && audience === 'instructor') lines.push(`💬 ${booking.customer_note}`);
  if (d.reason) lines.push(`ℹ️ Sabab: ${d.reason}`);

  const tail = TAIL[event]?.[audience];
  const code = shortCode(booking?.id);

  const body = [
    lines.join('\n'),
    tail ? `\n${tail}` : '',
    code ? `\nBron raqami: ${code}` : '',
  ].filter(Boolean).join('\n');

  return { title, body, full: `${title}\n\n${body}` };
}

/** DB `notifications` jadvali uchun qisqaroq matn (Mini App ichida ko'rinadi). */
export function inAppMessage(event: BookingEvent, d: BookingDetails, booking: any): string {
  const when = fmtWhen(booking?.start_at || booking?.booking_date);
  const parts = [d.courseName, when].filter(Boolean).join(' · ');
  const tail = TAIL[event]?.customer;
  return [parts, tail].filter(Boolean).join('. ');
}
