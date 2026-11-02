/**
 * TEST DRIVE — kassada «Chek chiqarish» tepasidagi tugma.
 * Bosilsa chek faqat «1 krug» bo'ladi: soat va vaqt tanlanmaydi, narxi
 * 1 krug + test drive (80 000 + 50 000 = 130 000), instruktor hisobotiga 15 daqiqa.
 * Chekda va kassa hisobotida test drive alohida ko'rinadi.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import { makeRegisterToken } from '../backend/src/shift-routes.js';
import { testDriveOf, loadTestDrive } from '../backend/src/pricing.js';

let h: Harness;
let kassa1 = '';
const A_TG = 880701;
const issue = (extra: any) => h.call('POST', '/api/admin/cashier/issue', { cookie: kassa1, payload: {
  register_token: makeRegisterToken('reg-p1'), full_name: 'Test Mijoz', phone: '+998901239900', course_id: 'c-b', category: 'B',
  card_amount: 0, ...extra, cash_amount: extra.amount } });
function signedInitData(user: Record<string, unknown>, botToken = '1:instructor') {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAtest', user: JSON.stringify(user) });
  const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dataCheck).digest('hex'));
  return params.toString();
}
const A = (method: string, url: string, payload?: any) =>
  h.app.inject({ method, url, payload, headers: { 'x-telegram-init-data': signedInitData({ id: A_TG, first_name: 'Aziz' }) } })
    .then((r: any) => ({ status: r.statusCode, body: JSON.parse(r.body || '{}') }));
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());

beforeAll(async () => {
  h = await makeHarness();
  const base = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async (u: any, o: any) => {
    if (String(u).includes('/rest/v1/rpc/generate_receipt_code')) {
      const code = `AVD-261102-T${String(++n).padStart(4, '0')}`;
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
  h.db.instructor_profiles.push({ id: 'ip-a', user_id: 'u-a', is_verified: true, is_available: true, categories: ['B'] });
  h.db.courses.push({ id: 'c-b', name: 'B toifa', category: 'B', price: 250000, duration_minutes: 60, is_active: true });
  h.db.admin_settings.push({ key: 'rate_b', value: 250000 });
  kassa1 = (await h.login('kassa1', 'parol1234')).cookie;
});

describe('Test drive — faqat 1 krug, 130 000', () => {
  it('sozlama: yo‘q bo‘lsa 50 000; 0 — o‘chiq; izohdan summa o‘qiladi', async () => {
    expect(await loadTestDrive()).toBe(50000);
    h.db.admin_settings.push({ key: 'test_drive_price', value: 60000 });
    expect(await loadTestDrive()).toBe(60000);
    h.db.admin_settings.find((x: any) => x.key === 'test_drive_price').value = 0;
    expect(await loadTestDrive()).toBe(0);
    expect(testDriveOf('1 krug · Test drive 50000')).toBe(50000);
    expect(testDriveOf('5 soatlik paket · 2/5')).toBe(0);
  });

  it('chek: 1 krug, 15 daqiqa, 130 000; test drive chekda va izohda alohida', async () => {
    const r = await issue({ test_drive: true, amount: 130000 });
    expect(r.status).toBe(201);
    expect(r.body.receipt).toMatchObject({ amount: 130000, test_drive: 50000, krug_text: '1 krug' });
    expect(h.db.payments).toHaveLength(1);
    expect(h.db.payments[0]).toMatchObject({ amount: 130000, note: '1 krug · Test drive 50000' });
    const b = h.db.bookings[0];
    expect(b.duration_minutes).toBe(15);
    expect(Date.parse(b.end_at) - Date.parse(b.start_at)).toBe(15 * 60000);
    expect(b.customer_note).toBe('Test drive · 1 krug');
  });

  it('soat yuborilsa ham (60, 300) — baribir 1 krug: narx 130 000 dan farq qilsa maxsus parol kerak', async () => {
    for (const [min, amount] of [[60, 300000], [300, 1_150_000], [60, 80000]]) {
      const r = await issue({ test_drive: true, duration_minutes: min, amount });
      expect(r.body.needs_price_pin).toBe(true);
      expect(r.body.expected).toBe(130000);
    }
    expect(h.db.payments).toHaveLength(0);
    const ok = await issue({ test_drive: true, duration_minutes: 300, amount: 130000 });
    expect(ok.status).toBe(201);
    expect(h.db.payments).toHaveLength(1);                                   // paket emas — bitta chek
    expect(h.db.bookings[0].duration_minutes).toBe(15);
  });

  it('bron to‘loviga test drive qo‘shilmaydi — 400', async () => {
    h.db.users.push({ id: 'u-m', full_name: 'Bron Mijoz', phone: '+998901110000', role: 'customer', is_active: true, is_blocked: false });
    const st = new Date(Date.now() + 3600e3).toISOString();
    h.db.bookings.push({ id: 'b-1', customer_id: 'u-m', instructor_id: 'ip-a', course_id: 'c-b', start_at: st, booking_date: st,
      end_at: new Date(Date.parse(st) + 3600e3).toISOString(), duration_minutes: 60, status: 'confirmed', source: 'app', price: 250000 });
    const r = await issue({ booking_id: 'b-1', test_drive: true, duration_minutes: 60, amount: 300000 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Test drive faqat bronsiz/);
    expect(h.db.payments).toHaveLength(0);
  });

  it('test drivesiz — hech narsa o‘zgarmaydi (1 soat 250 000)', async () => {
    const r = await issue({ duration_minutes: 60, amount: 250000 });
    expect(r.status).toBe(201);
    expect(r.body.receipt.test_drive).toBeNull();
    expect(h.db.bookings[0].duration_minutes).toBe(60);
    expect(h.db.payments[0].note || '').not.toMatch(/Test drive/);
  });

  it('o‘chirilgan (0) bo‘lsa — test drive bilan chek chiqmaydi', async () => {
    h.db.admin_settings.push({ key: 'test_drive_price', value: 0 });
    const r = await issue({ test_drive: true, amount: 130000 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Test drive o‘chirilgan/);
  });

  it('instruktor chekni ursa — hisobotiga 15 daqiqa, 130 000', async () => {
    const r = await issue({ test_drive: true, amount: 130000 });
    expect((await A('POST', '/api/instructor/scan/start', { code: r.body.receipt.short_code })).status).toBe(200);
    const rep = await h.call('GET', `/api/admin/instructor-report?from=${today()}&to=${today()}&rows=1`, { cookie: kassa1 });
    expect(rep.status).toBe(200);
    expect(rep.body.lessons).toHaveLength(1);
    expect(rep.body.lessons[0]).toMatchObject({ instructor_id: 'ip-a', minutes: 15, amount: 130000 });
  });

  it('kassa hisobotida test drive alohida: soni va summasi; Cheklar ro‘yxatida belgisi', async () => {
    expect((await issue({ test_drive: true, amount: 130000 })).status).toBe(201);
    expect((await issue({ test_drive: true, amount: 130000, full_name: 'Ikkinchi Mijoz', phone: '+998901239911' })).status).toBe(201);
    expect((await issue({ duration_minutes: 60, amount: 250000, full_name: 'Uchinchi Mijoz', phone: '+998901239922' })).status).toBe(201);
    const tok = makeRegisterToken('reg-p1');
    const d = await h.call('GET', `/api/admin/my-dashboard?token=${tok}&period=day`, { cookie: kassa1 });
    expect(d.status).toBe(200);
    expect(d.body.test_drive).toEqual({ count: 2, total: 100000 });
    const rc = await h.call('GET', `/api/admin/cashier/receipts?token=${tok}&from=${today()}&to=${today()}`, { cookie: kassa1 });
    expect(rc.status).toBe(200);
    const rows = rc.body.receipts || rc.body.rows || [];
    expect(rows.filter((x: any) => x.test_drive).map((x: any) => x.test_drive)).toEqual([50000, 50000]);
  });
});
