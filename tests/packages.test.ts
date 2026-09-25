/**
 * 5 SOATLIK PAKET, YANGI DAVOMIYLIKLAR, BANDLIK VA KUNLIK JADVAL
 *
 *  · mijoz 30 daq / 1 soat / 2 soat oladi; 5 soat — paket (1 100 000)
 *  · paket 5 / 3+2 / 2+2+1 / 1×5 ga bo'linadi — har biri alohida bron
 *  · bittasi band bo'lsa hech biri yozilmaydi
 *  · 2 soatlik bronning IKKALA soati ham band (qo'lda bron, kassa)
 *  · kassa paketni bir yo'la to'laydi — har mashg'ulotga o'z cheki
 *  · instruktorlar kunlik jadvali — admin, operator, kassa
 */
import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import { makeRegisterToken } from '../backend/src/shift-routes.js';
import { splitError, shares, parseSessions } from '../backend/src/packages.js';

let h: Harness;
let admin = '', operator = '', kassa1 = '';

const TZ = 'Asia/Tashkent';
const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const dayPlus = (n: number) => ymd(new Date(Date.now() + n * 864e5));
const at = (day: string, hm: string) => new Date(`${day}T${hm}:00+05:00`).toISOString();
const D2 = dayPlus(2), D3 = dayPlus(3), D4 = dayPlus(4), D5 = dayPlus(5), D6 = dayPlus(6);

function signedInitData(user: Record<string, unknown>, botToken = '1:customer') {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAtest', user: JSON.stringify(user) });
  const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dataCheck).digest('hex'));
  return params.toString();
}
const tg = async (method: string, url: string, payload?: any) => {
  const r = await h.app.inject({ method, url, headers: { 'x-telegram-init-data': signedInitData({ id: 777001, first_name: 'Mijoz' }) }, payload });
  let body: any = {}; try { body = JSON.parse(r.payload); } catch { body = r.payload; }
  return { status: r.statusCode, body };
};

beforeAll(async () => {
  h = await makeHarness();
  /* Bazadagi chek kodi funksiyasi o'rniga — har chaqiruvda yangi kod */
  const base = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async (u: any, o: any) => {
    if (String(u).includes('/rest/v1/rpc/generate_receipt_code')) {
      const code = `AVD-TEST-${String(++n).padStart(4, '0')}`;
      return { ok: true, status: 200, text: async () => JSON.stringify(code), json: async () => code, headers: new Map() } as any;
    }
    return base(u, o);
  }) as any;
});

beforeEach(async () => {
  h.reset();
  h.db.cash_registers.push({ id: 'reg-p1', code: 'P1', name: '1-kassa', is_active: true });
  const st = (id: string, login: string, role: string, register_id: string | null) =>
    h.db.staff.push({ id, login, password_hash: hashPassword('parol1234'), role, register_id, full_name: login, is_active: true });
  st('st-admin', 'boss', 'admin', null);
  st('st-op', 'operator1', 'operator', null);
  st('st-k1', 'kassa1', 'cashier', 'reg-p1');
  h.db.users.push({ id: 'u-admin', full_name: 'Admin', role: 'admin', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-tg', telegram_id: 777001, full_name: 'Mijoz Test', phone: '+998901110000', role: 'customer', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-ali', full_name: 'Ali Valiyev', phone: '+998901112233', role: 'customer', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-ins', full_name: 'Aziz Karimov', phone: '+998901114455', telegram_id: 880001, role: 'instructor', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-ins2', full_name: 'Anvar Sobirov', phone: '+998901114466', role: 'instructor', is_active: true, is_blocked: false });
  h.db.instructor_profiles.push({ id: 'ip-1', user_id: 'u-ins', is_verified: true, is_available: true, categories: ['B', 'C'] });
  h.db.instructor_profiles.push({ id: 'ip-2', user_id: 'u-ins2', is_verified: true, is_available: true, categories: ['B'] });
  h.db.courses.push({ id: 'c-b', name: 'B toifa', category: 'B', price: 250000, duration_minutes: 60, is_active: true });
  h.db.courses.push({ id: 'c-c', name: 'C toifa', category: 'C', price: 400000, duration_minutes: 60, is_active: true });
  h.db.admin_settings.push(
    { key: 'rate_b', value: 250000 }, { key: 'half_b', value: 150000 }, { key: 'rate_c', value: 400000 },
    { key: 'mgmt_pin', value: { hash: 'maxfiy' } },
  );
  admin = (await h.login('boss', 'parol1234')).cookie;
  operator = (await h.login('operator1', 'parol1234')).cookie;
  kassa1 = (await h.login('kassa1', 'parol1234')).cookie;
});

describe('Paket hisobi', () => {
  it('bo‘linish: faqat butun soatlar, jami 5 soat, 1–5 ta', () => {
    expect(splitError([300])).toBeNull();
    expect(splitError([180, 120])).toBeNull();
    expect(splitError([120, 120, 60])).toBeNull();
    expect(splitError([60, 60, 60, 60, 60])).toBeNull();
    expect(splitError([120, 120])).toMatch(/5 soat/);
    expect(splitError([150, 150])).toMatch(/butun soat/);
    expect(splitError([60, 60, 60, 60, 30, 30])).toMatch(/5 tagacha/);
  });
  it('narx soatiga qarab bo‘linadi, jami o‘zgarmaydi', () => {
    expect(shares(1_100_000, [180, 120])).toEqual([660000, 440000]);
    expect(shares(1_100_000, [60, 60, 60, 60, 60])).toEqual([220000, 220000, 220000, 220000, 220000]);
    const odd = shares(1_000_001, [120, 120, 60]);
    expect(odd.reduce((a, b) => a + b, 0)).toBe(1_000_001);
  });
  it('mashg‘ulotlar bir-birining ustiga tushsa — rad', () => {
    const r = parseSessions([{ start_at: at(D2, '10:00'), minutes: 180 }, { start_at: at(D2, '12:00'), minutes: 120 }]);
    expect('error' in r && r.error).toMatch(/ustiga/);
  });
});

describe('Mijoz: yangi davomiyliklar', () => {
  it('30 daqiqa — alohida narx, 30 daqiqa band', async () => {
    const r = await tg('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', duration_minutes: 30, start_at: at(D2, '10:00') });
    expect(r.status).toBe(201);
    expect(r.body.booking.duration_minutes).toBe(30);
    expect(r.body.booking.price).toBe(150000);
    expect(Date.parse(h.db.bookings[0].end_at) - Date.parse(h.db.bookings[0].start_at)).toBe(30 * 60000);
  });
  it('2 soat — 2 soat band, narx 2 × soat', async () => {
    const r = await tg('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', duration_minutes: 120, start_at: at(D2, '10:00') });
    expect(r.status).toBe(201);
    expect(r.body.booking.price).toBe(500000);
    expect(h.db.bookings[0].end_at).toBe(at(D2, '12:00'));
  });
  it('3–4 soat endi yo‘q; 5 soat — faqat paket', async () => {
    const r3 = await tg('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', duration_minutes: 180, start_at: at(D2, '10:00') });
    expect(r3.status).toBe(400);
    const r5 = await tg('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', duration_minutes: 300, start_at: at(D2, '10:00') });
    expect(r5.status).toBe(400);
    expect(r5.body.error).toMatch(/paket/i);
    expect(h.db.bookings).toHaveLength(0);
  });
  it('2 soatlik bronning ikkinchi soati boshqa mijozga BAND ko‘rinadi', async () => {
    await tg('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', duration_minutes: 120, start_at: at(D2, '10:00') });
    const av = await tg('GET', `/api/instructors/ip-1/availability?date=${D2}`);
    expect(av.status).toBe(200);
    expect(av.body.busy).toHaveLength(1);
    expect(av.body.busy[0].end_at).toBe(at(D2, '12:00'));
    // operator 11:00 ga qo'lda bron qilmoqchi — rad etiladi
    const m = await h.call('POST', '/api/admin/manual-booking', { cookie: operator, payload: {
      full_name: 'Boshqa Mijoz', phone: '+998907770000', instructor_id: 'ip-1', category: 'B', duration_minutes: 60, start_at: at(D2, '11:00') } });
    expect(m.status).toBe(409);
    expect(m.body.error).toMatch(/band/);
    // kassa ham 11:00 ga chek chiqarmaydi
    const k = await h.call('POST', '/api/admin/cashier/issue', { cookie: kassa1, payload: {
      register_token: makeRegisterToken('reg-p1'), full_name: 'Uchinchi', instructor_id: 'ip-1', course_id: 'c-b',
      category: 'B', duration_minutes: 60, start_at: at(D2, '11:00'), amount: 250000, cash_amount: 250000, card_amount: 0 } });
    expect(k.status).toBe(409);
    expect(h.db.bookings).toHaveLength(1);
    expect(h.db.payments).toHaveLength(0);
  });
});

describe('Mijoz: 5 soatlik paket', () => {
  it('3 + 2 soat — ikki bron, 660 000 + 440 000, bitta xabar', async () => {
    const r = await tg('POST', '/api/bookings/package', { instructor_id: 'ip-1', course_id: 'c-b', sessions: [
      { start_at: at(D3, '14:00'), minutes: 120 }, { start_at: at(D2, '09:00'), minutes: 180 }] });
    expect(r.status).toBe(201);
    expect(r.body.package.price).toBe(1_100_000);
    expect(r.body.package.list_price).toBe(1_250_000);
    const [a, b] = r.body.bookings;
    expect(a.start_at).toBe(at(D2, '09:00'));              // vaqt tartibida
    expect(a.price).toBe(660000);
    expect(b.price).toBe(440000);
    expect(a.duration_minutes).toBe(180);
    expect(h.db.bookings.map((x) => x.end_at)).toEqual([at(D2, '12:00'), at(D3, '16:00')]);
    expect(h.db.bookings.every((x) => x.status === 'pending' && /^AVD-\d+$/.test(x.pickup_code))).toBe(true);
    expect(h.db.bookings[0].customer_note).toMatch(/paket · 1\/2/);
    // Mijozga BITTA xabar — ikkala kod bilan
    const msgs = h.telegram.filter((m) => m.text.includes('5 soatlik paket'));
    expect(msgs.length).toBe(1);
    expect(msgs[0].text).toContain(h.db.bookings[0].pickup_code);
    expect(msgs[0].text).toContain(h.db.bookings[1].pickup_code);
    // Bronlarim — paket belgisi bilan
    const list = await tg('GET', '/api/bookings');
    expect(list.body.bookings.map((x: any) => x.package && `${x.package.n}/${x.package.of}`)).toEqual(['1/2', '2/2']);
  });

  it('har kuni 1 soatdan — 5 ta bron, har biri 220 000', async () => {
    const r = await tg('POST', '/api/bookings/package', { instructor_id: 'ip-1', course_id: 'c-b',
      sessions: [D2, D3, D4, D5, D6].map((d) => ({ start_at: at(d, '08:00'), minutes: 60 })) });
    expect(r.status).toBe(201);
    expect(h.db.bookings).toHaveLength(5);
    expect(h.db.bookings.map((x) => x.price)).toEqual([220000, 220000, 220000, 220000, 220000]);
  });

  it('bitta mashg‘ulot vaqti band bo‘lsa — HECH BIRI yozilmaydi', async () => {
    h.db.bookings.push({ id: 'b-old', customer_id: 'u-ali', instructor_id: 'ip-1', course_id: 'c-b', status: 'confirmed',
      start_at: at(D3, '09:00'), booking_date: at(D3, '09:00'), end_at: at(D3, '11:00'), duration_minutes: 120 });
    const r = await tg('POST', '/api/bookings/package', { instructor_id: 'ip-1', course_id: 'c-b', sessions: [
      { start_at: at(D2, '09:00'), minutes: 180 }, { start_at: at(D3, '10:00'), minutes: 120 }] });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/band/);
    expect(h.db.bookings).toHaveLength(1);
    expect(h.db.admin_settings.some((x) => String(x.key).startsWith('pack'))).toBe(false);
  });

  it('noto‘g‘ri bo‘linish, o‘tgan vaqt, toifani o‘rgatmaydigan instruktor — rad', async () => {
    const bad = await tg('POST', '/api/bookings/package', { instructor_id: 'ip-1', course_id: 'c-b', sessions: [
      { start_at: at(D2, '09:00'), minutes: 120 }, { start_at: at(D3, '09:00'), minutes: 120 }] });
    expect(bad.status).toBe(400);
    const past = await tg('POST', '/api/bookings/package', { instructor_id: 'ip-1', course_id: 'c-b', sessions: [
      { start_at: new Date(Date.now() - 3600e3).toISOString(), minutes: 300 }] });
    expect(past.status).toBe(400);
    const cat = await tg('POST', '/api/bookings/package', { instructor_id: 'ip-2', course_id: 'c-c', sessions: [
      { start_at: at(D2, '09:00'), minutes: 300 }] });
    expect(cat.status).toBe(409);
    expect(h.db.bookings).toHaveLength(0);
  });

  it('paket narxi sozlamadan; 0 — paket o‘chirilgan', async () => {
    h.db.admin_settings.push({ key: 'paket5_b', value: { value: 1_200_000 } }, { key: 'paket5_c', value: 0 });
    const ok = await tg('POST', '/api/bookings/package', { instructor_id: 'ip-1', course_id: 'c-b', sessions: [{ start_at: at(D2, '09:00'), minutes: 300 }] });
    expect(ok.status).toBe(201);
    expect(ok.body.bookings[0].price).toBe(1_200_000);
    const off = await tg('POST', '/api/bookings/package', { instructor_id: 'ip-1', course_id: 'c-c', sessions: [{ start_at: at(D4, '09:00'), minutes: 300 }] });
    expect(off.status).toBe(400);
    const pub = await h.call('GET', '/api/settings');
    expect(pub.body.settings.paket5_b).toBe(1_200_000);
  });
});

describe('Operator: qo‘lda paket', () => {
  it('2 + 2 + 1 — uch bron, kodlar, tasdiqlangan', async () => {
    const r = await h.call('POST', '/api/admin/manual-booking', { cookie: operator, payload: {
      full_name: 'Telefon Mijoz', phone: '+998909998877', instructor_id: 'ip-2', category: 'B', duration_minutes: 300,
      start_at: at(D2, '10:00'), sessions: [
        { start_at: at(D2, '10:00'), minutes: 120 }, { start_at: at(D3, '10:00'), minutes: 120 }, { start_at: at(D4, '10:00'), minutes: 60 }] } });
    expect(r.status).toBe(201);
    expect(r.body.pickup_codes).toHaveLength(3);
    expect(r.body.package.of).toBe(3);
    expect(h.db.bookings.map((x) => [x.status, x.price, x.source])).toEqual([
      ['confirmed', 440000, 'admin'], ['confirmed', 440000, 'admin'], ['confirmed', 220000, 'admin']]);
  });
  it('bir kunda 5 soat — bitta bron, paket narxi', async () => {
    const r = await h.call('POST', '/api/admin/manual-booking', { cookie: operator, payload: {
      full_name: 'Besh Soat', phone: '+998909998800', instructor_id: 'ip-1', category: 'B', duration_minutes: 300, start_at: at(D2, '08:00') } });
    expect(r.status).toBe(201);
    expect(h.db.bookings).toHaveLength(1);
    expect(h.db.bookings[0].price).toBe(1_100_000);
    expect(h.db.bookings[0].end_at).toBe(at(D2, '13:00'));
  });
});

describe('Kassa: paket', () => {
  const tok = () => makeRegisterToken('reg-p1');

  it('ko‘chadan kelgan mijoz: 5 soat — 1 100 000, bitta chek', async () => {
    const now = new Date(Date.now() + 60e3).toISOString();
    const r = await h.call('POST', '/api/admin/cashier/issue', { cookie: kassa1, payload: {
      register_token: tok(), full_name: 'Yangi Mijoz', phone: '+998901230077', instructor_id: 'ip-1', course_id: 'c-b',
      category: 'B', duration_minutes: 300, start_at: now, amount: 1_100_000, cash_amount: 1_100_000, card_amount: 0 } });
    expect(r.status).toBe(201);
    expect(r.body.receipts).toHaveLength(1);
    expect(r.body.receipt.amount).toBe(1_100_000);
    expect(r.body.receipt.package_text).toMatch(/paket/);
    expect(h.db.bookings[0].duration_minutes).toBe(300);
  });

  it('3 + 2 soat, naqd + terminal — ikki chek, summalar to‘g‘ri bo‘lingan', async () => {
    const r = await h.call('POST', '/api/admin/cashier/issue', { cookie: kassa1, payload: {
      register_token: tok(), full_name: 'Paket Mijoz', phone: '+998901230078', instructor_id: 'ip-1', course_id: 'c-b',
      category: 'B', duration_minutes: 300, start_at: at(D2, '09:00'),
      sessions: [{ start_at: at(D2, '09:00'), minutes: 180 }, { start_at: at(D3, '09:00'), minutes: 120 }],
      amount: 1_100_000, cash_amount: 600_000, card_amount: 500_000 } });
    expect(r.status).toBe(201);
    expect(r.body.receipts.map((x: any) => x.amount)).toEqual([660000, 440000]);
    const pays = h.db.payments;
    expect(pays).toHaveLength(2);
    expect(pays.reduce((a, p) => a + p.cash_amount, 0)).toBe(600000);
    expect(pays.reduce((a, p) => a + p.card_amount, 0)).toBe(500000);
    expect(pays.every((p) => p.cash_amount + p.card_amount === p.amount && p.cash_amount >= 0 && p.card_amount >= 0)).toBe(true);
    expect(new Set(pays.map((p) => p.receipt_code)).size).toBe(2);
  });

  it('mijoz ilovadan olgan paketni kassada bir yo‘la to‘laydi', async () => {
    await tg('POST', '/api/bookings/package', { instructor_id: 'ip-1', course_id: 'c-b', sessions: [
      { start_at: at(D2, '09:00'), minutes: 120 }, { start_at: at(D3, '09:00'), minutes: 120 }, { start_at: at(D4, '09:00'), minutes: 60 }] });
    const found = await h.call('GET', '/api/admin/cashier/find?q=Mijoz', { cookie: kassa1 });
    expect(found.status).toBe(200);
    const first = found.body.bookings.find((x: any) => x.package?.n === 1);
    expect(first.package.of).toBe(3);
    expect(first.price).toBe(440000);
    const r = await h.call('POST', '/api/admin/cashier/issue', { cookie: kassa1, payload: {
      register_token: tok(), booking_id: first.id, pay_package: true, category: 'B', duration_minutes: 120,
      amount: 1_100_000, cash_amount: 1_100_000, card_amount: 0 } });
    expect(r.status).toBe(201);
    expect(r.body.receipts.map((x: any) => x.amount)).toEqual([440000, 440000, 220000]);
    expect(h.db.bookings.every((b) => b.status === 'confirmed')).toBe(true);
    const again = await h.call('POST', '/api/admin/cashier/issue', { cookie: kassa1, payload: {
      register_token: tok(), booking_id: first.id, pay_package: true, category: 'B', duration_minutes: 120,
      amount: 1_100_000, cash_amount: 1_100_000, card_amount: 0 } });
    expect(again.status).toBe(409);
  });

  it('narx taklifi: 5 soat — paket narxi', async () => {
    const r = await h.call('GET', '/api/admin/price?category=B&minutes=300', { cookie: kassa1 });
    expect(r.body.price).toBe(1_100_000);
    const r2 = await h.call('GET', '/api/admin/price?category=B&minutes=120', { cookie: kassa1 });
    expect(r2.body.price).toBe(500000);
  });
});

describe('Instruktorlar kunlik jadvali', () => {
  it('bron butun davomiyligi bilan, yopiq soatlar bilan qaytadi; operator ham ko‘radi', async () => {
    h.db.bookings.push({ id: 'b-2h', customer_id: 'u-ali', instructor_id: 'ip-1', course_id: 'c-b', status: 'confirmed',
      start_at: at(D2, '10:00'), booking_date: at(D2, '10:00'), end_at: at(D2, '12:00'), duration_minutes: 120, pickup_code: 'AVD-1111' });
    h.db.bookings.push({ id: 'b-x', customer_id: 'u-ali', instructor_id: 'ip-2', course_id: 'c-b', status: 'cancelled',
      start_at: at(D2, '10:00'), booking_date: at(D2, '10:00'), end_at: at(D2, '11:00') });
    h.db.admin_settings.push({ key: 'instructor_busy:ip-2', value: { blocks: [{ start_at: at(D2, '14:00'), end_at: at(D2, '15:00') }] } });
    for (const cookie of [admin, operator, kassa1]) {
      const r = await h.call('GET', `/api/admin/schedule?date=${D2}`, { cookie });
      expect(r.status).toBe(200);
      expect(r.body.instructors.map((i: any) => i.name)).toEqual(['Anvar Sobirov', 'Aziz Karimov']);
      expect(r.body.bookings).toHaveLength(1);                 // bekor qilingan chiqmaydi
      expect(r.body.bookings[0]).toMatchObject({ minutes: 120, customer_name: 'Ali Valiyev', instructor_id: 'ip-1', end_at: at(D2, '12:00') });
      expect(r.body.blocks).toEqual([{ instructor_id: 'ip-2', start_at: at(D2, '14:00'), end_at: at(D2, '15:00') }]);
    }
  });

  it('admin sozlamalar ro‘yxatida paket yozuvlari ko‘rinmaydi', async () => {
    await tg('POST', '/api/bookings/package', { instructor_id: 'ip-1', course_id: 'c-b', sessions: [{ start_at: at(D2, '09:00'), minutes: 300 }] });
    expect(h.db.admin_settings.some((x) => String(x.key).startsWith('pack:'))).toBe(true);
    const r = await h.call('GET', '/api/admin/settings', { cookie: admin });
    expect(r.status).toBe(200);
    expect(r.body.settings.some((x: any) => /^pack/.test(x.key))).toBe(false);
    expect(r.body.settings.some((x: any) => x.key === 'rate_b')).toBe(true);
  });
});
