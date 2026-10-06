/**
 * INSTRUKTOR ISH GRAFIGI — admin belgilaydi: qaysi kun, soat nechdan
 * nechgacha ishlaydi, qachon tanaffus / dam. Grafikdan tashqari vaqtga
 * hech kim (Mini App, operator, kassa) bron qila olmaydi.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import {
  normDay, normSchedule, specFor, offBlocksBetween, describeDay, weekdayOf, hmToMin,
} from '../backend/src/instructor-schedule.js';

let h: Harness;
let admin = '', kassa = '', operator = '';
const INS_TG = 880077, CUST_TG = 777077;
const TZ = 'Asia/Tashkent';
const ymd = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + n * 864e5));
const day = ymd(2), day3 = ymd(3);
const at = (hm: string, d = day) => new Date(`${d}T${hm}:00+05:00`).toISOString();
const WD = String(weekdayOf(day));

function signedInitData(user: Record<string, unknown>, botToken = '1:customer') {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAtest', user: JSON.stringify(user) });
  const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dataCheck).digest('hex'));
  return params.toString();
}
const tg = (who: 'cust' | 'ins') => (method: string, url: string, payload?: any) =>
  h.app.inject({ method, url, payload, headers: { 'x-telegram-init-data': who === 'cust'
    ? signedInitData({ id: CUST_TG, first_name: 'Ali' }) : signedInitData({ id: INS_TG, first_name: 'Aziz' }, '1:instructor') } })
    .then((r: any) => ({ status: r.statusCode, body: JSON.parse(r.body || '{}') }));
const cust = tg('cust'), ins = tg('ins');
const put = (body: any, cookie = admin) => h.call('PUT', '/api/admin/instructors/ip-1/work-schedule', { cookie, payload: body });

beforeAll(async () => { h = await makeHarness(); });
beforeEach(async () => {
  h.reset();
  h.db.cash_registers.push({ id: 'reg-p1', code: 'P1', name: '1-kassa', pin_hash: null });
  h.db.staff.push({ id: 'st-admin', login: 'boss', password_hash: hashPassword('admin1234'), role: 'admin', register_id: null, is_active: true });
  h.db.staff.push({ id: 'st-k1', login: 'kassa1', password_hash: hashPassword('parol1234'), role: 'cashier', register_id: 'reg-p1', full_name: 'Kassa', is_active: true });
  h.db.staff.push({ id: 'st-op', login: 'oper', password_hash: hashPassword('parol1234'), role: 'operator', register_id: null, full_name: 'Operator', is_active: true });
  h.db.users.push({ id: 'u-admin', full_name: 'Admin', role: 'admin', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-instr', full_name: 'Aziz Karimov', phone: '+998901114455', telegram_id: INS_TG, role: 'instructor', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-ins2', full_name: 'Anvar Sobirov', phone: '+998901114466', role: 'instructor', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-cust', telegram_id: CUST_TG, full_name: 'Ali Mijoz', phone: '+998901119999', role: 'customer', is_active: true, is_blocked: false });
  h.db.instructor_profiles.push({ id: 'ip-1', user_id: 'u-instr', is_verified: true, is_available: true, categories: ['B'], rating: 4.9 });
  h.db.instructor_profiles.push({ id: 'ip-2', user_id: 'u-ins2', is_verified: true, is_available: true, categories: ['B'], rating: 4.5 });
  h.db.courses.push({ id: 'c-b', name: 'B kategoriya', category: 'B', price: 250000, duration_minutes: 60, is_active: true });
  admin = (await h.login('boss', 'admin1234')).cookie;
  kassa = (await h.login('kassa1', 'parol1234')).cookie;
  operator = (await h.login('oper', 'parol1234')).cookie;
});

/** Aziz: shu hafta kuni 09:00 dan ishlaydi, 13:00–14:00 tushlik, 17:00 da ketadi. */
const AZIZ_WEEK = { [WD]: { off: false, closed: [['07:00', '09:00'], ['13:00', '14:00'], ['17:00', '19:00']] } };

describe('Ish grafigi — qoida', () => {
  it('oraliqlarni tartiblaydi va birlashtiradi, noto‘g‘risini tashlaydi', () => {
    const d = normDay({ closed: [['13:00', '14:00'], ['12:00', '13:30'], ['15:00', '15:00'], ['xx', '10:00'], { from: '16:00', to: '17:00' }] })!;
    expect(d.closed).toEqual([[720, 840], [960, 1020]]);
    expect(hmToMin('24:00')).toBe(1440);
    expect(hmToMin('24:30')).toBeNull();
  });

  it('sana bo‘yicha qoida haftalik grafikdan ustun', () => {
    const s = normSchedule({ week: { [WD]: { off: true } }, dates: { [day]: { off: false, closed: [['07:00', '12:00']] } } });
    expect(specFor(s, day)!.off).toBe(false);
    const blocks = offBlocksBetween(s, new Date(at('00:00')), new Date(at('23:59')));
    expect(blocks).toEqual([{ start_at: at('07:00'), end_at: at('12:00'), off: true }]);
    // grafik yo'q — hech narsa yopiq emas
    expect(offBlocksBetween(normSchedule({}), new Date(at('00:00')), new Date(at('23:59')))).toEqual([]);
  });

  it('ish vaqtini o‘qiladigan matnga aylantiradi', () => {
    const s = normSchedule({ week: AZIZ_WEEK });
    expect(describeDay(specFor(s, day), 7 * 60, 19 * 60)).toBe('09:00–13:00, 14:00–17:00');
    expect(describeDay(normDay({ off: true }), 420, 1140)).toBe('dam olish kuni');
    expect(describeDay(null, 420, 1140)).toBe('to‘liq ish kuni');
  });
});

describe('Ish grafigi — admin API', () => {
  it('faqat administrator: kassir va operator 403, kirmagan 401', async () => {
    expect((await put({ week: AZIZ_WEEK }, kassa)).status).toBe(403);
    expect((await put({ week: AZIZ_WEEK }, operator)).status).toBe(403);
    expect((await h.call('GET', '/api/admin/work-schedules', { cookie: kassa })).status).toBe(403);
    expect((await h.call('GET', '/api/admin/work-schedules')).status).toBe(401);
  });

  it('saqlaydi va qaytaradi; ro‘yxatda ko‘rinadi, sozlamalar ro‘yxatiga chiqmaydi', async () => {
    const r = await put({ week: AZIZ_WEEK });
    expect(r.status).toBe(200);
    expect(r.body.schedule.week[WD].closed).toEqual([['07:00', '09:00'], ['13:00', '14:00'], ['17:00', '19:00']]);
    const one = await h.call('GET', '/api/admin/instructors/ip-1/work-schedule?days=7', { cookie: admin });
    expect(one.status).toBe(200);
    expect(one.body.schedule.week[WD].closed).toHaveLength(3);
    expect(one.body.instructor.name).toBe('Aziz Karimov');
    expect(one.body).toMatchObject({ work_start: '07:00', work_end: '19:00', slot_step_min: 60 });
    const list = await h.call('GET', '/api/admin/work-schedules', { cookie: admin });
    expect(list.body.instructors.find((x: any) => x.id === 'ip-1').schedule.week[WD]).toBeTruthy();
    expect(list.body.instructors.find((x: any) => x.id === 'ip-2').schedule).toBeNull();
    const st = await h.call('GET', '/api/admin/settings', { cookie: admin });
    expect(st.body.settings.some((x: any) => String(x.key).startsWith('instructor_schedule:'))).toBe(false);
    expect(h.db.admin_audit_logs.some((x: any) => x.action === 'INSTRUCTOR_SCHEDULE_UPDATED')).toBe(true);
  });

  it('o‘tgan sanalar saqlanmaydi; noto‘g‘ri hafta 400', async () => {
    const r = await put({ week: {}, dates: { '2020-01-01': { off: true }, [day3]: { off: true } } });
    expect(Object.keys(r.body.schedule.dates)).toEqual([day3]);
    expect((await put({ week: [1, 2] })).status).toBe(400);
  });

  it('dam vaqtga tushib qolgan bronlarni aytadi (bron o‘zgarmaydi)', async () => {
    h.db.bookings.push({ id: 'b-lunch', customer_id: 'u-cust', instructor_id: 'ip-1', start_at: at('13:00'), end_at: at('14:00'), booking_date: at('13:00'), status: 'confirmed' });
    h.db.bookings.push({ id: 'b-ok', customer_id: 'u-cust', instructor_id: 'ip-1', start_at: at('10:00'), end_at: at('11:00'), booking_date: at('10:00'), status: 'confirmed' });
    const r = await put({ week: AZIZ_WEEK });
    expect(r.body.conflicts.map((x: any) => x.id)).toEqual(['b-lunch']);
    expect(r.body.conflicts[0].customer_name).toBe('Ali Mijoz');
    expect(h.db.bookings.find((b: any) => b.id === 'b-lunch').status).toBe('confirmed');
  });
});

describe('Grafikdan tashqari vaqtga hech kim bron qila olmaydi', () => {
  beforeEach(async () => { await put({ week: AZIZ_WEEK, dates: { [day3]: { off: true, closed: [] } } }); });

  it('Mini App: band ko‘rinadi, tanaffusga va ishdan keyinga bron — 409, ish vaqtiga — 201', async () => {
    const av = await cust('GET', `/api/instructors/ip-1/availability?date=${day}`);
    const has = (a: string, b: string) => av.body.busy.some((x: any) => x.start_at === at(a) && x.end_at === at(b));
    expect(has('07:00', '09:00') && has('13:00', '14:00') && has('17:00', '19:00')).toBe(true);
    // boshqa instruktorga tegmaydi
    expect((await cust('GET', `/api/instructors/ip-2/availability?date=${day}`)).body.busy).toEqual([]);

    expect((await cust('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', hours: 1, start_at: at('13:00') })).status).toBe(409);
    expect((await cust('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', hours: 1, start_at: at('08:00') })).status).toBe(409);
    expect((await cust('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', hours: 1, start_at: at('17:00') })).status).toBe(409);
    // 12:00–14:00 (2 soat) tushlikka kirib qoladi
    expect((await cust('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', hours: 2, start_at: at('12:00') })).status).toBe(409);
    expect((await cust('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', hours: 1, start_at: at('10:00') })).status).toBe(201);
  });

  it('dam olish kuni — butun kun yopiq', async () => {
    const av = await cust('GET', `/api/instructors/ip-1/availability?date=${day3}`);
    expect(av.body.busy).toContainEqual({ start_at: at('00:00', day3), end_at: new Date(Date.parse(at('00:00', day3)) + 864e5).toISOString() });
    const r = await h.call('POST', '/api/admin/manual-booking', { cookie: admin, payload: {
      full_name: 'Qo‘lda Mijoz', phone: '+998905550000', instructor_id: 'ip-1', category: 'B', duration_minutes: 60, start_at: at('10:00', day3) } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/dam oladi/);
  });

  it('operator qo‘lda bron: tanaffusga — 409 (sababi bilan), ish vaqtiga — bo‘ladi', async () => {
    const bad = await h.call('POST', '/api/admin/manual-booking', { cookie: operator, payload: {
      full_name: 'Qo‘lda Mijoz', phone: '+998905550000', instructor_id: 'ip-1', category: 'B', duration_minutes: 60, start_at: at('13:00') } });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toMatch(/ish grafigi/);
    expect(bad.body.error).toMatch(/13:00–14:00/);
    const ok = await h.call('POST', '/api/admin/manual-booking', { cookie: operator, payload: {
      full_name: 'Qo‘lda Mijoz', phone: '+998905550000', instructor_id: 'ip-1', category: 'B', duration_minutes: 60, start_at: at('14:00') } });
    expect(ok.status).toBeLessThan(300);
  });

  it('kassa: bo‘sh instruktorlar — tanaffusdagi «ishlamaydi», qachon qaytishi bilan', async () => {
    const r = await h.call('GET', `/api/admin/cashier/free-instructors?at=${encodeURIComponent(at('13:00'))}&minutes=60&category=B`, { cookie: kassa });
    expect(r.body.free.map((x: any) => x.id)).toEqual(['ip-2']);
    const b = r.body.busy.find((x: any) => x.id === 'ip-1');
    expect(b).toMatchObject({ off: true, blocked: true, free_at: at('14:00') });
    // ishdan ketgan — bugun qaytmaydi
    const late = await h.call('GET', `/api/admin/cashier/free-instructors?at=${encodeURIComponent(at('17:30'))}&minutes=60&category=B`, { cookie: kassa });
    expect(late.body.busy.find((x: any) => x.id === 'ip-1')).toMatchObject({ off: true, free_at: null });
    const ok = await h.call('GET', `/api/admin/cashier/free-instructors?at=${encodeURIComponent(at('10:00'))}&minutes=60&category=B`, { cookie: kassa });
    expect(ok.body.free.map((x: any) => x.id)).toContain('ip-1');
  });

  it('jadval (kassa/operator): grafik bo‘yicha dam — off belgisi bilan', async () => {
    const r = await h.call('GET', `/api/admin/schedule?date=${day}`, { cookie: kassa });
    const off = r.body.blocks.filter((x: any) => x.instructor_id === 'ip-1' && x.off);
    expect(off.map((x: any) => x.start_at)).toEqual([at('07:00'), at('13:00'), at('17:00')]);
  });

  it('instruktor panelida: grafik bo‘yicha dam vaqtlar alohida keladi', async () => {
    const r = await ins('GET', `/api/instructor/blocks?from=${day}&to=${day3}`);
    expect(r.status).toBe(200);
    expect(r.body.blocks).toEqual([]);
    expect(r.body.off.map((x: any) => x.start_at)).toEqual([at('07:00'), at('13:00'), at('17:00'), at('00:00', day3)]);
  });

  it('admin instruktor o‘zi yopgan soatni ocha oladi', async () => {
    await ins('PUT', '/api/instructor/blocks', { date: day, slots: [{ from: '15:00', to: '16:00' }] });
    expect((await cust('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', hours: 1, start_at: at('15:00') })).status).toBe(409);
    const one = await h.call('GET', '/api/admin/instructors/ip-1/work-schedule', { cookie: admin });
    expect(one.body.blocks.map((x: any) => x.start_at)).toEqual([at('15:00')]);
    const open = await h.call('PUT', '/api/admin/instructors/ip-1/blocks', { cookie: admin, payload: { date: day, slots: [] } });
    expect(open.status).toBe(200);
    expect(open.body.blocks).toEqual([]);
    expect((await cust('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', hours: 1, start_at: at('15:00') })).status).toBe(201);
    expect((await h.call('PUT', '/api/admin/instructors/ip-1/blocks', { cookie: kassa, payload: { date: day, slots: [] } })).status).toBe(403);
  });

  it('grafik olib tashlansa — yana hamma vaqt ochiq', async () => {
    await put({ week: {}, dates: {} });
    const av = await cust('GET', `/api/instructors/ip-1/availability?date=${day}`);
    expect(av.body.busy).toEqual([]);
    expect((await cust('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', hours: 1, start_at: at('13:00') })).status).toBe(201);
  });
});

