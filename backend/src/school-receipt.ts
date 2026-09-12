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
 * KOD FORMATLARI:
 *   Avtodrom o'z cheki  : AVD-123456-A1B2C  (payments.receipt_code)
 *   Avtodrom pickup kod : AVD-1234          (mijozga beriladi)
 *   Avtoshkola cheki    : AVS-12345         (avtodrom12 chiqaradi)
 * "AVS" ataylab boshqa prefiks: pickup_code ham AVD-1234 ko'rinishida
 * bo'lgani uchun ikkalasi aralashib, birovning cheki ishlatilib
 * ketishi mumkin edi.
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
  id?: string;
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

/** Avtoshkola cheki: AVS-12345 */
export function isSchoolReceiptCode(code: string): boolean {
  return /^AVS-\d{5}$/.test(String(code || '').trim().toUpperCase());
}

/** QR ichidan yoki qo'lda yozilgan matndan avtoshkola kodini ajratadi.
    Faqat 5 xonali raqam yozilsa ham qabul qilamiz — AVD bilan
    chalkashmaydi, chunki prefiks boshqacha. */
export function normalizeSchoolCode(raw: string): string {
  const s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  if (/^\d{5}$/.test(s)) return `AVS-${s}`;
  const m = s.match(/AVS-\d{5}/);
  return m ? m[0] : s;
}

export function schoolBridgeReady(): boolean {
  return Boolean(BASE && KEY);
}

/** Nima yetishmayotganini aniq aytadi (instruktorga ko'rsatiladigan matn). */
export function schoolBridgeMissing(): string {
  const miss: string[] = [];
  if (!BASE) miss.push('AVTODROM12_URL');
  if (!KEY) miss.push('RECEIPT_SHARED_KEY');
  return miss.join(' va ');
}

/**
 * KO'PRIK TASHXISI — administrator o'zi ko'rib, o'zi tuzatishi uchun.
 * avtodrom12 ga mavjud bo'lmagan kod bilan murojaat qilamiz va
 * javobiga qarab holatni aniqlaymiz:
 *   404 — kalit qabul qilindi, hammasi joyida
 *   401 — kalitlar bir xil emas
 *   503 — avtodrom12 tomonida kalit qo'yilmagan
 */
export async function schoolBridgeDiagnose(): Promise<{
  ok: boolean; url_set: boolean; key_set: boolean; url: string;
  reachable: boolean; status: number | null; detail: string;
}> {
  const base = {
    url_set: Boolean(BASE), key_set: Boolean(KEY), url: BASE || '',
    reachable: false, status: null as number | null,
  };
  if (!BASE || !KEY) {
    return { ...base, ok: false, detail: `Vercel sozlamasida ${schoolBridgeMissing()} yo‘q` };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(`${BASE}/api/receipts/verify?code=AVS-00000`, {
      headers: { 'Content-Type': 'application/json', 'X-Receipt-Key': KEY },
      signal: ctrl.signal,
    });
    let d: any = {};
    try { d = await r.json(); } catch { /* JSON emas */ }
    const out = { ...base, reachable: true, status: r.status };
    if (r.status === 404 || r.status === 400) {
      return { ...out, ok: true, detail: 'Ulanish va kalit joyida' };
    }
    if (r.status === 401) {
      return { ...out, ok: false, detail: 'Kalitlar bir xil emas — ikkala loyihada RECEIPT_SHARED_KEY aynan bir xil bo‘lsin' };
    }
    if (r.status === 503) {
      return { ...out, ok: false, detail: 'avtodrom12 tomonida RECEIPT_SHARED_KEY qo‘yilmagan' };
    }
    return { ...out, ok: false, detail: d?.error || `Kutilmagan javob (${r.status})` };
  } catch (e: any) {
    const aborted = e?.name === 'AbortError';
    return {
      ...base, ok: false,
      detail: aborted ? 'avtodrom12 javob bermadi (10 soniya)' : `Ulanib bo‘lmadi: ${e?.message || e}`,
    };
  } finally { clearTimeout(timer); }
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
  return assertReceipt(d);
}

/** Javob kutilgan shaklda kelganini tekshiradi — avtodrom12 kutilmagan
    narsa qaytarsa, undefined bilan ishlab ketib chekni yoqib yubormaymiz. */
function assertReceipt(d: any): SchoolReceipt {
  const r = d?.receipt;
  if (!r || typeof r !== 'object' || !r.code) {
    throw new BridgeError('Avtoshkola serveri kutilmagan javob qaytardi', 502);
  }
  return r as SchoolReceipt;
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
  return { receipt: assertReceipt(d), note: d.note ?? null };
}

/** Dars yakunlandi — avtodrom12 dagi sessiya ham yopiladi.
 *  Bu chaqiruv darsni to'xtatmaydi: xato bo'lsa faqat log yoziladi. */
export async function completeSchoolReceipt(code: string, durationSeconds?: number, receiptId?: string | null): Promise<void> {
  try {
    await call('/api/receipts/complete', {
      method: 'POST',
      body: JSON.stringify({
        code: normalizeSchoolCode(code),
        receipt_id: receiptId || undefined,
        duration_seconds: Number.isFinite(Number(durationSeconds)) ? Math.round(Number(durationSeconds)) : undefined,
      }),
    });
  } catch (e: any) {
    console.error('[school-receipt] complete failed:', e?.message || e);
  }
}

/** Chekni QAYTARADI: biz o'z tomonimizda darsni ocholmadik.
 *  Shu bo'lmasa o'quvchining tekin darsi yo'qolib ketardi. */
export async function releaseSchoolReceipt(input: { code: string; receiptId?: string | null; reason?: string }): Promise<boolean> {
  try {
    await call('/api/receipts/release', {
      method: 'POST',
      body: JSON.stringify({
        code: normalizeSchoolCode(input.code),
        receipt_id: input.receiptId || undefined,
        reason: input.reason || 'Avtodrom tomonda dars ochilmadi',
      }),
    });
    return true;
  } catch (e: any) {
    console.error('[school-receipt] release failed:', e?.message || e);
    return false;
  }
}
