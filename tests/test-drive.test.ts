/**
 * TEST DRIVE — kassada «Chek chiqarish» tepasidagi tugma.
 * Bosilsa hamma narxga (1 krug, 30 daq … 3 soat, 5 soatlik paket) +50 000.
 * Paketda bir marta — 1-chekka. Chekda va kassa hisobotida alohida ko'rinadi.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import { makeRegisterToken } from '../backend/src/shift-routes.js';
import { testDriveOf, loadTestDrive } from '../backend/src/pricing.js';

let h: Harness;
let kassa1 = '';
const issue = (extra: any) => h.call('POST', '/api/admin/cashier/issue', { cookie: kassa1, payload: {
  register_token: makeRegisterToken('reg-p1'), full_name: 'Test Mijoz', phone: '+998901239900', course_id: 'c-b', category: 'B',
  card_amount: 0, ...extra, cash_amount: extra.amount } });

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
  h.db.courses.push({ id: 'c-b', name: 'B toifa', category: 'B', price: 250000, duration_minutes: 60, is_active: true });
  h.db.admin_settings.push({ key: 'rate_b', value: 250000 });
  kassa1 = (await h.login('kassa1', 'parol1234')).cookie;
});

describe('Test drive', () => {
  it('sozlama: yo‘q bo‘lsa 50 000; 0 — o‘chiq; izohdan summa o‘qiladi', async () => {
    expect(await loadTestDrive()).toBe(50000);
    h.db.admin_settings.push({ key: 'test_drive_price', value: 60000 });
    expect(await loadTestDrive()).toBe(60000);
    h.db.admin_settings.find((x: any) => x.key === 'test_drive_price').value = 0;
    expect(await loadTestDrive()).toBe(0);
    expect(testDriveOf('1 krug · Test drive 50000')).toBe(50000);
    expect(testDriveOf('5 soatlik paket · 2/5')).toBe(0);
  });

  it('1 soat + test drive = 300 000; test drive chekda va to‘lov izohida alohida', async () => {
    const r = await issue({ duration_minutes: 60, amount: 300000, test_drive: true });
    expect(r.status).toBe(201);
    expect(r.body.receipt.amount).toBe(300000);
    expect(r.body.receipt.test_drive).toBe(50000);
    expect(h.db.payments).toHaveLength(1);
    const p = h.db.payments[0];
    expect(p.amount).toBe(300000);
    expect(p.note).toMatch(/Test drive 50000/);
  });

  it('narx tekshiriladi: test drive bilan 250 000 (50 000 kam) — maxsus parolsiz o‘tmaydi', async () => {
    const r = await issue({ duration_minutes: 60, amount: 250000, test_drive: true });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.needs_price_pin).toBe(true);
    expect(r.body.expected).toBe(300000);
    expect(h.db.payments).toHaveLength(0);
  });

  it('1 krug + test drive = 130 000', async () => {
    const r = await issue({ krug: true, duration_minutes: 15, amount: 130000, test_drive: true });
    expect(r.status).toBe(201);
    expect(r.body.receipt.amount).toBe(130000);
    expect(r.body.receipt.test_drive).toBe(50000);
  });

  it('5 soatlik paket + test drive = 1 150 000: 1-chek 270 000 (test drive bilan), qolgan 4 tasi 220 000', async () => {
    const r = await issue({ duration_minutes: 300, amount: 1_150_000, test_drive: true });
    expect(r.status).toBe(201);
    const rs = r.body.receipts as any[];
    expect(rs).toHaveLength(5);
    expect(rs.map((x) => x.amount)).toEqual([270000, 220000, 220000, 220000, 220000]);
    expect(rs.map((x) => x.test_drive || 0)).toEqual([50000, 0, 0, 0, 0]);
    const notes = h.db.payments.map((p: any) => p.note);
    expect(notes.filter((n: string) => /Test drive/.test(n))).toHaveLength(1);
    expect(notes[0]).toMatch(/5 soatlik paket · 1\/5 · Test drive 50000/);
    // Paket yozuvi va bronlar — darsning o'z narxi (test drivesiz)
    expect(h.db.bookings.map((b: any) => b.price).filter(Boolean)).toEqual([220000, 220000, 220000, 220000, 220000]);
  });

  it('test drivesiz — hech narsa o‘zgarmaydi (1 soat 250 000, izohda test drive yo‘q)', async () => {
    const r = await issue({ duration_minutes: 60, amount: 250000 });
    expect(r.status).toBe(201);
    expect(r.body.receipt.test_drive).toBeNull();
    expect(h.db.payments[0].note || '').not.toMatch(/Test drive/);
  });

  it('o‘chirilgan (0) bo‘lsa — test drive bilan chek chiqmaydi', async () => {
    h.db.admin_settings.push({ key: 'test_drive_price', value: 0 });
    const r = await issue({ duration_minutes: 60, amount: 300000, test_drive: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Test drive o‘chirilgan/);
  });

  it('kassa hisobotida test drive alohida: soni va summasi; Cheklar ro‘yxatida belgisi', async () => {
    await issue({ duration_minutes: 60, amount: 300000, test_drive: true });
    await issue({ duration_minutes: 300, amount: 1_150_000, test_drive: true });
    await issue({ duration_minutes: 60, amount: 250000 });
    const tok = makeRegisterToken('reg-p1');
    const d = await h.call('GET', `/api/admin/my-dashboard?token=${tok}&period=day`, { cookie: kassa1 });
    expect(d.status).toBe(200);
    expect(d.body.test_drive).toEqual({ count: 2, total: 100000 });
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
    const rc = await h.call('GET', `/api/admin/cashier/receipts?token=${tok}&from=${day}&to=${day}`, { cookie: kassa1 });
    expect(rc.status).toBe(200);
    const rows = rc.body.receipts || rc.body.rows || [];
    expect(rows.filter((x: any) => x.test_drive).map((x: any) => x.test_drive).sort()).toEqual([50000, 50000]);
  });
});
