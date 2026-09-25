import crypto from 'node:crypto';
import { supabaseRest } from './supabase.js';
import { selectIn } from './rest-chunks.js';
import { computePrice, type Tariffs } from './pricing.js';
import { instructorBlockedAt, blockedMessage } from './instructor-blocks.js';

/**
 * 5 SOATLIK PAKET
 *
 * Mijoz 5 soatni chegirmali narxda (standart 1 100 000 so'm) oladi va
 * uni o'zi bo'ladi: bir kunda 5 soat, 3 + 2, 2 + 2 + 1 yoki har kuni
 * 1 soatdan. Har bir mashg'ulot — ALOHIDA bron: o'z vaqti, kodi, cheki
 * bor. Instruktor jadvalida, kassada va eslatmalarda oddiy bron kabi
 * ishlaydi. Paket narxi mashg'ulotlarga soatiga qarab bo'linadi va har
 * bronning `price` ustunida saqlanadi (3 + 2 → 660 000 + 440 000).
 *
 * Qaysi bron qaysi paketga tegishliligi bazaga migratsiyasiz,
 * admin_settings'da saqlanadi:
 *   pack:<paket_id>   → paket yozuvi (narx, mashg'ulotlar ro'yxati)
 *   packb:<bron_id>   → { package_id, n, of }  (bron → paket)
 */

export const PACKAGE_MINUTES = 300;
export const DEFAULT_PACKAGE_PRICE = 1_100_000;
export const MAX_SESSIONS = 5;
const PKG = 'pack:';
const PKGB = 'packb:';
/** admin_settings ro'yxatida ko'rsatilmaydigan tizim kalitlari */
export const SYSTEM_KEY_PREFIXES = [PKG, PKGB, 'instructor_busy:'];

type Cat = 'A' | 'B' | 'C';
const CATS: Cat[] = ['A', 'B', 'C'];
const ACTIVE = 'pending,confirmed,in_progress';
const q = (v: string) => encodeURIComponent(v);

export type PackagePrices = Record<Cat, number>;

/** Paket narxlari: sozlamalardagi paket5_a/b/c. Yo'q bo'lsa — 1 100 000.
    0 yozilgan bo'lsa — o'sha kategoriyada paket o'chirilgan. */
export async function loadPackagePrices(): Promise<PackagePrices> {
  const out: PackagePrices = { A: DEFAULT_PACKAGE_PRICE, B: DEFAULT_PACKAGE_PRICE, C: DEFAULT_PACKAGE_PRICE };
  try {
    const rows = await supabaseRest<any[]>('admin_settings', {
      query: `?key=in.(paket5_a,paket5_b,paket5_c)&select=key,value`,
    });
    for (const r of rows || []) {
      const raw = r?.value?.value ?? r?.value;
      if (raw === null || raw === undefined || raw === '') continue;
      const n = Number(raw);
      const cat = String(r.key).slice(-1).toUpperCase() as Cat;
      if (!CATS.includes(cat) || !Number.isFinite(n) || n < 0) continue;
      out[cat] = Math.round(n);
    }
  } catch (e) {
    console.warn('Paket narxlari o‘qilmadi, standart ishlatiladi:', e instanceof Error ? e.message : e);
  }
  return out;
}

export function packagePriceOf(category: string, prices: PackagePrices): number {
  const c = String(category || '').toUpperCase() as Cat;
  return CATS.includes(c) ? Math.max(0, Number(prices[c]) || 0) : 0;
}

/** Narx: 5 soat bo'lsa va paket yoqilgan bo'lsa — paket narxi, aks holda tarif. */
export function priceWithPackage(category: string, minutes: number, tariffs: Tariffs, prices: PackagePrices): number {
  const m = Math.round(Number(minutes) || 0);
  const p = packagePriceOf(category, prices);
  if (m === PACKAGE_MINUTES && p > 0) return p;
  return computePrice(category, m, tariffs);
}

/** Bo'linish to'g'rimi: 1–5 ta mashg'ulot, har biri butun soat, jami 5 soat. */
export function splitError(minutes: number[]): string | null {
  if (!Array.isArray(minutes) || minutes.length < 1 || minutes.length > MAX_SESSIONS) {
    return 'Paket 1 tadan 5 tagacha mashg‘ulotga bo‘linadi';
  }
  if (minutes.some((m) => !Number.isInteger(m) || m < 60 || m > PACKAGE_MINUTES || m % 60 !== 0)) {
    return 'Har bir mashg‘ulot butun soat bo‘lishi kerak (1–5 soat)';
  }
  if (minutes.reduce((a, b) => a + b, 0) !== PACKAGE_MINUTES) {
    return 'Mashg‘ulotlar jami 5 soat bo‘lishi kerak';
  }
  return null;
}

/** Paket narxini mashg'ulotlarga soatiga qarab bo'ladi. Qoldiq birinchisiga. */
export function shares(total: number, minutes: number[]): number[] {
  const sum = minutes.reduce((a, b) => a + b, 0) || 1;
  const out = minutes.map((m) => Math.floor((total * m) / sum));
  out[0] += Math.round(total) - out.reduce((a, b) => a + b, 0);
  return out;
}

const TZ_DAY = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(d);
const HM = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit' }).format(d);

export type Session = { start: Date; end: Date; minutes: number };

/** Kelgan mashg'ulotlarni tekshirib, vaqt tartibida qaytaradi. */
export function parseSessions(raw: unknown, opts: { rejectPast?: boolean; graceMs?: number } = {}):
  { sessions: Session[] } | { error: string } {
  if (!Array.isArray(raw) || !raw.length) return { error: 'Mashg‘ulotlar vaqtini tanlang' };
  const sessions: Session[] = [];
  for (const [i, s] of raw.entries()) {
    const start = new Date(String((s as any)?.start_at || ''));
    const minutes = Math.round(Number((s as any)?.minutes ?? (s as any)?.duration_minutes));
    if (Number.isNaN(start.getTime())) return { error: `${i + 1}-mashg‘ulot vaqti noto‘g‘ri` };
    if (opts.rejectPast && start.getTime() < Date.now() - (opts.graceMs ?? 0)) {
      return { error: `${i + 1}-mashg‘ulot vaqti o‘tib ketgan. Boshqa vaqtni tanlang.` };
    }
    sessions.push({ start, end: new Date(start.getTime() + minutes * 60000), minutes });
  }
  const err = splitError(sessions.map((s) => s.minutes));
  if (err) return { error: err };
  sessions.sort((a, b) => a.start.getTime() - b.start.getTime());
  for (let i = 1; i < sessions.length; i++) {
    if (sessions[i].start < sessions[i - 1].end) {
      return { error: 'Mashg‘ulotlar vaqti bir-birining ustiga tushyapti' };
    }
  }
  return { sessions };
}

/** Instruktor/mijoz shu vaqtlarda band emasmi. Band bo'lsa — tushunarli xabar. */
export async function sessionConflict(instructorId: string, customerId: string | null, sessions: Session[]): Promise<string | null> {
  if (!sessions.length) return null;
  const from = sessions[0].start.toISOString();
  const to = sessions[sessions.length - 1].end.toISOString();
  const who = customerId
    ? `&or=(instructor_id.eq.${q(instructorId)},customer_id.eq.${q(customerId)})`
    : `&instructor_id=eq.${q(instructorId)}`;
  const rows = await supabaseRest<any[]>('bookings', {
    query: `?start_at=lt.${q(to)}&end_at=gt.${q(from)}&status=in.(${ACTIVE})${who}` +
      '&select=id,instructor_id,customer_id,start_at,end_at&limit=500',
  });
  for (const s of sessions) {
    const hit = (rows || []).filter((b) => Date.parse(b.start_at) < s.end.getTime() && Date.parse(b.end_at) > s.start.getTime());
    const label = `${TZ_DAY(s.start).slice(5).split('-').reverse().join('.')} ${HM(s.start)}`;
    if (hit.some((b) => String(b.instructor_id) === String(instructorId))) {
      return `Instruktor ${label} da band. Boshqa vaqt yoki instruktorni tanlang.`;
    }
    if (customerId && hit.some((b) => String(b.customer_id) === String(customerId))) {
      return `Mijozda ${label} da boshqa bron bor.`;
    }
    const blk = await instructorBlockedAt(instructorId, s.start, s.end);
    if (blk) return blockedMessage(blk);
  }
  return null;
}

/**
 * Bronlarni ketma-ket yozadi. Bittasi yozilmasa — oldin yozilganlari
 * O'CHIRILADI: paketning yarmi yaratilib qolmasin.
 */
export async function insertBookings(payloads: any[], newCode: () => Promise<string>): Promise<any[]> {
  const created: any[] = [];
  const post = async (body: any) => (await supabaseRest<any[]>('bookings', {
    method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body),
  }))[0];
  try {
    for (const p of payloads) {
      let row: any = null;
      for (let attempt = 0; attempt < 3 && !row; attempt++) {
        try {
          row = await post({ ...p, pickup_code: await newCode() });
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e ?? '');
          if (/bookings_pickup_code_key/.test(m)) continue;         // kod takrorlandi — boshqasi
          if (/pickup_code/.test(m)) { row = await post(p); break; } // eski baza: kod ustuni yo'q
          throw e;
        }
      }
      if (!row) row = await post(p);
      if (!row) throw new Error('Bron yozilmadi');
      created.push(row);
    }
    return created;
  } catch (e) {
    if (created.length) {
      await supabaseRest('bookings', {
        method: 'DELETE', query: `?id=in.(${created.map((b) => q(String(b.id))).join(',')})`,
      }).catch((x) => console.error('Paket bronlarini qaytarib bo‘lmadi:', x));
    }
    throw e;
  }
}

export interface PackageRecord {
  id: string;
  customer_id: string | null;
  instructor_id: string | null;
  category: string;
  minutes: number;
  price: number;
  list_price: number;
  source: string;
  created_at: string;
  sessions: { booking_id: string; start_at: string; minutes: number; price: number; pickup_code: string | null }[];
}

export const newPackageId = () => crypto.randomUUID();

/** Paket yozuvini saqlaydi. Xato bo'lsa bronlar baribir qoladi (faqat belgi yo'qoladi). */
export async function savePackage(rec: PackageRecord): Promise<void> {
  const now = new Date().toISOString();
  const rows = [
    { key: PKG + rec.id, value: rec, updated_at: now },
    ...rec.sessions.map((s, i) => ({
      key: PKGB + s.booking_id, value: { package_id: rec.id, n: i + 1, of: rec.sessions.length }, updated_at: now,
    })),
  ];
  try {
    await supabaseRest('admin_settings', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(rows) });
  } catch (e) {
    console.error('Paket yozuvi saqlanmadi:', e instanceof Error ? e.message : e);
  }
}

export interface PackageInfo {
  id: string; n: number; of: number;
  price: number; list_price: number; minutes: number; category: string;
  sessions: PackageRecord['sessions'];
}

/** Bronlar → paket ma'lumoti (paketga tegishli bo'lmaganlari ro'yxatda yo'q). */
export async function packagesFor(bookingIds: unknown[]): Promise<Map<string, PackageInfo>> {
  const out = new Map<string, PackageInfo>();
  const ids = [...new Set(bookingIds.filter(Boolean).map(String))];
  if (!ids.length) return out;
  try {
    const links = await selectIn<any>('admin_settings', 'key', ids.map((id) => PKGB + id), 'key,value');
    if (!links.length) return out;
    const pids = [...new Set(links.map((l) => String(l?.value?.package_id || '')).filter(Boolean))];
    const recs = await selectIn<any>('admin_settings', 'key', pids.map((p) => PKG + p), 'key,value');
    const rm = new Map(recs.map((r) => [String(r.key).slice(PKG.length), r.value as PackageRecord]));
    for (const l of links) {
      const bid = String(l.key).slice(PKGB.length);
      const rec = rm.get(String(l?.value?.package_id));
      if (!rec) continue;
      out.set(bid, {
        id: rec.id, n: Number(l.value.n) || 1, of: Number(l.value.of) || rec.sessions?.length || 1,
        price: Number(rec.price) || 0, list_price: Number(rec.list_price) || 0,
        minutes: Number(rec.minutes) || PACKAGE_MINUTES, category: rec.category || '',
        sessions: Array.isArray(rec.sessions) ? rec.sessions : [],
      });
    }
  } catch (e) {
    console.warn('Paketlar o‘qilmadi:', e instanceof Error ? e.message : e);
  }
  return out;
}

/** Bitta bronning paketi. */
export async function packageOf(bookingId: string): Promise<PackageInfo | null> {
  return (await packagesFor([bookingId])).get(String(bookingId)) || null;
}

/** Bronga qisqa izoh: «5 soatlik paket · 2/3». */
export const packageNote = (n: number, of: number) =>
  of > 1 ? `5 soatlik paket · ${n}/${of}-mashg‘ulot` : '5 soatlik paket · bir kunda';

/** «3 soat», «30 daqiqa», «1 soat 30 daqiqa» */
export function durText(minutes: number): string {
  const m = Math.round(Number(minutes) || 0), h = Math.floor(m / 60), r = m % 60;
  return h ? (r ? `${h} soat ${r} daqiqa` : `${h} soat`) : `${r} daqiqa`;
}

/**
 * Paketni to'liq yaratadi: bandlikni tekshiradi, narxni bo'ladi,
 * bronlarni yozadi va paket yozuvini saqlaydi.
 */
export async function createPackage(o: {
  customerId: string;
  instructorId: string;
  courseId: string | null;
  category: string;
  sessions: Session[];
  status: string;
  source: string;
  extra?: Record<string, unknown>;
  note?: string | null;
  total?: number;
  tariffs: Tariffs;
  prices: PackagePrices;
  newCode: () => Promise<string>;
}): Promise<{ bookings: any[]; record: PackageRecord }> {
  const cat = String(o.category || '').toUpperCase();
  const total = Math.round(Number(o.total ?? packagePriceOf(cat, o.prices)));
  if (!(total > 0)) {
    const e: any = new Error(`${cat || 'Bu'} kategoriyada 5 soatlik paket o‘chirilgan`);
    e.statusCode = 400; throw e;
  }
  const clash = await sessionConflict(o.instructorId, o.customerId, o.sessions);
  if (clash) { const e: any = new Error(clash); e.statusCode = 409; throw e; }

  const parts = shares(total, o.sessions.map((s) => s.minutes));
  const of = o.sessions.length;
  const payloads = o.sessions.map((s, i) => ({
    customer_id: o.customerId,
    instructor_id: o.instructorId,
    course_id: o.courseId,
    booking_date: s.start.toISOString(),
    start_at: s.start.toISOString(),
    end_at: s.end.toISOString(),
    hours: Math.max(1, Math.round(s.minutes / 60)),
    duration_minutes: s.minutes,
    category: cat || null,
    price: parts[i],
    status: o.status,
    source: o.source,
    customer_note: packageNote(i + 1, of) + (o.note ? ` · ${o.note}` : ''),
    ...(o.extra || {}),
  }));
  const bookings = await insertBookings(payloads, o.newCode);
  const record: PackageRecord = {
    id: newPackageId(),
    customer_id: o.customerId,
    instructor_id: o.instructorId,
    category: cat,
    minutes: PACKAGE_MINUTES,
    price: total,
    list_price: computePrice(cat, PACKAGE_MINUTES, o.tariffs),
    source: o.source,
    created_at: new Date().toISOString(),
    sessions: bookings.map((b, i) => ({
      booking_id: String(b.id), start_at: String(b.start_at), minutes: o.sessions[i].minutes,
      price: parts[i], pickup_code: b.pickup_code || null,
    })),
  };
  await savePackage(record);
  return { bookings, record };
}
