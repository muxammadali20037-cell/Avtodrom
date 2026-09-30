/**
 * AUDIT — ishga tushirishdan oldingi tuzatishlar:
 *  · administrator IKKALA kassani (P1 + P2) birga yoki alohida ko'radi — istalgan davr
 *  · to'lov faqat kassa orqali va kassaga bog'langan (P1/P2 hisobotidan tushib qolmaydi)
 *  · kutilayotgan to'lov summasi — bron narxi (2 soat = 2 × soat)
 *  · noto'g'ri yopilgan bronni administrator qayta ochadi
 *  · aralash to'lov naqd/karta bo'linadi; chek ochiq smenaga bog'lanadi
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import { makeRegisterToken } from '../backend/src/shift-routes.js';

let h: Harness;
let admin = '', operator = '', kassa1 = '', kassa2 = '';
const D = (s: string) => new Date(s).toISOString();

beforeAll(async () => {
  h = await makeHarness();
  const base = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async (u: any, o: any) => {
    const url = String(u);
    if (url.includes('/rest/v1/rpc/generate_receipt_code')) {
      const code = `AVD-TEST-${String(++n).padStart(4, '0')}`;
      return { ok: true, status: 200, text: async () => JSON.stringify(code), json: async () => code, headers: new Map() } as any;
    }
    /* Kassa dashboardi — bazadagi funksiya o'rniga soddalashtirilgan hisob */
    if (url.includes('/rest/v1/rpc/register_dashboard')) {
      const b = JSON.parse(String(o.body || '{}'));
      const rows = h.db.payments.filter((p: any) => String(p.register_id) === String(b.p_register) && p.status === 'paid'
        && p.paid_at >= b.p_from && p.paid_at < b.p_to);
      const sum = (f: (p: any) => number) => rows.reduce((a: number, p: any) => a + f(p), 0);
      const totals = { receipts: rows.length, total: sum((p) => Number(p.amount)),
        cash: sum((p) => p.method === 'mixed' ? Number(p.cash_amount) : p.method === 'cash' ? Number(p.amount) : 0),
        card: sum((p) => p.method === 'mixed' ? Number(p.card_amount) : p.method === 'card' ? Number(p.amount) : 0),
        minutes: rows.length * 60, customers: new Set(rows.map((p: any) => p.customer_id)).size };
      const hours = [{ hour: 10, receipts: rows.length, total: totals.total }];
      const categories = rows.length ? [{ name: 'B', receipts: rows.length, total: totals.total }] : [];
      const recent = rows.map((p: any) => ({ receipt_code: p.receipt_code, paid_at: p.paid_at, amount: Number(p.amount), method: p.method, customer_name: 'X', instructor_name: 'Y', category: 'B', mins: 60 }));
      const body = { totals, hours, categories, instructors: [{ name: 'Aziz', receipts: rows.length, total: totals.total }], recent };
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body, headers: new Map() } as any;
    }
    return base(u, o);
  }) as any;
});

beforeEach(async () => {
  h.reset();
  h.db.cash_registers.push({ id: 'reg-p1', code: 'P1', name: '1-kassa', is_active: true });
  h.db.cash_registers.push({ id: 'reg-p2', code: 'P2', name: '2-kassa', is_active: true });
  const st = (id: string, login: string, role: string, register_id: string | null) =>
    h.db.staff.push({ id, login, password_hash: hashPassword('parol1234'), role, register_id, full_name: login, is_active: true });
  st('st-admin', 'boss', 'admin', null); st('st-op', 'operator1', 'operator', null);
  st('st-k1', 'kassa1', 'cashier', 'reg-p1'); st('st-k2', 'kassa2', 'cashier', 'reg-p2');
  h.db.users.push({ id: 'u-admin', full_name: 'Admin', role: 'admin', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-ali', full_name: 'Ali Valiyev', phone: '+998901112233', role: 'customer', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-vali', full_name: 'Vali Aliyev', phone: '+998901112244', role: 'customer', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-ins', full_name: 'Aziz Karimov', phone: '+998901114455', role: 'instructor', is_active: true, is_blocked: false });
  h.db.instructor_profiles.push({ id: 'ip-1', user_id: 'u-ins', is_verified: true, is_available: true, categories: ['B'] });
  h.db.courses.push({ id: 'c-b', name: 'B toifa', category: 'B', price: 250000, duration_minutes: 60, is_active: true });
  h.db.admin_settings.push({ key: 'rate_b', value: 250000 }, { key: 'half_b', value: 150000 });
  admin = (await h.login('boss', 'parol1234')).cookie;
  operator = (await h.login('operator1', 'parol1234')).cookie;
  kassa1 = (await h.login('kassa1', 'parol1234')).cookie;
  kassa2 = (await h.login('kassa2', 'parol1234')).cookie;
});

/* Oktabr oyi: P1 da 2 ta, P2 da 1 ta chek, bitta kassasiz eski to'lov */
function seedOctober() {
  const bk = (id: string, start: string, status = 'completed') => h.db.bookings.push({ id, customer_id: 'u-ali', instructor_id: 'ip-1', course_id: 'c-b',
    start_at: D(start), end_at: new Date(Date.parse(start) + 3600e3).toISOString(), booking_date: D(start), status, duration_minutes: 60, category: 'B', price: 250000 });
  const pay = (id: string, bid: string, reg: string | null, at: string, amount: number, method = 'cash', extra: any = {}) => h.db.payments.push({
    id, booking_id: bid, customer_id: 'u-ali', amount, method, status: 'paid', paid_at: D(at), receipt_code: 'AVD-' + id.toUpperCase(),
    register_id: reg, cash_amount: method === 'cash' ? amount : method === 'mixed' ? extra.cash : 0, card_amount: method === 'card' ? amount : method === 'mixed' ? extra.card : 0, ...extra });
  bk('b1', '2026-10-03T10:00:00+05:00'); pay('p1', 'b1', 'reg-p1', '2026-10-03T09:50:00+05:00', 250000);
  bk('b2', '2026-10-15T11:00:00+05:00'); pay('p2', 'b2', 'reg-p1', '2026-10-15T10:55:00+05:00', 500000, 'mixed', { cash: 300000, card: 200000 });
  bk('b3', '2026-10-31T18:00:00+05:00'); pay('p3', 'b3', 'reg-p2', '2026-10-31T17:50:00+05:00', 250000, 'card');
  bk('b4', '2026-10-20T09:00:00+05:00'); pay('p4', 'b4', null, '2026-10-20T08:50:00+05:00', 150000);          // eski, kassasiz
  bk('b5', '2026-11-01T09:00:00+05:00'); pay('p5', 'b5', 'reg-p1', '2026-11-01T08:50:00+05:00', 250000);     // keyingi oy
  bk('b6', '2026-10-10T09:00:00+05:00', 'cancelled'); pay('p6', 'b6', 'reg-p1', '2026-10-10T08:50:00+05:00', 250000); // bron bekor, pul qaytarilmagan
}

describe('Administrator: ikkala kassa, istalgan davr', () => {
  it('Cheklar — «Hammasi»: P1 + P2 + kassasiz eski to‘lovlar, oy oxirigacha (31-oktabr kiradi)', async () => {
    seedOctober();
    const r = await h.call('GET', '/api/admin/cashier/receipts?register=all&from=2026-10-01&to=2026-10-31', { cookie: admin });
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe('all');
    expect(r.body.registers.map((x: any) => x.code)).toEqual(['P1', 'P2']);
    const codes = r.body.receipts.map((x: any) => x.code).sort();
    expect(codes).toEqual(['AVD-P1', 'AVD-P2', 'AVD-P3', 'AVD-P4', 'AVD-P6']);           // p5 — noyabr
    expect(r.body.summary.amount).toBe(250000 + 500000 + 250000 + 150000 + 250000);
    expect(r.body.summary.cash).toBe(250000 + 300000 + 150000 + 250000);
    expect(r.body.summary.card).toBe(200000 + 250000);
    const byCode = Object.fromEntries(r.body.receipts.map((x: any) => [x.code, x]));
    expect(byCode['AVD-P1'].register).toBe('P1');
    expect(byCode['AVD-P3'].register).toBe('P2');
    expect(byCode['AVD-P4'].register).toBe('—');
    // Bron bekor, lekin pul qaytarilmagan — chek hisobda, belgisi bilan
    expect(byCode['AVD-P6'].state).toBe('active');
    expect(byCode['AVD-P6'].booking_cancelled).toBe(true);
  });

  it('Cheklar — bitta kassa (register_id) tokensiz; kassir «all» so‘rasa ham faqat o‘ziniki', async () => {
    seedOctober();
    const p2 = await h.call('GET', '/api/admin/cashier/receipts?register_id=reg-p2&from=2026-10-01&to=2026-10-31', { cookie: admin });
    expect(p2.body.receipts.map((x: any) => x.code)).toEqual(['AVD-P3']);
    expect(p2.body.summary.amount).toBe(250000);
    const k = await h.call('GET', `/api/admin/cashier/receipts?register=all&token=${makeRegisterToken('reg-p1')}&from=2026-10-01&to=2026-10-31`, { cookie: kassa1 });
    expect(k.status).toBe(200);
    expect(k.body.scope).toBe('one');
    expect(k.body.receipts.map((x: any) => x.code).sort()).toEqual(['AVD-P1', 'AVD-P2', 'AVD-P6']);
    const k2 = await h.call('GET', '/api/admin/cashier/receipts?register=all&from=2026-10-01&to=2026-10-31', { cookie: kassa1 });
    expect(k2.status).toBe(401);
    const op = await h.call('GET', '/api/admin/cashier/receipts?register=all&from=2026-10-01&to=2026-10-31', { cookie: operator });
    expect([401, 403]).toContain(op.status);
  });

  it('Kassa hisoboti — «Hammasi»: jami + har kassa alohida, oldingi davr bilan solishtirish', async () => {
    seedOctober();
    const r = await h.call('GET', '/api/admin/my-dashboard?register=all&period=month&date=2026-10-15', { cookie: admin });
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe('all');
    expect(r.body.register.code).toBe('Hammasi');
    expect(r.body.totals.total).toBe(250000 + 500000 + 250000 + 250000);      // kassaga bog'langanlar
    expect(r.body.totals.cash).toBe(250000 + 300000 + 250000);
    expect(r.body.totals.card).toBe(200000 + 250000);
    expect(r.body.totals.receipts).toBe(4);
    expect(r.body.registers.map((x: any) => [x.code, x.total, x.receipts])).toEqual([['P1', 1000000, 3], ['P2', 250000, 1]]);
    expect(r.body.recent.map((x: any) => x.register)).toEqual(['P2', 'P1', 'P1', 'P1']);   // vaqt bo'yicha
    expect(r.body.hours).toEqual([{ hour: 10, receipts: 4, total: 1250000 }]);
    expect(r.body.instructors).toEqual([{ name: 'Aziz', receipts: 4, total: 1250000 }]);
    const one = await h.call('GET', '/api/admin/my-dashboard?register_id=reg-p2&period=month&date=2026-10-15', { cookie: admin });
    expect(one.body.scope).toBe('one');
    expect(one.body.register.code).toBe('P2');
    expect(one.body.totals.total).toBe(250000);
  });
});

describe('To‘lov faqat kassa orqali', () => {
  const booking = () => h.db.bookings.push({ id: 'b-x', customer_id: 'u-ali', instructor_id: 'ip-1', course_id: 'c-b', hours: 2, duration_minutes: 120, price: 500000,
    start_at: new Date(Date.now() + 3600e3).toISOString(), end_at: new Date(Date.now() + 2 * 3600e3).toISOString(), booking_date: new Date().toISOString(), status: 'confirmed', category: 'B' });

  it('eski «cashier/pay» yo‘li: kassasiz — rad; token bilan — kassa va naqd/karta yoziladi; kassir — o‘z kassasi', async () => {
    booking();
    const no = await h.call('POST', '/api/admin/cashier/pay', { cookie: admin, payload: { booking_id: 'b-x', method: 'cash', amount: 500000 } });
    expect(no.status).toBe(400);
    expect(no.body.error).toMatch(/Kassa tanlanmagan/);
    expect(h.db.payments).toHaveLength(0);
    const ok = await h.call('POST', '/api/admin/cashier/pay', { cookie: admin, payload: { booking_id: 'b-x', method: 'card', amount: 500000, register_token: makeRegisterToken('reg-p2') } });
    expect(ok.status).toBe(201);
    expect(h.db.payments[0]).toMatchObject({ register_id: 'reg-p2', method: 'card', cash_amount: 0, card_amount: 500000, status: 'paid' });
  });

  it('kassir tokensiz — o‘z kassasiga yoziladi; PATCH orqali «paid» qilib bo‘lmaydi', async () => {
    booking();
    const ok = await h.call('POST', '/api/admin/cashier/pay', { cookie: kassa1, payload: { booking_id: 'b-x', method: 'cash', amount: 500000 } });
    expect(ok.status).toBe(201);
    expect(h.db.payments[0].register_id).toBe('reg-p1');
    h.db.payments.push({ id: 'p-pend', booking_id: 'b-x', customer_id: 'u-ali', amount: 500000, status: 'pending' });
    const r = await h.call('PATCH', '/api/admin/payments/p-pend', { cookie: admin, payload: { status: 'paid' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/faqat kassa orqali/);
    expect(h.db.payments.find((p: any) => p.id === 'p-pend').status).toBe('pending');
    const c = await h.call('PATCH', '/api/admin/payments/p-pend', { cookie: admin, payload: { status: 'cancelled' } });
    expect(c.status).toBe(200);
  });

  it('admin tasdiqlaganda kutilayotgan to‘lov summasi — BRON narxi (2 soat = 500 000)', async () => {
    h.db.bookings.push({ id: 'b-2h', customer_id: 'u-ali', instructor_id: 'ip-1', course_id: 'c-b', hours: 2, duration_minutes: 120, price: 500000,
      start_at: new Date(Date.now() + 86400e3).toISOString(), end_at: new Date(Date.now() + 86400e3 + 7200e3).toISOString(), booking_date: new Date().toISOString(), status: 'pending', category: 'B' });
    h.db.bookings.push({ id: 'b-30', customer_id: 'u-ali', instructor_id: 'ip-1', course_id: 'c-b', hours: 1, duration_minutes: 30, price: null,
      start_at: new Date(Date.now() + 90000e3).toISOString(), end_at: new Date(Date.now() + 90000e3 + 1800e3).toISOString(), booking_date: new Date().toISOString(), status: 'pending', category: 'B' });
    expect((await h.call('PATCH', '/api/admin/bookings/b-2h/status', { cookie: admin, payload: { status: 'confirmed' } })).status).toBe(200);
    expect((await h.call('PATCH', '/api/admin/bookings/b-30/status', { cookie: admin, payload: { status: 'confirmed' } })).status).toBe(200);
    const amt = (bid: string) => Number(h.db.payments.find((p: any) => p.booking_id === bid)?.amount);
    expect(amt('b-2h')).toBe(500000);
    expect(amt('b-30')).toBe(125000);      // narx yozilmagan — kurs narxidan daqiqaga qarab
  });

  it('chek ochiq smenaga bog‘lanadi — smena hisobi bo‘sh chiqmaydi', async () => {
    h.db.cashier_shifts.push({ id: 'sh-1', register_id: 'reg-p1', opened_at: new Date().toISOString(), closed_at: null, opening_cash: 0 });
    const r = await h.call('POST', '/api/admin/cashier/issue', { cookie: kassa1, payload: {
      register_token: makeRegisterToken('reg-p1'), full_name: 'Yangi Mijoz', instructor_id: 'ip-1', course_id: 'c-b',
      category: 'B', duration_minutes: 60, amount: 250000, cash_amount: 150000, card_amount: 100000, start_at: new Date().toISOString() } });
    expect(r.status).toBe(201);
    expect(h.db.payments[0]).toMatchObject({ shift_id: 'sh-1', register_id: 'reg-p1', method: 'mixed', cash_amount: 150000, card_amount: 100000 });
    const sh = await h.call('GET', '/api/admin/shifts', { cookie: admin });
    expect(sh.status).toBe(200);
    const row = (sh.body.shifts || []).find((x: any) => x.id === 'sh-1');
    expect(row?.total ?? row?.totals?.total ?? row?.sum?.total).toBe(250000);
  });
});

describe('Bronni qayta ochish va hisobot tafsilotlari', () => {
  const closed = (status: string) => h.db.bookings.push({ id: 'b-c', customer_id: 'u-ali', instructor_id: 'ip-1', course_id: 'c-b', duration_minutes: 60, price: 250000,
    start_at: new Date(Date.now() - 3600e3).toISOString(), end_at: new Date().toISOString(), booking_date: new Date().toISOString(), status, category: 'B',
    cancellation_reason: 'Avtomatik: mijoz kelmadi' });

  it('administrator «Kelmagan» bronni qayta ochadi (audit bilan); operator — yo‘q', async () => {
    closed('no_show');
    const op = await h.call('PATCH', '/api/admin/bookings/b-c/status', { cookie: operator, payload: { status: 'confirmed' } });
    expect(op.status).toBe(409);
    const r = await h.call('PATCH', '/api/admin/bookings/b-c/status', { cookie: admin, payload: { status: 'confirmed', reason: 'Mijoz kelgan edi' } });
    expect(r.status).toBe(200);
    expect(r.body.reopened).toBe(true);
    const b = h.db.bookings.find((x: any) => x.id === 'b-c');
    expect(b.status).toBe('confirmed');
    expect(b.cancellation_reason).toBeNull();
    expect(h.db.admin_audit_logs.some((a: any) => a.action === 'BOOKING_REOPENED' && a.new_data?.note === 'Mijoz kelgan edi')).toBe(true);
  });

  it('instruktorning shu vaqti boshqa bron bilan band bo‘lsa — qayta ochilmaydi', async () => {
    closed('cancelled');
    const b = h.db.bookings[0];
    h.db.bookings.push({ ...b, id: 'b-other', status: 'confirmed', customer_id: 'u-vali' });
    const r = await h.call('PATCH', '/api/admin/bookings/b-c/status', { cookie: admin, payload: { status: 'confirmed' } });
    expect(r.status).toBe(409);
    expect(h.db.bookings[0].status).toBe('cancelled');
  });

  it('instruktor nazorati: aralash to‘lov naqd va kartaga bo‘linadi', async () => {
    seedOctober();
    const r = await h.call('GET', '/api/admin/instructor-control/ip-1?from=2026-10-01&to=2026-10-31', { cookie: admin });
    expect(r.status).toBe(200);
    expect(r.body.summary.cash).toBe(250000 + 300000 + 150000 + 250000);   // p6: bron bekor, pul qaytarilmagan — kassada
    expect(r.body.summary.card).toBe(200000 + 250000);
    expect(r.body.summary.revenue).toBe(r.body.summary.cash + r.body.summary.card);
  });
});
