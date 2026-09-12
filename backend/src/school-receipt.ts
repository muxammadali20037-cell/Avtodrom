/**
 * AVTOSHKOLA QR CHEKI — avtodrom12 bilan ko'prik
 *
 * IKKI LOYIHA, BITTA OQIM:
 *   • avtodrom12  — chekni CHIQARADI. Operator belgilagan bitta
 *     avtoshkolaning o'quvchisiga QR kodli chek beradi. Dars TEKIN.
 *   • Avtodrom (shu repo) — instruktor paneli chekni SKANERLAYDI.
 *     Skanerlanganda dars shu yerda instruktor jadvaliga va hisobotiga
 *     tushadi, avtodrom12 da esa chek "ishlatilgan" bo'ladi.
 *
 * KOD FORMATLARI farq qiladi, shuning uchun adashmaydi:
 *   Avtodrom o'z cheki : AVD-123456-A1B2C  (payments.receipt_code)
 *   avtodrom12 cheki   : AVD-1234          (4-5 xonali)
 *
 * SOZLAMA (Vercel -> Environment Variables):
 *   AVTODROM12_URL        — masalan https://avtodrom12.vercel.app
 *   RECEIPT_SHARED_KEY    — ikkala loyihada BIR XIL maxfiy kalit
 * Ikkisi ham bo'lmasa, avtoshkola cheklari shunchaki ishlamaydi —
 * Avtodrom ning o'z cheklari avvalgidek ishlayveradi.
 */

const BASE = String(process.env.AVTODROM12_URL || process.env.SCHOOL_RECEIPT_URL || '').replace(/\/+$/, '');
const KEY = String(process.env.RECEIPT_SHARED_KEY || '');

export type SchoolReceipt = {
  code: string;
  status?: string;
  student_name: string | null;
  student_phone: string | null;
  school_name: string | null;
  group_name: string | null;
  planned_minutes: number;
  scanned_by_name?: string | null;
  free: true;
};

/** avtodrom12 cheki shu ko'rinishda: AVD-1234 yoki AVD-12345 */
export function isSchoolReceiptCode(code: string): boolean {
  return /^AVD-\d{4,5}$/.test(String(code || '').trim().toUpperCase());
}

/** Foydalanuvchi "1234" deb yozsa ham to'g'ri kodga aylantiramiz. */
export function normalizeSchoolCode(raw: string): string {
  const s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  if (/^\d{4,5}$/.test(s)) return `AVD-${s}`;
  const m = s.match(/AVD-\d{4,5}(?!\d|-)/);
  return m ? m[0] : s;
}

export function schoolBridgeReady(): boolean {
  return Boolean(BASE && KEY);
}

class BridgeError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** avtodrom12 ga so'rov. Javob JSON emas bo'lsa ham tushunarli xato beradi. */
async function call(path: string, init?: RequestInit): Promise<any> {
  if (!schoolBridgeReady()) {
    throw new BridgeError('Avtoshkola cheklari sozlanmagan (AVTODROM12_URL / RECEIPT_SHARED_KEY)', 503);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(`${BASE}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Receipt-Key': KEY,
        ...(init?.headers as any),
      },
    });
    let d: any = {};
    try { d = await r.json(); } catch { d = {}; }
    if (!r.ok) throw new BridgeError(d?.error || `Avtoshkola serveri javob bermadi (${r.status})`, r.status);
    return d;
  } catch (e: any) {
    if (e instanceof BridgeError) throw e;
    if (e?.name === 'AbortError') throw new BridgeError('Avtoshkola serveri javob bermadi (vaqt tugadi)', 504);
    throw new BridgeError(e?.message || 'Avtoshkola serveriga ulanib bo‘lmadi', 502);
  } finally {
    clearTimeout(timer);
  }
}

/** Chekni ISHLATMASDAN tekshiradi — skaner darhol ko'rsatishi uchun. */
export async function verifySchoolReceipt(code: string): Promise<SchoolReceipt> {
  const d = await call(`/api/receipts/verify?code=${encodeURIComponent(normalizeSchoolCode(code))}`);
  return d.receipt as SchoolReceipt;
}

/** Chekni ISHLATADI. Bir chek faqat bir marta — ikkinchisida 409 keladi. */
export async function redeemSchoolReceipt(input: {
  code: string;
  instructorName?: string | null;
  instructorRef?: string | null;
  vehiclePlate?: string | null;
  bookingId?: string | null;
}): Promise<{ receipt: SchoolReceipt; note?: string | null }> {
  const d = await call('/api/receipts/redeem', {
    method: 'POST',
    body: JSON.stringify({
      code: normalizeSchoolCode(input.code),
      instructor_name: input.instructorName || null,
      instructor_ref: input.instructorRef || null,
      vehicle_plate: input.vehiclePlate || null,
      external_booking_id: input.bookingId || null,
    }),
  });
  return { receipt: d.receipt as SchoolReceipt, note: d.note ?? null };
}

/** Dars yakunlandi — avtodrom12 dagi sessiya ham yopiladi.
 *  Bu chaqiruv darsni to'xtatmaydi: xato bo'lsa faqat log yoziladi. */
export async function completeSchoolReceipt(code: string, durationSeconds?: number): Promise<void> {
  try {
    await call('/api/receipts/complete', {
      method: 'POST',
      body: JSON.stringify({
        code: normalizeSchoolCode(code),
        duration_seconds: Number.isFinite(Number(durationSeconds)) ? Math.round(Number(durationSeconds)) : undefined,
      }),
    });
  } catch (e: any) {
    console.error('[school-receipt] complete failed:', e?.message || e);
  }
}
