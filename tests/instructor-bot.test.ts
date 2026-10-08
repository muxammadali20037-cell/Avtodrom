/**
 * INSTRUKTOR BOTI ORQALI BRON — instruktor botga «901234567 14:00» yozadi,
 * bot shu instruktorga bron qiladi (Excel bron ustuniga tushadi).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import { parseBotText } from '../backend/src/instructor-sheet-bot.js';
import { cellKey } from '../backend/src/booking-sheet.js';

let h: Harness;
let admin = '';
const INS_TG = 880099, INS2_TG = 880100;
const TZ = 'Asia/Tashkent';
const ymd = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + n * 864e5));
const T = '2026-10-08';
const at = (hm: string, d = ymd(1)) => new Date(`${d}T${hm}:00+05:00`).toISOString();

/** Instruktor botga xabar yuboradi, bot javobini qaytaradi */
async function say(text: string, tg = INS_TG) {
  const before = h.telegram.length;
  const r = await h.app.inject({
    method: 'POST', url: '/api/telegram/instructor/webhook',
    headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' },
    payload: { update_id: 1, message: { message_id: 1, chat: { id: tg, type: 'private' }, from: { id: tg, first_name: 'Aziz' }, text } },
  });
  expect(r.statusCode).toBe(200);
  return h.telegram.slice(before).map((m) => m.text).join('\n');
}
const active = () => h.db.bookings.filter((b: any) => ['pending', 'confirmed', 'in_progress'].includes(b.status));

beforeAll(async () => { h = await makeHarness(); });
beforeEach(async () => {
  h.reset();
  h.db.staff.push({ id: 'st-admin', login: 'boss', password_hash: hashPassword('admin1234'), role: 'admin', register_id: null, is_active: true });
  h.db.users.push({ id: 'u-admin', full_name: 'Admin', role: 'admin', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-instr', full_name: 'Aziz Karimov', phone: '+998901114455', telegram_id: INS_TG, role: 'instructor', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-ins2', full_name: 'Komila Sobirova', phone: '+998901114466', telegram_id: INS2_TG, role: 'instructor', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-cust', full_name: 'Ali Mijoz', phone: '+998901119999', role: 'customer', is_active: true, is_blocked: false });
  h.db.instructor_profiles.push({ id: 'ip-1', user_id: 'u-instr', is_verified: true, is_available: true, categories: ['B', 'C'], rating: 4.9 });
  h.db.instructor_profiles.push({ id: 'ip-2', user_id: 'u-ins2', is_verified: true, is_available: true, categories: ['B'], rating: 4.5 });
  h.db.courses.push({ id: 'c-b', name: 'B kategoriya', category: 'B', price: 250000, duration_minutes: 60, is_active: true });
  h.db.courses.push({ id: 'c-c', name: 'C kategoriya', category: 'C', price: 300000, duration_minutes: 60, is_active: true });
  admin = (await h.login('boss', 'admin1234')).cookie;
});

describe('Instruktor boti — xabarni o‘qish', () => {
  const p = (t: string) => parseBotText(t, T);
  it('raqam va vaqt', () => {
    expect(p('901234567 14:00')).toMatchObject({ kind: 'book', date: T, h0: 14, h1: 15, phone: '+998901234567', cat: null, half: false });
    expect(p('14:00 90 123 45 67')).toMatchObject({ kind: 'book', h0: 14, h1: 15, phone: '+998901234567' });
    expect(p('ertaga 901234567 15-17')).toMatchObject({ kind: 'book', date: '2026-10-09', h0: 15, h1: 17 });
    expect(p('завтра 901234567 с 15 до 17')).toMatchObject({ kind: 'book', date: '2026-10-09', h0: 15, h1: 17 });
    expect(p('901234567 15 dan 17 gacha')).toMatchObject({ kind: 'book', h0: 15, h1: 17 });
    expect(p('12.10 994188549 10:00')).toMatchObject({ kind: 'book', date: '2026-10-12', h0: 10, phone: '+998994188549' });
    expect(p('947372906/C 9:00')).toMatchObject({ kind: 'book', h0: 9, cat: 'C' });
    expect(p('901234567 9:00 C toifa')).toMatchObject({ kind: 'book', cat: 'C' });
    expect(p('977737646 12:00 30 min')).toMatchObject({ kind: 'book', h0: 12, half: true });
    expect(p('Dilshod 901234567 soat 14')).toMatchObject({ kind: 'book', h0: 14, name: 'Dilshod' });
    expect(p('99-313-56-26 16:00')).toMatchObject({ kind: 'book', phone: '+998993135626', h0: 16 });
    expect(p('901234567 14')).toMatchObject({ kind: 'book', h0: 14 });
  });
  it('bekor, jadval va xatolar', () => {
    expect(p('bekor 14:00')).toEqual({ kind: 'cancel', date: T, h0: 14, phone: null });
    expect(p('отмена завтра 901234567')).toMatchObject({ kind: 'cancel', date: '2026-10-09', phone: '+998901234567' });
    expect(p('ertaga')).toEqual({ kind: 'list', date: '2026-10-09' });
    expect(p('12.10')).toEqual({ kind: 'list', date: '2026-10-12' });
    expect(p('jadval')).toEqual({ kind: 'list', date: T });
    expect(p('bugun')).toEqual({ kind: 'list', date: T });
    expect(p('salom')).toEqual({ kind: 'help', error: undefined });
    expect(p('901234567')).toMatchObject({ kind: 'help', error: expect.stringMatching(/Vaqtni/) });
    expect(p('953905171 3/10')).toMatchObject({ kind: 'help', error: expect.stringMatching(/Vaqtni/) });
    expect(p('901234567 14:30')).toMatchObject({ kind: 'help', error: expect.stringMatching(/soat boshidan/) });
    expect(p('901234567 9-16')).toMatchObject({ kind: 'help', error: expect.stringMatching(/5 soat/) });
    expect(p('bekor')).toMatchObject({ kind: 'help' });
  });
});

describe('Instruktor boti — bron', () => {
  it('bron qiladi, kodni aytadi, Excel bronda ko‘rinadi', async () => {
    const msg = await say('ertaga 901234567 15-17');
    expect(msg).toMatch(/Bron qilindi/);
    const b = active()[0];
    expect(b).toMatchObject({ instructor_id: 'ip-1', status: 'confirmed', start_at: at('15:00'), end_at: at('17:00'), duration_minutes: 120, category: 'B' });
    expect(msg).toContain(b.pickup_code);
    expect(b.customer_note).toMatch(/^Instruktor boti: 901234567/);
    const g = await h.call('GET', `/api/admin/booking-sheet?date=${ymd(1)}`, { cookie: admin });
    expect(g.body.cells[cellKey('ip-1', 15)]).toMatchObject({ k: 'sheet', t: '901234567', by: 'Bot · Aziz Karimov' });
    expect(g.body.cells[cellKey('ip-1', 16)].bk.code).toBe(b.pickup_code);
    /* jadval — rasm va ostida bosiladigan raqam */
    const list = await say('ertaga');
    expect(list).toContain('15:00–17:00</b> +998901234567');
    expect(h.telegram[h.telegram.length - 1].method).toBe('sendPhoto');
  });

  it('band soatga yozmaydi; bor mijoz qayta yozilsa aytadi', async () => {
    await say('ertaga 901234567 10:00');
    expect(await say('ertaga 901234567 10:00')).toMatch(/allaqachon yozilgan/);
    expect(await say('ertaga 947494944 10:00')).toMatch(/band/);
    expect(active()).toHaveLength(1);
    /* Admin «BAND» yozgan soat */
    await h.call('PUT', '/api/admin/booking-sheet', { cookie: admin, payload: { date: ymd(1), changes: [{ key: cellKey('ip-1', 12), t: 'BAND', prev: '' }] } });
    expect(await say('ertaga 947494944 12:00')).toMatch(/band: «BAND»/);
  });

  it('toifa o‘rgatmasa — bron ham, yozuv ham qolmaydi', async () => {
    h.db.instructor_profiles[0].categories = ['B'];
    const msg = await say('ertaga 947372906/C 9:00');
    expect(msg).toMatch(/Bron qilinmadi: .*C toifani o‘rgatmaydi/);
    expect(active()).toHaveLength(0);
    const g = await h.call('GET', `/api/admin/booking-sheet?date=${ymd(1)}`, { cookie: admin });
    expect(g.body.cells[cellKey('ip-1', 9)]).toBeUndefined();
  });

  it('o‘zi yozgan bronni bekor qiladi; admin yozganini — yo‘q', async () => {
    await say('ertaga 901234567 15-17');
    const msg = await say('bekor ertaga 16:00');
    expect(msg).toMatch(/Bekor qilindi: Ertaga, 15:00–17:00/);
    expect(active()).toHaveLength(0);
    await h.call('PUT', '/api/admin/booking-sheet', { cookie: admin, payload: { date: ymd(1), changes: [{ key: cellKey('ip-1', 11), t: '947494944', prev: '' }] } });
    expect(await say('bekor ertaga 11:00')).toMatch(/admin kiritgan/);
    expect(active()).toHaveLength(1);
  });

  it('to‘langan bronni bekor qilmaydi', async () => {
    await say('ertaga 901234567 10:00');
    h.db.payments.push({ id: 'p1', booking_id: active()[0].id, status: 'paid', amount: 250000 });
    expect(await say('bekor ertaga 10:00')).toMatch(/to‘langan/);
    expect(active()).toHaveLength(1);
  });

  it('ish grafigi bo‘yicha dam vaqtga bron qilmaydi', async () => {
    const wd = String(new Date(`${ymd(1)}T12:00:00+05:00`).getUTCDay());
    h.db.admin_settings.push({ key: 'instructor_schedule:ip-1', value: { week: { [wd]: { off: false, closed: [['13:00', '14:00']] } }, dates: {} } });
    expect(await say('ertaga 901234567 13:00')).toMatch(/ishlamaydi/);
    expect(active()).toHaveLength(0);
  });

  it('har instruktor faqat o‘z ustuniga yozadi; instruktor bo‘lmagan odamga — rad', async () => {
    await say('ertaga 901234567 10:00', INS2_TG);
    expect(active()[0].instructor_id).toBe('ip-2');
    expect(await say('ertaga 901234567 10:00', 555000)).toMatch(/faqat tasdiqlangan instruktorlar/);
    expect(active()).toHaveLength(1);
  });

  it('noma’lum xabarga yordam matni', async () => {
    expect(await say('salom')).toMatch(/Bron qilish uchun shunday yozing/);
  });
});
