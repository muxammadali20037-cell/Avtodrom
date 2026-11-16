/**
 * 3 SOATLIK CHEK → 3 TA ALOHIDA 1 SOATLIK CHEK
 *  · kassada bronsiz «3 soat» — paketdek 3 ta OCHIQ 1 soatlik chek (har birining
 *    o'z 4 xonali raqami), jami narx o'zgarmaydi (B: 700 000 = 233 334 + 233 333 × 2);
 *  · istalgan kun, istalgan instruktor uradi — dars urilgan paytdan 1 soat;
 *  · eski bitta 3 soatlik chek — «3 ta chekka bo'lish» (maxsus parol bilan),
 *    1-chek o'z raqamini saqlaydi;
 *  · bron bo'yicha 3 soatlik to'lov — avvalgidek bitta chek.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import { makeRegisterToken, mgmtPinHashOf } from '../backend/src/shift-routes.js';
import { bundleText, bundleNote } from '../backend/src/packages.js';

let h: Harness;
let kassa1 = '';
const A_TG = 880901;

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
const issue = (extra: any) => h.call('POST', '/api/admin/cashier/issue', { cookie: kassa1, payload: {
  register_token: makeRegisterToken('reg-p1'), full_name: 'Feruza', phone: '+998901239977', course_id: 'c-b', category: 'B',
  card_amount: 0, ...extra, cash_amount: extra.cash_amount ?? extra.amount } });

beforeAll(async () => {
  h = await makeHarness();
  const base = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async (u: any, o: any) => {
    if (String(u).includes('/rest/v1/rpc/generate_receipt_code')) {
      const code = `AVD-261115-T${String(++n).padStart(4, '0')}`;
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
  h.db.instructor_profiles.push({ id: 'ip-a', user_id: 'u-a', is_verified: true, is_available: true, categories: ['A', 'B'] });
  h.db.courses.push({ id: 'c-b', name: 'B toifa', category: 'B', price: 250000, duration_minutes: 60, is_active: true });
  h.db.courses.push({ id: 'c-a', name: 'A toifa', category: 'A', price: 350000, duration_minutes: 60, is_active: true });
  h.db.admin_settings.push({ key: 'rate_b', value: 250000 }, { key: 'rate_a', value: 350000 });
  kassa1 = (await h.login('kassa1', 'parol1234')).cookie;
});

describe('Kassa: «3 soat» — 3 ta alohida 1 soatlik ochiq chek', () => {
  it('B toifa: 700 000 → 3 chek (233 334 + 233 333 + 233 333), har biri o‘z raqami bilan, ochiq', async () => {
    const r = await issue({ duration_minutes: 180, amount: 700000, instructor_id: 'ip-a' });
    expect(r.status).toBe(201);
    const rc = r.body.receipts;
    expect(rc).toHaveLength(3);
    expect(rc.map((x: any) => x.amount)).toEqual([233334, 233333, 233333]);
    expect(rc.every((x: any) => x.open && /^\d{4}$/.test(x.short_code))).toBe(true);
    expect(new Set(rc.map((x: any) => x.short_code)).size).toBe(3);
    expect(new Set(rc.map((x: any) => x.code)).size).toBe(3);
    expect(rc.map((x: any) => x.package_text)).toEqual(['3 soat · 1/3', '3 soat · 2/3', '3 soat · 3/3']);
    /* bronlar: 1 soatdan, ochiq (2099), instruktor biriktirilmagan (kim ursa — o'shaniki) */
    expect(h.db.bookings).toHaveLength(3);
    expect(h.db.bookings.every((b: any) => b.duration_minutes === 60 && b.instructor_id === null && new Date(b.start_at).getUTCFullYear() === 2099)).toBe(true);
    expect(h.db.bookings.map((b: any) => b.customer_note)).toContain('3 soat · 2/3-mashg‘ulot · ochiq chek');
    const pays = h.db.payments;
    expect(pays).toHaveLength(3);
    expect(pays.reduce((a: number, p: any) => a + p.amount, 0)).toBe(700000);
    expect(pays.map((p: any) => p.note)).toEqual(['3 soat · 1/3', '3 soat · 2/3', '3 soat · 3/3']);
    /* paket yozuvi — 180 daqiqa */
    const pk = h.db.admin_settings.find((x: any) => String(x.key).startsWith('pack:'));
    expect(pk.value).toMatchObject({ minutes: 180, price: 700000, list_price: 700000, open: true });
  });

  it('A toifa (tarif yo‘q): 3 × 350 000 = 1 050 000 → 3 ta 350 000 lik chek', async () => {
    const r = await issue({ course_id: 'c-a', category: 'A', duration_minutes: 180, amount: 1050000 });
    expect(r.status).toBe(201);
    expect(r.body.receipts.map((x: any) => x.amount)).toEqual([350000, 350000, 350000]);
  });

  it('aralash to‘lov: naqd va karta cheklarga bo‘linadi, jami mos', async () => {
    const r = await issue({ duration_minutes: 180, amount: 700000, cash_amount: 400000, card_amount: 300000 });
    expect(r.status).toBe(201);
    const pays = h.db.payments;
    expect(pays.reduce((a: number, p: any) => a + p.cash_amount, 0)).toBe(400000);
    expect(pays.reduce((a: number, p: any) => a + p.card_amount, 0)).toBe(300000);
  });

  it('har chek raqam bilan alohida uriladi — dars hozirdan 1 soat', async () => {
    const r = await issue({ duration_minutes: 180, amount: 700000 });
    const [c1, c2] = r.body.receipts;
    const s1 = await A('POST', '/api/instructor/scan/start', { code: c1.short_code });
    expect(s1.status).toBe(200);
    const b1 = h.db.bookings.find((b: any) => b.status === 'in_progress');
    expect(b1.instructor_id).toBe('ip-a');
    expect(Date.parse(b1.end_at) - Date.parse(b1.start_at)).toBe(60 * 60000);
    expect(Math.abs(Date.parse(b1.start_at) - Date.now())).toBeLessThan(60000);
    /* qolgan ikkitasi — hali faol */
    expect(h.db.bookings.filter((b: any) => b.status === 'confirmed')).toHaveLength(2);
    expect(c2.short_code).not.toBe(c1.short_code);
  });

  it('bron bo‘yicha 3 soatlik to‘lov — avvalgidek bitta chek', async () => {
    h.db.users.push({ id: 'u-m', full_name: 'Bron Mijoz', phone: '+998901110000', role: 'customer', is_active: true, is_blocked: false });
    const st = new Date(Date.now() + 3600e3).toISOString();
    h.db.bookings.push({ id: 'b-3h', customer_id: 'u-m', instructor_id: 'ip-a', course_id: 'c-b', category: 'B', start_at: st, booking_date: st,
      end_at: new Date(Date.parse(st) + 180 * 60000).toISOString(), duration_minutes: 180, status: 'confirmed', source: 'app', price: 700000 });
    const r = await h.call('POST', '/api/admin/cashier/issue', { cookie: kassa1, payload: {
      register_token: makeRegisterToken('reg-p1'), booking_id: 'b-3h', duration_minutes: 180, amount: 700000, cash_amount: 700000, card_amount: 0 } });
    expect(r.status).toBe(201);
    expect(r.body.receipts).toHaveLength(1);
    expect(h.db.payments).toHaveLength(1);
  });
});

describe('Eski bitta 3 soatlik chek → 3 ta chek (maxsus parol bilan)', () => {
  const old = () => {
    const s0 = new Date().toISOString(), e0 = new Date(Date.now() + 180 * 60000).toISOString();
    h.db.users.push({ id: 'u-f', full_name: 'FERUZA', role: 'customer', is_active: true, is_blocked: false });
    h.db.bookings.push({ id: 'bk-3h', customer_id: 'u-f', instructor_id: null, course_id: 'c-b', category: 'B', status: 'confirmed', source: 'walk_in',
      start_at: s0, end_at: e0, booking_date: s0, duration_minutes: 180, hours: 1, price: null });
    h.db.payments.push({ id: 'pay-3h', booking_id: 'bk-3h', customer_id: 'u-f', amount: 700000, method: 'cash', cash_amount: 700000, card_amount: 0,
      status: 'paid', receipt_code: 'AVD-261115-F3MZB', short_code: '5268', register_id: 'reg-p1', paid_at: s0, cashier_id: 'u-admin' });
    h.db.admin_settings.push({ key: 'mgmt_pin', value: { hash: mgmtPinHashOf('4321') } });
  };
  it('3 ta chek, summa o‘zgarmaydi, 1-chek eski raqamini (5268) saqlaydi', async () => {
    old();
    const t = await h.call('POST', '/api/admin/price-unlock', { cookie: kassa1, payload: { pin: '4321' } });
    const r = await h.call('POST', '/api/admin/cashier/split-package', { cookie: kassa1, payload: { code: 'AVD-261115-F3MZB', price_token: t.body.token } });
    expect(r.status).toBe(200);
    expect(r.body.receipts).toHaveLength(3);
    expect(r.body.receipts.map((x: any) => x.amount)).toEqual([233334, 233333, 233333]);
    expect(r.body.receipts[0]).toMatchObject({ code: 'AVD-261115-F3MZB', short_code: '5268', package_text: '3 soat · 1/3' });
    expect(new Set(r.body.receipts.map((x: any) => x.short_code)).size).toBe(3);
    const pays = h.db.payments.filter((p: any) => p.status === 'paid');
    expect(pays.reduce((a: number, p: any) => a + p.amount, 0)).toBe(700000);
    expect(h.db.bookings.every((b: any) => b.duration_minutes === 60 && new Date(b.start_at).getUTCFullYear() === 2099)).toBe(true);
    const s = await A('POST', '/api/instructor/scan/start', { code: '5268' });
    expect(s.status).toBe(200);
  });
  it('2 soatlik chekni bo‘lib bo‘lmaydi — 409', async () => {
    old();
    h.db.bookings[0].duration_minutes = 120;
    const t = await h.call('POST', '/api/admin/price-unlock', { cookie: kassa1, payload: { pin: '4321' } });
    const r = await h.call('POST', '/api/admin/cashier/split-package', { cookie: kassa1, payload: { code: 'AVD-261115-F3MZB', price_token: t.body.token } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/3 yoki 5 soatlik/);
  });
});

describe('Matnlar va panel', () => {
  it('nomlar: 5 soat — paket, 3 soat — «3 soat»', () => {
    expect(bundleText(300)).toBe('5 soatlik paket');
    expect(bundleText(180)).toBe('3 soat');
    expect(bundleNote(2, 3, 180)).toBe('3 soat · 2/3-mashg‘ulot');
    expect(bundleNote(2, 5, 300)).toBe('5 soatlik paket · 2/5-mashg‘ulot');
  });
  it('kassa: «3 soat» — 3 ta chek, instruktor va kun tanlanmaydi; Cheklar’da «3 ta chekka bo‘lish»', () => {
    const html = fs.readFileSync('admin/index.html', 'utf8');
    expect(html).toMatch(/const coTri = W => !W\.booking && !W\.krug && !isPkg\(W\) && Number\(W\.min\) === TRI_MIN;/);
    expect(html).toMatch(/else if \(coTri\(W\)\) \{ body\.duration_minutes = TRI_MIN; body\.instructor_id = null; \}/);
    expect(html).toMatch(/3 ta alohida chek chiqadi — har biri 1 soat/);
    expect(html).toMatch(/return m === PKG_MIN \? 5 : m === TRI_MIN \? 3 : 0;/);
  });
});
