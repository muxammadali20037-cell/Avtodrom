/**
 * OCHIQ CHEK VA 4 XONALI RAQAM
 *  · kassadagi 5 soatlik paket — 5 ta ochiq 1 soatlik chek (kuni yo'q);
 *  · istalgan instruktor istalgan kuni uradi — dars o'sha paytdan boshlanadi;
 *  · chekdagi 4 xonali raqam: panelda kiritiladi yoki botga yoziladi — chek o'zi uriladi;
 *  · oldingi darsning vaqti tugagan bo'lsa — yangi chek urilganda o'zi yopiladi.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import { makeRegisterToken, mgmtPinHashOf } from '../backend/src/shift-routes.js';
import { fmtWhen } from '../backend/src/notify.js';
import { isOpenAt } from '../backend/src/packages.js';
import { shortCodeOf, findByShortCode } from '../backend/src/short-code.js';
import { closeLateBookings } from '../backend/src/reminders.js';
import { handleInstructorSheetMessage } from '../backend/src/instructor-sheet-bot.js';

let h: Harness;
let kassa1 = '';
const A_TG = 880601, B_TG = 880602, C_TG = 880603;

function signedInitData(user: Record<string, unknown>, botToken = '1:instructor') {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAtest', user: JSON.stringify(user) });
  const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dataCheck).digest('hex'));
  return params.toString();
}
const ins = (tg: number) => (method: string, url: string, payload?: any) =>
  h.app.inject({ method, url, payload, headers: { 'x-telegram-init-data': signedInitData({ id: tg, first_name: 'I' }) } })
    .then((r: any) => ({ status: r.statusCode, body: JSON.parse(r.body || '{}') }));
const A = ins(A_TG), B = ins(B_TG), C = ins(C_TG);
const bk = (id: string) => h.db.bookings.find((b: any) => b.id === id);

async function sellPackage(name = 'Paket Mijoz', phone = '+998901230099') {
  const r = await h.call('POST', '/api/admin/cashier/issue', { cookie: kassa1, payload: {
    register_token: makeRegisterToken('reg-p1'), full_name: name, phone, course_id: 'c-b',
    category: 'B', duration_minutes: 300, amount: 1_100_000, cash_amount: 1_100_000, card_amount: 0 } });
  expect(r.status).toBe(201);
  return r.body.receipts as any[];
}

beforeAll(async () => {
  h = await makeHarness();
  const base = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async (u: any, o: any) => {
    if (String(u).includes('/rest/v1/rpc/generate_receipt_code')) {
      const code = `AVD-261031-O${String(++n).padStart(4, '0')}`;
      return { ok: true, status: 200, text: async () => JSON.stringify(code), json: async () => code, headers: new Map() } as any;
    }
    return base(u, o);
  }) as any;
});

beforeEach(async () => {
  h.reset();
  h.db.cash_registers.push({ id: 'reg-p1', code: 'P1', name: '1-kassa', is_active: true });
  h.db.staff.push({ id: 'st-k1', login: 'kassa1', password_hash: hashPassword('parol1234'), role: 'cashier', register_id: 'reg-p1', full_name: 'kassa1', is_active: true });
  h.db.users.push({ id: 'u-admin', full_name: 'Admin', role: 'admin', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-a', full_name: 'Aziz Karimov', phone: '+998901114455', telegram_id: A_TG, role: 'instructor', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-b', full_name: 'Bobur Aliyev', phone: '+998901114466', telegram_id: B_TG, role: 'instructor', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-c', full_name: 'Sardor C', phone: '+998901114477', telegram_id: C_TG, role: 'instructor', is_active: true, is_blocked: false });
  h.db.instructor_profiles.push({ id: 'ip-a', user_id: 'u-a', is_verified: true, is_available: true, categories: ['B'] });
  h.db.instructor_profiles.push({ id: 'ip-b', user_id: 'u-b', is_verified: true, is_available: true, categories: ['B'] });
  h.db.instructor_profiles.push({ id: 'ip-c', user_id: 'u-c', is_verified: true, is_available: true, categories: ['C'] });
  h.db.courses.push({ id: 'c-b', name: 'B toifa', category: 'B', price: 250000, duration_minutes: 60, is_active: true });
  h.db.admin_settings.push({ key: 'rate_b', value: 250000 });
  kassa1 = (await h.login('kassa1', 'parol1234')).cookie;
});

describe('Ochiq chek — istalgan kuni, istalgan instruktor', () => {
  it('belgilar: 2099-yil — «Ochiq chek», 4 xonali raqam ajratiladi', () => {
    expect(isOpenAt('2099-01-01T03:00:00.000Z')).toBe(true);
    expect(isOpenAt(new Date().toISOString())).toBe(false);
    expect(fmtWhen('2099-01-01T03:00:00.000Z')).toBe('Ochiq chek · istalgan kun');
    expect(shortCodeOf(' 1234 ')).toBe('1234');
    expect(shortCodeOf('12 34')).toBe('1234');
    expect(shortCodeOf('12345')).toBeNull();
    expect(shortCodeOf('AVD-1234')).toBeNull();
  });

  it('4 xonali raqam bilan uriladi: dars HOZIR boshlanadi, urgan instruktorga yoziladi', async () => {
    const receipts = await sellPackage();
    const third = receipts[2];
    const v = await B('POST', '/api/instructor/scan', { code: third.short_code });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ can_start: true, open: true, receipt_code: third.code, short_code: third.short_code });
    const s = await B('POST', '/api/instructor/scan/start', { code: third.short_code });
    expect(s.status).toBe(200);
    expect(s.body.open).toBe(true);
    const b = bk(third.booking_id);
    expect(b).toMatchObject({ status: 'in_progress', instructor_id: 'ip-b', instructor_name: 'Bobur Aliyev' });
    expect(Math.abs(Date.parse(b.start_at) - Date.now())).toBeLessThan(10_000);
    expect(Date.parse(b.end_at) - Date.parse(b.start_at)).toBe(60 * 60000);
    const av = h.db.attendance_verifications;
    expect(av).toHaveLength(1);
    expect(av[0]).toMatchObject({ booking_id: third.booking_id, receipt_code: third.code, telegram_user_id: B_TG });
    expect(av[0].verification_snapshot).toMatchObject({ instructor_id: 'ip-b', amount: 220000, minutes: 60 });
    /* Qolgan 4 tasi hamon ochiq */
    expect(h.db.bookings.filter((x) => x.status === 'confirmed' && new Date(x.start_at).getUTCFullYear() === 2099)).toHaveLength(4);
    /* Qayta urish — ruxsat yo'q */
    const again = await A('POST', '/api/instructor/scan/start', { code: third.short_code });
    expect(again.status).toBe(409);
  });

  it('QR (to‘liq kod) bilan ham ishlaydi; boshqa toifa instruktori ura olmaydi', async () => {
    const receipts = await sellPackage();
    const c = await C('POST', '/api/instructor/scan/start', { code: receipts[0].code });
    expect(c.status).toBe(409);
    expect(c.body.error).toMatch(/B toifa/);
    const a = await A('POST', '/api/instructor/scan/start', { code: `https://t.me/x?start=${receipts[0].code}` });
    expect(a.status).toBe(200);
    expect(bk(receipts[0].booking_id).instructor_id).toBe('ip-a');
  });

  it('kech qoldi deb yopilmaydi (muddatsiz)', async () => {
    await sellPackage();
    await closeLateBookings(Date.now() + 400 * 864e5).catch(() => null);
    expect(h.db.bookings.every((b) => b.status === 'confirmed')).toBe(true);
  });

  it('oddiy chek ham urilguncha yaroqli: 2 kun o‘tsa ham «Kelmadi» bo‘lmaydi, urilganda dars HOZIRDAN', async () => {
    const r = await h.call('POST', '/api/admin/cashier/issue', { cookie: kassa1, payload: {
      register_token: makeRegisterToken('reg-p1'), full_name: 'Kech Keldi', course_id: 'c-b', category: 'B',
      duration_minutes: 60, amount: 250000, cash_amount: 250000, card_amount: 0 } });
    expect(r.status).toBe(201);
    const b = bk(r.body.receipt.booking_id);
    /* chek 2 kun oldin chiqarilgan bo'lsin */
    const ago = (iso: string) => new Date(Date.parse(iso) - 2 * 864e5).toISOString();
    Object.assign(b, { start_at: ago(b.start_at), end_at: ago(b.end_at), booking_date: ago(b.booking_date), created_at: ago(b.created_at) });
    await closeLateBookings(Date.now());
    expect(b.status).toBe('confirmed');
    const s = await A('POST', '/api/instructor/scan/start', { code: r.body.receipt.short_code });
    expect(s.status).toBe(200);
    expect(b.status).toBe('in_progress');
    expect(Math.abs(Date.parse(b.start_at) - Date.now())).toBeLessThan(10_000);
    expect(Date.parse(b.end_at) - Date.parse(b.start_at)).toBe(60 * 60000);
  });

  it('oldingi darsning vaqti tugagan bo‘lsa — keyingi chek urilganda o‘zi yopiladi', async () => {
    const receipts = await sellPackage();
    expect((await A('POST', '/api/instructor/scan/start', { code: receipts[0].short_code })).status).toBe(200);
    /* Hali vaqti bor — ikkinchisini boshlab bo'lmaydi */
    const early = await A('POST', '/api/instructor/scan/start', { code: receipts[1].short_code });
    expect(early.status).toBe(409);
    expect(early.body.error).toMatch(/yakunlanmagan/);
    /* 61 daqiqa o'tdi */
    const first = bk(receipts[0].booking_id);
    const back = (iso: string) => new Date(Date.parse(iso) - 61 * 60000).toISOString();
    Object.assign(first, { arrived_at: back(first.arrived_at), start_at: back(first.start_at), end_at: back(first.end_at) });
    const next = await A('POST', '/api/instructor/scan/start', { code: receipts[1].short_code });
    expect(next.status).toBe(200);
    expect(bk(receipts[0].booking_id).status).toBe('completed');
    expect(bk(receipts[1].booking_id).status).toBe('in_progress');
  });

  it('instruktorlar hisoboti ?rows=1 — har bir dars alohida (Excel uchun)', async () => {
    const receipts = await sellPackage('Excel Mijoz', '+998901230044');
    expect((await A('POST', '/api/instructor/scan/start', { code: receipts[0].short_code })).status).toBe(200);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
    const r = await h.call('GET', `/api/admin/instructor-report?from=${day}&to=${day}&rows=1`, { cookie: kassa1 });
    expect(r.status).toBe(200);
    expect(r.body.lessons).toHaveLength(1);
    expect(r.body.lessons[0]).toMatchObject({ instructor_id: 'ip-a', customer: 'Excel Mijoz', phone: '+998901230044', school: false, amount: 220000, minutes: 60, receipt_code: receipts[0].code });
    const plain = await h.call('GET', `/api/admin/instructor-report?from=${day}&to=${day}`, { cookie: kassa1 });
    expect(plain.body.lessons).toBeUndefined();
    expect(plain.body.instructors.find((i: any) => i.id === 'ip-a')).toMatchObject({ lessons: 1, revenue: 220000 });
  });

  it('raqam topilmasa — tushunarli xabar', async () => {
    await sellPackage();
    const used = new Set(h.db.payments.map((p) => p.short_code));
    let free = '1000';
    for (let n = 1000; n < 10000; n++) if (!used.has(String(n))) { free = String(n); break; }
    const r = await A('POST', '/api/instructor/scan', { code: free });
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(new RegExp(`${free} raqamli chek topilmadi`));
  });

  it('bir xil raqam: faol (urilmagan) chek ishlatilganidan ustun', async () => {
    h.db.bookings.push({ id: 'old', customer_id: 'u-a', status: 'completed', start_at: new Date().toISOString(), end_at: new Date().toISOString() });
    h.db.bookings.push({ id: 'new', customer_id: 'u-a', status: 'confirmed', start_at: new Date().toISOString(), end_at: new Date().toISOString() });
    h.db.payments.push({ id: 'p-old', booking_id: 'old', status: 'paid', short_code: '4321', receipt_code: 'AVD-1', paid_at: new Date(Date.now() - 864e5).toISOString() });
    h.db.payments.push({ id: 'p-new', booking_id: 'new', status: 'paid', short_code: '4321', receipt_code: 'AVD-2', paid_at: new Date(Date.now() - 2 * 864e5).toISOString() });
    const r: any = await findByShortCode('4321');
    expect(r.booking.id).toBe('new');
  });
});

describe('Instruktor boti: 4 xonali raqam — chek uriladi', () => {
  it('«1234» yozsa dars boshlanadi va bot tasdiqlaydi', async () => {
    const receipts = await sellPackage('Bot Mijoz', '+998901230055');
    const replies: string[] = [];
    await handleInstructorSheetMessage('1:instructor', A_TG, A_TG, receipts[4].short_code, replies);
    expect(replies.join('\n')).toMatch(/Chek urildi — dars boshlandi/);
    expect(replies.join('\n')).toMatch(/Bot Mijoz/);
    expect(bk(receipts[4].booking_id)).toMatchObject({ status: 'in_progress', instructor_id: 'ip-a' });
    /* Ikkinchi marta — «allaqachon boshlangan» */
    const again: string[] = [];
    await handleInstructorSheetMessage('1:instructor', B_TG, B_TG, receipts[4].short_code, again);
    expect(again.join('\n')).toMatch(/allaqachon boshlangan/);
  });

  it('noto‘g‘ri raqam — bron yozilmaydi, xabar beriladi', async () => {
    const replies: string[] = [];
    await handleInstructorSheetMessage('1:instructor', A_TG, A_TG, '0000', replies);
    expect(replies.join('\n')).toMatch(/0000 raqamli chek topilmadi/);
    expect(h.db.bookings).toHaveLength(0);
  });
});

describe('Eski 5 soatlik bitta chek → 5 ta 1 soatlik ochiq chek (maxsus parol bilan)', () => {
  const old = () => {
    const s0 = '2026-10-31T10:30:00.000Z', e0 = '2026-10-31T15:30:00.000Z';
    h.db.users.push({ id: 'u-ab', full_name: 'ABDULBOSITGA', role: 'customer', is_active: true, is_blocked: false });
    h.db.bookings.push({ id: 'bk-5h', customer_id: 'u-ab', instructor_id: null, course_id: 'c-b', category: 'B', status: 'confirmed', source: 'walk_in',
      start_at: s0, end_at: e0, booking_date: s0, duration_minutes: 300, hours: 5, price: 1100000 });
    h.db.payments.push({ id: 'pay-5h', booking_id: 'bk-5h', customer_id: 'u-ab', amount: 1100000, method: 'mixed', cash_amount: 600000, card_amount: 500000,
      status: 'paid', receipt_code: 'AVD-261031-EQ6LP', register_id: 'reg-p1', paid_at: '2026-10-31T10:30:00.000Z', cashier_id: 'u-admin' });
    h.db.admin_settings.push({ key: 'mgmt_pin', value: { hash: mgmtPinHashOf('4321') } });
  };
  it('parolsiz — rad; parol bilan — 5 ta chek, summa va to‘lov kuni o‘zgarmaydi', async () => {
    old();
    const no = await h.call('POST', '/api/admin/cashier/split-package', { cookie: kassa1, payload: { code: 'AVD-261031-EQ6LP' } });
    expect(no.status).toBe(403);
    expect(h.db.payments).toHaveLength(1);
    const t = await h.call('POST', '/api/admin/price-unlock', { cookie: kassa1, payload: { pin: '4321' } });
    expect(t.status).toBe(200);
    const r = await h.call('POST', '/api/admin/cashier/split-package', { cookie: kassa1, payload: { code: 'AVD-261031-EQ6LP', price_token: t.body.token } });
    expect(r.status).toBe(200);
    expect(r.body.receipts).toHaveLength(5);
    expect(r.body.receipts.map((x: any) => x.amount)).toEqual([220000, 220000, 220000, 220000, 220000]);
    expect(r.body.receipts[0].code).toBe('AVD-261031-EQ6LP');                          // eski kod — 1-chek
    expect(r.body.receipts.every((x: any) => x.open && /^\d{4}$/.test(x.short_code))).toBe(true);
    const pays = h.db.payments.filter((p: any) => p.status === 'paid');
    expect(pays).toHaveLength(5);
    expect(pays.reduce((a: number, p: any) => a + p.amount, 0)).toBe(1100000);
    expect(pays.reduce((a: number, p: any) => a + p.cash_amount, 0)).toBe(600000);
    expect(pays.reduce((a: number, p: any) => a + p.card_amount, 0)).toBe(500000);
    expect(pays.every((p: any) => p.paid_at === '2026-10-31T10:30:00.000Z' && p.register_id === 'reg-p1')).toBe(true);
    const bks = h.db.bookings.filter((b: any) => b.customer_id === 'u-ab');
    expect(bks).toHaveLength(5);
    expect(bks.every((b: any) => b.duration_minutes === 60 && b.status === 'confirmed' && new Date(b.start_at).getUTCFullYear() === 2099)).toBe(true);
    expect(h.db.admin_audit_logs.some((x: any) => x.action === 'CHEQUE_SPLIT')).toBe(true);
    /* yangi cheklardan biri raqam bilan uriladi */
    const s = await A('POST', '/api/instructor/scan/start', { code: r.body.receipts[3].short_code });
    expect(s.status).toBe(200);
    /* ikkinchi marta bo'lib bo'lmaydi */
    const again = await h.call('POST', '/api/admin/cashier/split-package', { cookie: kassa1, payload: { code: 'AVD-261031-EQ6LP', price_token: t.body.token } });
    expect(again.status).toBe(409);
  });
});

describe('Kassa: Excel bron va Instruktorlar nazorati', () => {
  it('kassir Excel bronga yoza oladi (can_edit) va nazorat havolasini oladi', async () => {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date(Date.now() + 864e5));
    const g = await h.call('GET', `/api/admin/booking-sheet?date=${day}`, { cookie: kassa1 });
    expect(g.status).toBe(200);
    expect(g.body.can_edit).toBe(true);
    const put = await h.call('PUT', '/api/admin/booking-sheet', { cookie: kassa1, payload: { date: day, changes: [{ key: 'ip-a|10', t: '901234567', prev: '' }] } });
    expect(put.status).toBe(200);
    expect(h.db.bookings.some((b: any) => b.instructor_id === 'ip-a' && b.status === 'confirmed')).toBe(true);
    const link = await h.call('GET', '/api/admin/control-link', { cookie: kassa1 });
    expect(link.status).toBe(200);
    expect(link.body.url).toMatch(/\/nazorat\?k=/);
    const reset = await h.call('POST', '/api/admin/control-link', { cookie: kassa1, payload: { reset: true } });
    expect(reset.status).toBe(403);                                                     // yangilash — faqat admin
  });

  it('nazoratda darsdagi instruktor: tugash vaqti = chek urilgan vaqt + daqiqa', async () => {
    const receipts = await sellPackage('Nazorat Mijoz', '+998901230033');
    expect((await A('POST', '/api/instructor/scan/start', { code: receipts[0].short_code })).status).toBe(200);
    const link = await h.call('GET', '/api/admin/control-link', { cookie: kassa1 });
    const k = new URL(link.body.url).searchParams.get('k');
    const v = await h.call('GET', `/api/control-view?k=${k}`);
    expect(v.status).toBe(200);
    const a = v.body.instructors.find((i: any) => i.id === 'ip-a');
    expect(a.now.state).toBe('lesson');
    expect(Date.parse(a.now.ends) - Date.parse(a.now.started)).toBe(60 * 60000);
    expect(Math.abs(Date.parse(a.now.started) - Date.now())).toBeLessThan(15_000);
  });
});
