/**
 * BOSHLIQ ILOVASI — /boshliq (iPhone), /api/boss-*, /api/admin/boss-link
 *
 * Tekshiriladi: havola + PIN bilan kirish, token bekor bo'lishi (havola
 * yangilansa / PIN almashsa), kassa P1/P2, bronlar, darslar (avtoshkola
 * darsi ikki marta sanalmaydi), avtodrom12 ko'prigi va umumiy hisob,
 * avtodrom12 ishlamasa ham Avtodrom qismi chiqishi.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';

let h: Harness;
let admin = '', operator = '', kassa = '';
let baseFetch: any;
let ipSeq = 0;

const KEY = 'shared-key-0123456789abcdef0123';
const A12 = 'https://a12.test';
const bridgeCalls: string[] = [];
let bridgeReply: { status: number; body: any } = { status: 200, body: null };

const D = '2026-10-10';
const at = (hh: string) => new Date(`${D}T${hh}:00+05:00`).toISOString();

const owner = () => ({
  ok: true, kind: 'owner', source: 'avtodrom12', from_day: D, to_day: D, bucket: 'hour',
  paid: {
    totals: { sessions: 3, minutes: 150, revenue: 120000, cash: 50000, terminal: 40000, click: 30000, debt: 10000, debt_sessions: 1, auto_closed: 1, vehicles: 2, avg_check: 40000, avg_minutes: 50 },
    previous: { sessions: 1, minutes: 60, revenue: 60000 },
    durations: { upto30: 1, upto60: 1, upto120: 1, more: 0 },
    plates: { total: 2, new: 1, returning: 1, top: [{ plate: '01A123BC', visits: 2, minutes: 90, revenue: 80000, debt: 0 }] },
    debts: { total: 35000, sessions: 2, vehicles: 1, top: [{ plate: '455 DILNOZA', n: 2, total: 35000 }] },
    operators: [], live: { active: 1, frozen: 0, waiting: 0, sessions: [] },
  },
  school: {
    totals: { sessions: 2, lessons: 3, minutes: 120, revenue: 0, students: 2, schools: 1, over_lessons: 1 },
    previous: { sessions: 1, lessons: 1, minutes: 60, revenue: 0 },
    over_limit: { lessons: 1, students: 1, due: 50000 },
    schools: [{ id: 's1', name: 'Yo‘l Ustasi', sessions: 2, lessons: 3, students: 2, minutes: 120, over_lessons: 1, over_due: 50000 }],
    instructors: [], receipts: { issued: 2, open: 1, used: 1, cancelled: 0 },
    students: { active: 5, total: 5, new_in_period: 1, expiring_7d: 0 }, live: { count: 0, sessions: [] },
  },
  series: [{ key: '09:00', paid: 2, paid_revenue: 80000, school: 1, school_lessons: 1, school_revenue: 0 }],
  hours: [{ hour: 9, paid: 2, paid_revenue: 80000, school: 1 }],
  expenses: { total: 300000, count: 2, previous_total: 100000, by_method: { cash: 200000, card: 100000, click: 0 }, liters: 20,
    categories: [{ name: 'Yoqilg‘i', n: 1, total: 200000 }], vehicles: [], people: [], series: [{ key: D, total: 300000 }], recent: [] },
  warnings: [],
});

beforeAll(async () => { h = await makeHarness(); baseFetch = globalThis.fetch; });

beforeEach(async () => {
  h.reset();
  process.env.AVTODROM12_URL = A12;
  process.env.RECEIPT_SHARED_KEY = KEY;
  bridgeCalls.length = 0;
  bridgeReply = { status: 200, body: owner() };
  const harnessFetch = globalThis.fetch;
  globalThis.fetch = (async (u: any, o: any = {}) => {
    const url = String(u);
    if (url.startsWith(`${A12}/api/bridge/`)) {
      bridgeCalls.push(url);
      expect((o.headers || {})['X-Receipt-Key']).toBe(KEY);
      return { ok: bridgeReply.status < 400, status: bridgeReply.status, json: async () => bridgeReply.body } as any;
    }
    return harnessFetch(u, o);
  }) as any;

  const st = (id: string, login: string, role: string, register_id: string | null) =>
    h.db.staff.push({ id, login, password_hash: hashPassword('parol1234'), role, register_id, full_name: login, is_active: true });
  st('st-admin', 'boss', 'admin', null);
  st('st-op', 'operator1', 'operator', null);
  st('st-k1', 'kassa1', 'cashier', 'reg-p1');
  h.db.cash_registers.push({ id: 'reg-p1', code: 'P1', name: '1-kassa', is_active: true });
  h.db.cash_registers.push({ id: 'reg-p2', code: 'P2', name: '2-kassa', is_active: true });
  h.db.users.push({ id: 'u-admin', full_name: 'Admin', role: 'admin', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-ali', full_name: 'Ali Valiyev', role: 'customer', is_active: true, is_blocked: false, created_at: at('08:00') });
  h.db.users.push({ id: 'u-vali', full_name: 'Vali O‘quvchi', role: 'customer', is_active: true, is_blocked: false, created_at: '2026-09-01T00:00:00Z' });
  h.db.users.push({ id: 'u-ins', full_name: 'Aziz Karimov', role: 'instructor', is_active: true, is_blocked: false });
  h.db.instructor_profiles.push({ id: 'ip-1', user_id: 'u-ins', is_verified: true, is_available: true, categories: ['B'] });

  // 10-oktabr: P1 da naqd chek (dars o'tildi), P2 da aralash chek (urilmagan), avtoshkola darsi, kelmagan bron
  h.db.bookings.push({ id: 'bk-paid', customer_id: 'u-ali', instructor_id: 'ip-1', start_at: at('09:00'), end_at: at('10:00'), booking_date: at('09:00'),
    arrived_at: at('09:02'), status: 'completed', duration_minutes: 60, source: 'walk_in', category: 'B', created_at: at('08:00') });
  h.db.attendance_verifications.push({ id: 'av-1', booking_id: 'bk-paid', customer_id: 'u-ali', receipt_code: 'AVD-111111-AAAAA', created_at: at('09:02'),
    verification_snapshot: { kind: 'receipt', instructor_name: 'Aziz Karimov', amount: 250000, minutes: 60 } });
  h.db.payments.push({ id: 'py-1', booking_id: 'bk-paid', customer_id: 'u-ali', amount: 250000, method: 'cash', status: 'paid', paid_at: at('08:55'),
    receipt_code: 'AVD-111111-AAAAA', register_id: 'reg-p1' });
  h.db.bookings.push({ id: 'bk-p2', customer_id: 'u-vali', instructor_id: 'ip-1', start_at: at('15:00'), end_at: at('15:30'), booking_date: at('15:00'),
    status: 'confirmed', duration_minutes: 30, source: 'app', category: 'C', created_at: at('08:00') });
  h.db.payments.push({ id: 'py-2', booking_id: 'bk-p2', customer_id: 'u-vali', amount: 200000, method: 'mixed', cash_amount: 50000, card_amount: 150000,
    status: 'paid', paid_at: at('10:30'), receipt_code: 'AVD-111111-BBBBB', register_id: 'reg-p2' });
  h.db.bookings.push({ id: 'bk-school', customer_id: 'u-vali', instructor_id: 'ip-1', start_at: at('11:00'), end_at: at('12:00'), booking_date: at('11:00'),
    arrived_at: at('11:00'), status: 'completed', duration_minutes: 60, source: 'avtodrom12', school_receipt_code: 'AVS-00002', category: 'B', created_at: at('11:00') });
  h.db.bookings.push({ id: 'bk-ns', customer_id: 'u-ali', instructor_id: 'ip-1', start_at: at('13:00'), end_at: at('14:00'), booking_date: at('13:00'),
    status: 'no_show', duration_minutes: 60, source: 'admin', category: 'B', created_at: at('08:00') });
  // 9-oktabr (oldingi kun): P1 da 100 000
  h.db.payments.push({ id: 'py-0', booking_id: null, customer_id: 'u-ali', amount: 100000, method: 'card', status: 'paid', paid_at: '2026-10-09T05:00:00.000Z', register_id: 'reg-p1' });
  h.db.cashier_shifts.push({ id: 'sh-1', register_id: 'reg-p1', cashier_name: 'Kassir Nodira', opened_at: new Date().toISOString(), closed_at: null });

  admin = (await h.login('boss', 'parol1234')).cookie;
  operator = (await h.login('operator1', 'parol1234')).cookie;
  kassa = (await h.login('kassa1', 'parol1234')).cookie;
});

afterEach(() => { globalThis.fetch = baseFetch; delete process.env.AVTODROM12_URL; delete process.env.RECEIPT_SHARED_KEY; });

/* Har test o'z IP manzilidan — kirish chegarasi testlar orasida yig'ilmasin */
async function boss(method: string, url: string, o: { token?: string; payload?: any; ip?: string } = {}) {
  const headers: Record<string, string> = { 'x-real-ip': o.ip || `10.0.0.${++ipSeq}` };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  const r = await h.app.inject({ method, url, headers, payload: o.payload });
  let body: any = {};
  try { body = JSON.parse(r.payload); } catch { body = r.payload; }
  return { status: r.statusCode, body, headers: r.headers };
}
const keyOf = (url: string) => new URL(url).searchParams.get('k') || '';

async function setup(pin = '482915') {
  const link = await h.call('GET', '/api/admin/boss-link', { cookie: admin });
  expect(link.status).toBe(200);
  const set = await h.call('POST', '/api/admin/boss-link', { cookie: admin, payload: { pin } });
  expect(set.status).toBe(200);
  const k = keyOf(set.body.url);
  const login = await boss('POST', '/api/boss-login', { payload: { k, pin } });
  expect(login.status).toBe(200);
  return { k, token: login.body.token as string };
}

describe('Boshliq ilovasi — kirish', () => {
  it('havolani faqat administrator oladi', async () => {
    expect((await h.call('GET', '/api/admin/boss-link')).status).toBe(401);
    expect((await h.call('GET', '/api/admin/boss-link', { cookie: operator })).status).toBe(403);
    expect((await h.call('GET', '/api/admin/boss-link', { cookie: kassa })).status).toBe(403);
    expect((await h.call('POST', '/api/admin/boss-link', { cookie: kassa, payload: { pin: '1234' } })).status).toBe(403);
  });

  it('havola + PIN: PIN qo‘yilmaguncha kirib bo‘lmaydi, noto‘g‘ri PIN — 401', async () => {
    const r = await h.call('GET', '/api/admin/boss-link', { cookie: admin });
    expect(r.body).toMatchObject({ ok: true, pin_set: false });
    expect(r.body.url).toMatch(/^https:\/\/avtodrom\.vercel\.app\/boshliq\?k=[\w-]{24}$/);
    const k = keyOf(r.body.url);
    // Ikkinchi so'rov — o'sha havola
    expect((await h.call('GET', '/api/admin/boss-link', { cookie: admin })).body.url).toBe(r.body.url);

    expect((await boss('GET', '/api/boss-hello?k=noto-gri-kalit-0000000000')).status).toBe(403);
    expect((await boss('GET', `/api/boss-hello?k=${k}`)).body).toEqual({ ok: true, pin_set: false });
    expect((await boss('POST', '/api/boss-login', { payload: { k, pin: '1234' } })).status).toBe(409);

    expect((await h.call('POST', '/api/admin/boss-link', { cookie: admin, payload: { pin: '12a4' } })).status).toBe(400);
    expect((await h.call('POST', '/api/admin/boss-link', { cookie: admin, payload: { pin: '123' } })).status).toBe(400);
    expect((await h.call('POST', '/api/admin/boss-link', { cookie: admin, payload: {} })).status).toBe(400);
    const set = await h.call('POST', '/api/admin/boss-link', { cookie: admin, payload: { pin: '482915' } });
    expect(set.body).toMatchObject({ ok: true, pin_set: true });
    expect(set.body.url).toBe(r.body.url);                       // PIN qo'yish havolani o'zgartirmaydi

    expect((await boss('GET', `/api/boss-hello?k=${k}`)).body.pin_set).toBe(true);
    expect((await boss('POST', '/api/boss-login', { payload: { k, pin: '000000' } })).status).toBe(401);
    expect((await boss('POST', '/api/boss-login', { payload: { k: 'x'.repeat(24), pin: '482915' } })).status).toBe(403);
    const ok = await boss('POST', '/api/boss-login', { payload: { k, pin: '482915' } });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toMatch(/^bs1\.\d+\.[0-9a-f]{64}$/);
    expect(Date.parse(ok.body.expires_at) - Date.now()).toBeGreaterThan(59 * 864e5);

    // PIN xeshi ochiq saqlanmaydi, sozlamalar ro'yxatida ko'rinmaydi
    const row = h.db.admin_settings.find((x: any) => x.key === 'boss_link');
    expect(JSON.stringify(row.value)).not.toContain('482915');
    const settings = await h.call('GET', '/api/admin/settings', { cookie: admin });
    expect(JSON.stringify(settings.body)).not.toContain('boss_link');
    expect(h.db.admin_audit_logs.some((a: any) => a.action === 'BOSS_LOGIN')).toBe(true);
  });

  it('PIN tanlashga chegara: bir manzildan 8 urinishdan keyin 429', async () => {
    const { k } = await setup();
    const ip = '10.9.9.9';
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await boss('POST', '/api/boss-login', { payload: { k, pin: String(100000 + i) }, ip })).status);
    expect(codes.slice(0, 8).every((c) => c === 401)).toBe(true);
    expect(codes.slice(8)).toEqual([429, 429]);
  });

  it('havola yangilansa yoki PIN almashsa — eski token ishlamaydi', async () => {
    const { k, token } = await setup();
    expect((await boss('GET', `/api/boss-data?from=${D}&to=${D}`, { token })).status).toBe(200);
    expect((await boss('GET', `/api/boss-data?from=${D}&to=${D}`)).status).toBe(401);
    expect((await boss('GET', `/api/boss-data?from=${D}&to=${D}`, { token: token.slice(0, -2) + '00' })).status).toBe(401);

    // PIN almashdi
    await h.call('POST', '/api/admin/boss-link', { cookie: admin, payload: { pin: '7777' } });
    const r1 = await boss('GET', `/api/boss-data?from=${D}&to=${D}`, { token });
    expect(r1.status).toBe(401);
    expect(r1.body.relogin).toBe(true);
    const t2 = (await boss('POST', '/api/boss-login', { payload: { k, pin: '7777' } })).body.token;
    expect((await boss('GET', `/api/boss-data?from=${D}&to=${D}`, { token: t2 })).status).toBe(200);

    // Havola yangilandi: eski havola ham, eski token ham yopiq; PIN saqlanadi
    const reset = await h.call('POST', '/api/admin/boss-link', { cookie: admin, payload: { reset: true } });
    expect(reset.body.pin_set).toBe(true);
    const k2 = keyOf(reset.body.url);
    expect(k2).not.toBe(k);
    expect((await boss('GET', `/api/boss-data?from=${D}&to=${D}`, { token: t2 })).status).toBe(401);
    expect((await boss('GET', `/api/boss-hello?k=${k}`)).status).toBe(403);
    expect((await boss('POST', '/api/boss-login', { payload: { k: k2, pin: '7777' } })).status).toBe(200);
    expect(h.db.admin_audit_logs.some((a: any) => a.action === 'BOSS_LINK_RESET')).toBe(true);
  });
});

describe('Boshliq ilovasi — raqamlar', () => {
  it('Avtodrom: kassa P1/P2, bronlar, darslar; avtodrom12 qo‘shiladi; umumiy va sof foyda', async () => {
    const { token } = await setup();
    const r = await boss('GET', `/api/boss-data?from=${D}&to=${D}`, { token });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const d = r.body;
    expect(bridgeCalls).toEqual([`${A12}/api/bridge/owner?from=${D}&to=${D}&bucket=hour`]);
    expect(d.session.token).toMatch(/^bs1\./);                   // token yangilanadi

    const k = d.avtodrom.kassa;
    expect(k.totals).toEqual({ receipts: 2, total: 450000, cash: 300000, card: 150000 });
    expect(k.previous_total).toBe(100000);
    expect(k.change).toBe(350);
    const p1 = k.registers.find((x: any) => x.code === 'P1'), p2 = k.registers.find((x: any) => x.code === 'P2');
    expect(p1).toMatchObject({ receipts: 1, total: 250000, cash: 250000, card: 0, previous_total: 100000, change: 150, shift: { open: true, cashier: 'Kassir Nodira' } });
    expect(p2).toMatchObject({ receipts: 1, total: 200000, cash: 50000, card: 150000, shift: { open: false } });
    expect(k.categories).toEqual([{ name: 'B toifa', total: 250000, receipts: 1 }, { name: 'C toifa', total: 200000, receipts: 1 }]);
    expect(k.durations.map((x: any) => x.name)).toEqual(['30 daqiqa', '1 soat']);
    expect(k.hours.map((x: any) => x.hour)).toEqual([8, 10]);
    expect(k.recent[0]).toMatchObject({ code: 'AVD-111111-BBBBB', register: 'P2', customer: 'Vali O‘quvchi', instructor: 'Aziz Karimov', method: 'mixed' });

    const b = d.avtodrom.bookings;
    expect(b.total).toBe(4);
    expect(b.by_status).toMatchObject({ completed: 2, confirmed: 1, no_show: 1, cancelled: 0 });
    expect(b.by_source.map((x: any) => x.key).sort()).toEqual(['admin', 'app', 'avtodrom12', 'walk_in']);
    expect(b.by_source.find((x: any) => x.key === 'app').name).toMatch(/Mini App/);
    expect(b.customers).toBe(2);
    expect(b.new_customers).toBe(1);
    expect(b.no_show_rate).toBe(33);

    // Avtoshkola darsi (AVS) Avtodrom bo'limida faqat ma'lumot — umumiyga avtodrom12 dan kiradi
    expect(d.avtodrom.lessons).toMatchObject({ paid: 1, school: 1, minutes: 60, students: 1, unscanned: { receipts: 1, amount: 200000 } });
    expect(d.avtodrom.instructors[0]).toMatchObject({ name: 'Aziz Karimov', lessons: 2, paid: 1, school: 1, revenue: 250000 });
    expect(d.avtodrom.live.open_shifts[0]).toMatchObject({ register: 'P1', cashier: 'Kassir Nodira' });

    expect(d.avtodrom12.ok).toBe(true);
    expect(d.avtodrom12.paid.totals.revenue).toBe(120000);
    expect(d.avtodrom12.school.totals.lessons).toBe(3);

    const c = d.combined;
    expect(c.by_part).toEqual({ avtodrom: 450000, paid: 120000, school: 0 });
    expect(c.revenue).toBe(570000);
    expect(c.previous_revenue).toBe(160000);
    expect(c.by_method).toEqual({ cash: 350000, card: 190000, click: 30000 });
    expect(c.visits).toEqual({ avtodrom: 1, paid: 3, school: 2, total: 6 });
    expect(c.minutes).toBe(60 + 150 + 120);
    expect(c.expenses).toBe(300000);
    expect(c.net).toBe(270000);
    expect(c.previous_net).toBe(60000);
    expect(c.series).toHaveLength(24);
    expect(c.series.find((s: any) => s.key === '08:00')).toMatchObject({ avtodrom: 250000 });
    expect(c.series.find((s: any) => s.key === '09:00')).toMatchObject({ paid: 80000 });
    const alerts = c.alerts.map((a: any) => a.text).join(' | ');
    expect(alerts).toMatch(/urilmagan \(200 000 so‘m\)/);
    expect(alerts).toMatch(/qarzlar: 35 000/);
    expect(alerts).toMatch(/limitidan oshgan/);
  });

  it('oylik davr — kunlar bo‘yicha; xarajatlar grafikda', async () => {
    const { token } = await setup();
    bridgeReply = { status: 200, body: { ...owner(), bucket: 'day', series: [{ key: D, paid: 2, paid_revenue: 80000, school: 1, school_revenue: 0 }],
      expenses: { ...owner().expenses, series: [{ key: D, total: 300000 }] } } };
    const r = await boss('GET', '/api/boss-data?from=2026-10-01&to=2026-10-31', { token });
    expect(r.status).toBe(200);
    expect(r.body.bucket).toBe('day');
    expect(r.body.combined.series).toHaveLength(31);
    expect(r.body.combined.series.find((s: any) => s.key === D)).toMatchObject({ avtodrom: 450000, paid: 80000, expenses: 300000 });
    expect(r.body.combined.series.find((s: any) => s.key === '2026-10-09')).toMatchObject({ avtodrom: 100000 });
  });

  it('avtodrom12 ishlamasa — Avtodrom qismi chiqadi, sababi aytiladi', async () => {
    const { token } = await setup();
    bridgeReply = { status: 404, body: { error: 'Route topilmadi' } };
    const r = await boss('GET', `/api/boss-data?from=${D}&to=${D}`, { token });
    expect(r.status).toBe(200);
    expect(r.body.avtodrom12).toMatchObject({ ok: false, status: 404 });
    expect(r.body.avtodrom12.hint).toMatch(/bridge-owner/);
    expect(r.body.combined.revenue).toBe(450000);
    expect(r.body.combined.expenses_known).toBe(false);
    expect(r.body.combined.alerts[0]).toMatchObject({ level: 'bad' });

    // Eski avtodrom12 (Analitika ko'prigi bor, boshliq ko'prigi yo'q) javob qaytarsa ham — qabul qilinmaydi
    bridgeReply = { status: 200, body: { ok: true, source: 'avtodrom12', totals: {} } };
    const r2 = await boss('GET', `/api/boss-data?from=${D}&to=${D}`, { token });
    expect(r2.body.avtodrom12.ok).toBe(false);
    expect(r2.body.avtodrom12.hint).toMatch(/yangilanmagan/);

    delete process.env.AVTODROM12_URL;
    const r3 = await boss('GET', `/api/boss-data?from=${D}&to=${D}`, { token });
    expect(r3.body.avtodrom12.hint).toMatch(/AVTODROM12_URL/);
  });

  it('noto‘g‘ri sana — 400', async () => {
    const { token } = await setup();
    expect((await boss('GET', '/api/boss-data?from=2026-13-40&to=2026-10-10', { token })).status).toBe(400);
  });
});
