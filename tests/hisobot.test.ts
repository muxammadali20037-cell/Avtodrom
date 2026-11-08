/**
 * «HISOBOT» BO'LIMI — tushum va hamma hisobotlar faqat MAXSUS PAROL bilan.
 *
 *  · Bosh sahifa va Cheklar'da jami tushum ko'rinmaydi (har chek summasi qoladi);
 *  · Kassa hisoboti, Instruktorlar hisoboti, Umumiy hisobot (P1 + P2 + platniy),
 *    Platniy hisoboti (avtodrom12) — parolsiz 403 (kassir ham, administrator ham);
 *  · parol bilan kassir ham Jami / P1 / P2 ni alohida-alohida ko'radi;
 *  · token shu xodimniki — boshqa xodim ishlata olmaydi, muddati o'tsa — yopiq.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import { makeRegisterToken, makePriceToken, pricePinHash } from '../backend/src/shift-routes.js';
// @ts-ignore — oddiy JS modul (brauzer uchun)
import { answer } from '../admin/yordamchi.js';

let h: Harness;
let admin = '', kassa1 = '', kassa2 = '', operator = '';
let baseFetch: any;
const A12 = 'https://a12.test', KEY = 'shared-key-0123456789abcdef0123';
let bridgeOk = true;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
const minAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString();

const owner = () => ({
  ok: true, kind: 'owner', source: 'avtodrom12', bucket: 'hour',
  paid: {
    totals: { sessions: 3, minutes: 150, revenue: 120000, cash: 50000, terminal: 40000, click: 30000, debt: 10000, debt_sessions: 1, auto_closed: 1, vehicles: 2, avg_check: 40000, avg_minutes: 50 },
    previous: { sessions: 1, minutes: 60, revenue: 60000 },
    durations: { upto30: 1, upto60: 1, upto120: 1, more: 0 },
    plates: { total: 2, new: 1, returning: 1, top: [{ plate: '01A123BC', visits: 2, minutes: 90, revenue: 80000, debt: 0 }] },
    debts: { total: 35000, sessions: 2, vehicles: 1, top: [{ plate: '455 DILNOZA', n: 2, total: 35000 }] },
    operators: [{ name: '1-POST · Ramziddin', post: 1, paid: 2, minutes: 100, revenue: 80000, cash: 50000, terminal: 30000, click: 0 }],
    live: { active: 1, frozen: 0, waiting: 0, sessions: [] },
  },
  school: { totals: { revenue: 0 }, previous: {} },
  series: [{ key: '09:00', paid: 2, paid_revenue: 80000 }],
  hours: [{ hour: 9, paid: 2, paid_revenue: 80000 }],
  expenses: { total: 0 }, warnings: [],
});

beforeAll(async () => { h = await makeHarness(); baseFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = baseFetch; delete process.env.AVTODROM12_URL; delete process.env.RECEIPT_SHARED_KEY; });

beforeEach(async () => {
  h.reset();
  process.env.AVTODROM12_URL = A12;
  process.env.RECEIPT_SHARED_KEY = KEY;
  bridgeOk = true;
  const harnessFetch = globalThis.fetch;
  globalThis.fetch = (async (u: any, o: any = {}) => {
    if (String(u).startsWith(`${A12}/api/bridge/`)) {
      return bridgeOk
        ? { ok: true, status: 200, json: async () => owner() } as any
        : { ok: false, status: 401, json: async () => ({ ok: false, error: 'kalit' }) } as any;
    }
    return harnessFetch(u, o);
  }) as any;

  const st = (id: string, login: string, role: string, reg: string | null) =>
    h.db.staff.push({ id, login, password_hash: hashPassword('parol1234'), role, register_id: reg, full_name: login, is_active: true });
  st('st-admin', 'boss', 'admin', null);
  st('st-k1', 'kassa1', 'cashier', 'reg-p1');
  st('st-k2', 'kassa2', 'cashier', 'reg-p2');
  st('st-op', 'operator1', 'operator', null);
  h.db.cash_registers.push({ id: 'reg-p1', code: 'P1', name: '1-kassa', is_active: true });
  h.db.cash_registers.push({ id: 'reg-p2', code: 'P2', name: '2-kassa', is_active: true });
  h.db.users.push({ id: 'u-admin', full_name: 'Admin', role: 'admin', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-ali', full_name: 'Ali', role: 'customer', is_active: true, is_blocked: false });
  /* Bugun: P1 — 250 000 naqd + 130 000 test drive (karta); P2 — 200 000 aralash */
  h.db.payments.push({ id: 'py-1', customer_id: 'u-ali', amount: 250000, method: 'cash', status: 'paid', paid_at: minAgo(30), receipt_code: 'AVD-1', register_id: 'reg-p1' });
  h.db.payments.push({ id: 'py-2', customer_id: 'u-ali', amount: 130000, method: 'card', status: 'paid', paid_at: minAgo(20), receipt_code: 'AVD-2', register_id: 'reg-p1', note: '1 krug · Test drive 50000' });
  h.db.payments.push({ id: 'py-3', customer_id: 'u-ali', amount: 200000, method: 'mixed', cash_amount: 50000, card_amount: 150000, status: 'paid', paid_at: minAgo(10), receipt_code: 'AVD-3', register_id: 'reg-p2' });
  h.db.payments.push({ id: 'py-4', customer_id: 'u-ali', amount: 90000, method: 'cash', status: 'refunded', paid_at: minAgo(5), receipt_code: 'AVD-4', register_id: 'reg-p2' });

  admin = (await h.login('boss', 'parol1234')).cookie;
  kassa1 = (await h.login('kassa1', 'parol1234')).cookie;
  kassa2 = (await h.login('kassa2', 'parol1234')).cookie;
  operator = (await h.login('operator1', 'parol1234')).cookie;
});

const LOCKED = [
  '/api/admin/my-dashboard?register=all&period=day',
  '/api/admin/instructor-report?period=day',
  '/api/admin/report/summary?period=day',
  '/api/admin/report/platniy?period=day',
  '/api/admin/register-report?period=day',
];

describe('Parolsiz — hisobot yopiq (kassir ham, administrator ham)', () => {
  it('kassir va administrator: 403 + «parol kerak» belgisi', async () => {
    for (const url of LOCKED) for (const cookie of [kassa1, admin]) {
      const r = await h.call('GET', url, { cookie });
      expect(r.status, url).toBe(403);
      expect(r.body.needs_report_pin, url).toBe(true);
      expect(r.body.error).toMatch(/maxsus parol/);
    }
    for (const url of ['/api/admin/analytics?period=day', '/api/admin/retention?period=week', '/api/admin/unified-analytics?from=2026-10-10&to=2026-10-10']) {
      const r = await h.call('GET', url, { cookie: admin });
      expect(r.status, url).toBe(403);
      expect(r.body.needs_report_pin, url).toBe(true);
    }
  });

  it('operator — umuman yopiq; kirmagan — 401', async () => {
    for (const url of LOCKED) {
      expect((await h.call('GET', url, { cookie: operator, report: true })).status, url).toBe(403);
      expect((await h.call('GET', url)).status, url).toBe(401);
    }
  });

  it('token boshqa xodimniki yoki muddati o‘tgan bo‘lsa — yopiq', async () => {
    const k1tok = h.reportToken(kassa1);
    const other = await h.call('GET', '/api/admin/report/summary?period=day', { cookie: kassa2, headers: { 'x-report-token': k1tok } });
    expect(other.status).toBe(403);
    const old = makePriceToken({ id: 'st-k1' }, Date.now() - 16 * 60000).token;          // 16 daqiqa oldin berilgan
    const exp = await h.call('GET', '/api/admin/report/summary?period=day', { cookie: kassa1, headers: { 'x-report-token': old } });
    expect(exp.status).toBe(403);
    const ok = await h.call('GET', '/api/admin/report/summary?period=day', { cookie: kassa1, headers: { 'x-report-token': k1tok } });
    expect(ok.status).toBe(200);
  });

  it('maxsus parol: to‘g‘ri — 15 daqiqalik token, jurnalda «report»; noto‘g‘ri — 400', async () => {
    h.db.admin_settings.push({ key: 'price_pin', value: { hash: pricePinHash('4321') } });
    const bad = await h.call('POST', '/api/admin/price-unlock', { cookie: kassa1, payload: { pin: '1111', purpose: 'report' } });
    expect(bad.status).toBe(400);
    const r = await h.call('POST', '/api/admin/price-unlock', { cookie: kassa1, payload: { pin: '4321', purpose: 'report' } });
    expect(r.status).toBe(200);
    expect(Date.parse(r.body.expires_at) - Date.now()).toBeGreaterThan(14 * 60000);
    expect(h.db.admin_audit_logs.some((a: any) => a.action === 'PRICE_UNLOCK' && (a.new_data?.purpose || a.new_values?.purpose || JSON.stringify(a).includes('"report"')))).toBe(true);
    const s = await h.call('GET', '/api/admin/report/summary?period=day', { cookie: kassa1, headers: { 'x-report-token': r.body.token } });
    expect(s.status).toBe(200);
  });
});

describe('Cheklar va bosh sahifa — jami tushum yo‘q, har chek summasi bor', () => {
  it('parolsiz: summary.amount/cash/card — null; parol bilan — raqamlar', async () => {
    const tok = makeRegisterToken('reg-p1');
    const locked = await h.call('GET', `/api/admin/cashier/receipts?token=${tok}&register=all&date=${today()}`, { cookie: kassa1 });
    expect(locked.status).toBe(200);
    expect(locked.body.money_unlocked).toBe(false);
    expect(locked.body.summary).toMatchObject({ total: 4, active: 3, cancelled: 1, amount: null, cash: null, card: null });
    expect(locked.body.receipts.map((x: any) => x.amount).sort()).toEqual([130000, 200000, 250000, 90000]);
    const open = await h.call('GET', `/api/admin/cashier/receipts?token=${tok}&register=all&date=${today()}`, { cookie: kassa1, report: true });
    expect(open.body.summary).toMatchObject({ amount: 580000, cash: 300000, card: 280000 });
  });
});

describe('Parol bilan: Jami / P1 / P2 alohida-alohida', () => {
  it('kassa hisoboti: kassir «Jami» va P2 ni ham ko‘radi (parolsiz — yo‘q)', async () => {
    const all = await h.call('GET', '/api/admin/my-dashboard?register=all&period=day', { cookie: kassa1, report: true });
    expect(all.status).toBe(200);
    expect(all.body.scope).toBe('all');
    expect(all.body.register.code).toBe('Jami');
    expect(all.body.registers.map((r: any) => r.code)).toEqual(['P1', 'P2']);
    expect(all.body.test_drive).toEqual({ count: 1, total: 50000 });
    const p2 = await h.call('GET', '/api/admin/my-dashboard?register_id=reg-p2&period=day', { cookie: kassa1, report: true });
    expect(p2.body.scope).toBe('one');
    expect(p2.body.register.code).toBe('P2');
  });

  it('instruktorlar hisoboti: register=all — hamma kassa, register_id — bitta, parametrsiz kassir — o‘z kassasi', async () => {
    const all = await h.call('GET', '/api/admin/instructor-report?period=day&register=all', { cookie: kassa1, report: true });
    expect(all.status).toBe(200);
    expect(all.body.register_id).toBeNull();
    const p2 = await h.call('GET', '/api/admin/instructor-report?period=day&register_id=reg-p2', { cookie: kassa1, report: true });
    expect(p2.body.register_id).toBe('reg-p2');
    const own = await h.call('GET', '/api/admin/instructor-report?period=day', { cookie: kassa1, report: true });
    expect(own.body.register_id).toBe('reg-p1');
  });

  it('umumiy hisobot: P1 + P2 + platniy — jami va har biri alohida', async () => {
    const r = await h.call('GET', '/api/admin/report/summary?period=day', { cookie: kassa1, report: true });
    expect(r.status).toBe(200);
    const A = r.body.avtodrom;
    expect(A.total).toBe(580000);                                   // qaytarilgan 90 000 kirmaydi
    expect(A.receipts).toBe(3);
    const by = Object.fromEntries(A.registers.map((x: any) => [x.code, x]));
    expect(by.P1).toMatchObject({ total: 380000, receipts: 2, cash: 250000, card: 130000, test_drive: 1, test_drive_total: 50000 });
    expect(by.P2).toMatchObject({ total: 200000, receipts: 1, cash: 50000, card: 150000 });
    expect(r.body.platniy).toMatchObject({ ok: true, total: 120000, cash: 50000, terminal: 40000, click: 30000, sessions: 3, previous_total: 60000, change: 100 });
    expect(r.body.total).toBe(580000 + 120000);
    expect(r.body.by_method).toEqual({ cash: 300000 + 50000, card: 280000 + 40000, click: 30000 });
  });

  it('avtodrom12 javob bermasa — Avtodrom qismi baribir chiqadi, sababi aytiladi', async () => {
    bridgeOk = false;
    const r = await h.call('GET', '/api/admin/report/summary?period=day', { cookie: admin, report: true });
    expect(r.status).toBe(200);
    expect(r.body.platniy.ok).toBe(false);
    expect(r.body.platniy.hint).toMatch(/RECEIPT_SHARED_KEY/);
    expect(r.body.total).toBe(580000);
  });

  it('platniy hisoboti: to‘lov usullari, postlar, soatlar, qarzlar', async () => {
    const r = await h.call('GET', '/api/admin/report/platniy?period=day', { cookie: kassa2, report: true });
    expect(r.status).toBe(200);
    const P = r.body.platniy;
    expect(P).toMatchObject({ ok: true, total: 120000, sessions: 3, vehicles: 2, avg_check: 40000 });
    expect(P.posts[0]).toMatchObject({ name: '1-POST · Ramziddin', total: 80000, sessions: 2, cash: 50000, terminal: 30000 });
    expect(P.hours).toEqual([{ hour: 9, sessions: 2, total: 80000 }]);
    expect(P.debts.top[0]).toMatchObject({ plate: '455 DILNOZA', total: 35000 });
    expect(P.series.find((x: any) => x.key === '09:00')).toMatchObject({ revenue: 80000, sessions: 2 });
  });
});

describe('Panel: «Hisobot» bo‘limi', () => {
  const html = fs.readFileSync('admin/index.html', 'utf8');
  it('yon menyuda «Hisobot» guruhi (qulf bilan); Kassa guruhida hisobot yo‘q', () => {
    const side = /function sideDef\(\)\{([\s\S]*?)\n\}/.exec(html)![1];
    const kassa = /title: isCashier\(\) \? `Kassa[\s\S]*?\] \}\);/.exec(side)![0];
    expect(kassa).not.toMatch(/'report'|'insrep'/);
    const rep = /title: 'Hisobot', lock: true, items: \[([\s\S]*?)\] \}\);/.exec(side)![1];
    for (const r of ['hisobot', 'report', 'insrep', 'platniy']) expect(rep).toContain(`'${r}'`);
  });
  it('hisobot bo‘limlari qulflangan (lock: true) va qulf oynasi chiziladi', () => {
    const routes = /const ROUTES = \{([\s\S]*?)\n\};/.exec(html)![1];
    for (const r of ['hisobot', 'report', 'insrep', 'platniy', 'analytics', 'retention']) {
      expect(new RegExp(`\\n\\s*${r}:[^\\n]*lock: true`).test(routes), r).toBe(true);
    }
    expect(html).toMatch(/if \(R\.lock && !priceTokOk\(\)\) vRepLock\(\); else R\.render\(arg\);/);
    expect(html).toMatch(/\.\.\.repTokHeader\(\)/);
  });
  it('kassir bosh sahifasida «Tushum» yo‘q', () => {
    const home = /function vHome\(\)\{([\s\S]*?)\n\}/.exec(html)![1];
    const cashier = /if \(isCashier\(\)\) \{([\s\S]*?)\} else if \(isOp\(\)\)/.exec(home)![1];
    const stats = /stats = `([^`]*)`/.exec(cashier)![1];
    expect(stats).not.toMatch(/Tushum|h-sum/);
    expect(stats).toMatch(/Faol cheklar/);
    expect(cashier).toMatch(/tile\('hisobot'/);
  });
  it('Kengaytirilgan panel va Analitika ham parol so‘raydi', () => {
    for (const f of ['admin/full.html', 'analytics/index.html']) {
      const s = fs.readFileSync(f, 'utf8');
      expect(s, f).toMatch(/needs_report_pin/);
      expect(s, f).toMatch(/repHdr\(\)/);
    }
  });
});

describe('AI yordamchi: tushum qayerda', () => {
  const top = (q: string) => { const a = answer(q, 'cashier'); return a.kind === 'answer' ? a.items[0].id : a.kind; };
  it('«tushum qayerda» → Hisobot; platniy → Platniy hisoboti', () => {
    expect(top('tushum qayerda')).toBe('hisobot');
    expect(top('bugungi tushum korinmayapti')).toBe('hisobot');
    expect(top('platniy hisoboti')).toBe('platniy');
    expect(top('kassa hisobotini qanday koraman')).toBe('kassa-hisoboti');
  });
});
