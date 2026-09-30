/**
 * 1) Bot xabarlarida davomiylik va narx — BRONNIKI (30 daqiqa ≠ 1 soat).
 * 2) Bron bekor / yopilganda — admin botiga xabar (mijoz o'zi bekor qilsa ham).
 * 3) Kassada narxni o'zgartirish — faqat maxsus parol bilan.
 */
process.env.ADMIN_BOT_TOKEN = '1:admin';
process.env.ADMIN_MINI_APP_URL = 'https://avtodrom.vercel.app/admin';

import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import { makeRegisterToken, mgmtPinHashOf, pricePinHash } from '../backend/src/shift-routes.js';

let h: Harness;
let admin = '', kassa1 = '', kassa2 = '', operator = '';
const ADMIN_CHAT = 6140529649, CUST_TG = 777001, INS_TG = 880001;
const TZ = 'Asia/Tashkent';
const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const D2 = ymd(new Date(Date.now() + 2 * 864e5));
const at = (day: string, hm: string) => new Date(`${day}T${hm}:00+05:00`).toISOString();
const nb = (s: string) => s.replace(/ /g, ' ');

function signedInitData(user: Record<string, unknown>, botToken = '1:customer') {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAtest', user: JSON.stringify(user) });
  const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dataCheck).digest('hex'));
  return params.toString();
}
const tg = async (method: string, url: string, payload?: any) => {
  const r = await h.app.inject({ method, url, headers: { 'x-telegram-init-data': signedInitData({ id: CUST_TG, first_name: 'Anna' }) }, payload });
  let body: any = {}; try { body = JSON.parse(r.payload); } catch { body = r.payload; }
  return { status: r.statusCode, body };
};
const to = (chat: number) => h.telegram.filter((m) => m.chat === chat).map((m) => ({ ...m, text: nb(m.text) }));

beforeAll(async () => {
  h = await makeHarness();
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
  h.db.cash_registers.push({ id: 'reg-p2', code: 'P2', name: '2-kassa', is_active: true });
  const st = (id: string, login: string, role: string, register_id: string | null) =>
    h.db.staff.push({ id, login, password_hash: hashPassword('parol1234'), role, register_id, full_name: login, is_active: true });
  st('st-admin', 'boss', 'admin', null); st('st-op', 'operator1', 'operator', null);
  st('st-k1', 'kassa1', 'cashier', 'reg-p1'); st('st-k2', 'kassa2', 'cashier', 'reg-p2');
  h.db.users.push({ id: 'u-admin', full_name: 'Admin', role: 'admin', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-anna', full_name: 'Анна Иванова', phone: '+998901112233', telegram_id: CUST_TG, role: 'customer', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-ins', full_name: 'Abdulloh Yunusov', phone: '+998901114455', telegram_id: INS_TG, role: 'instructor', is_active: true, is_blocked: false });
  h.db.instructor_profiles.push({ id: 'ip-1', user_id: 'u-ins', is_verified: true, is_available: true, categories: ['B'] });
  h.db.courses.push({ id: 'c-b', name: 'Amaliy haydash — B toifa', category: 'B', price: 250000, duration_minutes: 60, is_active: true });
  h.db.admin_settings.push({ key: 'rate_b', value: 250000 }, { key: 'half_b', value: 150000 },
    { key: 'mgmt_pin', value: { hash: mgmtPinHashOf('4321') } });
  h.db.telegram_admins.push({ id: 1, telegram_chat_id: ADMIN_CHAT, is_active: true });
  admin = (await h.login('boss', 'parol1234')).cookie;
  kassa1 = (await h.login('kassa1', 'parol1234')).cookie;
  kassa2 = (await h.login('kassa2', 'parol1234')).cookie;
  operator = (await h.login('operator1', 'parol1234')).cookie;
});

describe('Bot xabarlari: davomiylik va narx — bronniki', () => {
  it('30 daqiqalik bron: instruktor va mijozga «30 daqiqa · 150 000», «1 soat / 250 000» emas', async () => {
    const r = await tg('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', duration_minutes: 30, start_at: at(D2, '16:00') });
    expect(r.status).toBe(201);
    const ins = to(INS_TG)[0].text;
    expect(ins).toContain('30 daqiqa');
    expect(ins).not.toMatch(/60 daqiqa|1 soat/);
    expect(ins).toContain('150 000 so‘m');
    expect(ins).not.toContain('250 000');
    const cust = to(CUST_TG)[0].text;
    expect(cust).toContain('30 daqiqa');
    expect(cust).toContain('150 000 so‘m');
  });

  it('admin tasdiqlaganda ham (30 daqiqa) va 2 soatlik bronda «2 soat · 500 000»', async () => {
    const r = await tg('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', duration_minutes: 120, start_at: at(D2, '10:00') });
    h.telegram.length = 0;
    const c = await h.call('PATCH', `/api/admin/bookings/${r.body.booking.id}/status`, { cookie: admin, payload: { status: 'confirmed' } });
    expect(c.status).toBe(200);
    const ins = to(INS_TG)[0].text;
    expect(ins).toContain('2 soat');
    expect(ins).toContain('500 000 so‘m');
  });

  it('eslatma ham bron narxi bilan', async () => {
    const { reminderText } = await import('../backend/src/reminders.js');
    const { loadBookingDetails } = await import('../backend/src/notify.js');
    const b = { id: 'b-x', course_id: 'c-b', instructor_id: 'ip-1', customer_id: 'u-anna', duration_minutes: 30, price: 150000, start_at: at(D2, '09:00'), status: 'confirmed' };
    const t = nb(reminderText(60, b, await loadBookingDetails(b)));
    expect(t).toContain('150 000 so‘m');
    expect(t).not.toContain('250 000');
  });
});

describe('Bron bekor / yopildi — admin botiga', () => {
  it('mijoz Mini App’da o‘zi bekor qilsa (tasdiqlanmagan bron) — admin botiga sabab bilan', async () => {
    const r = await tg('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', duration_minutes: 60, start_at: at(D2, '07:00') });
    const code = h.db.bookings[0].pickup_code;
    h.telegram.length = 0;
    const c = await tg('PATCH', `/api/bookings/${r.body.booking.id}/cancel`, { reason: 'Rejalarim o‘zgardi' });
    expect(c.status).toBe(200);
    expect(c.body.mode).toBe('cancelled');
    const m = to(ADMIN_CHAT);
    expect(m).toHaveLength(1);
    expect(m[0].text).toMatch(/BRON BEKOR QILINDI/);
    expect(m[0].text).toMatch(/mijoz o‘zi/);
    expect(m[0].text).toContain('Анна Иванова');
    expect(m[0].text).toContain('Abdulloh Yunusov');
    expect(m[0].text).toContain('07:00–08:00');
    expect(m[0].text).toContain(code);
    expect(m[0].text).toContain('Rejalarim o‘zgardi');
    expect(m[0].text).toMatch(/vaqt bo‘shadi/);
    expect(m[0].markup.inline_keyboard[0][0].web_app.url).toMatch(/open=bookings%2Fall/);
  });

  it('avtomatik yopilganda: to‘lanmagan — «mijoz kelmadi»; to‘langan — «pul kassada» ogohlantirishi', async () => {
    const mk = (id: string, startMin: number, extra: any = {}) => {
      const s = new Date(Date.now() + startMin * 60000).toISOString();
      h.db.bookings.push({ id, customer_id: 'u-anna', instructor_id: 'ip-1', course_id: 'c-b', start_at: s, booking_date: s,
        end_at: new Date(Date.parse(s) + 3600e3).toISOString(), status: 'confirmed', source: 'app', pickup_code: 'AVD-' + id, duration_minutes: 60, price: 250000,
        created_at: new Date(Date.now() - 3 * 864e5).toISOString(), ...extra });
    };
    mk('late', -20);
    mk('paid', -14 * 60);
    h.db.payments.push({ id: 'p-paid', booking_id: 'paid', customer_id: 'u-anna', amount: 250000, method: 'cash', status: 'paid', paid_at: new Date(Date.now() - 864e5).toISOString(), receipt_code: 'AVD-R1', register_id: 'reg-p1' });
    await h.app.inject({ method: 'GET', url: '/api/cron/reminders', headers: { authorization: 'Bearer test-cron-secret' } });
    const m = to(ADMIN_CHAT).map((x) => x.text);
    expect(m.some((t) => /BRON YOPILDI/.test(t) && t.includes('AVD-late'))).toBe(true);
    expect(m.some((t) => /TO‘LANGAN BRON YOPILDI/.test(t) && t.includes('AVD-paid') && /Pul kassada/.test(t))).toBe(true);
  });
});

describe('Kassada narxni o‘zgartirish — maxsus parol', () => {
  const walkIn = (cookie: string, amount: number, extra: any = {}) => h.call('POST', '/api/admin/cashier/issue', { cookie, payload: {
    register_token: makeRegisterToken(cookie === kassa2 ? 'reg-p2' : 'reg-p1'), full_name: 'Yangi Mijoz', instructor_id: 'ip-1', course_id: 'c-b',
    category: 'B', duration_minutes: 60, amount, cash_amount: amount, card_amount: 0, start_at: new Date().toISOString(), ...extra } });

  it('avtomatik narx — parolsiz; boshqa summa — parolsiz RAD, hech narsa yaratilmaydi', async () => {
    const bad = await walkIn(kassa1, 200000);
    expect(bad.status).toBe(403);
    expect(bad.body.error).toMatch(/maxsus parol/);
    expect(bad.body.error).toContain('250 000 → 200 000');
    expect(h.db.bookings).toHaveLength(0);
    expect(h.db.users.filter((u: any) => u.full_name === 'Yangi Mijoz')).toHaveLength(0);
    const ok = await walkIn(kassa1, 250000);
    expect(ok.status).toBe(201);
  });

  it('to‘g‘ri parol → 15 daqiqalik token → o‘zgartirilgan narx o‘tadi va auditga yoziladi', async () => {
    const wrong = await h.call('POST', '/api/admin/price-unlock', { cookie: kassa1, payload: { pin: '1111' } });
    expect(wrong.status).toBe(400);            // 401 emas — panel kassirni tizimdan chiqarmasin
    expect(wrong.body.wrong_pin).toBe(true);
    const u = await h.call('POST', '/api/admin/price-unlock', { cookie: kassa1, payload: { pin: '4321' } });   // Boshqaruv PIN (narx paroli hali yo'q)
    expect(u.status).toBe(200);
    expect(u.body.token).toMatch(/^price\./);
    expect(Date.parse(u.body.expires_at) - Date.now()).toBeGreaterThan(14 * 60000);
    const r = await walkIn(kassa1, 200000, { price_token: u.body.token });
    expect(r.status).toBe(201);
    expect(h.db.payments[0].amount).toBe(200000);
    const a = h.db.admin_audit_logs.find((x: any) => x.action === 'RECEIPT_ISSUED');
    expect(a.new_data.price_override).toEqual({ expected: 250000, total: 200000 });
    expect(h.db.admin_audit_logs.some((x: any) => x.action === 'PRICE_UNLOCK' && x.new_data?.staff === 'kassa1')).toBe(true);
    expect(h.db.admin_audit_logs.some((x: any) => x.action === 'PRICE_PIN_FAIL')).toBe(true);
    // Boshqa xodim shu token bilan o'zgartira olmaydi
    const other = await walkIn(kassa2, 200000, { price_token: u.body.token });
    expect(other.status).toBe(403);
  });

  it('administrator alohida «narx paroli» o‘rnatsa — Boshqaruv PIN endi ishlamaydi; operator ocholmaydi; 5 xatodan keyin blok', async () => {
    expect((await h.call('PUT', '/api/admin/price-pin', { cookie: kassa1, payload: { pin: '5555' } })).status).toBe(403);
    const set = await h.call('PUT', '/api/admin/price-pin', { cookie: admin, payload: { pin: '5555' } });
    expect(set.status).toBe(200);
    expect(h.db.admin_settings.find((x: any) => x.key === 'price_pin').value.hash).toBe(pricePinHash('5555'));
    const st = await h.call('GET', '/api/admin/price-pin', { cookie: admin });
    expect(st.body).toMatchObject({ is_set: true, ready: true });
    expect((await h.call('POST', '/api/admin/price-unlock', { cookie: kassa1, payload: { pin: '4321' } })).status).toBe(400);
    expect((await h.call('POST', '/api/admin/price-unlock', { cookie: kassa1, payload: { pin: '5555' } })).status).toBe(200);
    expect((await h.call('POST', '/api/admin/price-unlock', { cookie: operator, payload: { pin: '5555' } })).status).toBe(403);
    for (let i = 0; i < 5; i++) await h.call('POST', '/api/admin/price-unlock', { cookie: kassa2, payload: { pin: '0000' } });
    const locked = await h.call('POST', '/api/admin/price-unlock', { cookie: kassa2, payload: { pin: '5555' } });
    expect(locked.status).toBe(429);
    // Sozlamalar ro'yxatida parol xeshi ko'rinmaydi
    const s = await h.call('GET', '/api/admin/settings', { cookie: admin });
    expect(s.body.settings.map((x: any) => x.key)).not.toContain('price_pin');
  });

  it('bron bo‘yicha chek: bron narxi (30 daq = 150 000) — parolsiz; eski noto‘g‘ri kutilayotgan to‘lov (250 000) hisobga olinmaydi', async () => {
    const s = new Date(Date.now() + 3600e3).toISOString();
    h.db.bookings.push({ id: 'b-30', customer_id: 'u-anna', instructor_id: 'ip-1', course_id: 'c-b', start_at: s, booking_date: s,
      end_at: new Date(Date.parse(s) + 1800e3).toISOString(), status: 'confirmed', source: 'app', pickup_code: 'AVD-7918', duration_minutes: 30, price: 150000, category: 'B' });
    h.db.payments.push({ id: 'p-old', booking_id: 'b-30', customer_id: 'u-anna', amount: 250000, status: 'pending' });
    const f = await h.call('GET', '/api/admin/cashier/find?q=AVD-7918', { cookie: kassa1 });
    expect(f.body.bookings[0].price).toBe(150000);
    const issue = (amount: number, extra: any = {}) => h.call('POST', '/api/admin/cashier/issue', { cookie: kassa1, payload: {
      register_token: makeRegisterToken('reg-p1'), booking_id: 'b-30', category: 'B', duration_minutes: 30, amount, cash_amount: amount, card_amount: 0, ...extra } });
    expect((await issue(250000)).status).toBe(403);
    const ok = await issue(150000);
    expect(ok.status).toBe(201);
    expect(h.db.payments.find((p: any) => p.booking_id === 'b-30').amount).toBe(150000);
  });

  it('eski «cashier/pay» yo‘li ham: standart — bron narxi; boshqa summa — parol bilan', async () => {
    const s = new Date(Date.now() + 3600e3).toISOString();
    h.db.bookings.push({ id: 'b-2h', customer_id: 'u-anna', instructor_id: 'ip-1', course_id: 'c-b', start_at: s, booking_date: s, hours: 2,
      end_at: new Date(Date.parse(s) + 7200e3).toISOString(), status: 'confirmed', duration_minutes: 120, price: 500000, category: 'B' });
    const pay = (extra: any) => h.call('POST', '/api/admin/cashier/pay', { cookie: kassa1, payload: { booking_id: 'b-2h', method: 'cash', ...extra } });
    expect((await pay({ amount: 400000 })).status).toBe(403);
    const ok = await pay({});
    expect(ok.status).toBe(201);
    expect(h.db.payments[0].amount).toBe(500000);
  });
});
