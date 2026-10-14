/**
 * INSTRUKTOR BOTI ORQALI BRON — instruktor botga «901234567 14:00» yozadi,
 * bot shu instruktorga bron qiladi (Excel bron ustuniga tushadi).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import { parseBotText } from '../backend/src/instructor-sheet-bot.js';
import { cellKey } from '../backend/src/booking-sheet.js';
import { webhookSecret, _resetHealThrottle, _resetEnsuredCallbacks } from '../backend/src/webhook-secret.js';
import { parseMenu, _resetBotCommands } from '../backend/src/instructor-bot-menu.js';

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
/** Bot xabaridagi tugmani bosish (callback_query) */
async function press(data: string, tg = INS_TG) {
  const before = h.telegram.length;
  const r = await h.app.inject({
    method: 'POST', url: '/api/telegram/instructor/webhook',
    headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' },
    payload: { update_id: 2, callback_query: { id: 'cb-1', from: { id: tg, first_name: 'Aziz' }, data, message: { message_id: 77, chat: { id: tg, type: 'private' } } } },
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
  it('instruktorlar har xil yozadi — hammasini tushunadi', () => {
    const b = (t: string) => { const r: any = p(t); return r.kind === 'book' ? `${r.date} ${r.h0}-${r.h1} ${r.phone}${r.cat ? ' ' + r.cat : ''}${r.name ? ' ' + r.name : ''}` : `${r.kind}:${r.error || ''}`; };
    const D1 = '2026-10-09', P = '+998932728766';
    expect(b('ertaga 13:00 998932728766')).toBe(`${D1} 13-14 ${P}`);
    expect(b('ertaga13:00 932728766')).toBe(`${D1} 13-14 ${P}`);
    expect(b('13:00da ertaga 93 272 87 66')).toBe(`${D1} 13-14 ${P}`);
    expect(b('Ertaga soat 13 da +998 93 272 87 66')).toBe(`${D1} 13-14 ${P}`);
    expect(b('эртага 13:00 932728766')).toBe(`${D1} 13-14 ${P}`);
    expect(b('ертага 13:00 932728766')).toBe(`${D1} 13-14 ${P}`);
    expect(b('ertag 13:00 932728766')).toBe(`${D1} 13-14 ${P}`);
    expect(b('ertaga 13dan 15gacha 932728766')).toBe(`${D1} 13-15 ${P}`);
    expect(b('ertaga 2 soat 13:00 932728766')).toBe(`${D1} 13-15 ${P}`);
    expect(b('932728766 ertaga 13:00 3 soat')).toBe(`${D1} 13-16 ${P}`);
    expect(b('ertaga soat 3 da 932728766')).toBe(`${D1} 15-16 ${P}`);
    expect(b('kechki 6 da 932728766')).toBe(`${T} 18-19 ${P}`);
    expect(b('ertaga 2-4 932728766')).toBe(`${D1} 14-16 ${P}`);
    expect(b('juma 10:00 932728766')).toBe(`2026-10-09 10-11 ${P}`);           // 8-oktabr — payshanba
    expect(b('dushanba 10:00 932728766')).toBe(`2026-10-12 10-11 ${P}`);
    expect(b('ertaga 13:00 932728766 iltimos bron qiling')).toBe(`${D1} 13-14 ${P}`);
    expect(b('ertaga 932728766 Akmal aka 13:00')).toBe(`${D1} 13-14 ${P} Akmal`);
    expect(b('13:00 932728766 Дурдона')).toBe(`${T} 13-14 ${P} Дурдона`);
  });
  it('bekor, jadval va xatolar', () => {
    expect(p('bekor 14:00')).toEqual({ kind: 'cancel', date: T, h0: 14, phone: null });
    expect(p('bekor 932728766')).toEqual({ kind: 'cancel', date: T, h0: null, phone: '+998932728766', anyDay: true });
    expect(p('отмена завтра 901234567')).toMatchObject({ kind: 'cancel', date: '2026-10-09', phone: '+998901234567' });
    expect(p('ertaga')).toEqual({ kind: 'list', date: '2026-10-09' });
    expect(p('12.10')).toEqual({ kind: 'list', date: '2026-10-12' });
    expect(p('jadval')).toEqual({ kind: 'list', date: T });
    expect(p('bugun')).toEqual({ kind: 'list', date: T });
    expect(p('salom')).toEqual({ kind: 'help', error: undefined });
    expect(p('901234567')).toMatchObject({ kind: 'help', error: expect.stringMatching(/Vaqtni/) });
    expect(p('953905171 3/10')).toMatchObject({ kind: 'help', error: expect.stringMatching(/Vaqtni/) });
    expect(p('901234567 14:30')).toMatchObject({ kind: 'book', h0: 14, h1: 15, half: true, off: 30 });   // soat yarimidan, 30 daqiqa
    expect(p('901234567 14:15')).toMatchObject({ kind: 'help', error: expect.stringMatching(/soat boshidan/) });
    expect(p('901234567 9-16')).toMatchObject({ kind: 'help', error: expect.stringMatching(/5 soat/) });
    expect(p('bekor')).toMatchObject({ kind: 'cancel', pick: true, h0: null, phone: null });   // tugmalar chiqadi
  });

  it('yarim soat — har xil yozilishi', () => {
    const D1 = '2026-10-09';
    const half = (t: string) => { const r: any = p(t); return r.kind === 'book' ? `${r.date} ${r.h0}${r.off ? ':30' : ':00'} ${r.half ? '30m' : (r.h1 - r.h0) + 'h'} ${r.phone}` : `${r.kind}:${r.error || ''}`; };
    const P = '+998901234567', H0 = `${D1} 14:00 30m ${P}`, H30 = `${D1} 14:30 30m ${P}`;
    for (const t of ['ertaga 14:00 901234567 30 min', 'ertaga 14:00 901234567 30 minut', 'ertaga 14 901234567 30min', 'ertaga 14:00 901234567 30 daqiqa',
      'ertaga 14:00 901234567 yarim soat', 'ertaga 14:00 901234567 yarim soatlik', 'ertaga 14:00 901234567 yarim soatga', 'ertaga 14:00 901234567 yarim',
      'ertaga 14:00 901234567 yarimta', 'ertaga 14:00 901234567 0,5 soat', 'ertaga 14:00 901234567 0.5 soat', 'ertaga 14:00 901234567 1/2 soat',
      'ertaga 14:00 901234567 пол часа', 'ertaga 14:00 901234567 полчаса', 'эртага 14:00 901234567 ярим соат', 'эртага 14:00 901234567 30 минут',
      'ertaga 14:00-14:30 901234567', 'ertaga 14-14:30 901234567', 'ertaga 14:00 dan 14:30 gacha 901234567', 'ertaga 901234567 14:00 30',
      'ertaga 901234567 14:00 30-min', 'ertaga 901234567 soat 14 yarim soat', 'ertaga 14-00 901234567 30 min', 'yarim soat ertaga 14:00 901234567']) {
      expect(half(t), t).toBe(H0);
    }
    for (const t of ['ertaga 14:30 901234567', 'ertaga 14:30-15:00 901234567', 'ertaga 14.30 901234567', 'ertaga 14-30 901234567',
      'ertaga soat 2 yarimda 901234567', 'ertaga soat ikki yarimda 901234567', 'ertaga 14:30 901234567 yarim soat', 'эртага 14:30 901234567']) {
      expect(half(t), t).toBe(H30);
    }
    expect(half('ertaga soat ikkida 901234567')).toBe(`${D1} 14:00 1h ${P}`);
    expect(half('ertaga 14:00 901234567 ikki soat')).toBe(`${D1} 14:00 2h ${P}`);
    expect(half('ertaga 14:30 901234567 1 soat')).toMatch(/^help:Soat yarimidan faqat 30 daqiqalik/);
    expect(half('ertaga 14:30-15:30 901234567')).toMatch(/^help:Soat yarimidan faqat 30 daqiqalik/);
    expect(half('ertaga 14:00 901234567 1,5 soat')).toMatch(/^help:Excel bronda 30 daqiqa yoki butun soat/);
    expect(half('ertaga 14:00 901234567 bir yarim soat')).toMatch(/^help:Excel bronda 30 daqiqa yoki butun soat/);
    expect(half('ertaga 14-16 901234567 yarim soat')).toMatch(/^help:«Yarim soat» va 2 soatlik/);
    /* telefon bo'laklari vaqt bo'lib qolmaydi */
    expect(half('ertaga 93-272-87-00 14:00')).toBe(`${D1} 14:00 1h +998932728700`);
    expect(half('ertaga 14:00 93 272 87 30')).toBe(`${D1} 14:00 1h +998932728730`);
  });

  it('bron xabari bekor yoki boshqa narsa bo‘lib qolmaydi (ko‘rib chiqishda topilgan holatlar)', () => {
    const D1 = '2026-10-09', P = '+998901234567';
    const b = (t: string) => { const r: any = p(t); return r.kind === 'book' ? `${r.date} ${r.h0}${r.off ? ':30' : ':00'} ${r.half ? '30m' : (r.h1 - r.h0) + 'h'} ${r.phone}` : `${r.kind}:${r.error || ''}`; };
    for (const t of ['ertaga 15:00 901234567 agar kelmasa aytaman', "ertaga 15:00 901234567 o'chirmang", 'ertaga 901234567 15 bekorga', 'ertaga 15:00 901234567 Udalov',
      'ertaga 15:00 901234567 Uchirov', 'ertaga 15:00 901234567 Bekarov', 'ertaga bir o\'quvchi 901234567 15', 'ertaga ikki kishi 901234567 15',
      'завтра одна ученица 901234567 15', 'завтра две ученицы 901234567 в 15', 'ertaga 901234567 15 birga', 'ertaga akasi bilan birga 901234567 soat 15',
      'ertaga 15:00 901234567 avans 30 000', 'ertaga 15:00 901234567 30-may', "ertaga o'n beshda 901234567", "ertaga soat o'n beshda 901234567", 'ertaga soat 3 Husan 901234567']) {
      expect(b(t), t).toBe(`${D1} 15:00 1h ${P}`);
    }
    expect(b('ertaga 14:00 901234567 Kochirov')).toBe(`${D1} 14:00 1h ${P}`);
    expect(b('ertaga 14:00 901234567 1/20')).toBe(`${D1} 14:00 1h ${P}`);
    expect(b('ertaga 14:00 901234567 30 mexanika')).toBe(`${D1} 14:00 1h ${P}`);
    expect(b('ertaga 14:00 901234567 2 Hilola')).toBe(`${D1} 14:00 1h ${P}`);
    expect(b('ertaga 901234567 4 Hamid')).toBe(`${D1} 16:00 1h ${P}`);
    expect(b('ertaga 901234567 soat 5 Hasanga')).toBe(`${D1} 17:00 1h ${P}`);
    expect(b('завтра в 5 часов 901234567')).toBe(`${D1} 17:00 1h ${P}`);
    expect(b("ertaga o'n oltida 901234567")).toBe(`${D1} 16:00 1h ${P}`);
    expect(b("ertaga o'n sakkizga 901234567")).toBe(`${D1} 18:00 1h ${P}`);
    expect(b('ertaga 901234567 kechki oltida')).toBe(`${D1} 18:00 1h ${P}`);
    expect(b('soat birda 901234567')).toBe(`${T} 13:00 1h ${P}`);
    /* telefon bo'laklari */
    expect(b('ertaga 14:00 90 - 123 - 45 - 30')).toBe(`${D1} 14:00 1h +998901234530`);
    expect(b('ertaga 14:00 90 123 45 30 Murod')).toBe(`${D1} 14:00 1h +998901234530`);
    expect(b('ertaga 14:00 93 512 12-30')).toBe(`${D1} 14:00 1h +998935121230`);
    /* «kerak emas», «не нужно» telefon bilan — so'raydi (bron ham, bekor ham qilmaydi) */
    expect(b('ertaga 15:00 901234567 chek kerak emas')).toMatch(/^help:Tushunmadim: bron qilaymi yoki bekor qilaymi/);
    expect(b('завтра 901234567 15:00 чек не нужно')).toMatch(/^help:Tushunmadim/);
    /* ikki xil kun */
    expect(b('bugun kelmaydi, ertaga 15:00 901234567')).toMatch(/^help:Kun ikki xil/);
  });

  it('bekor — xabarning istalgan joyida, har xil yozilsa ham', () => {
    const D1 = '2026-10-09';
    const c = (t: string) => { const r: any = p(t); return r.kind === 'cancel' ? `${r.date} ${r.h0 ?? '-'} ${r.phone || '-'}${r.pick ? ' pick' : ''}` : `${r.kind}:${r.error || ''}`; };
    for (const t of ['bekor 14:00', 'bekor qil 14:00', 'bekor qiling 14:00', '14:00 ni bekor qiling', '14:00 bekor', 'otmen 14:00', 'otmena 14:00',
      'отмена 14:00', 'отмени 14:00', 'бекор 14:00', 'бекор килинг 14:00', 'udali 14:00', 'удали 14:00', 'bekr 14:00', 'bekor14:00', 'cancel 14:00']) {
      expect(c(t), t).toBe(`${T} 14 -`);
    }
    for (const t of ['ertaga 14:00 bekor', 'ertaga 14:00 dagi bronni bekor qil', 'ertaga 14 bekor qilindi', 'ertaga 14:00 kelmaydi',
      "ertaga 14:00 ni o'chir", 'ertaga 14:00 ochirib tashla', 'ertaga 14:00 ni bekor qilib bering', 'ertagi 14:00 bekor',
      'Bekor qilish ertaga soat 14', 'ertaga 14:00 da mijoz kelmaydi bekor qil', 'ertaga 14:00 kerak emas', 'ertaga 14:30 bekor']) {
      expect(c(t), t).toBe(`${D1} 14 -`);
    }
    expect(c('ertaga 14:00 901234567 bekor')).toBe(`${D1} 14 +998901234567`);   // ilgari bu bron bo'lib, ismi «Bekor» bo'lardi
    expect(c('901234567 bekor')).toBe(`${T} - +998901234567`);
    expect(c('ertaga 901234567 bekor qiling')).toBe(`${D1} - +998901234567`);
    expect(c('bekor qilmoqchiman')).toBe(`${T} - - pick`);
    expect(c('ertaga bekor')).toBe(`${D1} - - pick`);
    expect(c("ertaga 14:00ni 16:00ga ko'chiring")).toMatch(/^help:Ko‘chirish uchun/);
    /* tinish belgilari bilan */
    expect(c('bekor, ertaga 15:00 901234567')).toBe(`${D1} 15 +998901234567`);
    expect(c('otmena, 14:00 901234567')).toBe(`${T} 14 +998901234567`);
    expect(c('Bekor: ertaga 14:00')).toBe(`${D1} 14 -`);
    expect(c('отмена! завтра 14:00')).toBe(`${D1} 14 -`);
    expect(c('Bekor!')).toBe(`${T} - - pick`);
    expect(c('bekor.')).toBe(`${T} - - pick`);
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

  it('yarim soat: 14:00–14:30 va 14:30–15:00 — ikkalasi ham bron bo‘ladi, bekor ham qilinadi', async () => {
    let msg = await say('ertaga 14:00-14:30 901234567');
    expect(msg).toMatch(/Bron qilindi[\s\S]*14:00–14:30 \(30 daqiqa\)/);
    msg = await say('ertaga 15:30 947494944');
    expect(msg).toMatch(/Bron qilindi[\s\S]*15:30–16:00 \(30 daqiqa\)/);
    expect(msg).toContain('bekor 15:30');
    const [a, b] = active().sort((x: any, y: any) => x.start_at.localeCompare(y.start_at));
    expect(a).toMatchObject({ start_at: at('14:00'), end_at: at('14:30'), duration_minutes: 30 });
    expect(b).toMatchObject({ start_at: at('15:30'), end_at: at('16:00'), duration_minutes: 30 });
    const g = await h.call('GET', `/api/admin/booking-sheet?date=${ymd(1)}`, { cookie: admin });
    expect(g.body.cells[cellKey('ip-1', 15)].t).toBe('947494944 30 MIN 15:30');
    expect(g.body.cells[cellKey('ip-1', 15)].bk.code).toBe(b.pickup_code);
    /* Excel bron qayta saqlansa ham o'sha bron joyida qoladi */
    await h.call('PUT', '/api/admin/booking-sheet', { cookie: admin, payload: { date: ymd(1), changes: [{ key: cellKey('ip-1', 17), t: 'BAND', prev: '' }] } });
    expect(active()).toHaveLength(2);
    /* admin ko'chirsa — yangi joyda ham soat yarimidan */
    const mv = await h.call('POST', '/api/admin/booking-sheet-move', { cookie: admin, payload: { date: ymd(1), key: cellKey('ip-1', 15), to_date: ymd(1), to_ins: 'ip-2', to_h: 10 } });
    expect(mv.status, JSON.stringify(mv.body)).toBe(200);
    const moved = active().find((x: any) => x.instructor_id === 'ip-2')!;
    expect(moved).toMatchObject({ start_at: at('10:30'), end_at: at('11:00'), duration_minutes: 30 });
    expect(h.db.bookings.find((x: any) => x.id === b.id).cancellation_reason).toMatch(/10:30/);
    expect(await say('ertaga 14:00 bekor')).toMatch(/Bekor qilindi: Ertaga, 14:00–14:30/);
    expect(active()).toHaveLength(1);
  });

  it('o‘sha mijozning qo‘shni soatdagi broni bo‘lsa ham 14:30 alohida 30 daqiqa', async () => {
    await say('ertaga 13:00 901234567');
    const first = active()[0];
    expect(await say('ertaga 14:30 901234567')).toMatch(/14:30–15:00 \(30 daqiqa\)/);
    const list = active().sort((x: any, y: any) => x.start_at.localeCompare(y.start_at));
    expect(list.map((b: any) => [b.start_at, b.duration_minutes])).toEqual([[at('13:00'), 60], [at('14:30'), 30]]);
    expect(list[0].id).toBe(first.id);
  });

  it('admin Excel bronda «30 MIN 14:30» yozsa — bron 14:30–15:00; boshqa yozuvlar — avvalgidek', async () => {
    const put = (h0: number, t: string) => h.call('PUT', '/api/admin/booking-sheet', { cookie: admin, payload: { date: ymd(1), changes: [{ key: cellKey('ip-1', h0), t, prev: '' }] } });
    await put(14, '901234567 30 MIN 14:30');
    expect(active()[0]).toMatchObject({ start_at: at('14:30'), end_at: at('15:00'), duration_minutes: 30 });
    await put(9, '901234568 9:30');                       // «30 MIN» siz — oddiy 1 soat (izoh)
    await put(11, '901234569 30 MIN 11:00-11:30');         // tugash vaqti — birinchi yarmi
    await put(12, '901234571 30 MIN 12:30-13:00');         // oraliq boshi — ikkinchi yarmi
    await put(13, '901234572 30 MIN до 13:30');            // «до» — tugash
    expect(active().find((b: any) => b.start_at === at('12:30'))).toMatchObject({ duration_minutes: 30 });
    expect(active().find((b: any) => b.start_at === at('13:00'))).toMatchObject({ duration_minutes: 30 });
    const by = (hm: string) => active().find((b: any) => b.start_at === at(hm));
    expect(by('09:00')).toMatchObject({ duration_minutes: 60 });
    expect(by('11:00')).toMatchObject({ duration_minutes: 30 });
    /* ko'p soatli bron ichidagi «2:30 da keladi» — bron o'zgarmaydi */
    await h.call('PUT', '/api/admin/booking-sheet', { cookie: admin, payload: { date: ymd(1), changes: [
      { key: cellKey('ip-1', 16), t: '901234570', prev: '' }, { key: cellKey('ip-1', 17), t: '901234570', prev: '' }] } });
    const long = by('16:00');
    expect(long).toMatchObject({ duration_minutes: 120 });
    await h.call('PUT', '/api/admin/booking-sheet', { cookie: admin, payload: { date: ymd(1), changes: [{ key: cellKey('ip-1', 17), t: '901234570 5:30 da keladi', prev: '901234570' }] } });
    expect(by('16:00')).toMatchObject({ id: long.id, duration_minutes: 120 });
    expect(by('17:30')).toBeUndefined();
  });

  it('«ertaga 14:00 <raqam> bekor» — bron emas, bekor qiladi; boshqa mijozning broniga tegmaydi', async () => {
    await say('ertaga 901234567 14:00');
    await say('ertaga 933334455 15:00');
    expect(active()).toHaveLength(2);
    expect(await say('ertaga 15:00 901234567 bekor')).toMatch(/boshqa mijoz yozilgan \(\+998 93 333 44 55\) — bekor qilinmadi/);
    expect(active()).toHaveLength(2);
    expect(await say('ertaga 14:00 901234567 bekor')).toMatch(/Bekor qilindi/);
    expect(active()).toHaveLength(1);
  });

  it('faqat «bekor» — bronlar tugma bo‘lib chiqadi, bosilsa bekor bo‘ladi', async () => {
    await say('ertaga 901234567 10:00');
    await say('ertaga 947494944 12:00 30 min');
    const before = h.telegram.length;
    expect(await say('bekor')).toMatch(/Qaysi bronni bekor qilamiz/);
    const kb = h.telegram.slice(before).find((m) => m.markup?.inline_keyboard)!.markup.inline_keyboard;
    expect(kb.map((r: any) => r[0].text)).toEqual(['Ertaga 10:00–11:00 · +998 90 123 45 67', 'Ertaga 12:00–12:30 · +998 94 749 49 44']);
    const b12 = active().find((b: any) => b.start_at === at('12:00'));
    expect(kb[1][0].callback_data).toBe(`bc|${ymd(1)}|12|${b12.id}`);
    /* boshqa instruktor shu tugmani bossa — uning ustunida bron yo'q */
    expect(await press(kb[1][0].callback_data, INS2_TG)).toMatch(/allaqachon bekor qilingan yoki o‘zgargan/);
    expect(active()).toHaveLength(2);
    expect(await press(kb[1][0].callback_data)).toMatch(/Bekor qilindi: Ertaga, 12:00–12:30/);
    expect(active().map((b: any) => b.start_at)).toEqual([at('10:00')]);
    expect(h.tgCalls.some((c) => c.method === 'answerCallbackQuery')).toBe(true);
    expect(h.tgCalls.some((c) => c.method === 'editMessageReplyMarkup')).toBe(true);
    /* eski tugma: o'sha soatga keyin boshqa bron yozilgan — unga tegilmaydi */
    await say('ertaga 933334455 12:00');
    expect(await press(kb[1][0].callback_data)).toMatch(/allaqachon bekor qilingan yoki o‘zgargan/);
    expect(active()).toHaveLength(2);
    await say('ertaga 12:00 bekor');
    /* bekor qilinadigan bron yo'q bo'lsa — aytadi */
    await press(kb[0][0].callback_data);
    expect(await say('bekor qilmoqchiman')).toMatch(/bekor qilsa bo‘ladigan broningiz yo‘q/);
  });

  it('webhook tugmalarni qabul qilmasa — «bekor» yozilganda callback_query qo‘shiladi', async () => {
    _resetEnsuredCallbacks();
    const WH = 'https://avtodrom.vercel.app/api/telegram/instructor/webhook';
    h.tgResults.set('getWebhookInfo', { url: WH, pending_update_count: 0, max_connections: 40, allowed_updates: ['message'] });
    await say('bekor');
    const set = h.tgCalls.find((c) => c.method === 'setWebhook')!;
    expect(set.body).toMatchObject({ url: WH, secret_token: 'test-webhook-secret', drop_pending_updates: false, allowed_updates: ['message', 'callback_query'] });
    /* ikkinchi marta tekshirmaydi */
    const n = h.tgCalls.filter((c) => c.method === 'getWebhookInfo').length;
    await say('bekor');
    expect(h.tgCalls.filter((c) => c.method === 'getWebhookInfo')).toHaveLength(n);
    h.tgResults.delete('getWebhookInfo');
  });

  it('«bekor <raqam>» — kun aytilmasa ham o‘sha raqamni topib bekor qiladi', async () => {
    await say('ertaga 932728766 15:00');
    expect(active()).toHaveLength(1);
    expect(await say('bekor 932728766')).toMatch(/Bekor qilindi: Ertaga, 15:00–16:00/);
    expect(active()).toHaveLength(0);
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
    expect(await say('salom')).toMatch(/Mijoz raqami va vaqtni istalgan tartibda yozing/);
  });
});

describe('Instruktor boti — jim qolmaydi, jurnal, webhook', () => {
  const WH = 'https://avtodrom.vercel.app/api/telegram/instructor/webhook';
  const botLog = () => (h.db.admin_settings.find((r: any) => r.key === 'instructor_bot_log')?.value || []) as any[];

  it('xodim raqamiga bron — nima uchunligini aytadi', async () => {
    h.db.users.push({ id: 'u-me2', full_name: 'Muxammadali', phone: '+998932728766', role: 'instructor', is_active: true, is_blocked: false });
    const out = await say('ERTAG 14:00 998932728766');
    expect(out).toMatch(/\+998 93 272 87 66 — instruktor akkauntining raqami \(Muxammadali\)/);
    expect(active()).toHaveLength(0);
  });

  it('har xabar va javob jurnalga yoziladi', async () => {
    await say('ertaga 901234567 14:00');
    const [e] = botLog();
    expect(e).toMatchObject({ chat: INS_TG, text: 'ertaga 901234567 14:00', error: null });
    expect(e.reply).toMatch(/Bron qilindi/);
    await say('salom');
    expect(botLog()).toHaveLength(2);
    expect(botLog()[0].text).toBe('salom');
  });

  it('kutilmagan xato bo‘lsa ham instruktor javob oladi', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = ((u: any, o: any) => (/\/rest\/v1\/bookings/.test(String(u)) ? Promise.reject(new Error('baza javob bermadi')) : orig(u, o))) as any;
    try {
      expect(await say('ertaga 901234567 14:00')).toMatch(/Xatolik yuz berdi — bron yozilmadi[\s\S]*baza javob bermadi/);
    } finally { globalThis.fetch = orig; }
    expect(botLog()[0].error).toMatch(/baza javob bermadi/);
  });

  it('?kick=1 — navbat tiqilib qolsa webhook shu manzilga qayta o‘rnatiladi', async () => {
    const info = { url: WH, pending_update_count: 1, last_error_date: 1791459225, last_error_message: 'Wrong response from the webhook: 400 Bad Request', max_connections: 40, allowed_updates: ['message', 'callback_query'] };
    h.tgResults.set('getWebhookInfo', info);
    const plain = await h.app.inject({ method: 'GET', url: '/api/telegram/instructor/webhook' });
    expect(JSON.parse(plain.body).telegram).toMatchObject({ pending_update_count: 1, last_error_at: '2026-10-08T11:33:45.000Z' });
    expect(h.tgCalls.some((c) => c.method === 'setWebhook')).toBe(false);

    const r = JSON.parse((await h.app.inject({ method: 'GET', url: '/api/telegram/instructor/webhook?kick=1' })).body);
    expect(r.kick).toMatch(/qayta o‘rnatildi/);
    const set = h.tgCalls.find((c) => c.method === 'setWebhook')!;
    expect(set.body).toMatchObject({ url: WH, secret_token: 'test-webhook-secret', drop_pending_updates: false, max_connections: 40, allowed_updates: ['message', 'callback_query'] });

    // boshqa joyga ulangan webhook'ga tegilmaydi; navbat bo'sh bo'lsa ham
    h.tgCalls.length = 0;
    h.tgResults.set('getWebhookInfo', { ...info, url: 'https://boshqa.example/hook' });
    expect(JSON.parse((await h.app.inject({ method: 'GET', url: '/api/telegram/instructor/webhook?kick=1' })).body).kick).toMatch(/boshqa manzilda/);
    expect(h.tgCalls.some((c) => c.method === 'setWebhook')).toBe(false);
  });

  it('webhook sirsiz o‘rnatilgan bo‘lsa — so‘rov rad etiladi, webhook o‘zi tuzaladi', async () => {
    _resetHealThrottle();
    h.tgResults.set('getWebhookInfo', { url: WH, pending_update_count: 4, last_error_message: 'Wrong response from the webhook: 503 Service Unavailable', max_connections: 40, allowed_updates: ['message', 'callback_query'] });
    const post = (headers: any) => h.app.inject({ method: 'POST', url: '/api/telegram/instructor/webhook', headers,
      payload: { update_id: 9, message: { message_id: 9, chat: { id: INS_TG, type: 'private' }, from: { id: INS_TG, first_name: 'Aziz' }, text: 'ertaga 901234567 14:00' } } });
    expect((await post({})).statusCode).toBe(401);
    expect(active()).toHaveLength(0);
    const set = h.tgCalls.filter((c) => c.method === 'setWebhook');
    expect(set).toHaveLength(1);
    expect(set[0].body).toMatchObject({ url: WH, secret_token: 'test-webhook-secret', drop_pending_updates: false });
    // daqiqasiga bir martadan ko'p emas
    expect((await post({ 'x-telegram-bot-api-secret-token': 'notogri' })).statusCode).toBe(401);
    expect(h.tgCalls.filter((c) => c.method === 'setWebhook')).toHaveLength(1);
    // Telegram endi to'g'ri sir bilan yuboradi — bron bo'ladi
    expect((await post({ 'x-telegram-bot-api-secret-token': 'test-webhook-secret' })).statusCode).toBe(200);
    expect(active()).toHaveLength(1);
  });

  it('TELEGRAM_WEBHOOK_SECRET bo‘lmasa sir bot tokenidan hosil qilinadi', () => {
    const a = webhookSecret('', '123:AAA'), b = webhookSecret('', '456:BBB');
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
    expect(webhookSecret('', '123:AAA')).toBe(a);
    expect(webhookSecret('env-sir', '123:AAA')).toBe('env-sir');
    expect(webhookSecret('', '')).toBe('');
  });
});

describe('Instruktor boti — menyu (katalog)', () => {
  const T0 = '2026-10-08';
  it('menyu tugmalari va «/» buyruqlarini taniydi', () => {
    expect(parseMenu('📅 Bugungi jadvalim', T0)).toEqual({ kind: 'day', date: T0 });
    expect(parseMenu('📅 Ertangi jadvalim', T0)).toEqual({ kind: 'day', date: '2026-10-09' });
    expect(parseMenu('📋 Bugungi bronlarim', T0)).toEqual({ kind: 'bookings', date: T0 });
    expect(parseMenu('📋 Ertangi bronlarim', T0)).toEqual({ kind: 'bookings', date: '2026-10-09' });
    expect(parseMenu('/bugun', T0)).toEqual({ kind: 'day', date: T0 });
    expect(parseMenu('/ertaga@avtodrom_bot', T0)).toEqual({ kind: 'day', date: '2026-10-09' });
    expect(parseMenu('/bronlarim', T0)).toEqual({ kind: 'bookings', date: T0 });
    expect(parseMenu('/yordam', T0)).toEqual({ kind: 'help' });
    expect(parseMenu('❓ Bron qanday yoziladi', T0)).toEqual({ kind: 'help' });
    expect(parseMenu('menyu', T0)).toEqual({ kind: 'menu' });
    // bron matni menyu emas
    expect(parseMenu('ertaga 14:00 901234567', T0)).toBeNull();
    expect(parseMenu('bugun', T0)).toBeNull();
  });

  it('/start — tasdiqlangan instruktorga panel tugmasi va pastda menyu', async () => {
    _resetBotCommands();
    h.db.instructor_applications.push({ id: 'app-1', telegram_user_id: INS_TG, status: 'APPROVED', first_name: 'Aziz' });
    const before = h.telegram.length;
    await say('/start');
    const msgs = h.telegram.slice(before);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].markup.inline_keyboard[0][0].web_app).toBeTruthy();
    const kb = msgs[1].markup;
    expect(kb.is_persistent).toBe(true);
    expect(kb.keyboard.flat().map((b: any) => b.text)).toEqual(['📅 Bugungi jadvalim', '📅 Ertangi jadvalim', '📋 Bugungi bronlarim', '📋 Ertangi bronlarim', '❓ Bron qanday yoziladi']);
    const cmds = h.tgCalls.find((c) => c.method === 'setMyCommands')!;
    expect(cmds.body.commands.map((c: any) => c.command)).toEqual(['start', 'bugun', 'ertaga', 'bronlarim', 'ertangi', 'yordam']);
  });

  it('«Bronlarim» — soati bilan, raqam bosiladigan ko‘rinishda', async () => {
    expect(await say('📋 Bugungi bronlarim')).toMatch(/Hozircha bron yo‘q/);
    await say('ertaga 901234567 14:00 Dilshod');
    await say('ertaga 15-17 932728766');
    const out = await say('📋 Ertangi bronlarim');
    expect(out).toMatch(/Bronlarim<\/b> — Ertaga/);
    expect(out).toMatch(/· 2 ta/);
    expect(out).toMatch(/🕐 <b>14:00–15:00<\/b> {2}\+998901234567\n {6}Dilshod · AVD-\d+/);
    expect(out).toMatch(/🕐 <b>15:00–17:00<\/b> {2}\+998932728766/);
    expect(out.indexOf('14:00')).toBeLessThan(out.indexOf('15:00–17:00'));
    expect(out).toMatch(/Raqamni bosing — qo‘ng‘iroq qilasiz/);
  });

  it('«Jadvalim» — kun rasmi va raqamlar; noma’lum matnga yordam + menyu', async () => {
    await say('ertaga 901234567 14:00');
    const before = h.telegram.length;
    const out = await say('📅 Ertangi jadvalim');
    expect(['sendPhoto', 'sendMessage']).toContain(h.telegram[before].method);
    expect(out).toMatch(/14:00–15:00<\/b> \+998901234567/);
    const b2 = h.telegram.length;
    await say('salom');
    expect(h.telegram[b2].markup?.keyboard).toBeTruthy();
  });
});

describe('Instruktor boti — kirill yozuvi', () => {
  const T0 = '2026-10-08', D1 = '2026-10-09';
  const p = (t: string) => parseBotText(t, T0) as any;
  it('o‘zbekcha kirillda yozilgan bron, bekor va ro‘yxat', () => {
    expect(p('эртага 14:00 901234567')).toMatchObject({ kind: 'book', date: D1, h0: 14, h1: 15, phone: '+998901234567' });
    expect(p('Эртага соат 14 да 901234567')).toMatchObject({ kind: 'book', date: D1, h0: 14 });
    expect(p('эртага 15 дан 17 гача 901234567')).toMatchObject({ kind: 'book', h0: 15, h1: 17, name: null });
    expect(p('тушдан кейин 3 901234567')).toMatchObject({ kind: 'book', h0: 15, name: null });
    expect(p('эртага ярим соат 14:00 901234567')).toMatchObject({ kind: 'book', h0: 14, half: true, name: null });
    expect(p('Дилшод ака 901234567 эртага 14 ёзиб қўй')).toMatchObject({ kind: 'book', name: 'Дилшод' });
    expect(p('эртага 901234567/С 9:00')).toMatchObject({ kind: 'book', cat: 'C' });
    expect(p('бекор 14:00')).toMatchObject({ kind: 'cancel', h0: 14 });
    expect(p('Бекор қилиш эртага 14:00')).toMatchObject({ kind: 'cancel', date: D1, h0: 14 });
    expect(p('бекор 901234567')).toMatchObject({ kind: 'cancel', phone: '+998901234567', anyDay: true });
    expect(p('жадвал')).toEqual({ kind: 'list', date: T0 });
    expect(p('эртага рўйхат')).toEqual({ kind: 'list', date: D1 });
  });
  it('ruscha ham', () => {
    expect(p('завтра с 15 до 17 901234567')).toMatchObject({ kind: 'book', date: D1, h0: 15, h1: 17 });
    expect(p('вечером в 6 901234567 завтра')).toMatchObject({ kind: 'book', date: D1, h0: 18 });
    expect(p('отмена 14:00')).toMatchObject({ kind: 'cancel', h0: 14 });
  });
  it('menyu kirillda', () => {
    expect(parseMenu('📅 Бугунги жадвалим', T0)).toEqual({ kind: 'day', date: T0 });
    expect(parseMenu('эртанги бронларим', T0)).toEqual({ kind: 'bookings', date: D1 });
    expect(parseMenu('ёрдам', T0)).toEqual({ kind: 'help' });
  });
  it('kirillda yozilgan bron botda ishlaydi', async () => {
    expect(await say('эртага соат 14 да 901234567 Дилшод')).toMatch(/Bron qilindi/);
    expect(active()).toHaveLength(1);
    expect(await say('бекор эртага 14:00')).toMatch(/Bekor qilindi/);
    expect(active()).toHaveLength(0);
  });
});

describe('Instruktor boti — o‘chirilgan profil', () => {
  it('admin o‘chirgan instruktorga sababini aytadi', async () => {
    h.db.instructor_profiles.find((x: any) => x.id === 'ip-1').is_available = false;
    expect(await say('📋 Bugungi bronlarim')).toMatch(/Profilingiz hozir faol emas/);
    expect(await say('ertaga 901234567 14:00', 555001)).toMatch(/faqat tasdiqlangan instruktorlar/);
  });
});
