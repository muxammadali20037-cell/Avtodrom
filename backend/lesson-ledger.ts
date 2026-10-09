import { supabaseRest } from './supabase.js';
import { selectIn } from './rest-chunks.js';
import { lessonMinutes, isSchoolLesson, tashkentYmd } from './lesson-math.js';

/**
 * DARS DAFTARI — instruktor hisobotlarining YAGONA manbasi.
 *
 * Qoida (foydalanuvchi bilan kelishilgan, 2026-10-08):
 *   • Dars — kassada chiqarilgan CHEK URILGANDA (skanerlanganda) boshlanadi.
 *   • Chekni ISTALGAN instruktor ura oladi; bron boshqa instruktorga
 *     yozilgan bo'lsa ham dars (va puli) chekni URGAN instruktorga yoziladi.
 *   • Hisobotdagi kun — chek urilgan kun (bron qilingan kun emas).
 *   • Chek urilmagan bron — hisobotda dars emas (to'langan bo'lsa ham:
 *     u «urilmagan cheklar» bo'lib alohida ko'rinadi).
 *
 * Qanday tuziladi:
 *   • Chek urilganda (scan/start) bron chekni URGAN instruktorga o'tadi va
 *     arrived_at = urilgan vaqt yoziladi. Shuning uchun dars egasi —
 *     bron.instructor_id, kuni — arrived_at.
 *   • Dalil — attendance_verifications yozuvi (bitta bronga bitta, o'zgartirib
 *     bo'lmaydi; verification_snapshot da kimdan o'tgani, summa, daqiqa).
 *   • Avtoshkola darslari (AVS cheki) — bron faqat chek urilganda yaratiladi,
 *     shuning uchun bronning o'zi dalil.
 *   • Eski darslar (birinchi yozuvdan OLDINGI) — skaner yozuvi yo'q edi:
 *     boshlangan/tugagan + to'langan bron, bron instruktoriga.
 *     (Ilgari chekni faqat bron egasi ura olardi — natija bir xil.)
 *   • Shundan keyin chek urilmay boshlangan dars (masalan, admin qo'lda) — sanalmaydi.
 */

const q = (v: string) => encodeURIComponent(v);
const iso = (ms: number) => new Date(ms).toISOString();
const STARTED = ['in_progress', 'completed'];

export type LedgerRow = {
  booking_id: string;
  instructor_id: string | null;          // chekni urgan instruktor (instructor_profiles.id)
  from_instructor_id: string | null;     // bron oldin kimga yozilgan edi (boshqa bo'lsa)
  scanned_at: string;                    // chek urilgan vaqt (dars boshlangan)
  day: string;                           // Toshkent kuni
  receipt_code: string | null;
  school: boolean;
  customer_id: string | null;
  minutes: number;                       // chekdagi (to'langan) daqiqa
  amount: number; cash: number; card: number; method: string | null;
  register_id: string | null;
  status: string;                        // bronning hozirgi holati
  start_at: string;                      // bron vaqti (ma'lumot uchun)
  category: string | null;
  course_id: string | null;
  source: 'scan' | 'school' | 'legacy';
};

/* ------------------------------------------------------------------ */
/* Chek urilganini yozish                                              */
/* ------------------------------------------------------------------ */
export async function recordScan(o: {
  booking: any; scannerUserId: string | null; scannerTelegramId: number; instructorId: string; instructorName: string | null;
  receiptCode: string; payment?: any; school?: boolean; fromInstructorId?: string | null; minutes: number;
}): Promise<void> {
  const p = o.payment && String(o.payment.status) === 'paid' ? o.payment : null;
  const amount = p ? Number(p.amount || 0) : 0;
  const method = p ? String(p.method || 'cash') : null;
  const cash = p ? (method === 'mixed' ? Number(p.cash_amount || 0) : method === 'card' ? 0 : amount) : 0;
  const card = p ? (method === 'mixed' ? Number(p.card_amount || 0) : method === 'card' ? amount : 0) : 0;
  await supabaseRest('attendance_verifications', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      booking_id: o.booking.id,
      customer_id: o.booking.customer_id,
      method: 'qr',
      token_epoch: Math.floor(Date.now() / 1000),
      telegram_user_id: o.scannerTelegramId,
      scanned_by: o.scannerUserId,
      receipt_code: o.receiptCode,
      verification_snapshot: {
        v: 1, kind: o.school ? 'school_receipt' : 'receipt',
        instructor_id: o.instructorId, instructor_name: o.instructorName,
        from_instructor_id: o.fromInstructorId || null,
        minutes: o.minutes, amount, cash, card, method,
        register_id: p?.register_id || null, category: o.booking.category || null,
      },
    }),
  });
}

/* ------------------------------------------------------------------ */
/* Daftar                                                              */
/* ------------------------------------------------------------------ */
export async function pageAll<T = any>(table: string, query: string, max = 50000): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < max; offset += 1000) {
    const chunk = await supabaseRest<T[]>(table, { query: `${query}&limit=1000&offset=${offset}` });
    out.push(...chunk);
    if (chunk.length < 1000) break;
  }
  return out;
}

/** Birinchi skaner yozuvi qachon — undan oldingi darslar «eski» usulda sanaladi */
async function ledgerStart(): Promise<number> {
  /* So'rov yiqilsa — xato (hisobot noto'g'ri «eski usulda» chiqmasin) */
  const r = await supabaseRest<any[]>('attendance_verifications', { query: '?select=created_at&order=created_at.asc,id.asc&limit=1' });
  const t = Date.parse(r?.[0]?.created_at || '');
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

function payMap(pays: any[]) {
  const m = new Map<string, any>();
  for (const p of pays) {
    const k = String(p.booking_id), cur = m.get(k);
    if (!cur || (cur.status !== 'paid' && p.status === 'paid')) m.set(k, p);
  }
  return m;
}
const moneyOf = (p: any) => {
  if (!p || String(p.status) !== 'paid') return { amount: 0, cash: 0, card: 0, method: null as string | null };
  const amount = Number(p.amount || 0), method = String(p.method || 'cash');
  return {
    amount, method,
    cash: method === 'mixed' ? Number(p.cash_amount || 0) : method === 'card' ? 0 : amount,
    card: method === 'mixed' ? Number(p.card_amount || 0) : method === 'card' ? amount : 0,
  };
};

export type Ledger = { rows: LedgerRow[]; bookings: Map<string, any>; courses: Map<string, any> };

/**
 * [from, to) oralig'ida urilgan cheklar (darslar).
 * instructorId — faqat shu instruktor URGANlari; registerId — faqat shu
 * kassada sotilgan cheklar (+ kassaga bog'liq bo'lmagan avtoshkola darslari).
 */
export async function loadLedger(o: { from: Date; to: Date; instructorId?: string | null; registerId?: string | null }): Promise<Ledger> {
  const F = o.from.getTime(), T = o.to.getTime();
  const insF = o.instructorId ? `&instructor_id=eq.${q(o.instructorId)}` : '';
  /* Dars boshlangan vaqt = chek urilgan vaqt (scan/start arrived_at ni yozadi).
     Bron boshqa kunga bo'lsa ham — urilgan kun hisobga olinadi. */
  const [arrived, noArrive, cutoff] = await Promise.all([
    pageAll<any>('bookings',
      `?status=in.(${STARTED.join(',')})&arrived_at=gte.${q(iso(F))}&arrived_at=lt.${q(iso(T))}${insF}&select=*&order=arrived_at.asc,id.asc`),
    /* juda eski yozuvlar: arrived_at yo'q — bron vaqti */
    pageAll<any>('bookings',
      `?status=in.(${STARTED.join(',')})&arrived_at=is.null&start_at=gte.${q(iso(F))}&start_at=lt.${q(iso(T))}${insF}&select=*&order=start_at.asc,id.asc`),
    ledgerStart(),
  ]);
  /* Sahifalashda bir qator ikki marta kelsa ham bir marta sanaladi */
  const known = new Map<string, any>([...arrived, ...noArrive].map((b) => [String(b.id), b]));
  const all = [...known.values()];
  const ids = [...known.keys()];
  const [scans, payList] = await Promise.all([
    selectIn<any>('attendance_verifications', 'booking_id', ids, 'booking_id,receipt_code,created_at,verification_snapshot'),
    selectIn<any>('payments', 'booking_id', ids, 'booking_id,amount,method,status,receipt_code,paid_at,cash_amount,card_amount,register_id'),
  ]);
  /* Bitta bronga bitta yozuv (bazada UNIQUE) */
  const scanOf = new Map<string, any>(scans.map((x) => [String(x.booking_id), x]));
  const pays = payMap(payList);
  const cids = [...new Set(all.map((b) => b.course_id).filter(Boolean).map(String))];
  const courses = new Map((await selectIn<any>('courses', 'id', cids, 'id,name,category,duration_minutes')).map((c) => [String(c.id), c]));

  const rows: LedgerRow[] = [];
  for (const b of all) {
    const id = String(b.id);
    const ts = Date.parse(b.arrived_at || b.start_at || b.booking_date);
    if (!Number.isFinite(ts)) continue;
    const scan = scanOf.get(id);
    const p = pays.get(id);
    let src: LedgerRow['source'];
    if (scan) src = 'scan';
    else if (isSchoolLesson(b)) src = 'school';                         // AVS cheki: bron faqat urilganda yaratiladi
    else if (ts < cutoff && p && String(p.status) === 'paid') src = 'legacy';
    else continue;                                                     // chek urilmagan — dars emas
    const snap = scan?.verification_snapshot || {};
    /* Egasi — bronning hozirgi instruktori (chek urilganda unga o'tgan);
       instruktor o'chirilgan bo'lsa — chekni urgan (yozuvdagi) */
    const ins = b.instructor_id ? String(b.instructor_id) : snap.instructor_id ? String(snap.instructor_id) : null;
    const fromIns = snap.from_instructor_id && String(snap.from_instructor_id) !== ins ? String(snap.from_instructor_id) : null;
    const m = moneyOf(p);
    const c = courses.get(String(b.course_id));
    rows.push({
      booking_id: id, instructor_id: ins, from_instructor_id: fromIns,
      scanned_at: iso(ts), day: tashkentYmd(iso(ts)),
      receipt_code: scan?.receipt_code || p?.receipt_code || b.school_receipt_code || null,
      school: isSchoolLesson(b), customer_id: b.customer_id ? String(b.customer_id) : null,
      minutes: lessonMinutes(b, c) || Number(snap.minutes) || 0,
      amount: m.amount, cash: m.cash, card: m.card, method: m.method,
      register_id: p?.register_id || null, status: String(b.status || ''),
      start_at: b.start_at || b.booking_date, category: b.category || c?.category || null,
      course_id: b.course_id ? String(b.course_id) : null, source: src,
    });
  }

  /* Kassa: faqat o'z kassasida sotilgan cheklar + to'lovsiz avtoshkola darslari */
  const scoped = o.registerId
    ? rows.filter((r) => String(r.register_id || '') === String(o.registerId) || (r.school && !r.register_id && !r.amount))
    : rows;
  scoped.sort((a, b) => a.scanned_at.localeCompare(b.scanned_at));
  return { rows: scoped, bookings: known, courses };
}

/**
 * Shu oraliqda TO'LANGAN, lekin hali urilmagan cheklar — kassadagi pul,
 * hech bir instruktorga yozilmagan.
 */
export async function unscannedReceipts(o: { from: Date; to: Date; registerId?: string | null }) {
  const raw = await pageAll<any>('payments',
    `?status=eq.paid&receipt_code=not.is.null&paid_at=gte.${q(o.from.toISOString())}&paid_at=lt.${q(o.to.toISOString())}` +
    (o.registerId ? `&register_id=eq.${q(o.registerId)}` : '') + '&select=id,booking_id,amount,receipt_code,register_id,paid_at&order=paid_at.asc,id.asc');
  const pays = [...new Map(raw.map((p) => [String(p.id ?? p.receipt_code), p])).values()];
  if (!pays.length) return { receipts: 0, amount: 0, list: [] as any[] };
  const ids = pays.map((p) => String(p.booking_id));
  const [bks, scans, cutoff] = await Promise.all([
    selectIn<any>('bookings', 'id', ids, 'id,status,instructor_id,start_at,arrived_at,customer_id,source,school_receipt_code,customer_note'),
    selectIn<any>('attendance_verifications', 'booking_id', ids, 'booking_id'),
    ledgerStart(),
  ]);
  const bm = new Map(bks.map((b) => [String(b.id), b]));
  const scanned = new Set(scans.map((x) => String(x.booking_id)));
  /* Hisobga kirgan chek — dars boshlangan VA (chek urilgan yoki eski usulda
     sanalgan). Qolgani — kassadagi, hech kimga yozilmagan pul: urilmagan,
     kelmagan, bekor qilingan, chek urmasdan qo'lda boshlangan. */
  const counted = (b: any) => {
    if (!STARTED.includes(String(b.status))) return false;
    if (scanned.has(String(b.id)) || isSchoolLesson(b)) return true;
    return Date.parse(b.arrived_at || b.start_at) < cutoff;
  };
  const list = pays.filter((p) => {
    const b = bm.get(String(p.booking_id));
    return !!b && !counted(b);
  }).map((p) => ({ ...p, status: bm.get(String(p.booking_id))?.status || null }));
  return { receipts: list.length, amount: list.reduce((a, p) => a + Number(p.amount || 0), 0), list };
}

/* ------------------------------------------------------------------ */
/* Avtomatik yopish                                                    */
/* ------------------------------------------------------------------ */
/**
 * Chek urilgandan keyin chekdagi vaqt (1 soat, 2 soat …) o'tsa — dars
 * o'zi yopiladi. Yopilish vaqti — boshlangan vaqt + chekdagi daqiqa.
 */
export async function finishDueLessons(nowMs = Date.now()) {
  const out = { checked: 0, closed: 0, details: [] as string[] };
  const rows = await supabaseRest<any[]>('bookings', {
    query: '?status=eq.in_progress&arrived_at=not.is.null&select=*&order=arrived_at.asc&limit=300',
  });
  out.checked = rows.length;
  if (!rows.length) return out;
  const cids = [...new Set(rows.map((b) => b.course_id).filter(Boolean).map(String))];
  const cm = new Map((await selectIn<any>('courses', 'id', cids, 'id,duration_minutes')).map((c) => [String(c.id), c]));
  for (const b of rows) {
    const mins = lessonMinutes(b, cm.get(String(b.course_id))) || 60;
    const endMs = Date.parse(b.arrived_at) + mins * 60000;
    if (!Number.isFinite(endMs) || endMs > nowMs) continue;
    const at = iso(endMs);
    let upd: any[] = [];
    try {
      upd = await supabaseRest<any[]>('bookings', {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        query: `?id=eq.${q(String(b.id))}&status=eq.in_progress`,
        body: JSON.stringify({ status: 'completed', departed_at: at, updated_at: iso(nowMs) }),
      });
    } catch (e) {
      out.details.push(`${String(b.id).slice(0, 8)} yopilmadi: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    if (!upd?.length) continue;
    out.closed++;
    const done = { ...b, ...upd[0] };
    await supabaseRest('admin_audit_logs', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        admin_id: null, action: 'LESSON_AUTO_FINISHED', entity_type: 'bookings', entity_id: b.id,
        old_data: { status: 'in_progress', arrived_at: b.arrived_at }, new_data: { status: 'completed', departed_at: at, minutes: mins },
      }),
    }).catch(() => {});
    /* Avtoshkola darsi — avtodrom12 dagi chekni ham yopamiz */
    const code = String(b.school_receipt_code || '').toUpperCase();
    if (/^AVS-\d{5}$/.test(code)) {
      const { completeSchoolReceipt } = await import('./school-receipt.js');
      void completeSchoolReceipt(code, mins * 60).catch(() => {});
    }
    /* Mijozga xabar — faqat yaqinda tugagan darslar uchun (eski osilib
       qolgan darslar yopilganda kunlar oldingi dars haqida yozmaymiz) */
    if (nowMs - endMs < 2 * 3600e3) {
      try {
        const { notifyBookingStatus } = await import('./instructor-routes.js');
        await notifyBookingStatus(done, 'completed');
      } catch { /* xabar ketmasa ham dars yopilgan */ }
    }
  }
  return out;
}
