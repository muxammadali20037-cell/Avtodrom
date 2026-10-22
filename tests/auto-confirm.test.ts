/**
 * AVTOMATIK TASDIQLASH: Mini App broni darhol «Tasdiqlangan».
 * Mijoz admin javobini kutmaydi; admin botiga «Avtomatik tasdiqlandi»;
 * mijoz avto-tasdiqlangan (to'lanmagan, xodim tegmagan) bronni o'zi darhol
 * bekor qila oladi. Sozlama o'chirilsa — eski tartib (pending).
 */
process.env.ADMIN_BOT_TOKEN = '1:admin';
process.env.ADMIN_MINI_APP_URL = 'https://avtodrom.vercel.app/admin';
process.env.CUSTOMER_MINI_APP_URL = 'https://avtodrom.vercel.app/';

import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeHarness, type Harness } from './harness.js';
import { canCancelNow, autoConfirmedUntouched } from '../backend/src/booking-auto.js';

let h: Harness;
const ADMIN_CHAT = 6140529649, CUST_TG = 777001, INS_TG = 880001;
const TZ = 'Asia/Tashkent';
const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const D2 = ymd(new Date(Date.now() + 2 * 864e5));
const at = (day: string, hm: string) => new Date(`${day}T${hm}:00+05:00`).toISOString();

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
const book = (hm = '10:00') => tg('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', duration_minutes: 60, start_at: at(D2, hm) });
const msgsTo = (chat: number) => h.telegram.filter((m) => m.chat === chat);

beforeAll(async () => { h = await makeHarness(); });
beforeEach(() => {
  h.reset();
  h.db.users.push({ id: 'u-tg', telegram_id: CUST_TG, full_name: 'Ali Valiyev', phone: '+998901112233', role: 'customer', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-ins', full_name: 'Aziz Karimov', phone: '+998901114455', telegram_id: INS_TG, role: 'instructor', is_active: true, is_blocked: false });
  h.db.instructor_profiles.push({ id: 'ip-1', user_id: 'u-ins', is_verified: true, is_available: true, categories: ['B'] });
  h.db.courses.push({ id: 'c-b', name: 'B toifa', category: 'B', price: 250000, duration_minutes: 60, is_active: true });
  h.db.admin_settings.push({ key: 'rate_b', value: 250000 }, { key: 'half_b', value: 150000 });
  h.db.telegram_admins.push({ id: 1, telegram_chat_id: ADMIN_CHAT, is_active: true });
});

describe('Avtomatik tasdiqlash — standart yoqiq', () => {
  it('bron darhol tasdiqlangan: mijozga «tasdiqlandi» + kod + «Ilovani ochish», adminga ma’lumot', async () => {
    const r = await book();
    expect(r.status).toBe(201);
    expect(r.body.auto_confirmed).toBe(true);
    expect(r.body.booking.status).toBe('confirmed');
    expect(r.body.booking.can_cancel).toBe(true);
    const b = h.db.bookings[0];
    expect(b.status).toBe('confirmed');
    expect(b.confirmed_at).toBeTruthy();
    expect(b.confirmed_by ?? null).toBeNull();

    const c = msgsTo(CUST_TG);
    expect(c).toHaveLength(1);
    expect(c[0].text).toContain('✅ Broningiz tasdiqlandi');
    expect(c[0].text).toContain('kutish shart emas');
    expect(c[0].text).toContain(b.pickup_code);
    expect(c[0].text).not.toMatch(/Admin tasdiqlashini kuting/);
    expect(JSON.stringify(c[0].markup)).toContain('Ilovani ochish');
    expect(JSON.stringify(c[0].markup)).not.toMatch(/Mini Appni/);

    const ins = msgsTo(INS_TG);
    expect(ins[0].text).toContain('Yangi bron · tasdiqlangan');

    const a = msgsTo(ADMIN_CHAT);
    expect(a).toHaveLength(1);
    expect(a[0].text).toContain('✅ tasdiqlangan');
    expect(a[0].text).toContain('Avtomatik tasdiqlandi');
    expect(a[0].text).not.toMatch(/Tasdiqlash kutilmoqda|tezroq tasdiqlang/);

    // Mijoz ilovasida in-app bildirishnoma ham «tasdiqlandi»
    expect(h.db.notifications.some((n) => /tasdiqlandi/.test(n.title))).toBe(true);
  });

  it('mijoz avto-tasdiqlangan bronni o‘zi darhol bekor qiladi (admin so‘rovsiz)', async () => {
    const r = await book();
    const id = r.body.booking.id;
    const list = await tg('GET', '/api/bookings');
    expect(list.body.bookings[0].can_cancel).toBe(true);
    const x = await tg('PATCH', `/api/bookings/${id}/cancel`, { reason: 'Rejalarim o‘zgardi' });
    expect(x.status).toBe(200);
    expect(x.body.mode).toBe('cancelled');
    expect(h.db.bookings[0].status).toBe('cancelled');
    expect(h.db.bookings[0].cancel_requested_at ?? null).toBeNull();
  });

  it('kassada to‘langan bron — faqat so‘rov orqali', async () => {
    const r = await book();
    const id = r.body.booking.id;
    h.db.payments.push({ id: 'p1', booking_id: id, status: 'paid', amount: 250000 });
    const list = await tg('GET', '/api/bookings');
    expect(list.body.bookings[0].can_cancel).toBe(false);
    const x = await tg('PATCH', `/api/bookings/${id}/cancel`, { reason: 'Kasal bo‘lib qoldim' });
    expect(x.body.mode).toBe('requested');
    expect(h.db.bookings[0].status).toBe('confirmed');
    expect(h.db.bookings[0].cancel_requested_at).toBeTruthy();
  });

  it('xodim qo‘lda tasdiqlagan bron — so‘rov orqali (avvalgidek)', async () => {
    const r = await book();
    h.db.bookings[0].confirmed_by = 'u-admin';
    const x = await tg('PATCH', `/api/bookings/${r.body.booking.id}/cancel`, { reason: 'Vaqtim to‘g‘ri kelmadi' });
    expect(x.body.mode).toBe('requested');
  });
});

describe('Avtomatik tasdiqlash — o‘chirilgan', () => {
  it('admin_settings.booking_auto_confirm = false → «Kutilmoqda», eski xabarlar', async () => {
    h.db.admin_settings.push({ key: 'booking_auto_confirm', value: { value: false } });
    const r = await book('11:00');
    expect(r.status).toBe(201);
    expect(r.body.auto_confirmed).toBe(false);
    expect(h.db.bookings[0].status).toBe('pending');
    expect(msgsTo(CUST_TG)[0].text).toContain('Admin tasdiqlashini kuting');
    expect(msgsTo(ADMIN_CHAT)[0].text).toContain('Tasdiqlash kutilmoqda');
  });
});

describe('canCancelNow', () => {
  const future = new Date(Date.now() + 3600e3).toISOString();
  const past = new Date(Date.now() - 60e3).toISOString();
  it('qoidalar', () => {
    expect(canCancelNow({ id: '1', status: 'pending', start_at: future }, new Set())).toBe(true);
    expect(canCancelNow({ id: '1', status: 'confirmed', start_at: future }, new Set())).toBe(true);
    expect(canCancelNow({ id: '1', status: 'confirmed', start_at: past }, new Set())).toBe(false);
    expect(canCancelNow({ id: '1', status: 'confirmed', start_at: future }, new Set(['1']))).toBe(false);
    expect(canCancelNow({ id: '1', status: 'confirmed', start_at: future, school_receipt_code: 'X1' }, new Set())).toBe(false);
    expect(canCancelNow({ id: '1', status: 'confirmed', start_at: future, source: 'admin' }, new Set())).toBe(false);
    expect(canCancelNow({ id: '1', status: 'in_progress', start_at: future }, new Set())).toBe(false);
    expect(autoConfirmedUntouched({ status: 'confirmed', confirmed_by: 'x' })).toBe(false);
  });
});
