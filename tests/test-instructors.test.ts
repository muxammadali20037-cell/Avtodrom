/**
 * SINOV AKKAUNTI — egasi o'z instruktor akkaunti bilan botni sinaydi,
 * lekin mijoz, kassa va Excel bron ro'yxatlarida u ko'rinmaydi.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import { parseTestIds } from '../backend/src/test-instructors.js';
import { cellKey } from '../backend/src/booking-sheet.js';

let h: Harness;
let admin = '', kassa = '';
const CUST_TG = 777091, TEST_TG = 880201;
const TZ = 'Asia/Tashkent';
const ymd = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + n * 864e5));
const day = ymd(1), day2 = ymd(2);
const at = (hm: string, d = day) => new Date(`${d}T${hm}:00+05:00`).toISOString();

function signedInitData(user: Record<string, unknown>, botToken = '1:customer') {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAtest', user: JSON.stringify(user) });
  const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dataCheck).digest('hex'));
  return params.toString();
}
const cust = (method: string, url: string, payload?: any) =>
  h.app.inject({ method, url, payload, headers: { 'x-telegram-init-data': signedInitData({ id: CUST_TG, first_name: 'Ali' }) } })
    .then((r: any) => ({ status: r.statusCode, body: JSON.parse(r.body || '{}') }));
const insApi = (method: string, url: string) =>
  h.app.inject({ method, url, headers: { 'x-telegram-init-data': signedInitData({ id: TEST_TG, first_name: 'Muxammadali' }, '1:instructor') } })
    .then((r: any) => ({ status: r.statusCode, body: JSON.parse(r.body || '{}') }));
async function say(text: string, tgId = TEST_TG) {
  const before = h.telegram.length;
  const r = await h.app.inject({
    method: 'POST', url: '/api/telegram/instructor/webhook',
    headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' },
    payload: { update_id: 1, message: { message_id: 1, chat: { id: tgId, type: 'private' }, from: { id: tgId, first_name: 'M' }, text } },
  });
  expect(r.statusCode).toBe(200);
  return h.telegram.slice(before).map((m) => m.text).join('\n');
}
const ids = (rows: any[]) => rows.map((x: any) => String(x.id)).sort();

beforeAll(async () => { h = await makeHarness(); });
beforeEach(async () => {
  h.reset();
  h.db.cash_registers.push({ id: 'reg-p1', code: 'P1', name: '1-kassa', pin_hash: null });
  h.db.staff.push({ id: 'st-admin', login: 'boss', password_hash: hashPassword('admin1234'), role: 'admin', register_id: null, is_active: true });
  h.db.staff.push({ id: 'st-k1', login: 'kassa1', password_hash: hashPassword('parol1234'), role: 'cashier', register_id: 'reg-p1', full_name: 'Kassa', is_active: true });
  h.db.users.push({ id: 'u-admin', full_name: 'Admin', role: 'admin', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-instr', full_name: 'Aziz Karimov', phone: '+998901114455', role: 'instructor', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-test', full_name: 'MUXAMMADALI Ibroximov', phone: '+998000000000', telegram_id: TEST_TG, role: 'instructor', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-cust', telegram_id: CUST_TG, full_name: 'Ali Mijoz', phone: '+998901119999', role: 'customer', is_active: true, is_blocked: false });
  h.db.instructor_profiles.push({ id: 'ip-1', user_id: 'u-instr', is_verified: true, is_available: true, categories: ['B'], rating: 4.9 });
  h.db.instructor_profiles.push({ id: 'db90e88e-445b-4e59-8c96-3a8a4c680053', user_id: 'u-test', is_verified: true, is_available: true, categories: ['B'], rating: 0 });
  h.db.admin_settings.push({ key: 'test_instructors', value: ['db90e88e-445b-4e59-8c96-3a8a4c680053'] });
  h.db.courses.push({ id: 'c-b', name: 'B kategoriya', category: 'B', price: 250000, duration_minutes: 60, is_active: true });
  admin = (await h.login('boss', 'admin1234')).cookie;
  kassa = (await h.login('kassa1', 'parol1234')).cookie;
});
const TID = 'db90e88e-445b-4e59-8c96-3a8a4c680053';

describe('Sinov akkaunti', () => {
  it('ro‘yxat har xil yozilsa ham o‘qiladi', () => {
    expect([...parseTestIds([TID])]).toEqual([TID]);
    expect([...parseTestIds({ ids: [TID] })]).toEqual([TID]);
    expect([...parseTestIds({ value: [TID] })]).toEqual([TID]);
    expect([...parseTestIds(JSON.stringify([TID]))]).toEqual([TID]);
    expect([...parseTestIds(`${TID}, `)]).toEqual([TID]);
    expect(parseTestIds(null).size).toBe(0);
    expect(parseTestIds('').size).toBe(0);
  });

  it('mijoz Mini App’da ko‘rmaydi va unga bron qila olmaydi', async () => {
    const r = await cust('GET', '/api/instructors');
    expect(r.status).toBe(200);
    expect(ids(r.body.instructors)).toEqual(['ip-1']);
    const b = await cust('POST', '/api/bookings', { instructor_id: TID, course_id: 'c-b', hours: 1, start_at: at('10:00') });
    expect(b.status).toBe(400);
    expect(h.db.bookings.length).toBe(0);
    // ro'yxatdan chiqarilsa — yana ko'rinadi
    h.db.admin_settings.length = 0;
    expect(ids((await cust('GET', '/api/instructors')).body.instructors)).toEqual(['ip-1', TID].sort());
  });

  it('kassa ro‘yxatlari va bo‘sh instruktorlarda yo‘q', async () => {
    const list = await h.call('GET', '/api/admin/cashier/instructors', { cookie: kassa });
    expect(ids(list.body.instructors)).toEqual(['ip-1']);
    const free = await h.call('GET', `/api/admin/cashier/free-instructors?at=${encodeURIComponent(at('12:00'))}&minutes=60&category=B`, { cookie: kassa });
    expect(free.status).toBe(200);
    expect([...free.body.free, ...free.body.busy].map((x: any) => String(x.id ?? x.instructor_id))).not.toContain(TID);
    const sch = await h.call('GET', `/api/admin/schedule?date=${day}`, { cookie: kassa });
    expect(ids(sch.body.instructors)).toEqual(['ip-1']);
  });

  it('o‘zi botga kiradi, bron yozadi; Excel bron’da faqat o‘sha kuni ko‘rinadi', async () => {
    // instruktor paneli ochiladi
    expect((await insApi('GET', '/api/instructor/me')).status).toBe(200);
    // Excel bron'da bo'sh kunda yo'q
    expect(ids((await h.call('GET', `/api/admin/booking-sheet?date=${day}`, { cookie: admin })).body.instructors)).toEqual(['ip-1']);
    // botdan bron
    const out = await say('ertaga 901234567 14:00');
    expect(out).toMatch(/bron qilindi/i);
    const bk = h.db.bookings.find((b: any) => b.instructor_id === TID);
    expect(bk).toBeTruthy();
    // o'sha kuni Excel bron va kassa jadvalida ko'rinadi (bron bor), keyingi kuni yo'q
    const sh = (await h.call('GET', `/api/admin/booking-sheet?date=${day}`, { cookie: admin })).body;
    expect(ids(sh.instructors)).toEqual(['ip-1', TID].sort());
    expect(sh.cells[cellKey(TID, 14)]).toBeTruthy();
    expect(ids((await h.call('GET', `/api/admin/booking-sheet?date=${day2}`, { cookie: admin })).body.instructors)).toEqual(['ip-1']);
    expect(ids((await h.call('GET', `/api/admin/schedule?date=${day}`, { cookie: kassa })).body.instructors)).toContain(TID);
    // o'z ro'yxatini so'raydi
    expect(await say('ertaga')).toMatch(/14:00/);
  });
});
