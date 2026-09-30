/**
 * ADMIN BOTI: Mini App'dan bron qilinsa — admin botiga TO'LIQ xabar
 * va «Admin panelda ochish» tugmasi (panel «Yangi bronlar»da ochiladi).
 * Qaysi chatlar xabar olishini admin panelda boshqarish.
 */
process.env.ADMIN_BOT_TOKEN = '1:admin';
process.env.ADMIN_MINI_APP_URL = 'https://avtodrom.vercel.app/admin';

import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import { adminNewBookingText, fmtPhone, whenRange, untilText } from '../backend/src/admin-notify.js';

let h: Harness;
let admin = '', kassa = '';
const ADMIN_CHAT = 6140529649, ADMIN2 = 5550001, GROUP = -1001234567890, CUST_TG = 777001, INS_TG = 880001;

const TZ = 'Asia/Tashkent';
const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const dayPlus = (n: number) => ymd(new Date(Date.now() + n * 864e5));
const at = (day: string, hm: string) => new Date(`${day}T${hm}:00+05:00`).toISOString();
const D2 = dayPlus(2), D3 = dayPlus(3);

function signedInitData(user: Record<string, unknown>, botToken = '1:customer') {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAtest', user: JSON.stringify(user) });
  const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dataCheck).digest('hex'));
  return params.toString();
}
const tg = async (method: string, url: string, payload?: any) => {
  const r = await h.app.inject({ method, url, headers: { 'x-telegram-init-data': signedInitData({ id: CUST_TG, first_name: 'Ali' }) }, payload });
  let body: any = {}; try { body = JSON.parse(r.payload); } catch { body = r.payload; }
  return { status: r.statusCode, body };
};
/* so'm summalarida Intl bo'shlig'i (U+00A0) — oddiy bo'shliqqa keltiramiz */
const toAdmin = (chat = ADMIN_CHAT) => h.telegram.filter((m) => m.chat === chat).map((m) => ({ ...m, text: m.text.replace(/\u00a0/g, ' ') }));

beforeAll(async () => { h = await makeHarness(); });
beforeEach(async () => {
  h.reset();
  h.db.cash_registers.push({ id: 'reg-p1', code: 'P1', name: '1-kassa', is_active: true });
  h.db.staff.push({ id: 'st-admin', login: 'boss', password_hash: hashPassword('parol1234'), role: 'admin', register_id: null, full_name: 'Boss', is_active: true });
  h.db.staff.push({ id: 'st-k1', login: 'kassa1', password_hash: hashPassword('parol1234'), role: 'cashier', register_id: 'reg-p1', full_name: 'Kassa', is_active: true });
  h.db.users.push({ id: 'u-admin', full_name: 'Admin', role: 'admin', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-tg', telegram_id: CUST_TG, full_name: 'Ali Valiyev', phone: '+998901112233', role: 'customer', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-ins', full_name: 'Aziz Karimov', phone: '+998901114455', telegram_id: INS_TG, role: 'instructor', is_active: true, is_blocked: false });
  h.db.instructor_profiles.push({ id: 'ip-1', user_id: 'u-ins', is_verified: true, is_available: true, categories: ['B'],
    vehicle_model: 'Chevrolet Cobalt', vehicle_plate: '01 A 555 AA' });
  h.db.courses.push({ id: 'c-b', name: 'B toifa', category: 'B', price: 250000, duration_minutes: 60, is_active: true });
  h.db.admin_settings.push({ key: 'rate_b', value: 250000 }, { key: 'half_b', value: 150000 });
  h.db.telegram_admins.push({ id: 1, telegram_chat_id: ADMIN_CHAT, is_active: true });
  admin = (await h.login('boss', 'parol1234')).cookie;
  kassa = (await h.login('kassa1', 'parol1234')).cookie;
});

describe('Mini App bron → admin boti', () => {
  it('bitta bron: admin botiga barcha ma’lumot va panelni ochish tugmasi', async () => {
    const r = await tg('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', duration_minutes: 60, start_at: at(D2, '10:00'), customer_note: 'Parkovkani ko‘proq' });
    expect(r.status).toBe(201);
    const code = h.db.bookings[0].pickup_code;

    const m = toAdmin();
    expect(m).toHaveLength(1);
    const t = m[0].text;
    expect(m[0].parse).toBe('HTML');
    expect(t).toMatch(/YANGI BRON/);
    expect(t).toContain('Ali Valiyev');
    expect(t).toContain('+998 90 111 22 33');              // mijoz telefoni
    expect(t).toContain('Aziz Karimov');                   // instruktor
    expect(t).toContain('+998 90 111 44 55');              // instruktor telefoni
    expect(t).toContain('Chevrolet Cobalt · 01 A 555 AA'); // mashina
    expect(t).toContain('B toifa · 1 soat');
    expect(t).toContain('10:00–11:00');                    // aniq soat oralig'i (Toshkent)
    expect(t).toContain('250 000 so‘m');
    expect(t).toContain(code);
    expect(t).toContain('Parkovkani ko‘proq');
    expect(t).toMatch(/Yangi mijoz — birinchi broni/);
    expect(t).toMatch(/Tasdiqlash kutilmoqda/);

    // Tugma: web_app, panel «Yangi bronlar» bo'limida ochiladi
    const btn = m[0].markup.inline_keyboard[0][0];
    expect(btn.text).toMatch(/Admin panel/);
    expect(btn.web_app.url).toBe('https://avtodrom.vercel.app/admin?open=bookings%2Fnew');

    // Mijoz va instruktorga odatdagi xabarlar ham ketdi
    expect(h.telegram.some((x) => x.chat === CUST_TG)).toBe(true);
    expect(h.telegram.some((x) => x.chat === INS_TG)).toBe(true);
  });

  it('o‘chirilgan chatga bormaydi; guruhga oddiy havola tugmasi bilan boradi', async () => {
    h.db.telegram_admins.push({ id: 2, telegram_chat_id: ADMIN2, is_active: false }, { id: 3, telegram_chat_id: GROUP, is_active: true });
    await tg('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', duration_minutes: 30, start_at: at(D2, '12:00') });
    expect(toAdmin(ADMIN2)).toHaveLength(0);
    const g = toAdmin(GROUP);
    expect(g).toHaveLength(1);
    const btn = g[0].markup.inline_keyboard[0][0];
    expect(btn.web_app).toBeUndefined();                   // guruhda web_app ishlamaydi
    expect(btn.url).toMatch(/open=bookings%2Fnew/);
    expect(g[0].text).toContain('30 daqiqa');
  });

  it('5 soatlik paket: bitta xabar, hamma mashg‘ulot kodi bilan, paket narxi', async () => {
    const r = await tg('POST', '/api/bookings/package', { instructor_id: 'ip-1', course_id: 'c-b', sessions: [
      { start_at: at(D2, '09:00'), minutes: 180 }, { start_at: at(D3, '14:00'), minutes: 120 }] });
    expect(r.status).toBe(201);
    const m = toAdmin();
    expect(m).toHaveLength(1);
    const t = m[0].text;
    expect(t).toMatch(/5 soatlik paket/);
    expect(t).toContain('5 soat · 2 ta mashg‘ulot');
    expect(t).toContain('09:00–12:00');
    expect(t).toContain('14:00–16:00');
    for (const b of h.db.bookings) expect(t).toContain(b.pickup_code);
    expect(t).toContain('1 100 000 so‘m');
    expect(t).toContain('odatda 1 250 000 so‘m');
    expect(t).not.toMatch(/Izoh/);                        // avtomatik «paket · 1/2» izohi ko'rsatilmaydi
  });

  it('doimiy mijoz: oldingi bronlar tarixi ko‘rinadi', async () => {
    const old = (d: number, status: string) => h.db.bookings.push({ id: `b-old-${d}`, customer_id: 'u-tg', instructor_id: 'ip-1', course_id: 'c-b',
      start_at: new Date(Date.now() - d * 864e5).toISOString(), end_at: new Date(Date.now() - d * 864e5 + 3600e3).toISOString(), status });
    old(5, 'completed'); old(3, 'no_show');
    await tg('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', duration_minutes: 60, start_at: at(D2, '15:00') });
    expect(toAdmin()[0].text).toMatch(/Oldin 2 marta bron qilgan · 1 tasi o‘tgan, 1 tasida kelmagan/);
  });

  it('ism ichidagi HTML belgilar xavfsiz chiqadi', async () => {
    h.db.users.find((u: any) => u.id === 'u-tg').full_name = 'Ali <b>&</b>';
    await tg('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', duration_minutes: 60, start_at: at(D2, '16:00') });
    expect(toAdmin()[0].text).toContain('Ali &lt;b&gt;&amp;&lt;/b&gt;');
  });

  it('admin botiga xabar ketmasa ham bron yaratiladi', async () => {
    h.telegramFail.set(ADMIN_CHAT, 'Forbidden: bot was blocked by the user');
    const r = await tg('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', duration_minutes: 60, start_at: at(D2, '17:00') });
    expect(r.status).toBe(201);
    expect(h.db.bookings).toHaveLength(1);
    expect(h.telegram.some((x) => x.chat === CUST_TG)).toBe(true);
  });

  it('admin bot tokeni bo‘lmasa — jim, bron baribir yaratiladi', async () => {
    const saved = process.env.ADMIN_BOT_TOKEN;
    delete process.env.ADMIN_BOT_TOKEN;
    try {
      const r = await tg('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', duration_minutes: 60, start_at: at(D2, '18:00') });
      expect(r.status).toBe(201);
      expect(toAdmin()).toHaveLength(0);
    } finally { process.env.ADMIN_BOT_TOKEN = saved; }
  });

  it('bekor qilish so‘rovi ham admin botiga — «Bekor so‘rovlari» bo‘limiga tugma', async () => {
    const r = await tg('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', duration_minutes: 60, start_at: at(D3, '10:00') });
    const id = r.body.booking.id;
    h.db.bookings[0].status = 'confirmed';
    h.telegram.length = 0;
    const c = await tg('PATCH', `/api/bookings/${id}/cancel`, { reason: 'Kasal bo‘lib qoldim' });
    expect(c.status).toBe(200);
    const m = toAdmin();
    expect(m).toHaveLength(1);
    expect(m[0].text).toMatch(/Bekor qilish so‘rovi/);
    expect(m[0].text).toContain('Kasal bo‘lib qoldim');
    expect(m[0].markup.inline_keyboard[0][0].web_app.url).toMatch(/open=bookings%2Fcancels/);
  });
});

describe('Matn yordamchilari', () => {
  it('telefon, vaqt oralig‘i va «qancha qoldi»', () => {
    expect(fmtPhone('+998901112233')).toBe('+998 90 111 22 33');
    expect(fmtPhone('998 90 111-22-33')).toBe('+998 90 111 22 33');
    expect(fmtPhone('12345')).toBe('12345');
    expect(whenRange('2026-10-03T05:00:00Z', '2026-10-03T06:00:00Z')).toBe('3-oktabr, shanba · 10:00–11:00');
    const now = Date.parse('2026-10-03T03:00:00Z');
    expect(untilText('2026-10-03T03:45:00Z', now)).toBe('45 daqiqadan keyin');
    expect(untilText('2026-10-03T05:15:00Z', now)).toBe('2 soat 15 daqiqadan keyin');
    expect(untilText('2026-10-06T03:00:00Z', now)).toBe('3 kundan keyin');
  });

  it('dars 3 soatdan kam qolgan bo‘lsa — «tezroq tasdiqlang»', () => {
    const now = Date.parse('2026-10-03T03:00:00Z');
    const ctx = { customer: { name: 'A', phone: '' }, instructor: { name: 'B', phone: '', vehicle: '' }, course: { name: '', category: 'B' },
      history: { prior: 0, completed: 0, noShow: 0, cancelled: 0 } };
    const soon = adminNewBookingText([{ start_at: '2026-10-03T04:30:00Z', end_at: '2026-10-03T05:30:00Z', duration_minutes: 60 }], ctx, { nowMs: now });
    expect(soon).toMatch(/Dars 1 soat 30 daqiqadan keyin<\/b> — tezroq tasdiqlang/);
    const later = adminNewBookingText([{ start_at: '2026-10-05T04:30:00Z', end_at: '2026-10-05T05:30:00Z', duration_minutes: 60 }], ctx, { nowMs: now });
    expect(later).not.toMatch(/tezroq/);
  });
});

describe('Admin panel: xabar oladigan chatlar', () => {
  it('ro‘yxat faqat administratorga; kassir 403, kirmagan 401', async () => {
    expect((await h.call('GET', '/api/admin/telegram-admins')).status).toBe(401);
    expect((await h.call('GET', '/api/admin/telegram-admins', { cookie: kassa })).status).toBe(403);
    const r = await h.call('GET', '/api/admin/telegram-admins', { cookie: admin });
    expect(r.status).toBe(200);
    expect(r.body.bot).toEqual({ configured: true, username: 'avtodrom_admin_bot' });
    expect(r.body.chats).toEqual([expect.objectContaining({ chat_id: String(ADMIN_CHAT), is_active: true, group: false })]);
    expect(r.body.panel_url).toMatch(/open=bookings%2Fnew/);
  });

  it('qo‘shish: avval sinov xabari; chat topilmasa — tushunarli xato, ro‘yxatga tushmaydi', async () => {
    h.telegramFail.set(ADMIN2, 'Bad Request: chat not found');
    const bad = await h.call('POST', '/api/admin/telegram-admins', { cookie: admin, payload: { chat_id: String(ADMIN2) } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/admin botga \/start/);
    expect(h.db.telegram_admins).toHaveLength(1);

    h.telegramFail.clear();
    const ok = await h.call('POST', '/api/admin/telegram-admins', { cookie: admin, payload: { chat_id: ` ${ADMIN2} ` } });
    expect(ok.status).toBe(200);
    expect(h.db.telegram_admins.map((x: any) => Number(x.telegram_chat_id))).toEqual([ADMIN_CHAT, ADMIN2]);
    expect(toAdmin(ADMIN2)[0].text).toMatch(/admin xabarlariga ulandi/);
    expect(h.db.admin_audit_logs.some((a: any) => a.action === 'TELEGRAM_ADMIN_ADD')).toBe(true);

    const dup = await h.call('POST', '/api/admin/telegram-admins', { cookie: admin, payload: { chat_id: ADMIN2 } });
    expect(dup.status).toBe(409);
    const junk = await h.call('POST', '/api/admin/telegram-admins', { cookie: admin, payload: { chat_id: 'salom' } });
    expect(junk.status).toBe(400);
  });

  it('o‘chirish/yoqish va olib tashlash — xabar faqat faol chatga boradi', async () => {
    const off = await h.call('PATCH', '/api/admin/telegram-admins/1', { cookie: admin, payload: { is_active: false } });
    expect(off.status).toBe(200);
    await tg('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', duration_minutes: 60, start_at: at(D2, '11:00') });
    expect(toAdmin()).toHaveLength(0);

    // O'chirilgan chatni qayta qo'shish — yangi qator emas, qayta yoqiladi
    const again = await h.call('POST', '/api/admin/telegram-admins', { cookie: admin, payload: { chat_id: ADMIN_CHAT } });
    expect(again.status).toBe(200);
    expect(h.db.telegram_admins).toHaveLength(1);
    expect(h.db.telegram_admins[0].is_active).toBe(true);

    const del = await h.call('DELETE', '/api/admin/telegram-admins/1', { cookie: admin });
    expect(del.status).toBe(200);
    expect(h.db.telegram_admins).toHaveLength(0);
    expect((await h.call('DELETE', '/api/admin/telegram-admins/1', { cookie: admin })).status).toBe(404);
  });

  it('sinov xabari oxirgi Mini App broni misolida', async () => {
    await tg('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', duration_minutes: 60, start_at: at(D2, '13:00') });
    h.db.bookings[0].source = 'app';
    h.telegram.length = 0;
    const r = await h.call('POST', '/api/admin/telegram-admins/test', { cookie: admin });
    expect(r.status).toBe(200);
    expect(r.body.sent).toBe(1);
    expect(toAdmin()[0].text).toMatch(/SINOV/);
    expect(toAdmin()[0].text).toContain('Ali Valiyev');
  });
});

describe('Admin bot: /start va /id', () => {
  const hook = (chatId: number, text: string) => h.app.inject({ method: 'POST', url: '/api/telegram/admin/webhook',
    headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' }, payload: { message: { chat: { id: chatId }, text } } });

  it('ro‘yxatda yo‘q odam /start — chat ID va qayerga qo‘shishni aytadi', async () => {
    const r = await hook(ADMIN2, '/start');
    expect(r.statusCode).toBe(200);
    const m = toAdmin(ADMIN2);
    expect(m.some((x) => /Admin panelini ochish/.test(JSON.stringify(x.markup || {})))).toBe(true);
    expect(m.some((x) => x.text.includes(String(ADMIN2)) && /Admin bot — yangi bron xabarlari/.test(x.text))).toBe(true);
  });

  it('ro‘yxatdagi admin — «xabarlarni oladi»; guruhda /id ishlaydi', async () => {
    await hook(ADMIN_CHAT, '/start');
    expect(toAdmin().some((x) => /Bu chat yangi bron xabarlarini oladi/.test(x.text))).toBe(true);
    await hook(GROUP, '/id');
    expect(toAdmin(GROUP)[0].text).toContain(String(GROUP));
  });
});
