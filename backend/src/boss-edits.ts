import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import { selectIn } from './rest-chunks.js';
import { pageAll } from './lesson-ledger.js';
import { rangeFromQuery } from './analytics-routes.js';
import { tashkentYmd } from './lesson-math.js';
import { readBossLink, verifyBossToken, bearer } from './boss-dashboard.js';

/**
 * BOSHLIQ ILOVASI → «TAHRIRLANGANLAR»
 *
 *   GET /api/boss-edits?from=&to=&before=&limit=&src=   (Authorization: Bearer <boss token>)
 *
 * Ikkala tizimdagi hamma tahrir — nima, qachon (soat:daqiqa), kim, eski → yangi:
 *
 *   AVTODROM (shu loyiha, Supabase):
 *     admin_audit_logs — ilova yozadigan amallar (bron holati, ko'chirish, to'lov
 *       qaytarish, narx qo'lda o'zgartirilgan chek, sozlamalar, instruktor, xodim…).
 *       Kundalik ish (kirish, oddiy sotuv, avtomatik yopish…) chiqarilmaydi.
 *     db_changes — bazaning o'zi yozadigan jurnal (trigger, migratsiya
 *       20261106120000_db_changes_audit.sql): admin panel chetlab o'tilgan
 *       tahrirlar ham. Bir tahrir ikkalasiga tushsa (o'sha yozuv, ±15 s) —
 *       bitta qator: ilova amali + bazadagi «eski → yangi».
 *   AVTODROM12 (platniy + avtoshkola): /api/bridge/edits ko'prigi — xuddi shu
 *       usul (change_log + db_changes), o'z sahifalashi bilan.
 *
 * Sahifalash ikkala manba bo'yicha birga: kursor `<vaqt mikrosoniya>|<id>`,
 * eng yangisi birinchi.
 */

const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const q = (v: string) => encodeURIComponent(v);

/* Tahrir emas — kundalik ish yoki avtomatik jarayon */
export const NOISE_ACTIONS = [
  'LOGIN', 'LOGOUT', 'BOSS_LOGIN', 'PAYMENT_RECEIVED', 'MANUAL_BOOKING_CREATED', 'WALK_IN_CREATED',
  'SHIFT_OPENED', 'SHIFT_CLOSED', 'LESSON_AUTO_FINISHED', 'BOOKING_AUTO_LATE', 'BOOKING_FREED_BY_SCAN',
  'BOOKING_TRANSFERRED_BY_SCAN', 'BOOKING_REOPENED_PAID_CHEQUE', 'PRICE_UNLOCK', 'PRICE_PIN_FAIL',
];

const ACTION_LABEL: Record<string, string> = {
  BOOKING_STATUS_CHANGED: 'Bron holati o‘zgartirildi',
  BOOKING_CANCEL_APPROVED: 'Bekor qilish so‘rovi tasdiqlandi',
  BOOKING_CANCEL_REJECTED: 'Bekor qilish so‘rovi rad etildi',
  BOOKING_FORCE_FINISHED: 'Dars qo‘lda yakunlandi',
  BOOKING_REOPENED: 'Bron qayta ochildi',
  BOOKING_SHEET_CANCEL: 'Jadvaldan bron olib tashlandi',
  BOOKING_SHEET_MOVE: 'Bron boshqa vaqtga ko‘chirildi',
  BOOKING_SHEET_SAVED: 'Jadvalda bronlar bekor qilindi',
  PAYMENT_UPDATED: 'To‘lov tahrirlandi',
  PAYMENT_REFUNDED: 'To‘lov qaytarildi',
  CHEQUE_SPLIT: 'Chek bo‘lindi',
  RECEIPT_ISSUED: 'Narx qo‘lda o‘zgartirildi',
  SETTING_UPDATED: 'Sozlama o‘zgartirildi',
  SETTINGS_UPDATED: 'Sozlama o‘zgartirildi',
  INSTRUCTOR_CREATED: 'Instruktor qo‘shildi',
  INSTRUCTOR_UPDATED: 'Instruktor ma’lumoti tahrirlandi',
  INSTRUCTOR_DELETED: 'Instruktor o‘chirildi',
  INSTRUCTOR_DISABLED: 'Instruktor ishdan to‘xtatildi',
  INSTRUCTOR_RESTORED: 'Instruktor qayta yoqildi',
  INSTRUCTOR_SCHEDULE_UPDATED: 'Instruktor ish jadvali o‘zgartirildi',
  INSTRUCTOR_BLOCKS_UPDATED: 'Instruktor band soatlari o‘zgartirildi',
  INSTRUCTOR_PHOTO_SET: 'Instruktor rasmi almashtirildi',
  STAFF_CREATED: 'Xodim qo‘shildi',
  STAFF_UPDATED: 'Xodim ma’lumoti tahrirlandi',
  STAFF_DELETED: 'Xodim o‘chirildi',
  COURSE_CREATED: 'Kurs qo‘shildi',
  COURSE_UPDATED: 'Kurs tahrirlandi',
  REVIEW_MODERATED: 'Sharh ko‘rib chiqildi',
  TELEGRAM_ADMIN_ADD: 'Telegram admin qo‘shildi',
  TELEGRAM_ADMIN_DELETE: 'Telegram admin o‘chirildi',
  PRICE_PIN_SET: 'Narx PIN-kodi o‘zgartirildi',
  MGMT_PIN_SET: 'Boshqaruv PIN-kodi o‘zgartirildi',
  BOSS_PIN_SET: 'Boshliq ilovasi PIN-kodi o‘zgartirildi',
  BOSS_LINK_RESET: 'Boshliq ilovasi havolasi yangilandi',
  REGISTER_PIN_SET: 'Kassa PIN-kodi o‘zgartirildi',
  CONTROL_LINK_RESET: 'Nazorat havolasi yangilandi',
};

/* avtodrom12 change_log amallari */
const A12_ACTION: Record<string, string> = {
  correct: 'Yozuv tuzatildi', split: 'Vaqt bo‘lib yopildi', debt_paid: 'Qarz to‘landi', debt_unpaid: 'Qarz to‘lovi bekor qilindi',
  cleanup: 'Jarayondagilar tozalandi', cleanup_undo: 'Tozalash bekor qilindi', expense_edit: 'Xarajat tahrirlandi',
  expense_delete: 'Xarajat o‘chirildi', delete: 'Hisob o‘chirildi', attach: 'Hisob qo‘shildi', detach: 'Hisob ajratildi',
  post: 'Post almashtirildi', unlock_blocked: 'Maxsus bo‘lim bloklandi', password_change: 'Parol o‘zgartirildi',
  password_set: 'Parol qo‘yildi', password_reset: 'Parol tiklandi', entry_pin_change: 'Kirish kodi o‘zgartirildi',
  attendance_cancel: 'Dars bekor qilindi', attendance_bulk: 'Darslar tahrirlandi', lessons_edit: 'Darslar soni o‘zgartirildi',
  access_extend: 'Kirish muddati uzaytirildi', access_extend_cancel: 'Muddat uzaytirish bekor qilindi',
  access_period: 'Kirish muddati belgilandi', undo_import: 'Import bekor qilindi', group_restore: 'Guruh tiklandi',
};

const TABLE_LABEL: Record<string, string> = {
  bookings: 'Bron', payments: 'To‘lov', users: 'Mijoz', staff: 'Xodim', courses: 'Kurs', cash_registers: 'Kassa',
  cashier_shifts: 'Smena', instructor_profiles: 'Instruktor', admin_settings: 'Sozlama', reviews: 'Sharh',
  telegram_admins: 'Telegram admin',
  sessions: 'Mashina yozuvi', expenses: 'Xarajat', debt_payments: 'Qarz to‘lovi', students: 'O‘quvchi',
  driving_schools: 'Avtoshkola', school_groups: 'Guruh', instructors: 'Instruktor', vehicles: 'Mashina',
  school_vehicles: 'Avtoshkola mashinasi', user_settings: 'Narx sozlamalari', settings: 'Narx sozlamalari',
};

export const SETTING_LABEL: Record<string, string> = {
  rate_a: 'Narx · A toifa (1 soat)', rate_b: 'Narx · B toifa (1 soat)', rate_c: 'Narx · C toifa (1 soat)',
  half_a: 'Narx · A toifa (30 daqiqa)', half_b: 'Narx · B toifa (30 daqiqa)', half_c: 'Narx · C toifa (30 daqiqa)',
  paket5_a: '5 soatlik paket · A', paket5_b: '5 soatlik paket · B', paket5_c: '5 soatlik paket · C',
  tarif3_a: '3 soatlik tarif · A', tarif3_b: '3 soatlik tarif · B', tarif3_c: '3 soatlik tarif · C',
  krug_price: 'Krug narxi', krug_min: 'Krug daqiqasi', test_drive_price: 'Test drive narxi',
  reminder_minutes: 'Eslatma vaqtlari (daqiqa)', work_start: 'Ish boshlanishi', work_end: 'Ish tugashi',
  slot_step_min: 'Bron qadami (daqiqa)', late_cancel_min: 'Kech bekor qilish chegarasi', booking_enabled: 'Onlayn bron',
  location: 'Manzil va xarita', address: 'Manzil', contact_phone: 'Telefon raqamlar', system_name: 'Avtodrom nomi',
  working_hours: 'Ish vaqti matni', about_text: 'Biz haqimizda', facilities: 'Qulayliklar',
  price_pin: 'Narx PIN-kodi', mgmt_pin: 'Boshqaruv PIN-kodi', test_instructors: 'Sinov instruktorlari',
  lesson_price: 'Dars narxi', lesson_duration: 'Dars davomiyligi',
};

type Kind = 'money' | 'time' | 'date' | 'minutes' | 'seconds' | 'bool' | 'secret' | 'status' | 'text';
const COL: Record<string, [string, Kind?]> = {
  status: ['Holat', 'status'], price: ['Narx', 'money'], amount: ['Summa', 'money'], cash_amount: ['Naqd', 'money'],
  card_amount: ['Karta', 'money'], terminal_amount: ['Terminal', 'money'], click_amount: ['Click', 'money'],
  debt_amount: ['Qarz', 'money'], paid_amount: ['To‘langan', 'money'], deposit_amount: ['Zaklad', 'money'],
  hourly_rate: ['Soatlik narx', 'money'], minimum_payment: ['Minimal to‘lov', 'money'],
  counted_cash: ['Sanalgan naqd', 'money'], expected_cash: ['Kutilgan naqd', 'money'], difference: ['Farq', 'money'],
  opening_cash: ['Boshlang‘ich naqd', 'money'], contract_price: ['Shartnoma narxi', 'money'],
  start_at: ['Boshlanish', 'time'], end_at: ['Tugash', 'time'], booking_date: ['Bron vaqti', 'time'],
  arrived_at: ['Kelgan vaqti', 'time'], departed_at: ['Ketgan vaqti', 'time'], started_at: ['Boshlangan', 'time'],
  finished_at: ['Tugagan', 'time'], deleted_at: ['O‘chirilgan', 'time'], paid_at: ['To‘langan vaqti', 'time'],
  refunded_at: ['Qaytarilgan vaqti', 'time'], closed_at: ['Yopilgan', 'time'], opened_at: ['Ochilgan', 'time'],
  confirmed_at: ['Tasdiqlangan', 'time'], cancelled_at: ['Bekor qilingan', 'time'], frozen_at: ['Muzlatilgan', 'time'],
  access_until: ['Kirish muddati', 'time'], spent_on: ['Sana', 'date'],
  duration_minutes: ['Davomiylik', 'minutes'], duration_seconds: ['Davomiylik', 'seconds'], hours: ['Soat'],
  instructor_id: ['Instruktor'], customer_id: ['Mijoz'], course_id: ['Kurs'], vehicle_id: ['Mashina'],
  student_id: ['O‘quvchi'], group_id: ['Guruh'], school_id: ['Avtoshkola'], register_id: ['Kassa'],
  category: ['Toifa'], method: ['To‘lov usuli'], pay_method: ['To‘lov usuli'], receipt_code: ['Chek'],
  note: ['Izoh'], refund_reason: ['Qaytarish sababi'], refunded_by: ['Kim qaytardi'], full_name: ['Ism'],
  phone: ['Telefon'], login: ['Login'], username: ['Login'], role: ['Rol'], password_hash: ['Parol', 'secret'],
  pin_hash: ['PIN', 'secret'], is_active: ['Faol', 'bool'], is_blocked: ['Bloklangan', 'bool'],
  is_available: ['Ishlaydi', 'bool'], is_verified: ['Tasdiqlangan', 'bool'], active: ['Faol', 'bool'],
  name: ['Nomi'], value: ['Qiymat'], calculation_mode: ['Hisoblash usuli'], label: ['Raqam'], plate: ['Davlat raqami'],
  person: ['Kim'], liters: ['Litr'], contract_lessons: ['Shartnoma darslari'], lessons_total: ['Darslar'],
  bio: ['Tavsif'], experience_years: ['Tajriba (yil)'], vehicle_model: ['Mashina'], vehicle_plate: ['Davlat raqami'],
  categories: ['Toifalar'], photo_url: ['Rasm'], avatar_url: ['Rasm'], avatar_path: ['Rasm'], description: ['Tavsif'],
  rating: ['Baho'], comment: ['Sharh'], admin_note: ['Admin izohi'], customer_note: ['Izoh'],
  cancellation_reason: ['Bekor qilish sababi'], cashier_name: ['Kassir'], code: ['Kod'], post: ['Post'],
  driver_name: ['Haydovchi'], instructor_name: ['Instruktor'], school_name: ['Avtoshkola'], group_name: ['Guruh'],
};
const STATUS: Record<string, string> = {
  pending: 'Kutilmoqda', confirmed: 'Tasdiqlangan', in_progress: 'Darsda', completed: 'Tugagan', cancelled: 'Bekor qilingan',
  no_show: 'Kelmadi', rejected: 'Rad etilgan', paid: 'To‘langan', refunded: 'Qaytarilgan', active: 'Faol', frozen: 'Muzlatilgan',
  waiting: 'Kutmoqda', approved: 'Tasdiqlangan', hidden: 'Yashirilgan', deleted: 'O‘chirilgan', open: 'Ochiq', closed: 'Yopiq',
};
const ROLE: Record<string, string> = { admin: 'admin', cashier: 'kassir', operator: 'operator', instructor: 'instruktor', customer: 'mijoz' };

/* Matn ichidagi qiymatni ko'rinishga keltirish uchun tur */
function kindOf(col: string, v: unknown, tbl: string, rowKey?: string | null): Kind {
  const c = COL[col]?.[1];
  if (c) return c;
  if (v === '***') return 'secret';
  if (typeof v === 'boolean') return 'bool';
  if (col === 'value' && tbl === 'admin_settings') {
    if (rowKey && /pin/.test(rowKey)) return 'secret';
    if (rowKey && /(rate_|half_|paket|tarif|price)/.test(rowKey)) return 'money';
  }
  if (/_at$/.test(col)) return 'time';
  if (/(amount|price|sum|total)$/.test(col)) return 'money';
  return 'text';
}
/* admin_settings qiymati ko'pincha {"value": X} — ichini olamiz */
const unwrap = (v: any) => (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && 'value' in v ? v.value : v);
const short = (v: any) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.length > 300 ? v.slice(0, 300) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  const s = JSON.stringify(v);
  return s.length > 300 ? s.slice(0, 300) + '…' : v;
};

export type EditField = { col: string; label: string; kind: Kind; old: any; new: any; old_name?: string | null; new_name?: string | null };
export type EditItem = {
  id: string; at: string; source: 'avtodrom' | 'avtodrom12'; kind: 'log' | 'db';
  table: string | null; op: 'update' | 'delete' | null; action: string | null; action_label: string;
  title: string; note: string | null; fields: EditField[]; reason: string | null;
  actor: string | null; actor_role: string | null; bulk: number; deleted: boolean; money: boolean;
};

/* Vaqt — mikrosoniyagacha, UTC, bir xil ko'rinish (kursor uchun matn solishtiriladi) */
export function usIso(s: unknown): string {
  const str = String(s || '');
  const m = /^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]00(?::?00)?)?$/.exec(str);
  if (m) return `${m[1]}T${m[2]}.${(m[3] || '').padEnd(6, '0').slice(0, 6)}Z`;
  const t = Date.parse(str);
  return Number.isFinite(t) ? new Date(t).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z') : '1970-01-01T00:00:00.000000Z';
}
const before = (a: { at: string; id: string }, cur: { at: string; id: string } | null) =>
  !cur || a.at < cur.at || (a.at === cur.at && a.id < cur.id);
const cmpDesc = (a: { at: string; id: string }, b: { at: string; id: string }) =>
  (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
const parseCursor = (v: unknown) => {
  const s = String(v || '');
  const i = s.indexOf('|');
  if (i < 0) return null;
  const at = s.slice(0, i), id = s.slice(i + 1);
  return Number.isFinite(Date.parse(at)) ? { at: usIso(at), id } : null;
};
const hm = (iso: string) => {
  const d = new Date(Date.parse(iso) + 5 * 3600e3);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};
const money = (v: unknown) => `${String(Math.round(n(v))).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')} so‘m`;

/* ------------------------------------------------------------------ */
/* Avtodrom: xom qatorlar                                              */
/* ------------------------------------------------------------------ */
type Raw = { audits: any[]; db: any[]; warnings: Array<{ section: string; error: string }> };

async function safe<T>(warnings: Raw['warnings'], section: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch (e: any) {
    warnings.push({ section, error: String(e?.message || e).slice(0, 200) });
    return fallback;
  }
}

/** Ilova amali tahrirmi (shovqin emas) */
export function auditIsEdit(a: any): boolean {
  const act = String(a?.action || '');
  if (NOISE_ACTIONS.includes(act)) return false;
  if (act === 'RECEIPT_ISSUED') {
    const po = a?.new_data?.price_override;
    return !!po && n(po.total) !== n(po.expected);
  }
  if (act === 'BOOKING_SHEET_SAVED') return Array.isArray(a?.new_data?.cancelled) && a.new_data.cancelled.length > 0;
  return true;
}

async function rawAvtodrom(from: Date, to: Date): Promise<Raw> {
  const warnings: Raw['warnings'] = [];
  const range = `created_at=gte.${q(from.toISOString())}&created_at=lt.${q(to.toISOString())}`;
  const hard = NOISE_ACTIONS.map(q).join(',');
  const [audits, db] = await Promise.all([
    safe(warnings, 'audit', () => pageAll<any>('admin_audit_logs',
      `?select=id,admin_id,action,entity_type,entity_id,old_data,new_data,created_at,staff_id,staff_login&${range}&action=not.in.(${hard})&order=created_at.desc,id.desc`, 20000), [] as any[]),
    safe(warnings, 'db_changes', () => pageAll<any>('db_changes',
      `?select=id,at,tbl,op,row_id,actor,changes,n_rows&at=gte.${q(from.toISOString())}&at=lt.${q(to.toISOString())}&order=at.desc,id.desc`, 20000), [] as any[]),
  ]);
  return { audits: audits.filter(auditIsEdit), db, warnings };
}

/* Ilova amali qaysi jadval/qatorga tegishli */
const auditKey = (a: any) => {
  const rid = a.entity_id || a.new_data?.entity_key || null;
  return rid ? `${a.entity_type}|${rid}` : null;
};

/** Ilova amali + bazadagi o'zgarish juftlari (o'sha yozuv, ±15 s) */
function pairUp(raw: Raw) {
  const byKey = new Map<string, any[]>();
  for (const d of raw.db) {
    if (!d.row_id) continue;
    const k = `${d.tbl}|${d.row_id}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(d);
  }
  const used = new Set<string>();
  const pairs: Array<{ a: any | null; d: any | null }> = [];
  for (const a of raw.audits) {
    const k = auditKey(a);
    let best: any = null, bestGap = Infinity;
    const t = Date.parse(a.created_at);
    for (const d of (k && byKey.get(k)) || []) {
      if (used.has(String(d.id))) continue;
      const gap = Math.abs(Date.parse(d.at) - t);
      if (gap <= 15000 && gap < bestGap) { best = d; bestGap = gap; }
    }
    if (best) used.add(String(best.id));
    pairs.push({ a, d: best });
  }
  for (const d of raw.db) if (!used.has(String(d.id))) pairs.push({ a: null, d });
  return pairs;
}

const pairAt = (p: { a: any; d: any }) => usIso(p.a ? p.a.created_at : p.d.at);
const pairId = (p: { a: any; d: any }) => (p.a ? `a:${p.a.id}` : `adb:${String(p.d.id).padStart(12, '0')}`);
const pairDeleted = (p: { a: any; d: any }) =>
  (p.d && p.d.op === 'D') || /(DELETE|CANCEL|REFUND)/.test(String(p.a?.action || '')) || p.a?.new_data?.status === 'cancelled';
const pairMoney = (p: { a: any; d: any }) => {
  const t = p.a?.entity_type || p.d?.tbl;
  if (t === 'payments') return true;
  if (/(PAYMENT|CHEQUE|RECEIPT|PRICE)/.test(String(p.a?.action || ''))) return true;
  const ch = p.d?.op === 'U' && p.d?.changes ? Object.keys(p.d.changes) : [];
  if (ch.some((c) => kindOf(c, null, t, p.d?.row_id) === 'money')) return true;
  return t === 'admin_settings' && /(rate_|half_|paket|tarif|price)/.test(String(p.d?.row_id || p.a?.new_data?.entity_key || ''));
};

/* ------------------------------------------------------------------ */
/* Nomlar                                                              */
/* ------------------------------------------------------------------ */
type Names = {
  staffById: Map<string, any>; staffByLogin: Map<string, any>; users: Map<string, any>; usersByTg: Map<string, any>;
  bookings: Map<string, any>; payments: Map<string, any>; instructors: Map<string, string>; courses: Map<string, string>;
  registers: Map<string, string>; shifts: Map<string, any>;
};

async function resolveNames(pairs: Array<{ a: any; d: any }>, warnings: Raw['warnings']): Promise<Names> {
  const ids = { bookings: new Set<string>(), payments: new Set<string>(), ins: new Set<string>(), users: new Set<string>(), tg: new Set<string>(), shifts: new Set<string>() };
  const add = (set: Set<string>, v: unknown) => { if (v && /^[\w-]{1,64}$/.test(String(v))) set.add(String(v)); };
  for (const { a, d } of pairs) {
    const tbl = a?.entity_type || d?.tbl;
    const rid = a?.entity_id || d?.row_id;
    if (tbl === 'bookings') add(ids.bookings, rid);
    if (tbl === 'payments') add(ids.payments, rid);
    if (tbl === 'instructor_profiles') add(ids.ins, rid);
    if (tbl === 'users') add(ids.users, rid);
    if (tbl === 'cashier_shifts') add(ids.shifts, rid);
    for (const k of ['instructor', 'instructor_id']) { add(ids.ins, a?.old_data?.[k]); add(ids.ins, a?.new_data?.[k]); }
    if (d?.op === 'U' && d.changes) for (const [col, pair] of Object.entries<any>(d.changes)) {
      const vals = Array.isArray(pair) ? pair : [pair];
      for (const v of vals) {
        if (col === 'instructor_id') add(ids.ins, v);
        if (col === 'customer_id') add(ids.users, v);
      }
    }
    if (d?.op === 'D' && d.changes) { add(ids.users, d.changes.customer_id); add(ids.ins, d.changes.instructor_id); }
    const tag = String(d?.actor || '');
    if (tag.startsWith('tg:')) ids.tg.add(tag.slice(3));
  }
  const W = <T>(section: string, fn: () => Promise<T>, fb: T) => safe(warnings, `names_${section}`, fn, fb);
  const [staff, bookings, payments, insRows, courses, registers, shifts] = await Promise.all([
    W('staff', () => supabaseRest<any[]>('staff', { query: '?select=id,login,full_name,role&limit=500' }), [] as any[]),
    W('bookings', () => selectIn<any>('bookings', 'id', [...ids.bookings], 'id,customer_id,start_at,booking_date,instructor_id,instructor_name,status,price'), [] as any[]),
    W('payments', () => selectIn<any>('payments', 'id', [...ids.payments], 'id,receipt_code,amount,booking_id,customer_id'), [] as any[]),
    W('instructors', () => selectIn<any>('instructor_profiles', 'id', [...ids.ins], 'id,user_id'), [] as any[]),
    W('courses', () => supabaseRest<any[]>('courses', { query: '?select=id,name&limit=500' }), [] as any[]),
    W('registers', () => supabaseRest<any[]>('cash_registers', { query: '?select=id,code,name&limit=100' }), [] as any[]),
    W('shifts', () => selectIn<any>('cashier_shifts', 'id', [...ids.shifts], 'id,register_id,opened_at,cashier_name'), [] as any[]),
  ]);
  for (const b of bookings) add(ids.users, b.customer_id);
  for (const p of payments) add(ids.users, p.customer_id);
  for (const r of insRows) add(ids.users, r.user_id);
  const [users, usersByTg] = await Promise.all([
    W('users', () => selectIn<any>('users', 'id', [...ids.users], 'id,full_name,phone'), [] as any[]),
    W('users_tg', () => selectIn<any>('users', 'telegram_id', [...ids.tg], 'id,full_name,telegram_id,role'), [] as any[]),
  ]);
  const um = new Map(users.map((u: any) => [String(u.id), u]));
  return {
    staffById: new Map(staff.map((s: any) => [String(s.id), s])),
    staffByLogin: new Map(staff.map((s: any) => [String(s.login).toLowerCase(), s])),
    users: um,
    usersByTg: new Map(usersByTg.map((u: any) => [String(u.telegram_id), u])),
    bookings: new Map(bookings.map((b: any) => [String(b.id), b])),
    payments: new Map(payments.map((p: any) => [String(p.id), p])),
    instructors: new Map(insRows.map((r: any) => [String(r.id), String(um.get(String(r.user_id))?.full_name || '')]).filter(([, v]) => v) as Array<[string, string]>),
    courses: new Map(courses.map((c: any) => [String(c.id), String(c.name || '')])),
    registers: new Map(registers.map((r: any) => [String(r.id), String(r.name || r.code || '')])),
    shifts: new Map(shifts.map((s: any) => [String(s.id), s])),
  };
}

function refName(col: string, v: unknown, names: Names): string | null {
  if (v === null || v === undefined || v === '') return null;
  const k = String(v);
  if (col === 'instructor_id' || col === 'instructor') return names.instructors.get(k) || null;
  if (col === 'customer_id') { const u = names.users.get(k); return u ? String(u.full_name || u.phone || '') || null : null; }
  if (col === 'course_id') return names.courses.get(k) || null;
  if (col === 'register_id') return names.registers.get(k) || null;
  return null;
}

function staffName(s: any) {
  if (!s) return null;
  const name = String(s.full_name || s.login || '').trim();
  const role = ROLE[String(s.role || '')];
  return { name: name || null, role: role || null };
}

function actorOf(a: any, d: any, names: Names): { actor: string | null; role: string | null } {
  if (a?.staff_id && names.staffById.has(String(a.staff_id))) { const s = staffName(names.staffById.get(String(a.staff_id))); if (s?.name) return { actor: s.name, role: s.role }; }
  const login = a?.staff_login || (typeof a?.new_data?.by === 'string' ? a.new_data.by : null) || (typeof a?.new_data?.staff === 'string' ? a.new_data.staff : null);
  if (login) {
    const s = staffName(names.staffByLogin.get(String(login).toLowerCase()));
    return { actor: s?.name || String(login), role: s?.role || null };
  }
  const tag = String(d?.actor || '');
  if (tag.startsWith('s:')) { const s = staffName(names.staffById.get(tag.slice(2))); return { actor: s?.name || 'Xodim', role: s?.role || null }; }
  if (tag.startsWith('l:')) { const l = tag.slice(2); const s = staffName(names.staffByLogin.get(l.toLowerCase())); return { actor: s?.name || l, role: s?.role || (l === String(process.env.ADMIN_LOGIN || '') ? 'admin' : null) }; }
  if (tag.startsWith('tg:')) { const u = names.usersByTg.get(tag.slice(3)); return { actor: u?.full_name || `Telegram ${tag.slice(3)}`, role: ROLE[String(u?.role || '')] || 'Telegram' }; }
  if (a?.admin_id) return { actor: 'Admin panel', role: null };
  return { actor: null, role: null };
}

function titleOf(tbl: string, rid: string | null, a: any, d: any, names: Names): string {
  const snap = d?.op === 'D' ? d.changes || {} : {};
  const nd = a?.new_data || {}, od = a?.old_data || {};
  switch (tbl) {
    case 'bookings': {
      const b = (rid && names.bookings.get(rid)) || snap;
      const cust = refName('customer_id', b?.customer_id, names);
      const when = b?.start_at || b?.booking_date || od.start;
      const code = nd.code || od.code || nd.new_code;
      return [cust || 'Bron', when ? hm(String(when)) : '', code ? String(code) : ''].filter(Boolean).join(' · ');
    }
    case 'payments': {
      const p = (rid && names.payments.get(rid)) || snap;
      const code = p?.receipt_code || nd.receipt_code;
      const amt = p?.amount ?? nd.amount;
      return [code ? `Chek ${code}` : 'To‘lov', amt != null ? money(amt) : ''].filter(Boolean).join(' · ');
    }
    case 'instructor_profiles': return (rid && names.instructors.get(rid)) || nd.full_name || 'Instruktor';
    case 'staff': {
      const s = (rid && names.staffById.get(rid)) || snap;
      return String(s?.full_name || s?.login || nd.login || nd.full_name || 'Xodim');
    }
    case 'admin_settings': return SETTING_LABEL[String(rid)] || String(rid || 'Sozlama');
    case 'courses': return (rid && names.courses.get(rid)) || snap.name || nd.name || 'Kurs';
    case 'users': { const u = (rid && names.users.get(rid)) || snap; return String(u?.full_name || u?.phone || 'Mijoz'); }
    case 'cash_registers': return (rid && names.registers.get(rid)) || snap.name || 'Kassa';
    case 'cashier_shifts': {
      const s = (rid && names.shifts.get(rid)) || snap;
      return ['Smena', names.registers.get(String(s?.register_id)) || '', s?.opened_at ? hm(String(s.opened_at)).slice(0, 5) : ''].filter(Boolean).join(' · ');
    }
    default: return TABLE_LABEL[tbl] || tbl;
  }
}

/* Ilova yozuvidan «eski → yangi» (bazadagi o'zgarish bo'lmasa) */
const META = new Set(['by', 'entity_key', 'updated_at', 'manual', 'reason', 'ua', 'role', 'staff', 'at', 'pin_changed', 'code', 'new_code', 'new_id', 'cells', 'date', 'errors', 'created', 'cancelled']);
const WD = ['Yakshanba', 'Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba'];
const dayPlan = (x: any) => (!x ? 'odatiy' : x.off ? 'dam olish'
  : Array.isArray(x.closed) && x.closed.length ? x.closed.map((r: any) => (Array.isArray(r) ? r.join('–') : String(r))).join(', ') + ' yopiq' : 'to‘liq ish kuni');
const asObj = (x: any) => (x === null || x === undefined ? null : typeof x !== 'object' || Array.isArray(x) ? { value: x } : x);

function auditFields(a: any, names: Names): { fields: EditField[]; note: string | null } {
  const od = asObj(a.old_data);
  const nd = asObj(a.new_data);
  const tbl = String(a.entity_type || '');
  const act = String(a.action || '');
  if (act === 'RECEIPT_ISSUED' && nd?.price_override) {
    return { fields: [{ col: 'price', label: 'Narx', kind: 'money', old: n(nd.price_override.expected), new: n(nd.price_override.total) }],
      note: [nd.receipt_code ? `Chek ${nd.receipt_code}` : '', nd.register ? `kassa ${nd.register}` : ''].filter(Boolean).join(' · ') || null };
  }
  if (act === 'BOOKING_SHEET_MOVE' && od && nd) {
    const to = nd.to_date && nd.to_h != null ? `${String(nd.to_date).slice(8, 10)}.${String(nd.to_date).slice(5, 7)} ${String(nd.to_h).padStart(2, '0')}:00` : null;
    const f: EditField[] = [{ col: 'start_at', label: 'Vaqt', kind: 'text', old: od.start ? hm(String(od.start)) : null, new: to }];
    if (od.instructor !== nd.instructor) f.push({ col: 'instructor_id', label: 'Instruktor', kind: 'text', old: od.instructor, new: nd.instructor, old_name: refName('instructor', od.instructor, names), new_name: refName('instructor', nd.instructor, names) });
    return { fields: f, note: [od.code, nd.new_code].filter(Boolean).join(' → ') || null };
  }
  if (act === 'BOOKING_SHEET_SAVED' && nd) {
    const c = Array.isArray(nd.cancelled) ? nd.cancelled : [];
    return { fields: [], note: `${c.length} ta bron bekor qilindi${nd.date ? ` (${String(nd.date).slice(8, 10)}.${String(nd.date).slice(5, 7)})` : ''}${c.length ? ': ' + c.slice(0, 5).map((x: any) => x?.code || x).filter(Boolean).join(', ') : ''}` };
  }
  if (act === 'INSTRUCTOR_SCHEDULE_UPDATED' && (od || nd)) {
    const ow = od?.week || {}, nw = nd?.week || {};
    const f: EditField[] = [];
    for (const k of ['1', '2', '3', '4', '5', '6', '0']) {
      const a1 = dayPlan(ow[k]), b1 = dayPlan(nw[k]);
      if (a1 !== b1) f.push({ col: `week_${k}`, label: WD[Number(k)], kind: 'text', old: a1, new: b1 });
    }
    const dates = new Set([...Object.keys(od?.dates || {}), ...Object.keys(nd?.dates || {})]);
    const changedDates = [...dates].filter((d) => JSON.stringify(od?.dates?.[d] ?? null) !== JSON.stringify(nd?.dates?.[d] ?? null));
    return { fields: f, note: changedDates.length ? `Alohida kunlar: ${changedDates.slice(0, 6).map((d) => `${d.slice(8, 10)}.${d.slice(5, 7)}`).join(', ')}` : null };
  }
  if (act === 'INSTRUCTOR_BLOCKS_UPDATED') return { fields: [], note: 'Band (yopiq) soatlari o‘zgartirildi' };
  if (act === 'CHEQUE_SPLIT' && nd) {
    return { fields: [], note: `${nd.receipt_code || 'Chek'} → ${Array.isArray(nd.into) ? nd.into.length : '?'} ta chek${Array.isArray(nd.amounts) ? ' (' + nd.amounts.map((x: any) => money(x)).join(', ') + ')' : ''}` };
  }
  const fields: EditField[] = [];
  if (od || (nd && (act === 'SETTING_UPDATED'))) {
    const keys = new Set([...Object.keys(od || {}), ...Object.keys(nd || {})]);
    for (const k of keys) {
      if (META.has(k)) continue;
      const ov = od ? od[k] : undefined, nv = nd ? nd[k] : undefined;
      if (od && !(k in od) && act !== 'SETTING_UPDATED') continue;
      if (JSON.stringify(ov ?? null) === JSON.stringify(nv ?? null)) continue;
      const col = k === 'active' ? 'is_available' : k === 'instructor' ? 'instructor_id' : k;
      fields.push({ col, label: COL[col]?.[0] || (k === 'value' ? 'Qiymat' : k), kind: kindOf(col, nv ?? ov, tbl, a.new_data?.entity_key),
        old: short(unwrap(ov ?? null)), new: short(unwrap(nv ?? null)), old_name: refName(col, ov, names), new_name: refName(col, nv, names) });
    }
  }
  return { fields: fields.slice(0, 12), note: null };
}

function dbFields(d: any, names: Names): EditField[] {
  if (!d || d.op !== 'U' || !d.changes) return [];
  const out: EditField[] = [];
  for (const [col, pair] of Object.entries<any>(d.changes)) {
    const [ov, nv] = Array.isArray(pair) ? pair : [null, pair];
    const o = d.tbl === 'admin_settings' && col === 'value' ? unwrap(ov) : ov;
    const v = d.tbl === 'admin_settings' && col === 'value' ? unwrap(nv) : nv;
    out.push({ col, label: COL[col]?.[0] || col, kind: kindOf(col, v ?? o, d.tbl, d.row_id), old: short(o), new: short(v),
      old_name: refName(col, ov, names), new_name: refName(col, nv, names) });
  }
  return out;
}

function dbActionLabel(d: any): string {
  const t = TABLE_LABEL[d.tbl] || d.tbl;
  if (d.op === 'D') return `${t} o‘chirildi`;
  if (n(d.n_rows) > 1) return `${t}: ${n(d.n_rows)} ta yozuv birdaniga o‘zgartirildi`;
  if (d.tbl === 'admin_settings') return 'Sozlama o‘zgartirildi';
  if (d.tbl === 'users') return 'Mijoz ma’lumoti o‘zgartirildi';
  if (d.tbl === 'bookings' && d.changes?.status) return 'Yopilgan bron o‘zgartirildi';
  return `${t} tahrirlandi`;
}

function shapePair(p: { a: any; d: any }, names: Names): EditItem {
  const { a, d } = p;
  const tbl = String(a?.entity_type || d?.tbl || '');
  const rid = a?.entity_id || a?.new_data?.entity_key || d?.row_id || null;
  const af = a ? auditFields(a, names) : { fields: [], note: null };
  const df = dbFields(d, names);
  const who = actorOf(a, d, names);
  const reason = a ? (a.new_data?.reason || a.old_data?.reason || a.new_data?.refund_reason || null) : null;
  return {
    id: pairId(p), at: pairAt(p), source: 'avtodrom', kind: a ? 'log' : 'db', table: tbl || null,
    op: d ? (d.op === 'D' ? 'delete' : 'update') : null,
    action: a ? String(a.action) : null,
    action_label: a ? ACTION_LABEL[String(a.action)] || String(a.action).toLowerCase().replace(/_/g, ' ') : dbActionLabel(d),
    title: titleOf(tbl, rid ? String(rid) : null, a, d, names),
    note: af.note,
    fields: df.length ? df : af.fields,
    reason: reason ? String(reason).slice(0, 300) : null,
    actor: who.actor, actor_role: who.role,
    bulk: d && n(d.n_rows) > 1 ? n(d.n_rows) : 0,
    deleted: pairDeleted(p), money: pairMoney(p),
  };
}

/* ------------------------------------------------------------------ */
/* avtodrom12 ko'prigi                                                 */
/* ------------------------------------------------------------------ */
export async function fetchEditsBridge(fromYmd: string, toYmd: string, cursor: string | null, limit: number) {
  const base = String(process.env.AVTODROM12_URL || process.env.SCHOOL_RECEIPT_URL || '').replace(/\/+$/, '');
  const key = String(process.env.RECEIPT_SHARED_KEY || '');
  if (!base || !key) return { ok: false, error: 'avtodrom12 ulanmagan' } as any;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`${base}/api/bridge/edits?from=${q(fromYmd)}&to=${q(toYmd)}&limit=${limit}${cursor ? `&before=${q(cursor)}` : ''}`, {
      headers: { 'X-Receipt-Key': key, Accept: 'application/json' }, signal: ctrl.signal,
    });
    let d: any = null;
    try { d = await r.json(); } catch { /* JSON emas */ }
    if (r.ok && d?.ok) return d;
    return { ok: false, error: r.status === 404 ? 'avtodrom12 yangilanmagan (api/edits-log.js yo‘q)' : d?.error || `avtodrom12 javobi: ${r.status}` };
  } catch (e: any) {
    return { ok: false, error: e?.name === 'AbortError' ? 'avtodrom12 15 soniyada javob bermadi' : `avtodrom12 ga ulanib bo‘lmadi: ${e?.message || e}` };
  } finally { clearTimeout(timer); }
}

const A12_TABLE: Record<string, string> = { session: 'sessions', expense: 'expenses', student: 'students', group: 'school_groups', school: 'driving_schools', instructor: 'instructors' };

export function shapeA12(it: any): EditItem {
  const tbl = String(it.table || A12_TABLE[String(it.entity || '')] || it.entity || '');
  const fields: EditField[] = (Array.isArray(it.fields) ? it.fields : []).map((f: any) => ({
    col: String(f.col), label: COL[String(f.col)]?.[0] || String(f.col), kind: kindOf(String(f.col), f.new ?? f.old, tbl),
    old: short(f.old), new: short(f.new), old_name: f.old_name || null, new_name: f.new_name || null,
  }));
  /* change_log yozuvining o'zi (bazadagi diff bo'lmasa) */
  if (!fields.length && it.kind === 'log' && (it.old != null || it.new != null)) {
    fields.push({ col: String(it.field || 'value'), label: COL[String(it.field || '')]?.[0] || String(it.field || 'Qiymat'), kind: 'text', old: short(it.old), new: short(it.new) });
  }
  const act = it.action ? String(it.action) : null;
  const del = it.op === 'delete' || /(delete|cancel)/.test(String(act || '')) || fields.some((f) => f.col === 'deleted_at' && f.new != null && f.old == null);
  const label = act ? A12_ACTION[act] || act.replace(/_/g, ' ')
    : it.op === 'delete' ? `${TABLE_LABEL[tbl] || tbl} o‘chirildi`
    : n(it.bulk) > 1 ? `${TABLE_LABEL[tbl] || tbl}: ${n(it.bulk)} ta yozuv birdaniga o‘zgartirildi`
    : `${TABLE_LABEL[tbl] || tbl} tahrirlandi`;
  return {
    id: String(it.id), at: usIso(it.at), source: 'avtodrom12', kind: it.kind === 'log' ? 'log' : 'db', table: tbl || null,
    op: it.op === 'delete' ? 'delete' : it.op === 'update' ? 'update' : null, action: act, action_label: label,
    title: String(it.title || TABLE_LABEL[tbl] || 'Yozuv'), note: null, fields,
    reason: it.reason ? String(it.reason).slice(0, 300) : null, actor: it.actor || null, actor_role: null,
    bulk: n(it.bulk), deleted: del,
    money: ['sessions', 'expenses', 'debt_payments', 'user_settings', 'settings'].includes(tbl) && (fields.some((f) => f.kind === 'money') || ['expenses', 'debt_payments'].includes(tbl) || /debt|split/.test(String(act || ''))),
  };
}

/* ------------------------------------------------------------------ */
/* Yig'ish                                                             */
/* ------------------------------------------------------------------ */
const dayOf = (iso: string) => tashkentYmd(iso);

/** Boshliq bosh sahifasi uchun: davrdagi tahrirlar soni (Avtodrom qismi) */
export async function avtodromEditsSummary(from: Date, to: Date) {
  const raw = await rawAvtodrom(from, to);
  const pairs = pairUp(raw);
  let deleted = 0, money_ = 0, last: string | null = null;
  for (const p of pairs) {
    if (pairDeleted(p)) deleted++;
    if (pairMoney(p)) money_++;
    const at = pairAt(p);
    if (!last || at > last) last = at;
  }
  return { total: pairs.length, deleted, money: money_, last_at: last, warnings: raw.warnings };
}

export async function buildBossEdits(query: any) {
  const range = rangeFromQuery(query);
  const { from, to } = range;
  const fromYmd = range.fromYmd || tashkentYmd(from.toISOString());
  const toYmd = range.toYmd || tashkentYmd(new Date(to.getTime() - 1).toISOString());
  const limit = Math.max(5, Math.min(200, Math.trunc(Number(query?.limit)) || 60));
  const cur = parseCursor(query?.before);
  const src = ['avtodrom', 'avtodrom12'].includes(String(query?.src)) ? String(query.src) : 'all';
  const wantA = src !== 'avtodrom12', wantB = src !== 'avtodrom';

  const [raw, a12] = await Promise.all([
    wantA ? rawAvtodrom(from, to) : Promise.resolve<Raw>({ audits: [], db: [], warnings: [] }),
    wantB ? fetchEditsBridge(fromYmd, toYmd, cur ? `${cur.at}|${cur.id}` : null, limit) : Promise.resolve(null),
  ]);
  const pairs = pairUp(raw).map((p) => ({ p, at: pairAt(p), id: pairId(p) })).sort(cmpDesc);

  /* Kunlar bo'yicha — butun davr (sahifadan qat'i nazar) */
  const days = new Map<string, { day: string; n: number; avtodrom: number; avtodrom12: number; deleted: number }>();
  const dayRow = (d: string) => { if (!days.has(d)) days.set(d, { day: d, n: 0, avtodrom: 0, avtodrom12: 0, deleted: 0 }); return days.get(d)!; };
  let aDeleted = 0, aMoney = 0;
  for (const x of pairs) {
    const r = dayRow(dayOf(x.at)); r.n++; r.avtodrom++;
    if (pairDeleted(x.p)) { r.deleted++; aDeleted++; }
    if (pairMoney(x.p)) aMoney++;
  }
  const a12ok = !!a12?.ok;
  for (const d of (a12ok && Array.isArray(a12.days) ? a12.days : [])) {
    const r = dayRow(String(d.day)); r.n += n(d.n); r.avtodrom12 += n(d.n); r.deleted += n(d.deleted);
  }

  /* Sahifa: Avtodrom (kursordan keyingilar) + avtodrom12 sahifasi → birga, eng yangisi birinchi */
  const aPage = pairs.filter((x) => before(x, cur)).slice(0, limit + 1);
  const bItems: EditItem[] = a12ok ? (a12.items || []).map(shapeA12) : [];
  const merged = [...aPage.map((x) => ({ at: x.at, id: x.id, a: x })), ...bItems.map((b) => ({ at: b.at, id: b.id, b }))].sort(cmpDesc);
  const page = merged.slice(0, limit);
  /* Yana bor: ko'rsatilmagan nomzod qoldi yoki avtodrom12 ning keyingi sahifasi bor
     (u holda keyingi so'rov shu sahifaning oxiridan ikkala manbadan davom etadi) */
  const more = merged.length > limit || (a12ok && !!a12.next_before);
  const names = await resolveNames(page.filter((x) => 'a' in x).map((x: any) => x.a.p), raw.warnings);
  const items: EditItem[] = page.map((x: any) => ('a' in x ? shapePair(x.a.p, names) : x.b));
  const last = page[page.length - 1];

  const a12total = a12ok ? n(a12.total) : 0;
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    period: range.period, label: range.label, from: from.toISOString(), to: to.toISOString(), from_day: fromYmd, to_day: toYmd,
    src,
    totals: {
      total: pairs.length + a12total,
      avtodrom: pairs.length, avtodrom12: a12total,
      deleted: aDeleted + (a12ok ? n(a12.deleted) : 0),
      money: aMoney,
    },
    days: [...days.values()].sort((x, y) => x.day.localeCompare(y.day)),
    items,
    next_before: more && last ? `${last.at}|${last.id}` : null,
    sources: {
      avtodrom: wantA ? { ok: !raw.warnings.some((w) => w.section === 'audit'), warnings: raw.warnings } : null,
      avtodrom12: wantB ? (a12ok ? { ok: true, warnings: a12.warnings || [] } : { ok: false, error: a12?.error || 'avtodrom12 javob bermadi' }) : null,
    },
  };
}

export async function registerBossEditsRoutes(app: FastifyInstance) {
  app.get('/api/boss-edits', async (req: any, reply: any) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    try {
      const link = await readBossLink();
      if (!verifyBossToken(link, bearer(req))) {
        return reply.code(401).send({ ok: false, error: 'Qayta kiring — PIN kerak', relogin: true });
      }
      return await buildBossEdits(req.query || {});
    } catch (e: any) {
      if (!e?.statusCode) console.error('BOSS EDITS', e);
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Tahrirlar yuklanmadi' });
    }
  });
}

