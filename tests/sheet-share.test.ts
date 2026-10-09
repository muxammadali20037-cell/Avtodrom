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
import { buildSheetParts, sheetPartSvg } from '../backend/src/sheet-image.js';

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

describe('Guruhga tashlash — tiniq rasm', () => {
  const band = (d: string, ins: string, hr: number, t = 'BAND') => {
    let row = h.db.admin_settings.find((x: any) => x.key === `booking_sheet:${d}`);
    if (!row) { row = { key: `booking_sheet:${d}`, value: { cells: {} } }; h.db.admin_settings.push(row); }
    row.value.cells[cellKey(ins, hr)] = { t };
  };
  const groupMsgs = () => h.telegram.filter((m) => m.chat === GROUP);

  it('bitta rasm: tugma rasmning o‘zida, izohda kun va bronlar soni', async () => {
    const d = ymd(1);
    expect((await h.call('POST', '/api/admin/sheet-share', { cookie: admin, payload: { date: d } })).status).toBe(409);   // ulanmagan
    await linkGroup();
    band(d, 'ip-1', 10); band(d, 'ip-1', 11); band(d, 'ip-2', 12, 'Dilshod 901234567');
    h.tgResults.set('sendPhoto', { message_id: 77, chat: { id: GROUP } });
    const r = await h.call('POST', '/api/admin/sheet-share', { cookie: admin, payload: { date: d } });
    expect(r.status).toBe(200);
    expect(r.body.images).toBe(1);
    const msg = groupMsgs().pop()!;
    expect(msg.method).toBe('sendPhoto');
    expect(msg.text).toMatch(/Ertaga, /);
    expect(msg.text).toMatch(/📋 3 ta band · 2 instruktor/);         // bron yo'q — «0 ta bron» yozilmaydi
    expect(msg.markup.inline_keyboard[0][0]).toMatchObject({ text: '📋 Jadvalni ochish', url: sheetLinkUrl(d) });
    expect(h.db.admin_settings.find((x: any) => x.key === `sheet_group_msg:${d}`).value).toMatchObject({ chat_id: GROUP, photos: [77] });
  });

  it('qayta tashlansa — yangi rasm, eskisi guruhdan o‘chadi', async () => {
    const d = ymd(1);
    await linkGroup();
    band(d, 'ip-1', 10);
    h.tgResults.set('sendPhoto', { message_id: 77 });
    await h.call('POST', '/api/admin/sheet-share', { cookie: admin, payload: { date: d } });
    h.tgResults.set('sendPhoto', { message_id: 78 });
    h.tgCalls.length = 0;
    await h.call('POST', '/api/admin/sheet-share', { cookie: operator, payload: { date: d } });
    expect(h.tgCalls.find((c) => c.method === 'deleteMessages')?.body).toMatchObject({ chat_id: GROUP, message_ids: [77] });
    expect(h.db.admin_settings.find((x: any) => x.key === `sheet_group_msg:${d}`).value.photos).toEqual([78]);
  });

  it('instruktor ko‘p — albom (har rasmda ≤5 ustun) va alohida tugmali xabar', async () => {
    const d = ymd(1);
    await linkGroup();
    for (let i = 3; i <= 8; i++) {
      h.db.users.push({ id: `u-ins${i}`, full_name: `Instruktor ${i}`, phone: `+99890111440${i}`, role: 'instructor', is_active: true, is_blocked: false });
      h.db.instructor_profiles.push({ id: `ip-${i}`, user_id: `u-ins${i}`, is_verified: true, is_available: true, categories: ['B'] });
    }
    for (let i = 1; i <= 8; i++) band(d, `ip-${i}`, 9 + (i % 3));
    h.tgResults.set('sendMediaGroup', [{ message_id: 201 }, { message_id: 202 }]);
    h.tgResults.set('sendMessage', { message_id: 203 });
    const r = await h.call('POST', '/api/admin/sheet-share', { cookie: admin, payload: { date: d } });
    expect(r.body.images).toBe(2);                         // 8 ta → 4 + 4
    const album = h.tgCalls.find((c) => c.method === 'sendMediaGroup')!;
    expect(album.body.files).toBe(2);
    expect(album.body.media.map((m: any) => m.media)).toEqual(['attach://p0', 'attach://p1']);
    expect(album.body.text).toMatch(/8 instruktor/);
    const btn = groupMsgs().pop()!;
    expect(btn.method).toBe('sendMessage');
    expect(btn.markup.inline_keyboard[0][0].url).toBe(sheetLinkUrl(d));
    expect(h.db.admin_settings.find((x: any) => x.key === `sheet_group_msg:${d}`).value).toMatchObject({ photos: [201, 202], button_id: 203 });
  });

  it('bron yo‘q kun — rasm emas, havolali matn', async () => {
    const d = ymd(2);
    await linkGroup();
    const r = await h.call('POST', '/api/admin/sheet-share', { cookie: admin, payload: { date: d } });
    expect(r.body.images).toBe(0);
    const msg = groupMsgs().pop()!;
    expect(msg.method).toBe('sendMessage');
    expect(msg.text).toMatch(/Hozircha bron yo‘q/);
    expect(msg.markup.inline_keyboard[0][0].url).toBe(sheetLinkUrl(d));
  });

  it('har saqlashda: guruhga faqat o‘zgargan instruktor jadvali (yangi xabar); to‘liq rasm joyida yangilanadi', async () => {
    const d = ymd(1);
    await linkGroup();
    h.tgResults.set('sendPhoto', { message_id: 90 });
    let s = await h.call('PUT', '/api/admin/booking-sheet', { cookie: admin, payload: { date: d, changes: [{ key: cellKey('ip-1', 9), t: 'BAND', prev: '' }] } });
    expect(s.status).toBe(200);
    expect(s.body.result.group).toBe('sent');
    const ch = groupMsgs().pop()!;
    expect(ch.method).toBe('sendPhoto');
    expect(ch.text).toMatch(/Jadval yangilandi/);
    expect(ch.text).toMatch(/Aziz Karimov<\/b>: 📌 9:00 «BAND»/);
    expect(ch.text).not.toMatch(/Komila/);
    expect(ch.markup.inline_keyboard[0][0].url).toBe(sheetLinkUrl(d));
    /* «Guruhga tashlash» — to'liq jadval (91) */
    h.tgResults.set('sendPhoto', { message_id: 91 });
    await h.call('POST', '/api/admin/sheet-share', { cookie: admin, payload: { date: d } });
    h.tgCalls.length = 0;
    s = await h.call('PUT', '/api/admin/booking-sheet', { cookie: operator, payload: { date: d, changes: [{ key: cellKey('ip-2', 9), t: 'BAND', prev: '' }] } });
    expect(s.body.result.group).toBe('sent');
    const ed = h.tgCalls.find((c) => c.method === 'editMessageMedia')!;
    expect(ed.body).toMatchObject({ chat_id: GROUP, message_id: 91, files: 1 });
    expect(ed.body.text).toMatch(/2 ta band/);
    const sent = h.tgCalls.filter((c) => c.method === 'sendPhoto' && c.body.chat_id === GROUP);
    expect(sent).toHaveLength(1);
    expect(sent[0].body.text).toMatch(/Komila Sobirova<\/b>: 📌 9:00/);
    expect(sent[0].body.text).not.toMatch(/Aziz/);
  });

  it('instruktor botga bron yozsa ham guruhga boradi', async () => {
    await linkGroup();
    h.db.instructor_applications = h.db.instructor_applications || [];
    h.db.instructor_applications.push({ telegram_user_id: 880001, status: 'APPROVED', first_name: 'Aziz' });
    const before = groupMsgs().length;
    const r = await h.app.inject({
      method: 'POST', url: '/api/telegram/instructor/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' },
      payload: { update_id: 9, message: { message_id: 9, chat: { id: 880001, type: 'private' }, from: { id: 880001, first_name: 'Aziz' }, text: 'ertaga 14:00 901234567' } },
    });
    expect(r.statusCode).toBe(200);
    const g = groupMsgs().slice(before);
    expect(g.length).toBeGreaterThanOrEqual(1);
    expect(g[0].text).toMatch(/Jadval yangilandi/);
    expect(g[0].text).toMatch(/Aziz Karimov<\/b>: ✅ 14:00–15:00 90 123 45 67 · B/);
    expect(g[0].text).toMatch(/Bot · Aziz Karimov/);
  });

  it('rasmni oldindan ko‘rish — PNG (faqat admin va operator)', async () => {
    const d = ymd(1);
    band(d, 'ip-1', 10);
    const r = await h.call('GET', `/api/admin/sheet-image?date=${d}`, { cookie: operator });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(1);
    expect(r.body.image).toMatch(/^data:image\/png;base64,iVBOR/);
    expect((await h.call('GET', `/api/admin/sheet-image?date=${d}`, { cookie: kassa })).status).toBe(403);
  });

  it('20:00 dan keyin ertangi kun bir marta ketadi', async () => {
    await linkGroup();
    const d = ymd(1);
    const at20 = (hh: number) => Date.parse(`${ymd(0)}T${String(hh).padStart(2, '0')}:10:00+05:00`);
    expect((await runSheetGroupEvening(at20(19))).ran).toBe(false);
    const n0 = groupMsgs().length;
    expect((await runSheetGroupEvening(at20(20))).ran).toBe(true);
    expect((await runSheetGroupEvening(at20(21))).ran).toBe(false);
    const sent = groupMsgs().slice(n0);
    expect(sent).toHaveLength(1);
    expect(sent[0].markup.inline_keyboard[0][0].url).toBe(sheetLinkUrl(d));
  });
});

describe('Rasm: toifa va davomiylik', () => {
  const ins = (id: string, group: string) => ({ id, name: `Ins ${id}`, phone: '+998901112233', group });
  const K = (id: string, h: number) => `${id}|${String(h).padStart(2, '0')}`;
  const d = {
    date: '2026-10-10', hours: [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
    instructors: [ins('a1', 'A'), ins('a2', 'A'), ins('b1', 'B'), ins('b2', 'B'), ins('c1', 'B, C')],
    cells: {
      [K('a1', 10)]: { k: 'sheet', t: '994188549', phone: '+998994188549', code: 'AVD-1', cat: 'A', min: 120 },
      [K('a1', 11)]: { k: 'sheet', t: '994188549', phone: '+998994188549', code: 'AVD-1', cat: 'A', min: 120 },
      [K('a2', 12)]: { k: 'sheet', t: '977737646/30 MIN', phone: '+998977737646', code: 'AVD-2', cat: 'A', min: 30 },
      [K('b1', 9)]: { k: 'bk', phone: '+998901234502', code: 'AVD-3', cat: 'B', src: 'app', min: 60 },
      [K('c1', 14)]: { k: 'sheet', t: '901112233/C', phone: '+998901112233', code: 'AVD-4', cat: 'C', min: 60 },
    },
    stats: { instructors: 5, busy_instructors: 4, bron: 4, band: 0 },
  };
  it('A toifa alohida rasmda; 2 soat — bitta blok; toifa, 30 daq ko‘rinadi', () => {
    const parts = buildSheetParts(d as any, { title: 'Ertaga', line: '4 ta bron', at: '09:00 holati', nowMs: Date.parse('2026-10-09T09:00:00+05:00') });
    expect(parts.map((p) => p.cols.map((c) => c.group))).toEqual([['A', 'A'], ['B', 'B, C']]);
    const two = parts[0].blocks.find((b) => b.main === '99 418 85 49')!;
    expect([two.h0, two.h1]).toEqual([10, 12]);
    expect(two.sub).toMatch(/^A toifa · AVD-1/);
    expect(parts[0].blocks.find((b) => b.main === '97 773 76 46')!.sub).toMatch(/^A toifa · 30 daq/);
    expect(parts[1].blocks.find((b) => b.main === '90 111 22 33')!.sub).toMatch(/^C toifa/);
    const svg = sheetPartSvg(parts[0]);
    expect(svg).toContain('10:00–12:00 · 2 soat');
    expect(svg).toContain('#c2410c');                                        // A toifa sarlavhasi o'z rangida
    expect(sheetPartSvg(parts[1])).toContain('#6d28d9');                     // «B, C» — aralash guruh
  });
});
