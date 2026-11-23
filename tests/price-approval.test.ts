/**
 * SO'MLIK CHEK — ADMIN RUXSATI (Telegram).
 * Kassir narxni maxsus parol bilan 1 000 so'mdan kam qilsa (0, 1, 2 so'm…),
 * chek admin botdagi «Ruxsat berish» tugmasidan keyingina chiqadi.
 * Ruxsat aynan shu chekka bog'langan, bir marta ishlatiladi.
 * Shu yerda: test drive + 1 soat (250 000 + 50 000 = 300 000).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import { makeRegisterToken } from '../backend/src/shift-routes.js';
import { decisionSig } from '../backend/src/price-approval.js';

let h: Harness;
let kassa1 = '';
const ADMIN_TG = 5001, GROUP = -100777;
const issue = (extra: any, cookie = kassa1) => h.call('POST', '/api/admin/cashier/issue', { cookie, payload: {
  register_token: makeRegisterToken('reg-p1'), full_name: 'Mohina Aliyeva', phone: '+998901230000', course_id: 'c-b', category: 'B',
  card_amount: 0, duration_minutes: 60, ...extra, cash_amount: extra.amount } });
const pin = (extra: any) => issue({ ...extra, price_token: h.reportToken(kassa1) });
function signedInitData(user: Record<string, unknown>, botToken = '1:admin', age = 0) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000) - age), query_id: 'AAtest', user: JSON.stringify(user) });
  const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dataCheck).digest('hex'));
  return params.toString();
}
const decide = (id: string, d: 'ok' | 'no', user: any = { id: ADMIN_TG, first_name: 'Rahbar' }) =>
  h.call('POST', '/api/price-ok', { payload: { id, d, initData: signedInitData(user) } });
const rec = (id: string) => h.db.admin_settings.find((x: any) => x.key === `price_ok:${id}`)?.value;
const sends = () => h.tgCalls.filter((c: any) => c.method === 'sendMessage');
const edits = () => h.tgCalls.filter((c: any) => c.method === 'editMessageText');

beforeAll(async () => {
  h = await makeHarness();
  const base = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async (u: any, o: any) => {
    if (String(u).includes('/rest/v1/rpc/generate_receipt_code')) {
      const code = `AVD-261123-P${String(++n).padStart(4, '0')}`;
      return { ok: true, status: 200, text: async () => JSON.stringify(code), json: async () => code, headers: new Map() } as any;
    }
    return base(u, o);
  }) as any;
});

beforeEach(async () => {
  h.reset();
  process.env.ADMIN_BOT_TOKEN = '1:admin';
  h.tgResults.set('sendMessage', { message_id: 77 });
  h.db.cash_registers.push({ id: 'reg-p1', code: 'P1', name: '1-kassa', is_active: true });
  h.db.staff.push({ id: 'st-k1', login: 'kassa1', password_hash: hashPassword('parol1234'), role: 'cashier', register_id: 'reg-p1', full_name: 'kassa1', is_active: true });
  h.db.users.push({ id: 'u-admin', full_name: 'Admin', role: 'admin', is_active: true, is_blocked: false });
  h.db.courses.push({ id: 'c-b', name: 'B toifa', category: 'B', price: 250000, duration_minutes: 60, is_active: true });
  h.db.admin_settings.push({ key: 'rate_b', value: 250000 });
  h.db.telegram_admins.push({ id: 1, telegram_chat_id: ADMIN_TG, is_active: true }, { id: 2, telegram_chat_id: GROUP, is_active: true },
    { id: 3, telegram_chat_id: 6002, is_active: false });
  kassa1 = (await h.login('kassa1', 'parol1234')).cookie;
});

describe('So‘mlik chek — Telegram orqali admin ruxsati', () => {
  it('0 so‘m: parolsiz — maxsus parol; parol bilan — ruxsat so‘rovi, chek chiqmaydi', async () => {
    const a = await issue({ amount: 0 });
    expect(a.status).toBe(403);
    expect(a.body.needs_price_pin).toBe(true);

    const r = await pin({ amount: 0 });
    expect(r.status).toBe(403);
    expect(r.body.needs_approval).toBe(true);
    expect(r.body.approval).toMatchObject({ status: 'pending', total: 0, expected: 250000, sent: 2 });
    expect(h.db.payments).toHaveLength(0);
    expect(h.db.bookings).toHaveLength(0);
    expect(h.db.users.filter((u: any) => u.role === 'customer')).toHaveLength(0);   // mijoz ham yaratilmadi

    /* faqat faol adminlarga: shaxsiy chatda web_app, guruhda imzolangan havola */
    const s = sends();
    expect(s.map((x: any) => x.body.chat_id).sort()).toEqual([GROUP, ADMIN_TG].sort());
    const priv = s.find((x: any) => x.body.chat_id === ADMIN_TG).body;
    expect(priv.text).toMatch(/So‘mlik chek/);
    expect(priv.text).toMatch(/Mohina Aliyeva/);
    expect(priv.text).toMatch(/250 000<\/s> → <b>0 so‘m/);
    const [ok, no] = priv.reply_markup.inline_keyboard[0];
    expect(ok.text).toMatch(/Ruxsat berish/);
    expect(no.text).toMatch(/Rad etish/);
    expect(ok.web_app.url).toMatch(new RegExp(`/ruxsat\\?id=${r.body.approval.id}&d=ok$`));
    const grp = s.find((x: any) => x.body.chat_id === GROUP).body.reply_markup.inline_keyboard[0][0];
    expect(grp.web_app).toBeUndefined();
    expect(grp.url).toContain(`s=${decisionSig(r.body.approval.id, 'ok')}`);
    expect(h.db.admin_audit_logs.some((x: any) => x.action === 'PRICE_APPROVAL_ASKED')).toBe(true);
  });

  it('kutilayotganda qayta bosilsa — o‘sha so‘rov, adminlarga ikkinchi xabar ketmaydi', async () => {
    const r1 = await pin({ amount: 0 });
    const r2 = await pin({ amount: 0 });
    expect(r2.body.approval.id).toBe(r1.body.approval.id);
    expect(sends()).toHaveLength(2);
  });

  it('ruxsat → kassa holatni ko‘radi → chek 0 so‘m bilan chiqadi; ruxsat bir marta ishlaydi', async () => {
    const id = (await pin({ amount: 0 })).body.approval.id;
    expect((await h.call('GET', `/api/admin/price-approval?id=${id}`, { cookie: kassa1 })).body.status).toBe('pending');

    const d = await decide(id, 'ok');
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ ok: true, status: 'approved', decided_by: 'Rahbar' });
    expect(edits()).toHaveLength(2);                                          // ikkala xabarda tugmalar olindi
    expect(edits()[0].body.text).toMatch(/Ruxsat berildi/);
    expect(edits()[0].body.reply_markup).toBeUndefined();
    expect((await h.call('GET', `/api/admin/price-approval?id=${id}`, { cookie: kassa1 })).body).toMatchObject({ status: 'approved', decided_by: 'Rahbar' });

    const r = await pin({ amount: 0 });
    expect(r.status).toBe(201);
    expect(h.db.payments).toHaveLength(1);
    expect(h.db.payments[0]).toMatchObject({ amount: 0, cash_amount: 0, card_amount: 0, status: 'paid', register_id: 'reg-p1' });
    expect(rec(id).status).toBe('used');
    const log = h.db.admin_audit_logs.find((x: any) => x.action === 'RECEIPT_ISSUED');
    expect(log.new_data.price_override).toEqual({ expected: 250000, total: 0 });
    expect(h.db.admin_audit_logs.some((x: any) => x.action === 'PRICE_APPROVAL_OK')).toBe(true);

    /* ikkinchi shunday chek — yana ruxsat kerak */
    const again = await pin({ amount: 0, full_name: 'Mohina Aliyeva' });
    expect(again.status).toBe(403);
    expect(again.body.needs_approval).toBe(true);
    expect(h.db.payments).toHaveLength(1);
  });

  it('ruxsat aynan o‘sha chekka: 0 so‘mga berilgan ruxsat 1 so‘mga yoki boshqa mijozga ishlamaydi', async () => {
    const id = (await pin({ amount: 0 })).body.approval.id;
    await decide(id, 'ok');
    const one = await pin({ amount: 1 });
    expect(one.body.needs_approval).toBe(true);
    expect(one.body.approval.id).not.toBe(id);
    const other = await pin({ amount: 0, full_name: 'Boshqa Odam' });
    expect(other.body.needs_approval).toBe(true);
    expect(h.db.payments).toHaveLength(0);
    expect(rec(id).status).toBe('approved');                                  // o'zinikiga hali ham ishlaydi
  });

  it('rad etish → kassa «rejected» ko‘radi; darhol qayta bosilsa yangi xabar ketmaydi', async () => {
    const id = (await pin({ amount: 1 })).body.approval.id;
    const d = await decide(id, 'no');
    expect(d.body.status).toBe('rejected');
    expect(edits()[0].body.text).toMatch(/Rad etildi/);
    expect((await h.call('GET', `/api/admin/price-approval?id=${id}`, { cookie: kassa1 })).body.status).toBe('rejected');
    const r = await pin({ amount: 1 });
    expect(r.status).toBe(403);
    expect(r.body.approval.status).toBe('rejected');
    expect(sends()).toHaveLength(2);
    expect(h.db.payments).toHaveLength(0);
    /* bir daqiqadan keyin — yangi so'rov */
    rec(id).decided_at = new Date(Date.now() - 2 * 60000).toISOString();
    const r2 = await pin({ amount: 1 });
    expect(r2.body.approval.status).toBe('pending');
    expect(sends()).toHaveLength(4);
  });

  it('qarorni faqat admin beradi: begona, soxta imzo, imzosiz — rad; guruh havolasi imzosi ishlaydi', async () => {
    const id = (await pin({ amount: 0 })).body.approval.id;
    expect((await decide(id, 'ok', { id: 9999, first_name: 'Begona' })).status).toBe(403);
    expect((await decide(id, 'ok', { id: 6002, first_name: 'Ochirilgan admin' })).status).toBe(403);
    const forged = signedInitData({ id: ADMIN_TG }, '1:boshqa-bot');
    expect((await h.call('POST', '/api/price-ok', { payload: { id, d: 'ok', initData: forged } })).status).toBe(401);
    expect((await h.call('POST', '/api/price-ok', { payload: { id, d: 'ok' } })).status).toBe(401);
    expect((await h.call('POST', '/api/price-ok', { payload: { id, d: 'ok', s: decisionSig(id, 'no') } })).status).toBe(401);
    expect(rec(id).status).toBe('pending');
    const g = await h.call('POST', '/api/price-ok', { payload: { id, d: 'ok', s: decisionSig(id, 'ok') } });
    expect(g.body.status).toBe('approved');
    /* ikkinchi bosish — o'zgarmaydi */
    const again = await decide(id, 'no');
    expect(again.body).toMatchObject({ status: 'approved', already: true });
  });

  it('kassir so‘rovni bekor qiladi — adminlardagi tugmalar olinadi, keyin ruxsat berib bo‘lmaydi', async () => {
    const id = (await pin({ amount: 0 })).body.approval.id;
    const c = await h.call('POST', '/api/admin/price-approval', { cookie: kassa1, payload: { id, cancel: true } });
    expect(c.body.status).toBe('cancelled');
    expect(edits()[0].body.text).toMatch(/bekor qildi/);
    expect((await decide(id, 'ok')).body).toMatchObject({ status: 'cancelled', already: true });
  });

  it('15 daqiqada javob bo‘lmasa — muddati o‘tadi, keyingi bosishda yangi so‘rov', async () => {
    const id = (await pin({ amount: 0 })).body.approval.id;
    rec(id).expires_at = new Date(Date.now() - 1000).toISOString();
    expect((await h.call('GET', `/api/admin/price-approval?id=${id}`, { cookie: kassa1 })).body.status).toBe('expired');
    expect((await decide(id, 'ok')).body.status).toBe('expired');
    const r = await pin({ amount: 0 });
    expect(r.body.approval.status).toBe('pending');
    expect(sends()).toHaveLength(4);
  });

  it('1 000 so‘m va undan ko‘p — oddiy chegirma, ruxsat so‘ralmaydi', async () => {
    const r = await pin({ amount: 1000 });
    expect(r.status).toBe(201);
    expect(sends()).toHaveLength(0);
    const r2 = await pin({ amount: 200000, full_name: 'Ikkinchi', phone: '+998901230001' });
    expect(r2.status).toBe(201);
  });

  it('admin bot sozlanmagan bo‘lsa — so‘mlik chek chiqmaydi, sababi aytiladi', async () => {
    delete process.env.ADMIN_BOT_TOKEN;
    delete process.env.TELEGRAM_ADMIN_BOT_TOKEN;
    const r = await pin({ amount: 0 });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/Admin bot sozlanmagan/);
    expect(h.db.payments).toHaveLength(0);
  });

  it('eski /cashier/pay yo‘li orqali so‘mlik chek chiqarib bo‘lmaydi', async () => {
    h.db.users.push({ id: 'u-m', full_name: 'Bron Mijoz', phone: '+998901110000', role: 'customer', is_active: true, is_blocked: false });
    const st = new Date(Date.now() + 3600e3).toISOString();
    h.db.bookings.push({ id: 'b-1', customer_id: 'u-m', course_id: 'c-b', start_at: st, booking_date: st,
      end_at: new Date(Date.parse(st) + 3600e3).toISOString(), duration_minutes: 60, status: 'confirmed', source: 'app', price: 250000 });
    const r = await h.call('POST', '/api/admin/cashier/pay', { cookie: kassa1, payload: {
      booking_id: 'b-1', method: 'cash', amount: 1, register_token: makeRegisterToken('reg-p1'), price_token: h.reportToken(kassa1) } });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/faqat Kassa → Chek chiqarish/);
    expect(h.db.payments).toHaveLength(0);
  });

  it('bronli chek ham: 0 so‘m — ruxsat so‘raladi, ruxsatdan keyin o‘tadi', async () => {
    h.db.users.push({ id: 'u-m', full_name: 'Bron Mijoz', phone: '+998901110000', role: 'customer', is_active: true, is_blocked: false });
    const st = new Date(Date.now() + 3600e3).toISOString();
    h.db.bookings.push({ id: 'b-1', customer_id: 'u-m', course_id: 'c-b', start_at: st, booking_date: st, pickup_code: 'AVD-1234',
      end_at: new Date(Date.parse(st) + 3600e3).toISOString(), duration_minutes: 60, status: 'confirmed', source: 'app', price: 250000, category: 'B' });
    const r = await pin({ booking_id: 'b-1', amount: 0 });
    expect(r.body.needs_approval).toBe(true);
    expect(sends()[0].body.text).toMatch(/Bron AVD-1234/);
    await decide(r.body.approval.id, 'ok');
    const ok = await pin({ booking_id: 'b-1', amount: 0 });
    expect(ok.status).toBe(201);
    expect(h.db.payments[0]).toMatchObject({ booking_id: 'b-1', amount: 0 });
  });
});

describe('Test drive + 1 soat — 300 000', () => {
  it('chek: 1 soat, 60 daqiqa, 250 000 + test drive 50 000', async () => {
    const r = await issue({ test_drive: true, test_drive_hour: true, amount: 300000 });
    expect(r.status).toBe(201);
    expect(r.body.receipt).toMatchObject({ amount: 300000, test_drive: 50000, krug_text: null, duration_minutes: 60 });
    expect(h.db.payments[0]).toMatchObject({ amount: 300000, note: '1 soat · Test drive 50000' });
    const b = h.db.bookings[0];
    expect(b.duration_minutes).toBe(60);
    expect(Date.parse(b.end_at) - Date.parse(b.start_at)).toBe(60 * 60000);
    expect(b.customer_note).toBe('Test drive · 1 soat');
    expect(h.db.admin_audit_logs.find((x: any) => x.action === 'RECEIPT_ISSUED').new_data).toMatchObject({ td_hour: true, test_drive: 50000, krug: false });
  });

  it('boshqa davomiylik yuborilsa ham 1 soat; narx farq qilsa — maxsus parol', async () => {
    const r = await issue({ test_drive: true, test_drive_hour: true, duration_minutes: 300, amount: 130000 });
    expect(r.body.needs_price_pin).toBe(true);
    expect(r.body.expected).toBe(300000);
    const ok = await issue({ test_drive: true, test_drive_hour: true, duration_minutes: 300, amount: 300000 });
    expect(ok.status).toBe(201);
    expect(h.db.payments).toHaveLength(1);
    expect(h.db.bookings[0].duration_minutes).toBe(60);
  });

  it('narx qat’iy 300 000: soat narxi yoki test drive qo‘shimchasi o‘zgarsa ham o‘zgarmaydi', async () => {
    h.db.admin_settings.find((x: any) => x.key === 'rate_b').value = 270000;
    h.db.admin_settings.push({ key: 'test_drive_price', value: 70000 });
    const r = await issue({ test_drive: true, test_drive_hour: true, amount: 320000 });
    expect(r.body.needs_price_pin).toBe(true);
    expect(r.body.expected).toBe(300000);
    const ok = await issue({ test_drive: true, test_drive_hour: true, amount: 300000 });
    expect(ok.status).toBe(201);
    expect(h.db.payments[0]).toMatchObject({ amount: 300000, note: '1 soat · Test drive 30000' });   // 300 000 − 270 000
  });

  it('sozlama: test_drive_hour_price — boshqa narx; 0 — o‘chiq', async () => {
    h.db.admin_settings.push({ key: 'test_drive_hour_price', value: { value: 350000 } });
    expect((await issue({ test_drive: true, test_drive_hour: true, amount: 300000 })).body.expected).toBe(350000);
    h.db.admin_settings.find((x: any) => x.key === 'test_drive_hour_price').value = { value: 0 };
    const off = await issue({ test_drive: true, test_drive_hour: true, amount: 300000 });
    expect(off.status).toBe(400);
    expect(off.body.error).toMatch(/1 soat o‘chirilgan/);
  });

  it('eski «1 krug» test drive o‘zgarmadi', async () => {
    const r = await issue({ test_drive: true, amount: 130000 });
    expect(r.status).toBe(201);
    expect(h.db.bookings[0].duration_minutes).toBe(15);
    expect(h.db.payments[0].note).toBe('1 krug · Test drive 50000');
  });
});
