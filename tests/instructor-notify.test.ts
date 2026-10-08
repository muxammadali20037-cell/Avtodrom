/**
 * INSTRUKTORGA O'Z O'QUVCHILARI — botda rasm (faqat uning ustuni) va
 * ostida bosib qo'ng'iroq qilinadigan raqamlar; admin o'zgartirsa, qo'lda
 * bron yoki kassa — darhol xabar; kechqurun/ertalab kunlik ro'yxat.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import { cellKey } from '../backend/src/booking-sheet.js';
import { dayImageSvg, renderDayPng } from '../backend/src/instructor-day-image.js';
import { runInstructorDigest } from '../backend/src/instructor-notify.js';

let h: Harness;
let admin = '', operator = '';
const INS_TG = 880111, INS2_TG = 880112;
const TZ = 'Asia/Tashkent';
const ymd = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + n * 864e5));
const D1 = ymd(1);
const at = (hm: string, d = D1) => new Date(`${d}T${hm}:00+05:00`).toISOString();
const save = (cells: Record<string, string>, prev: Record<string, string> = {}) => h.call('PUT', '/api/admin/booking-sheet', {
  cookie: admin, payload: { date: D1, changes: Object.entries(cells).map(([key, t]) => ({ key, t, prev: prev[key] || '' })) },
});
const to = (chat: number) => h.telegram.filter((m) => m.chat === chat);

beforeAll(async () => { h = await makeHarness(); });
beforeEach(async () => {
  h.reset();
  h.db.staff.push({ id: 'st-admin', login: 'boss', password_hash: hashPassword('admin1234'), role: 'admin', register_id: null, is_active: true });
  h.db.staff.push({ id: 'st-op', login: 'oper', password_hash: hashPassword('parol1234'), role: 'operator', register_id: null, full_name: 'Operator', is_active: true });
  h.db.users.push({ id: 'u-admin', full_name: 'Admin', role: 'admin', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-instr', full_name: 'Aziz Karimov', phone: '+998901114455', telegram_id: INS_TG, role: 'instructor', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-ins2', full_name: 'Komila Sobirova', phone: '+998901114466', telegram_id: INS2_TG, role: 'instructor', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-ins3', full_name: 'Telegramsiz', phone: '+998901114477', role: 'instructor', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-cust', full_name: 'Ali Mijoz', phone: '+998901119999', role: 'customer', is_active: true, is_blocked: false });
  h.db.instructor_profiles.push({ id: 'ip-1', user_id: 'u-instr', is_verified: true, is_available: true, categories: ['B'], rating: 4.9 });
  h.db.instructor_profiles.push({ id: 'ip-2', user_id: 'u-ins2', is_verified: true, is_available: true, categories: ['B'], rating: 4.5 });
  h.db.instructor_profiles.push({ id: 'ip-3', user_id: 'u-ins3', is_verified: true, is_available: true, categories: ['B'], rating: 4.5 });
  h.db.courses.push({ id: 'c-b', name: 'B kategoriya', category: 'B', price: 250000, duration_minutes: 60, is_active: true });
  admin = (await h.login('boss', 'admin1234')).cookie;
  operator = (await h.login('oper', 'parol1234')).cookie;
});

describe('Kunlik rasm', () => {
  it('SVG faqat bitta instruktor ustuni; PNG chiziladi', async () => {
    const d = { title: 'Ertaga, 9-oktabr, payshanba', insName: 'Aziz Karimov', insPhone: '90 111 44 55', footer: 'x',
      rows: [{ h: 10, main: '94 005 26 50', sub: 'Дурдона · B toifa', tag: 'AVD-5140', kind: 'bron' as const, past: false },
        { h: 11, main: '<BAND>', sub: '', tag: 'band', kind: 'band' as const, past: false }] };
    const svg = dayImageSvg(d);
    expect(svg).toContain('AZIZ KARIMOV');
    expect(svg).toContain('94 005 26 50');
    expect(svg).toContain('&lt;BAND&gt;');
    const png = await renderDayPng(d);
    expect(png && Buffer.from(png).subarray(1, 4).toString()).toBe('PNG');
  });
});

describe('Admin Excel bronni o‘zgartirsa — instruktorga xabar', () => {
  it('yangi bron: o‘zgarish + rasm + bosiladigan raqam; boshqa instruktorga — hech narsa', async () => {
    await save({ [cellKey('ip-1', 10)]: 'Дурдона 994188549' });
    const m = to(INS_TG);
    expect(m).toHaveLength(1);
    expect(m[0].method).toBe('sendPhoto');
    expect(m[0].text).toMatch(/Jadvalingiz o‘zgardi/);
    expect(m[0].text).toMatch(/✅ Yangi bron: <b>10:00–11:00<\/b> \+998994188549 · Дурдона · AVD-\d+/);
    expect(m[0].text).toMatch(/1 ta yozuv/);
    expect(to(INS2_TG)).toHaveLength(0);
  });
  it('bekor qilinsa va BAND yozilsa ham xabar', async () => {
    await save({ [cellKey('ip-1', 10)]: '994188549' });
    h.telegram.length = 0;
    await save({ [cellKey('ip-1', 10)]: '', [cellKey('ip-1', 12)]: 'BAND' }, { [cellKey('ip-1', 10)]: '994188549' });
    const t = to(INS_TG)[0].text;
    expect(t).toMatch(/❌ Bekor qilindi: <b>10:00–11:00<\/b> \+998994188549/);
    expect(t).toMatch(/📌 <b>12:00<\/b> band: «BAND»/);
    h.telegram.length = 0;
    await save({ [cellKey('ip-1', 12)]: '' }, { [cellKey('ip-1', 12)]: 'BAND' });
    expect(to(INS_TG)[0].text).toMatch(/🔓 <b>12:00<\/b> bo‘shadi/);
  });
  it('Telegram’siz instruktor — xato bermaydi', async () => {
    const r = await save({ [cellKey('ip-3', 10)]: '994188549' });
    expect(r.status).toBe(200);
    expect(r.body.result.created).toHaveLength(1);
    expect(h.telegram).toHaveLength(0);
  });
});

describe('Qo‘lda bron — instruktorga darhol', () => {
  it('operator qo‘lda bron qilsa instruktorga «Yangi bron (qo‘lda bron)»', async () => {
    const r = await h.call('POST', '/api/admin/manual-booking', { cookie: operator, payload: {
      full_name: 'Vali', phone: '+998901112233', instructor_id: 'ip-1', category: 'B', duration_minutes: 60, start_at: at('14:00') } });
    expect(r.status).toBe(201);
    const t = to(INS_TG).map((x) => x.text).join('\n');
    expect(t).toMatch(/Yangi bron<\/b> \(qo‘lda bron\)/);
    expect(t).toMatch(/14:00–15:00/);
    expect(t).toContain('+998901112233');
  });
});

describe('Kunlik ro‘yxat (kechqurun ertangi, ertalab bugungi)', () => {
  it('20:00 dan keyin — ertangi o‘quvchilari bor instruktorga bir marta', async () => {
    await save({ [cellKey('ip-1', 9)]: '994188549', [cellKey('ip-1', 15)]: 'BAND' });
    h.telegram.length = 0;
    const evening = new Date(`${ymd(0)}T20:30:00+05:00`).getTime();
    const r = await runInstructorDigest(evening);
    expect(r).toMatchObject({ ran: true, kind: 'evening', date: D1, sent: 1 });
    const m = to(INS_TG);
    expect(m).toHaveLength(1);
    expect(m[0].method).toBe('sendPhoto');
    expect(m[0].text).toMatch(/Ertangi o‘quvchilaringiz/);
    expect(m[0].text).toMatch(/<b>09:00–10:00<\/b> \+998994188549/);
    expect(m[0].text).toMatch(/<b>15:00<\/b> BAND/);
    expect(to(INS2_TG)).toHaveLength(0);                 // o'quvchisi yo'q — bezovta qilinmaydi
    expect(await runInstructorDigest(evening + 600000)).toMatchObject({ ran: false, reason: 'sent' });
    expect(to(INS_TG)).toHaveLength(1);
  });
  it('kunduzi (12:00–20:00) yuborilmaydi', async () => {
    expect(await runInstructorDigest(new Date(`${ymd(0)}T15:00:00+05:00`).getTime())).toMatchObject({ ran: false, reason: 'not time' });
  });
  it('sozlamalar ro‘yxatida belgilar ko‘rinmaydi', async () => {
    await save({ [cellKey('ip-1', 9)]: '994188549' });
    await runInstructorDigest(new Date(`${ymd(0)}T20:30:00+05:00`).getTime());
    const st = await h.call('GET', '/api/admin/settings', { cookie: admin });
    expect(JSON.stringify(st.body)).not.toContain('instructor_digest');
  });
});
