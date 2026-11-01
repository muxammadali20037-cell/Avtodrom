/**
 * SHARHLAR: Mini App mijozlariga so'rov, sharh yozish va Nazorat panelida ko'rish.
 * Sharh sir saqlanadi — nazorat paneliga mijoz ismi/telefoni chiqmaydi.
 */
import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';

let h: Harness;
let admin = '', operator = '';

function signedInitData(user: Record<string, unknown>, botToken = '1:customer') {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAtest', user: JSON.stringify(user) });
  const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dataCheck).digest('hex'));
  return params.toString();
}
const C = (tg: number, method: string, url: string, payload?: any) =>
  h.app.inject({ method, url, headers: { 'x-telegram-init-data': signedInitData({ id: tg, first_name: 'Ali' }) }, payload })
    .then((r: any) => ({ status: r.statusCode, body: JSON.parse(r.payload || '{}') }));

const ALI = 701001, VALI = 701002, BLOCKED = 701003, WALKIN = 701004, NOBOOK = 701005;
function cust(id: string, name: string, tg: number, o: any = {}) {
  h.db.users.push({ id, full_name: name, phone: `+99890${tg}`, telegram_id: tg, role: 'customer', is_active: true, is_blocked: false, ...o });
}
function bk(id: string, customer: string, o: any = {}) {
  const start = new Date(Date.now() - 2 * 864e5).toISOString();
  h.db.bookings.push({ id, customer_id: customer, instructor_id: 'ip-1', course_id: 'c-b', start_at: start, booking_date: start,
    end_at: new Date(Date.parse(start) + 3600e3).toISOString(), status: 'completed', source: 'app', created_at: start, ...o });
}

beforeAll(async () => { h = await makeHarness(); });
beforeEach(async () => {
  h.reset();
  h.db.staff.push({ id: 'st-admin', login: 'boss', password_hash: hashPassword('admin1234'), role: 'admin', register_id: null, is_active: true });
  h.db.staff.push({ id: 'st-op', login: 'op1', password_hash: hashPassword('parol1234'), role: 'operator', register_id: null, is_active: true });
  h.db.users.push({ id: 'u-i1', full_name: 'Aziz Karimov', telegram_id: 880001, role: 'instructor', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-i2', full_name: 'Bobur Olimov', telegram_id: 880002, role: 'instructor', is_active: true, is_blocked: false });
  h.db.instructor_profiles.push({ id: 'ip-1', user_id: 'u-i1', is_verified: true, is_available: true, categories: ['B'] });
  h.db.instructor_profiles.push({ id: 'ip-2', user_id: 'u-i2', is_verified: true, is_available: true, categories: ['B'] });
  h.db.courses.push({ id: 'c-b', name: 'B', category: 'B', price: 250000, duration_minutes: 60, is_active: true });
  cust('u-ali', 'Ali Valiyev', ALI);
  cust('u-vali', 'Vali Toshev', VALI);
  cust('u-blk', 'Bloklangan', BLOCKED, { is_blocked: true });
  cust('u-walk', 'Kassa Mijoz', WALKIN);
  cust('u-nob', 'Yangi Mijoz', NOBOOK);
  bk('b-1', 'u-ali');
  bk('b-2', 'u-ali', { instructor_id: 'ip-2', status: 'cancelled' });       // bekor — ro'yxatga kirmaydi
  bk('b-3', 'u-vali', { instructor_id: 'ip-2' });
  bk('b-4', 'u-blk');
  bk('b-5', 'u-walk', { source: 'walk_in' });                               // kassadan — Mini App emas
  admin = (await h.login('boss', 'admin1234')).cookie;
  operator = (await h.login('op1', 'parol1234')).cookie;
});

describe('Mini App: sharh qoldirish', () => {
  it('oyna — mijoz dars o‘tgan instruktorlar (bekor qilingan bron hisobga olinmaydi)', async () => {
    const r = await C(ALI, 'GET', '/api/feedback/form');
    expect(r.status).toBe(200);
    expect(r.body.instructors).toEqual([{ id: 'ip-1', name: 'Aziz Karimov' }]);
    expect(r.body.sent).toBe(0);
  });

  it('sharh yoziladi; bo‘sh — 400; ro‘yxatda yo‘q odam — 403; kuniga 5 tadan ko‘p — 429', async () => {
    expect((await C(ALI, 'POST', '/api/feedback', { comment: '   ' })).status).toBe(400);
    expect((await C(999999, 'POST', '/api/feedback', { comment: 'salom' })).status).toBe(403);
    const ok = await C(ALI, 'POST', '/api/feedback', { place_rating: 5, instructor_id: 'ip-1', instructor_rating: 4, comment: 'Zo‘r!', suggestion: 'Kechqurun ham ishlang' });
    expect(ok.status).toBe(200);
    expect(h.db.feedback).toHaveLength(1);
    expect(h.db.feedback[0]).toMatchObject({ customer_id: 'u-ali', instructor_id: 'ip-1', place_rating: 5, instructor_rating: 4, comment: 'Zo‘r!', source: 'mini_app' });
    // Noma'lum instruktor — instruktor bahosi tashlanadi, qolgani saqlanadi; baho 1..5 oralig'ida
    await C(ALI, 'POST', '/api/feedback', { place_rating: 9, instructor_id: 'ip-xyz', instructor_rating: 5, comment: 'ok' });
    expect(h.db.feedback[1]).toMatchObject({ instructor_id: null, instructor_rating: null, place_rating: null, comment: 'ok' });
    for (let i = 0; i < 3; i++) expect((await C(ALI, 'POST', '/api/feedback', { place_rating: 4 })).status).toBe(200);
    expect((await C(ALI, 'POST', '/api/feedback', { place_rating: 4 })).status).toBe(429);
    expect((await C(ALI, 'GET', '/api/feedback/form')).body.sent).toBe(5);
  });
});

describe('Nazorat paneli: 💬 Sharhlar', () => {
  it('maxfiy havola bilan — o‘rtacha baholar va sharhlar, mijoz ismi/telefoni YO‘Q', async () => {
    await C(ALI, 'POST', '/api/feedback', { place_rating: 5, instructor_id: 'ip-1', instructor_rating: 5, comment: 'Aziz aka zo‘r' });
    await C(VALI, 'POST', '/api/feedback', { place_rating: 3, instructor_id: 'ip-2', instructor_rating: 4, suggestion: 'Hojatxona tozaroq bo‘lsin' });
    await C(VALI, 'POST', '/api/feedback', { place_rating: 4 });
    expect((await h.call('GET', '/api/control-feedback?k=notatoken-notatoken-123')).status).toBe(403);
    const link = await h.call('GET', '/api/admin/control-link', { cookie: admin });
    const k = new URL(link.body.url).searchParams.get('k');
    const r = await h.call('GET', `/api/control-feedback?k=${k}`);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(3);
    expect(r.body.place).toEqual({ avg: 4, count: 3, dist: [0, 0, 1, 1, 1] });
    expect(r.body.instructors).toEqual([
      { id: 'ip-1', name: 'Aziz Karimov', avg: 5, count: 1 },
      { id: 'ip-2', name: 'Bobur Olimov', avg: 4, count: 1 },
    ]);
    expect(r.body.items.map((x: any) => x.suggestion).filter(Boolean)).toEqual(['Hojatxona tozaroq bo‘lsin']);
    const raw = JSON.stringify(r.body);
    for (const leak of ['Ali Valiyev', 'Vali Toshev', 'u-ali', 'u-vali', String(ALI), '+99890']) expect(raw).not.toContain(leak);
  });
});

describe('Admin: sharh so‘rovini yuborish', () => {
  it('faqat Mini App orqali bron qilganlarga, har biriga bir marta; yangi mijoz qo‘shilsa — faqat unga', async () => {
    expect((await h.call('GET', '/api/admin/feedback-invite', { cookie: operator })).status).toBe(403);
    expect((await h.call('POST', '/api/admin/feedback-invite', { cookie: operator, payload: {} })).status).toBe(403);
    const pre = await h.call('GET', '/api/admin/feedback-invite', { cookie: admin });
    expect(pre.status).toBe(200);
    expect(pre.body).toMatchObject({ total: 2, pending: 2, last: null });           // Ali, Vali (bloklangan va kassa mijozi yo'q)
    expect(pre.body.text).toMatch(/sir saqlanadi/);

    const r = await h.call('POST', '/api/admin/feedback-invite', { cookie: admin, payload: {} });
    expect(r.body).toMatchObject({ ok: true, sent: 2, failed: 0, total: 2, already: 0, left: 0 });
    const msgs = h.telegram.filter((m) => m.method === 'sendMessage');
    expect(msgs.map((m) => m.chat).sort()).toEqual([ALI, VALI]);
    const a = msgs.find((m) => m.chat === ALI)!;
    expect(a.text).toMatch(/Assalomu alaykum, Ali!/);
    expect(a.text).toMatch(/🔒 Sharhingiz sir saqlanadi/);
    expect(a.text).toMatch(/avtodrom va instruktorlar haqida/);
    const btn = a.markup.inline_keyboard[0][0];
    expect(btn.text).toBe('✍️ Sharh qoldirish');
    expect(btn.web_app.url).toMatch(/[?&]open=feedback$/);

    // Qayta bosildi — hech kimga takror ketmaydi
    const again = await h.call('POST', '/api/admin/feedback-invite', { cookie: admin, payload: {} });
    expect(again.body).toMatchObject({ sent: 0, already: 2 });
    expect(h.telegram.filter((m) => m.method === 'sendMessage')).toHaveLength(2);
    expect(h.db.admin_settings.filter((s: any) => s.key === 'feedback_campaign')).toHaveLength(1);

    // Yangi Mini App mijozi + bittasi botni bloklagan
    cust('u-new', 'Sardor', 701006); bk('b-6', 'u-new');
    bk('b-7', 'u-nob');
    h.telegramFail.set(NOBOOK, 'Forbidden: bot was blocked by the user');
    const third = await h.call('POST', '/api/admin/feedback-invite', { cookie: admin, payload: {} });
    expect(third.body).toMatchObject({ sent: 1, failed: 1, already: 2 });
    const st = await h.call('GET', '/api/admin/feedback-invite', { cookie: admin });
    expect(st.body).toMatchObject({ total: 4, pending: 1 });                        // yetib bormagan — keyin yana urinadi
    expect(st.body.last).toMatchObject({ sent: 3, failed: 1, by: 'boss' });
  });

  it('ismi «Mijoz +998…» bo‘lsa — ismsiz salom', async () => {
    h.db.users.find((u: any) => u.id === 'u-vali').full_name = 'Mijoz +998901234567';
    await h.call('POST', '/api/admin/feedback-invite', { cookie: admin, payload: {} });
    const v = h.telegram.find((m) => m.chat === VALI)!;
    expect(v.text.startsWith('🙏 Assalomu alaykum!')).toBe(true);
  });
});

describe('Kim yozgani — faqat admin panel va rahbar ilovasida', () => {
  async function seed() {
    await C(ALI, 'POST', '/api/feedback', { place_rating: 5, instructor_id: 'ip-1', instructor_rating: 5, comment: 'Aziz aka zo‘r' });
    await C(VALI, 'POST', '/api/feedback', { place_rating: 3, suggestion: 'Choy qo‘ying' });
  }

  it('Admin → Boshqaruv → Sharhlar: ism, telefon va kim haqida; operator — 403', async () => {
    await seed();
    expect((await h.call('GET', '/api/admin/feedback', { cookie: operator })).status).toBe(403);
    expect((await h.call('GET', '/api/admin/feedback')).status).toBe(401);
    const r = await h.call('GET', '/api/admin/feedback', { cookie: admin });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    const [vali, ali] = r.body.items;                                               // eng yangisi tepada
    expect(ali).toMatchObject({ customer: { name: 'Ali Valiyev', phone: `+99890${ALI}` }, instructor: 'Aziz Karimov', instructor_id: 'ip-1', instructor_rating: 5, comment: 'Aziz aka zo‘r' });
    expect(vali).toMatchObject({ customer: { name: 'Vali Toshev' }, instructor: null, instructor_id: null, place_rating: 3, suggestion: 'Choy qo‘ying' });
    // Nazorat panelida esa hamon ismsiz
    const link = await h.call('GET', '/api/admin/control-link', { cookie: admin });
    const k = new URL(link.body.url).searchParams.get('k');
    const nz = await h.call('GET', `/api/control-feedback?k=${k}`);
    expect(nz.body.items[0].customer).toBeUndefined();
    expect(JSON.stringify(nz.body)).not.toContain('Vali Toshev');
  });

  it('Rahbar ilovasi (PIN bilan): boss-data ichida sharhlar — kim yozgani bilan', async () => {
    await seed();
    await h.call('GET', '/api/admin/boss-link', { cookie: admin });
    const set = await h.call('POST', '/api/admin/boss-link', { cookie: admin, payload: { pin: '482915' } });
    const k = new URL(set.body.url).searchParams.get('k');
    const inj = (method: string, url: string, o: any = {}) => h.app.inject({ method, url, headers: { 'x-real-ip': '10.9.9.9', ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) }, payload: o.payload })
      .then((r: any) => ({ status: r.statusCode, body: JSON.parse(r.payload || '{}') }));
    const login = await inj('POST', '/api/boss-login', { payload: { k, pin: '482915' } });
    expect(login.status).toBe(200);
    const D = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
    expect((await inj('GET', `/api/boss-data?from=${D}&to=${D}`)).status).toBe(401);
    const d = await inj('GET', `/api/boss-data?from=${D}&to=${D}`, { token: login.body.token });
    expect(d.status).toBe(200);
    expect(d.body.feedback.total).toBe(2);
    expect(d.body.feedback.place).toMatchObject({ avg: 4, count: 2 });
    expect(d.body.feedback.instructors).toEqual([{ id: 'ip-1', name: 'Aziz Karimov', avg: 5, count: 1 }]);
    expect(d.body.feedback.items.map((x: any) => x.customer.name)).toEqual(['Vali Toshev', 'Ali Valiyev']);
  });
});
