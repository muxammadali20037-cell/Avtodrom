/**
 * TO'RT PANEL: Admin · Kassa P1 · Kassa P2 · Operator.
 * Har biri faqat o'z ishini ko'radi — bir-biriga aralashmaydi.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import { makeRegisterToken } from '../backend/src/shift-routes.js';

let h: Harness;
let admin = '', operator = '', kassa1 = '', kassa2 = '';

const TZ_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
const todayAt = (hm: string) => new Date(`${TZ_DAY}T${hm}:00+05:00`).toISOString();

beforeAll(async () => { h = await makeHarness(); });

beforeEach(async () => {
  h.reset();
  h.db.cash_registers.push({ id: 'reg-p1', code: 'P1', name: '1-kassa', is_active: true });
  h.db.cash_registers.push({ id: 'reg-p2', code: 'P2', name: '2-kassa', is_active: true });
  const st = (id: string, login: string, role: string, register_id: string | null) =>
    h.db.staff.push({ id, login, password_hash: hashPassword('parol1234'), role, register_id, full_name: login, is_active: true });
  st('st-admin', 'boss', 'admin', null);
  st('st-op', 'operator1', 'operator', null);
  st('st-k1', 'kassa1', 'cashier', 'reg-p1');
  st('st-k2', 'kassa2', 'cashier', 'reg-p2');
  h.db.users.push({ id: 'u-admin', full_name: 'Admin', role: 'admin', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-ali', full_name: 'Ali Valiyev', phone: '+998901112233', role: 'customer', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-ins', full_name: 'Aziz Karimov', phone: '+998901114455', role: 'instructor', is_active: true, is_blocked: false });
  h.db.instructor_profiles.push({ id: 'ip-1', user_id: 'u-ins', is_verified: true, is_available: true, categories: ['B'] });
  h.db.courses.push({ id: 'c-b', name: 'B toifa', category: 'B', price: 250000, duration_minutes: 60, is_active: true });
  h.db.admin_settings.push({ key: 'rate_b', value: 250000 }, { key: 'mgmt_pin', value: { hash: 'maxfiy' } });

  admin = (await h.login('boss', 'parol1234')).cookie;
  operator = (await h.login('operator1', 'parol1234')).cookie;
  kassa1 = (await h.login('kassa1', 'parol1234')).cookie;
  kassa2 = (await h.login('kassa2', 'parol1234')).cookie;
});

describe('Operator paneli', () => {
  it('operator kiradi va roli «operator»', async () => {
    const r = await h.login('operator1', 'parol1234');
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('operator');
    const me = await h.call('GET', '/api/admin/me', { cookie: operator });
    expect(me.status).toBe(200);
    expect(me.body.role).toBe('operator');
  });

  it('bronlar, tasdiqlash, bekor so‘rovlari, chat — ochiq', async () => {
    h.db.bookings.push({ id: 'b-1', customer_id: 'u-ali', instructor_id: 'ip-1', course_id: 'c-b',
      start_at: todayAt('15:00'), booking_date: todayAt('15:00'), end_at: todayAt('16:00'), status: 'pending' });
    const list = await h.call('GET', '/api/admin/bookings', { cookie: operator });
    expect(list.status).toBe(200);
    const ok = await h.call('PATCH', '/api/admin/bookings/b-1/status', { cookie: operator, payload: { status: 'confirmed' } });
    expect(ok.status).toBe(200);
    expect(h.db.bookings[0].status).toBe('confirmed');
    expect((await h.call('GET', '/api/admin/cancellation-requests', { cookie: operator })).status).toBe(200);
    expect((await h.call('GET', '/api/admin/support', { cookie: operator })).status).toBe(200);
    expect((await h.call('GET', '/api/admin/courses', { cookie: operator })).status).toBe(200);
  });

  it('qo‘lda bron qila oladi', async () => {
    const r = await h.call('POST', '/api/admin/manual-booking', { cookie: operator, payload: {
      full_name: 'Yangi Mijoz', phone: '+998907776655', instructor_id: 'ip-1', category: 'B',
      duration_minutes: 60, start_at: new Date(Date.now() + 26 * 3600e3).toISOString() } });
    expect(r.status).not.toBe(403);
    expect(r.status).toBeLessThan(300);
  });

  it('sozlamalardan faqat ish uchun keraklilari keladi (PIN xeshi yo‘q)', async () => {
    const r = await h.call('GET', '/api/admin/settings', { cookie: operator });
    expect(r.status).toBe(200);
    const keys = r.body.settings.map((x: any) => x.key);
    expect(keys).toContain('rate_b');
    expect(keys).not.toContain('mgmt_pin');
    const full = await h.call('GET', '/api/admin/settings', { cookie: admin });
    expect(full.body.settings.map((x: any) => x.key)).toContain('mgmt_pin');
  });

  it('kassa, pul, hisobot, xodimlar, sozlash — YOPIQ', async () => {
    const closed: Array<[string, string, any?]> = [
      ['GET', '/api/admin/payments'],
      ['GET', '/api/admin/stats'],
      ['GET', '/api/admin/analytics?period=day'],
      ['GET', '/api/admin/register-report?period=day'],
      ['GET', '/api/admin/registers'],
      ['GET', '/api/admin/staff'],
      ['GET', '/api/admin/instructors'],
      ['GET', '/api/admin/customers'],
      ['GET', '/api/admin/audit-logs'],
      ['GET', '/api/admin/in-progress'],
      ['GET', '/api/admin/cashier/receipts?token=' + makeRegisterToken('reg-p1')],
      ['GET', '/api/admin/cashier/day'],
      ['POST', '/api/admin/cashier/issue', { register_token: makeRegisterToken('reg-p1') }],
      ['POST', '/api/admin/registers/reg-p1/unlock', { pin: '' }],
      ['PUT', '/api/admin/settings/rate_b', { value: 1 }],
      ['PATCH', '/api/admin/courses/c-b', { price: 1 }],
    ];
    for (const [m, u, payload] of closed) {
      const r = await h.call(m, u, { cookie: operator, payload });
      expect(r.status, `${m} ${u}`).toBe(403);
    }
  });
});

describe('Kassalar bir-biriga aralashmaydi', () => {
  it('kassir bronlar ro‘yxati va bekor so‘rovlariga kira olmaydi (bu operator ishi)', async () => {
    expect((await h.call('GET', '/api/admin/bookings', { cookie: kassa1 })).status).toBe(403);
    expect((await h.call('GET', '/api/admin/cancellation-requests', { cookie: kassa1 })).status).toBe(403);
  });

  it('P1 kassiri P2 kassani ocha olmaydi', async () => {
    expect((await h.call('POST', '/api/admin/registers/reg-p2/unlock', { cookie: kassa1, payload: { pin: '' } })).status).toBe(403);
    expect((await h.call('POST', '/api/admin/registers/reg-p1/unlock', { cookie: kassa1, payload: { pin: '' } })).status).toBe(200);
  });

  it('P1 kassiri P2 tokeni bilan chek chiqara olmaydi', async () => {
    const r = await h.call('POST', '/api/admin/cashier/issue', { cookie: kassa1, payload: {
      register_token: makeRegisterToken('reg-p2'), full_name: 'X', instructor_id: 'ip-1', course_id: 'c-b',
      category: 'B', duration_minutes: 60, amount: 250000, cash_amount: 250000, card_amount: 0,
      start_at: new Date().toISOString() } });
    expect(r.status).toBe(403);
  });

  it('kassa hisobotida kassir faqat o‘z kassasini ko‘radi', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (u: any, o: any) => {
      if (String(u).includes('/rest/v1/rpc/register_report')) {
        const rows = [
          { register_id: 'reg-p1', code: 'P1', receipts: 3, cash: 300, card: 0, total: 300 },
          { register_id: 'reg-p2', code: 'P2', receipts: 5, cash: 500, card: 0, total: 500 },
        ];
        return { ok: true, status: 200, text: async () => JSON.stringify(rows), headers: new Map() } as any;
      }
      return orig(u, o);
    }) as any;
    try {
      const k = await h.call('GET', '/api/admin/register-report?period=day', { cookie: kassa1 });
      expect(k.body.registers.map((r: any) => r.code)).toEqual(['P1']);
      const a = await h.call('GET', '/api/admin/register-report?period=day', { cookie: admin });
      expect(a.body.registers.map((r: any) => r.code)).toEqual(['P1', 'P2']);
    } finally { globalThis.fetch = orig; }
  });
});

describe('Chiqarilgan cheklar (faqat kassa oynasida)', () => {
  beforeEach(() => {
    const bk = (id: string, status: string, extra: any = {}) => h.db.bookings.push({
      id, customer_id: 'u-ali', instructor_id: 'ip-1', course_id: 'c-b', category: 'B', duration_minutes: 60,
      start_at: todayAt('10:00'), booking_date: todayAt('10:00'), end_at: todayAt('11:00'), status, ...extra });
    const pay = (id: string, booking_id: string, code: string, at: string, extra: any = {}) => h.db.payments.push({
      id, booking_id, customer_id: 'u-ali', amount: 250000, method: 'cash', status: 'paid',
      paid_at: at, receipt_code: code, register_id: 'reg-p1', ...extra });
    bk('b-act', 'confirmed');
    bk('b-used', 'in_progress', { arrived_at: todayAt('10:02') });
    bk('b-scan', 'confirmed');
    bk('b-ns', 'no_show');
    bk('b-ref', 'confirmed');
    bk('b-p2', 'confirmed');
    bk('b-old', 'completed');
    pay('p1', 'b-act', 'AVD-260925-AAAAA', todayAt('09:10'));
    pay('p2', 'b-used', 'AVD-260925-BBBBB', todayAt('09:20'));
    pay('p3', 'b-scan', 'AVD-260925-CCCCC', todayAt('09:30'));
    pay('p4', 'b-ns', 'AVD-260925-DDDDD', todayAt('09:40'));
    pay('p5', 'b-ref', 'AVD-260925-EEEEE', todayAt('09:50'), { status: 'refunded' });
    pay('p6', 'b-p2', 'AVD-260925-FFFFF', todayAt('09:55'), { register_id: 'reg-p2' });
    pay('p7', 'b-old', 'AVD-260901-GGGGG', new Date(Date.now() - 5 * 864e5).toISOString());
    h.db.attendance_verifications.push({ booking_id: 'b-scan', receipt_code: 'AVD-260925-CCCCC', created_at: todayAt('09:58') });
  });

  it('bugungi cheklar holati bilan: faol, ishlatilgan, kelmadi, bekor', async () => {
    const r = await h.call('GET', `/api/admin/cashier/receipts?token=${makeRegisterToken('reg-p1')}`, { cookie: kassa1 });
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.receipts.map((x: any) => [x.code, x.state]));
    expect(by).toEqual({
      'AVD-260925-AAAAA': 'active',
      'AVD-260925-BBBBB': 'used',
      'AVD-260925-CCCCC': 'used',
      'AVD-260925-DDDDD': 'no_show',
      'AVD-260925-EEEEE': 'cancelled',
    });
    expect(r.body.summary).toMatchObject({ total: 5, active: 1, used: 2, no_show: 1, cancelled: 1, amount: 1000000 });
    // Eng yangisi tepada, vaqti bilan
    expect(r.body.receipts[0].code).toBe('AVD-260925-EEEEE');
    expect(r.body.receipts.find((x: any) => x.code === 'AVD-260925-CCCCC').used_at).toBe(todayAt('09:58'));
    expect(r.body.receipts[0].customer.full_name).toBe('Ali Valiyev');
    expect(r.body.receipts[0].instructor_name).toBe('Aziz Karimov');
  });

  it('P2 kassiri P1 cheklarini ko‘rmaydi va qayta chiqara olmaydi', async () => {
    const r = await h.call('GET', `/api/admin/cashier/receipts?token=${makeRegisterToken('reg-p1')}`, { cookie: kassa2 });
    expect(r.status).toBe(403);
    const own = await h.call('GET', `/api/admin/cashier/receipts?token=${makeRegisterToken('reg-p2')}`, { cookie: kassa2 });
    expect(own.body.receipts.map((x: any) => x.code)).toEqual(['AVD-260925-FFFFF']);
    const re = await h.call('GET', '/api/admin/cashier/receipt/AVD-260925-AAAAA', { cookie: kassa2 });
    expect(re.status).toBe(403);
    const mine = await h.call('GET', '/api/admin/cashier/receipt/AVD-260925-AAAAA', { cookie: kassa1 });
    expect(mine.status).toBe(200);
    expect(mine.body.receipt.code).toBe('AVD-260925-AAAAA');
  });

  it('kassa tokenisiz ro‘yxat berilmaydi; boshqa kun tanlasa o‘sha kun', async () => {
    expect((await h.call('GET', '/api/admin/cashier/receipts', { cookie: kassa1 })).status).toBe(401);
    const old = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date(Date.now() - 5 * 864e5));
    const r = await h.call('GET', `/api/admin/cashier/receipts?date=${old}&token=${makeRegisterToken('reg-p1')}`, { cookie: kassa1 });
    expect(r.body.receipts.map((x: any) => x.code)).toEqual(['AVD-260901-GGGGG']);
    expect(r.body.receipts[0].state).toBe('used');
  });
});

describe('Xodimlar: operator login berish', () => {
  it('admin operator yaratadi, unga kassa biriktirilmaydi', async () => {
    const r = await h.call('POST', '/api/admin/staff', { cookie: admin, payload: {
      login: 'operator2', password: 'parol1234', role: 'operator', register_id: 'reg-p1', full_name: 'Operator' } });
    expect(r.status).toBe(201);
    const row = h.db.staff.find((x: any) => x.login === 'operator2');
    expect(row.role).toBe('operator');
    expect(row.register_id).toBeNull();
    const l = await h.login('operator2', 'parol1234');
    expect(l.body.role).toBe('operator');
  });
});
