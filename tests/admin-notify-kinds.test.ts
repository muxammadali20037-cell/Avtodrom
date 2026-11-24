/**
 * ADMIN BOT — HAR BIR ULANGAN AKKAUNT QAYSI XABARLARNI OLADI.
 * Masalan, boshliq — faqat «so'mlik chek ruxsati»: unga yangi bron,
 * bekor qilish, mijoz savollari bormaydi. Yozuv yo'q chat — hammasini oladi.
 */
process.env.ADMIN_BOT_TOKEN = '1:admin';
process.env.ADMIN_MINI_APP_URL = 'https://avtodrom.vercel.app/admin';

import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import { makeRegisterToken } from '../backend/src/shift-routes.js';
import { adminChatIds, notifyAdmins } from '../backend/src/admin-notify.js';

let h: Harness;
let admin = '', kassa = '';
const MANAGER = 6140529649, BOSS = 5550001, CUST_TG = 777001;
const TZ = 'Asia/Tashkent';
const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + 2 * 864e5));
const at = (hm: string) => new Date(`${day}T${hm}:00+05:00`).toISOString();

function signedInitData(user: Record<string, unknown>, botToken = '1:customer') {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAtest', user: JSON.stringify(user) });
  const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dataCheck).digest('hex'));
  return params.toString();
}
const book = async () => {
  const r = await h.app.inject({ method: 'POST', url: '/api/bookings', headers: { 'x-telegram-init-data': signedInitData({ id: CUST_TG, first_name: 'Ali' }) },
    payload: { instructor_id: 'ip-1', course_id: 'c-b', duration_minutes: 60, start_at: at('10:00') } });
  return r.statusCode;
};
const to = (chat: number) => h.telegram.filter((m) => m.chat === chat);
const setKinds = (notify: string[], id = 2) => h.call('PATCH', `/api/admin/telegram-admins/${id}`, { cookie: admin, payload: { notify } });
const tinyCheque = () => h.call('POST', '/api/admin/cashier/issue', { cookie: kassa, payload: {
  register_token: makeRegisterToken('reg-p1'), full_name: 'Mohina', phone: '+998901230000', course_id: 'c-b', category: 'B',
  duration_minutes: 60, amount: 0, cash_amount: 0, card_amount: 0, price_token: h.reportToken(kassa) } });

beforeAll(async () => { h = await makeHarness(); });
beforeEach(async () => {
  h.reset();
  h.tgResults.set('sendMessage', { message_id: 9 });
  h.db.cash_registers.push({ id: 'reg-p1', code: 'P1', name: '1-kassa', is_active: true });
  h.db.staff.push({ id: 'st-admin', login: 'boss', password_hash: hashPassword('parol1234'), role: 'admin', register_id: null, full_name: 'Boss', is_active: true });
  h.db.staff.push({ id: 'st-k1', login: 'kassa1', password_hash: hashPassword('parol1234'), role: 'cashier', register_id: 'reg-p1', full_name: 'Kassa', is_active: true });
  h.db.users.push({ id: 'u-admin', full_name: 'Admin', role: 'admin', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-tg', telegram_id: CUST_TG, full_name: 'Ali Valiyev', phone: '+998901112233', role: 'customer', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-ins', full_name: 'Aziz Karimov', role: 'instructor', is_active: true, is_blocked: false });
  h.db.instructor_profiles.push({ id: 'ip-1', user_id: 'u-ins', is_verified: true, is_available: true, categories: ['B'] });
  h.db.courses.push({ id: 'c-b', name: 'B toifa', category: 'B', price: 250000, duration_minutes: 60, is_active: true });
  h.db.admin_settings.push({ key: 'rate_b', value: 250000 });
  h.db.telegram_admins.push({ id: 1, telegram_chat_id: MANAGER, is_active: true }, { id: 2, telegram_chat_id: BOSS, is_active: true });
  admin = (await h.login('boss', 'parol1234')).cookie;
  kassa = (await h.login('kassa1', 'parol1234')).cookie;
});

describe('Xabar turlari — har bir akkaunt uchun', () => {
  it('standart: yozuv yo‘q — hamma xabar hammaga (avvalgidek)', async () => {
    const r = await h.call('GET', '/api/admin/telegram-admins', { cookie: admin });
    expect(r.body.kinds.map((k: any) => k.key)).toEqual(['booking_new', 'booking_closed', 'cancel_request', 'support', 'price_ok']);
    expect(r.body.chats.every((c: any) => c.notify.length === 5)).toBe(true);
    expect(await book()).toBe(201);
    expect(to(MANAGER)).toHaveLength(1);
    expect(to(BOSS)).toHaveLength(1);
  });

  it('boshliq — «faqat so‘mlik chek»: yangi bron unga bormaydi, ruxsat so‘rovi faqat unga', async () => {
    expect((await setKinds(['price_ok'])).body.notify).toEqual(['price_ok']);
    await setKinds(['booking_new', 'booking_closed', 'cancel_request', 'support'], 1);
    h.telegram.length = 0; h.tgCalls.length = 0;

    expect(await book()).toBe(201);
    expect(to(MANAGER)).toHaveLength(1);
    expect(to(BOSS)).toHaveLength(0);

    const r = await tinyCheque();
    expect(r.body.needs_approval).toBe(true);
    const asks = h.tgCalls.filter((c: any) => c.method === 'sendMessage' && /So‘mlik chek/.test(c.body.text));
    expect(asks.map((c: any) => c.body.chat_id)).toEqual([BOSS]);
    expect(h.db.admin_audit_logs.some((a: any) => a.action === 'TELEGRAM_ADMIN_NOTIFY')).toBe(true);
  });

  it('turlar bo‘yicha filtr: mijoz savoli, bekor qilish so‘rovi', async () => {
    await setKinds(['support'], 2);
    expect(await adminChatIds('support')).toEqual(expect.arrayContaining([MANAGER, BOSS]));
    expect(await adminChatIds('cancel_request')).toEqual([MANAGER]);
    h.telegram.length = 0;
    await notifyAdmins('so‘rov', { kind: 'cancel_request' });
    expect(to(BOSS)).toHaveLength(0);
    expect(to(MANAGER)).toHaveLength(1);
    /* tursiz (masalan, sinov xabari) — hamma faol chatga */
    await notifyAdmins('sinov');
    expect(to(BOSS)).toHaveLength(1);
  });

  it('so‘mlik chek ruxsatini hech kim olmasa — kassaga tushunarli xato, adminlarga hech narsa bormaydi', async () => {
    await setKinds(['booking_new'], 1);
    await setKinds([], 2);
    h.tgCalls.length = 0;
    const r = await tinyCheque();
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/So‘mlik chek ruxsati.*yoqilmagan/);
    expect(h.tgCalls.filter((c: any) => c.method === 'sendMessage')).toHaveLength(0);
    expect(h.db.payments).toHaveLength(0);
  });

  it('noto‘g‘ri tur — 400; kassir o‘zgartira olmaydi; chat o‘chirilsa yozuvi ham o‘chadi', async () => {
    expect((await setKinds(['hamma_narsa'])).status).toBe(400);
    expect((await h.call('PATCH', '/api/admin/telegram-admins/2', { cookie: kassa, payload: { notify: ['price_ok'] } })).status).toBe(403);
    await setKinds(['price_ok']);
    expect(h.db.admin_settings.find((x: any) => x.key === 'admin_notify_prefs').value[String(BOSS)]).toEqual(['price_ok']);
    expect((await h.call('DELETE', '/api/admin/telegram-admins/2', { cookie: admin })).status).toBe(200);
    expect(h.db.admin_settings.find((x: any) => x.key === 'admin_notify_prefs').value[String(BOSS)]).toBeUndefined();
  });

  it('o‘chirilgan (faol emas) chat tanlangan turlar bilan ham xabar olmaydi', async () => {
    await setKinds(['price_ok']);
    await h.call('PATCH', '/api/admin/telegram-admins/2', { cookie: admin, payload: { is_active: false } });
    expect(await adminChatIds('price_ok')).toEqual([MANAGER]);
  });
});
