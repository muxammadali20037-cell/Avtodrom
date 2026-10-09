/**
 * EXCEL BRON → GURUHGA HAVOLA
 *  · guruh bir martalik kod bilan ulanadi («/ulash 123456»);
 *  · guruhga «📋 Jadvalni ochish» tugmali xabar: tugma bosilganda yangi,
 *    saqlaganda o'sha xabar yangilanadi, 20:00 da ertangi kun;
 *  · havola imzolangan, sahifa jadvalni o'qiy oladi.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import { sheetLinkToken, sheetLinkUrl, checkSheetLink, runSheetGroupEvening } from '../backend/src/sheet-share.js';
import { cellKey } from '../backend/src/booking-sheet.js';

let h: Harness;
let admin = '', operator = '', kassa = '';
const TZ = 'Asia/Tashkent';
const ymd = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + n * 864e5));
const GROUP = -1001234567890;

async function groupSays(text: string, chatId = GROUP, title = 'Instruktorlar') {
  const before = h.telegram.length;
  const r = await h.app.inject({
    method: 'POST', url: '/api/telegram/instructor/webhook',
    headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' },
    payload: { update_id: 5, message: { message_id: 5, chat: { id: chatId, type: 'supergroup', title }, from: { id: 880001, first_name: 'Aziz' }, text } },
  });
  expect(r.statusCode).toBe(200);
  return h.telegram.slice(before);
}
async function linkGroup() {
  const c = await h.call('POST', '/api/admin/sheet-group-code', { cookie: admin, payload: {} });
  expect(c.status).toBe(200);
  const out = await groupSays(`/ulash@avtodrom_instructor_bot ${c.body.code}`);
  expect(out[0]?.text).toMatch(/Guruh ulandi: «Instruktorlar»/);
}

beforeAll(async () => { h = await makeHarness(); });
beforeEach(async () => {
  h.reset();
  h.db.cash_registers.push({ id: 'reg-p1', code: 'P1', name: '1-kassa', is_active: true });
  const st = (id: string, login: string, role: string, reg: string | null) =>
    h.db.staff.push({ id, login, password_hash: hashPassword('parol1234'), role, register_id: reg, full_name: login, is_active: true });
  st('st-admin', 'boss', 'admin', null); st('st-op', 'oper', 'operator', null); st('st-k', 'kassa1', 'cashier', 'reg-p1');
  h.db.users.push({ id: 'u-admin', full_name: 'Admin', role: 'admin', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-ins', full_name: 'Aziz Karimov', phone: '+998901114455', telegram_id: 880001, role: 'instructor', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-ins2', full_name: 'Komila Sobirova', phone: '+998901114466', role: 'instructor', is_active: true, is_blocked: false });
  h.db.instructor_profiles.push({ id: 'ip-1', user_id: 'u-ins', is_verified: true, is_available: true, categories: ['B'] });
  h.db.instructor_profiles.push({ id: 'ip-2', user_id: 'u-ins2', is_verified: true, is_available: true, categories: ['B'] });
  h.db.courses.push({ id: 'c-b', name: 'B', category: 'B', price: 250000, duration_minutes: 60, is_active: true });
  admin = (await h.login('boss', 'parol1234')).cookie;
  operator = (await h.login('oper', 'parol1234')).cookie;
  kassa = (await h.login('kassa1', 'parol1234')).cookie;
});

describe('Havola', () => {
  it('imzolangan: boshqa kun yoki noto‘g‘ri kalit ochilmaydi, eski kun yopiladi', () => {
    const d = ymd(1);
    expect(sheetLinkUrl(d)).toMatch(new RegExp(`/jadval\\?d=${d}&k=[\\w-]{22}$`));
    expect(checkSheetLink(d, sheetLinkToken(d))).toBeNull();
    expect(checkSheetLink(ymd(2), sheetLinkToken(d))).toMatch(/noto‘g‘ri/);
    expect(checkSheetLink(d, 'xxxxxxxxxxxxxxxxxxxxxx')).toMatch(/noto‘g‘ri/);
    const old = ymd(-3);
    expect(checkSheetLink(old, sheetLinkToken(old))).toMatch(/eskirgan/);
    expect(checkSheetLink(ymd(-1), sheetLinkToken(ymd(-1)))).toBeNull();
  });

  it('sahifa jadvalni o‘qiydi — yozuvlar, raqamlar, statistika', async () => {
    const d = ymd(1);
    h.db.admin_settings.push({ key: `booking_sheet:${d}`, value: { cells: { [cellKey('ip-1', 10)]: { t: 'BAND' }, [cellKey('ip-2', 12)]: { t: 'Dilshod 901234567' } } } });
    const bad = await h.app.inject({ method: 'GET', url: `/api/sheet-view?d=${d}&k=notright` });
    expect(bad.statusCode).toBe(403);
    const r = await h.app.inject({ method: 'GET', url: `/api/sheet-view?d=${d}&k=${sheetLinkToken(d)}` });
    expect(r.statusCode).toBe(200);
    const j = JSON.parse(r.body);
    expect(j.title).toMatch(/^Ertaga, /);
    expect(j.instructors.map((i: any) => i.name)).toEqual(['Aziz Karimov', 'Komila Sobirova']);
    expect(j.cells[cellKey('ip-1', 10)]).toMatchObject({ k: 'note', t: 'BAND' });
    expect(j.cells[cellKey('ip-2', 12)]).toMatchObject({ t: 'Dilshod 901234567' });
    expect(j.stats).toMatchObject({ instructors: 2, busy_instructors: 2, band: 2 });
    expect(r.headers['cache-control']).toBe('no-store');
  });
});

describe('Guruhni ulash', () => {
  it('bir martalik kod bilan; noto‘g‘ri kod ulamaydi; boshqa buyruqlarga jim', async () => {
    const wrong = await groupSays('/ulash 000000');
    expect(wrong[0]?.text).toMatch(/Kod noto‘g‘ri yoki eskirgan/);
    expect(h.db.admin_settings.find((r: any) => r.key === 'sheet_group')).toBeUndefined();
    expect(await groupSays('/start@avtodrom_instructor_bot')).toHaveLength(0);
    await linkGroup();
    expect(h.db.admin_settings.find((r: any) => r.key === 'sheet_group').value).toMatchObject({ chat_id: GROUP, title: 'Instruktorlar', linked_by: 'boss' });
    // kod ikkinchi marta ishlamaydi
    const again = await groupSays('/ulash 123456', -100999);
    expect(again[0]?.text).toMatch(/noto‘g‘ri/);
    const st = await h.call('GET', '/api/admin/sheet-group', { cookie: operator });
    expect(st.body.group).toMatchObject({ chat_id: GROUP });
    expect(st.body.link).toMatch(/\/jadval\?d=/);
  });

  it('faqat admin va operator', async () => {
    expect((await h.call('POST', '/api/admin/sheet-group-code', { cookie: kassa, payload: {} })).status).toBe(403);
    expect((await h.call('POST', '/api/admin/sheet-group-code', { cookie: operator, payload: {} })).status).toBe(200);
  });
});

describe('Guruhga yuborish', () => {
  it('tugma: guruhga «📋 Jadvalni ochish» tugmali xabar', async () => {
    const d = ymd(1);
    expect((await h.call('POST', '/api/admin/sheet-share', { cookie: admin, payload: { date: d } })).status).toBe(409);   // ulanmagan
    await linkGroup();
    h.tgResults.set('sendMessage', { message_id: 77, chat: { id: GROUP } });
    const r = await h.call('POST', '/api/admin/sheet-share', { cookie: admin, payload: { date: d } });
    expect(r.status).toBe(200);
    const msg = h.telegram.filter((m) => m.chat === GROUP).pop()!;
    expect(msg.text).toMatch(/Excel bron — Ertaga/);
    expect(msg.markup.inline_keyboard[0][0]).toMatchObject({ text: '📋 Jadvalni ochish', url: sheetLinkUrl(d) });
    expect(h.db.admin_settings.find((x: any) => x.key === `sheet_group_msg:${d}`).value).toMatchObject({ message_id: 77, chat_id: GROUP });
  });

  it('saqlaganda: o‘sha kun xabari yangilanadi (yangi xabar emas)', async () => {
    const d = ymd(1);
    await linkGroup();
    h.tgResults.set('sendMessage', { message_id: 91, chat: { id: GROUP } });
    // birinchi saqlash — xabar yo'q edi → yangi
    let s = await h.call('PUT', '/api/admin/booking-sheet', { cookie: admin, payload: { date: d, changes: [{ key: cellKey('ip-1', 9), t: 'BAND', prev: '' }] } });
    expect(s.status).toBe(200);
    expect(s.body.result.group).toBe('posted');
    // ikkinchi saqlash — tahrirlanadi
    h.tgCalls.length = 0;
    s = await h.call('PUT', '/api/admin/booking-sheet', { cookie: operator, payload: { date: d, changes: [{ key: cellKey('ip-2', 9), t: 'BAND', prev: '' }] } });
    expect(s.body.result.group).toBe('updated');
    const ed = h.tgCalls.find((c) => c.method === 'editMessageText')!;
    expect(ed.body).toMatchObject({ chat_id: GROUP, message_id: 91 });
    expect(ed.body.text).toMatch(/2 ta band/);
    expect(h.tgCalls.some((c) => c.method === 'sendMessage' && c.body.chat_id === GROUP)).toBe(false);
  });

  it('20:00 dan keyin ertangi kun bir marta ketadi', async () => {
    await linkGroup();
    const d = ymd(1);
    const at20 = (h: number) => Date.parse(`${ymd(0)}T${String(h).padStart(2, '0')}:10:00+05:00`);
    expect((await runSheetGroupEvening(at20(19))).ran).toBe(false);
    const n0 = h.telegram.filter((m) => m.chat === GROUP).length;
    expect((await runSheetGroupEvening(at20(20))).ran).toBe(true);
    expect((await runSheetGroupEvening(at20(21))).ran).toBe(false);
    const sent = h.telegram.filter((m) => m.chat === GROUP).slice(n0);
    expect(sent).toHaveLength(1);
    expect(sent[0].markup.inline_keyboard[0][0].url).toBe(sheetLinkUrl(d));
  });
});
