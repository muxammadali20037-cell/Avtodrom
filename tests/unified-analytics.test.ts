/**
 * BIRLASHGAN ANALITIKA — Avtodrom + avtodrom12 (/api/admin/unified-analytics)
 *
 * avtodrom12 serveri o'rniga soxta javob: ko'prik so'rovi to'g'ri kalit
 * va davr bilan ketadimi, javoblar to'g'ri qo'shiladimi, avtodrom12
 * ishlamasa Avtodrom qismi baribir chiqadimi — shular tekshiriladi.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import { seriesKey, allKeys } from '../backend/src/unified-analytics.js';

let h: Harness;
let admin = '', operator = '', kassa = '';
let baseFetch: any;

const KEY = 'shared-key-0123456789abcdef0123';
const A12 = 'https://a12.test';
const bridgeCalls: Array<{ url: string; key: string | null }> = [];
let bridgeReply: { status: number; body: any } = { status: 200, body: null };

const a12Payload = () => ({
  ok: true, source: 'avtodrom12', from_day: '2026-10-10', to_day: '2026-10-10', bucket: 'hour',
  totals: { sessions: 4, school_sessions: 1, paid_sessions: 3, minutes: 250, revenue: 190000, cash: 100000, terminal: 90000, vehicles: 3, students: 1, schools: 1, avg_minutes: 63 },
  previous: { sessions: 1, school_sessions: 0, paid_sessions: 1, minutes: 60, revenue: 60000 },
  series: [{ key: '09:00', sessions: 2, school: 1, paid: 1, revenue: 60000, minutes: 120 }, { key: '14:00', sessions: 1, school: 0, paid: 1, revenue: 90000, minutes: 90 }],
  hours: [{ hour: 9, sessions: 2 }, { hour: 14, sessions: 1 }],
  heatmap: [{ dow: 6, hour: 9, n: 2 }],
  schools: [{ id: 's1', name: 'Yo‘l Ustasi', sessions: 1, students: 1, minutes: 60, active_students: 5, active_groups: 1, free_visits: null }],
  instructors: [], operators: [],
  live: { active: 1, frozen: 0, waiting: 2, sessions: [{ id: 'x', status: 'active', plate: '01A123BC', minutes: 25, is_school: true }] },
  receipts: { issued: 3, open: 1, used: 1, cancelled: 1, by_status: {}, previous_issued: 0, scanners: [] },
  gate: { in: 0, out: 0, denied: 0, total: 0 },
  students: { active: 5, total: 5, new_in_period: 0, expiring_7d: 1, schools_active: 2, groups_active: 1 },
  feed: [{ at: '2026-10-10T09:30:00.000Z', kind: 'receipt_scanned', title: 'AVS-00002', detail: 'O‘quvchi', actor: 'Anvar' }],
  warnings: [],
});

beforeAll(async () => { h = await makeHarness(); baseFetch = globalThis.fetch; });

beforeEach(async () => {
  h.reset();
  process.env.AVTODROM12_URL = A12;
  process.env.RECEIPT_SHARED_KEY = KEY;
  bridgeCalls.length = 0;
  bridgeReply = { status: 200, body: a12Payload() };
  globalThis.fetch = (async (u: any, o: any = {}) => {
    const url = String(u);
    if (url.startsWith(`${A12}/api/bridge/analytics`)) {
      const hd = o.headers || {};
      bridgeCalls.push({ url, key: hd['X-Receipt-Key'] ?? null });
      return { ok: bridgeReply.status < 400, status: bridgeReply.status, json: async () => bridgeReply.body, text: async () => JSON.stringify(bridgeReply.body) } as any;
    }
    if (url.includes('/rest/v1/rpc/analytics_report')) {
      const b = JSON.parse(String(o.body || '{}'));
      const current = b.p_from === '2026-10-09T19:00:00.000Z';
      const out = current
        ? { totals: { revenue: 250000, bookings: 3, completed: 1, no_show: 1, cancelled: 0, customers: 2, avg_check: 250000 },
            series: [{ label: '2026-10-10 09:00', revenue: 250000, bookings: 2 }, { label: '2026-10-10 15:00', revenue: 0, bookings: 1 }],
            hours: [{ hour: 9, bookings: 2 }], heatmap: [{ dow: 6, hour: 9, n: 2 }], instructors: [{ name: 'Aziz Karimov', completed: 1, revenue: 250000, minutes: 60 }] }
        : { totals: { revenue: 100000, bookings: 1, completed: 1, customers: 1 }, series: [] };
      return { ok: true, status: 200, text: async () => JSON.stringify(out), json: async () => out, headers: new Map() } as any;
    }
    return baseFetch(u, o);
  }) as any;

  const st = (id: string, login: string, role: string, register_id: string | null) =>
    h.db.staff.push({ id, login, password_hash: hashPassword('parol1234'), role, register_id, full_name: login, is_active: true });
  st('st-admin', 'boss', 'admin', null);
  st('st-op', 'operator1', 'operator', null);
  st('st-k1', 'kassa1', 'cashier', 'reg-p1');
  h.db.cash_registers.push({ id: 'reg-p1', code: 'P1', name: '1-kassa', is_active: true });
  h.db.users.push({ id: 'u-admin', full_name: 'Admin', role: 'admin', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-ali', full_name: 'Ali Valiyev', role: 'customer', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-vali', full_name: 'Vali O‘quvchi', role: 'customer', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-ins', full_name: 'Aziz Karimov', role: 'instructor', is_active: true, is_blocked: false });
  h.db.instructor_profiles.push({ id: 'ip-1', user_id: 'u-ins', is_verified: true, is_available: true, categories: ['B'] });

  // 10-oktabr (Toshkent): bitta pullik dars (chek urilgan) va bitta avtoshkola darsi
  const at = (hh: string) => new Date(`2026-10-10T${hh}:00+05:00`).toISOString();
  h.db.bookings.push({ id: 'bk-paid', customer_id: 'u-ali', instructor_id: 'ip-1', start_at: at('09:00'), end_at: at('10:00'), booking_date: at('09:00'),
    arrived_at: at('09:02'), status: 'completed', duration_minutes: 60, source: 'kassa', category: 'B', created_at: at('08:00') });
  h.db.attendance_verifications.push({ id: 'av-1', booking_id: 'bk-paid', customer_id: 'u-ali', receipt_code: 'AVD-111111-AAAAA', created_at: at('09:02'),
    verification_snapshot: { kind: 'receipt', instructor_name: 'Aziz Karimov', amount: 250000, minutes: 60 } });
  h.db.payments.push({ id: 'py-1', booking_id: 'bk-paid', customer_id: 'u-ali', amount: 250000, method: 'cash', status: 'paid', paid_at: at('08:55'), receipt_code: 'AVD-111111-AAAAA' });
  h.db.bookings.push({ id: 'bk-school', customer_id: 'u-vali', instructor_id: 'ip-1', start_at: at('11:00'), end_at: at('12:00'), booking_date: at('11:00'),
    arrived_at: at('11:00'), status: 'completed', duration_minutes: 60, source: 'avtodrom12', school_receipt_code: 'AVS-00002', category: 'B', created_at: at('11:00') });
  // Hozir davom etayotgan dars va tasdiq kutayotgan bron
  h.db.bookings.push({ id: 'bk-live', customer_id: 'u-ali', instructor_id: 'ip-1', start_at: new Date(Date.now() - 20 * 60e3).toISOString(),
    end_at: new Date(Date.now() + 40 * 60e3).toISOString(), booking_date: new Date().toISOString(), arrived_at: new Date(Date.now() - 20 * 60e3).toISOString(),
    status: 'in_progress', duration_minutes: 60, category: 'B', created_at: new Date().toISOString() });
  h.db.bookings.push({ id: 'bk-pend', customer_id: 'u-vali', instructor_id: 'ip-1', start_at: new Date(Date.now() + 5 * 3600e3).toISOString(),
    end_at: new Date(Date.now() + 6 * 3600e3).toISOString(), booking_date: new Date().toISOString(), status: 'pending', created_at: new Date().toISOString() });
  h.db.cashier_shifts.push({ id: 'sh-1', register_id: 'reg-p1', cashier_name: 'Kassir', opened_at: new Date().toISOString(), closed_at: null });
  h.db.admin_audit_logs.push({ id: 'al-1', action: 'MANUAL_BOOKING_CREATED', entity_type: 'bookings', staff_login: 'boss', admin_id: 'u-admin', new_data: { status: 'confirmed' }, created_at: at('08:00') });

  admin = (await h.login('boss', 'parol1234')).cookie;
  operator = (await h.login('operator1', 'parol1234')).cookie;
  kassa = (await h.login('kassa1', 'parol1234')).cookie;
});

afterEach(() => { globalThis.fetch = baseFetch; delete process.env.AVTODROM12_URL; delete process.env.RECEIPT_SHARED_KEY; });

describe('Birlashgan analitika', () => {
  it('faqat administrator: kirmagan 401, operator va kassir 403', async () => {
    expect((await h.call('GET', '/api/admin/unified-analytics?from=2026-10-10&to=2026-10-10')).status).toBe(401);
    expect((await h.call('GET', '/api/admin/unified-analytics?from=2026-10-10&to=2026-10-10', { cookie: operator })).status).toBe(403);
    expect((await h.call('GET', '/api/admin/unified-analytics?from=2026-10-10&to=2026-10-10', { cookie: kassa })).status).toBe(403);
    expect(bridgeCalls.length).toBe(0);
  });

  it('ikkala loyiha qo‘shiladi: tushum, darslar, avtoshkola, daqiqa', async () => {
    const r = await h.call('GET', '/api/admin/unified-analytics?from=2026-10-10&to=2026-10-10', { cookie: admin });
    expect(r.status).toBe(200);
    const d = r.body;
    // Ko'prik so'rovi: to'g'ri kalit, davr va bo'lak
    expect(bridgeCalls).toHaveLength(1);
    expect(bridgeCalls[0].key).toBe(KEY);
    expect(bridgeCalls[0].url).toBe(`${A12}/api/bridge/analytics?from=2026-10-10&to=2026-10-10&bucket=hour`);

    expect(d.avtodrom.totals).toMatchObject({ revenue: 250000, bookings: 3, lessons: 2, school_lessons: 1, paid_lessons: 1, minutes: 120 });
    expect(d.avtodrom12.ok).toBe(true);
    expect(d.combined.totals).toEqual({ revenue: 440000, lessons: 6, school_lessons: 2, paid_lessons: 4, minutes: 370 });
    expect(d.combined.previous.revenue).toBe(160000);
    expect(d.combined.change.revenue).toBe(175);

    // Soatlik dinamika: 24 kalit, 09:00 da ikkala loyiha bir qatorda
    expect(d.combined.series).toHaveLength(24);
    const nine = d.combined.series.find((s: any) => s.key === '09:00');
    expect(nine).toMatchObject({ avtodrom_revenue: 250000, avtodrom_lessons: 1, avtodrom12_revenue: 60000, avtodrom12_sessions: 2 });
    expect(d.combined.hours[9]).toEqual({ hour: 9, avtodrom: 2, avtodrom12: 2 });
    expect(d.combined.heatmap).toContainEqual({ dow: 6, hour: 9, avtodrom: 2, avtodrom12: 2 });

    // Jonli holat
    expect(d.avtodrom.live.in_progress).toHaveLength(1);
    expect(d.avtodrom.live.in_progress[0]).toMatchObject({ instructor: 'Aziz Karimov', customer: 'Ali Valiyev' });
    expect(d.avtodrom.live.pending).toBe(1);
    expect(d.avtodrom.live.open_shifts[0]).toMatchObject({ register: '1-kassa' });

    // Amallar lentasi: ikkala manba, vaqt bo'yicha kamayib boradi
    const sources = new Set(d.feed.map((f: any) => f.source));
    expect(sources).toEqual(new Set(['avtodrom', 'avtodrom12']));
    const kinds = d.feed.map((f: any) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(['audit', 'payment', 'scan', 'booking', 'receipt_scanned']));
    const times = d.feed.map((f: any) => Date.parse(f.at)).filter(Number.isFinite);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(d.avtodrom12.feed).toBeUndefined();     // lenta bitta joyda
  });

  it('avtodrom12 kaliti mos kelmasa — Avtodrom qismi baribir chiqadi, sababi aytiladi', async () => {
    bridgeReply = { status: 401, body: { ok: false, error: 'Kalit noto‘g‘ri' } };
    const r = await h.call('GET', '/api/admin/unified-analytics?from=2026-10-10&to=2026-10-10', { cookie: admin });
    expect(r.status).toBe(200);
    expect(r.body.avtodrom12).toMatchObject({ ok: false, status: 401 });
    expect(r.body.avtodrom12.hint).toMatch(/RECEIPT_SHARED_KEY/);
    expect(r.body.avtodrom.totals.revenue).toBe(250000);
    expect(r.body.combined.totals.revenue).toBe(250000);
  });

  it('avtodrom12 da ko‘prik hali yo‘q (404) — deploy qilish kerakligi aytiladi', async () => {
    bridgeReply = { status: 404, body: { error: 'Route topilmadi' } };
    const r = await h.call('GET', '/api/admin/unified-analytics?from=2026-10-10&to=2026-10-10', { cookie: admin });
    expect(r.body.avtodrom12.ok).toBe(false);
    expect(r.body.avtodrom12.hint).toMatch(/deploy/);
  });

  it('sozlanmagan bo‘lsa — avtodrom12 ga murojaat qilinmaydi, qaysi sozlama yo‘qligi aytiladi', async () => {
    delete process.env.AVTODROM12_URL;
    const r = await h.call('GET', '/api/admin/unified-analytics?from=2026-10-10&to=2026-10-10', { cookie: admin });
    expect(r.status).toBe(200);
    expect(bridgeCalls).toHaveLength(0);
    expect(r.body.avtodrom12.ok).toBe(false);
    expect(r.body.avtodrom12.hint).toMatch(/AVTODROM12_URL/);
  });

  it('noto‘g‘ri sana — 400', async () => {
    const r = await h.call('GET', '/api/admin/unified-analytics?from=2026-13-40&to=2026-10-10', { cookie: admin });
    expect(r.status).toBe(400);
  });
});

describe('Grafik kalitlari', () => {
  it('hisobot yorlig‘i umumiy kalitga keladi', () => {
    expect(seriesKey('2026-10-10', 'day')).toBe('2026-10-10');
    expect(seriesKey('2026-10-10T00:00:00+05:00', 'day')).toBe('2026-10-10');
    expect(seriesKey('2026-10', 'month')).toBe('2026-10');
    expect(seriesKey('2026-10-01', 'month')).toBe('2026-10');
    expect(seriesKey('09:00', 'hour')).toBe('09:00');
    expect(seriesKey('2026-10-10 9:00', 'hour')).toBe('09:00');
    expect(seriesKey('2026-10-10T14:00:00', 'hour')).toBe('14:00');
  });
  it('davrdagi barcha kunlar/oylar, yil almashsa ham', () => {
    expect(allKeys('2026-12-30', '2027-01-02', 'day')).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
    expect(allKeys('2026-11-15', '2027-02-03', 'month')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    expect(allKeys('2026-10-10', '2026-10-10', 'hour')).toHaveLength(24);
  });
});
