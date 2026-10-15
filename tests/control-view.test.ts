/**
 * NAZORAT PANELI — bitta maxfiy havola bilan hamma instruktor:
 *  · havolani faqat administrator oladi / yangilaydi, eskisi darhol yopiladi;
 *  · sahifa ma'lumoti: ish vaqti (grafik − tanaffus − o'zi yopgan), bronlar,
 *    Excel «BAND», hozirgi holat, hafta va statistika.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import { openRanges } from '../backend/src/control-view.js';

let h: Harness;
let admin = '', operator = '';
const D = '2026-10-14';                       // chorshanba
const at = (hm: string, d = D) => new Date(`${d}T${hm}:00+05:00`).toISOString();
const D2 = '2026-10-15';

async function token() {
  const r = await h.call('GET', '/api/admin/control-link', { cookie: admin });
  expect(r.status).toBe(200);
  return { url: r.body.url as string, k: new URL(r.body.url).searchParams.get('k') || '' };
}
const view = (k: string, d = '') => h.call('GET', `/api/control-view?k=${encodeURIComponent(k)}${d ? `&d=${d}` : ''}`);

beforeAll(async () => { h = await makeHarness(); });
afterEach(() => { vi.useRealTimers(); });
beforeEach(async () => {
  h.reset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(at('10:20')));
  const st = (id: string, login: string, role: string) =>
    h.db.staff.push({ id, login, password_hash: hashPassword('parol1234'), role, register_id: null, full_name: login, is_active: true });
  st('st-admin', 'boss', 'admin'); st('st-op', 'oper', 'operator');
  h.db.users.push({ id: 'u-admin', full_name: 'Admin', role: 'admin', is_active: true, is_blocked: false });
  const ins = (n: number, name: string, extra: any = {}) => {
    h.db.users.push({ id: `u-i${n}`, full_name: name, phone: `+99890111000${n}`, role: 'instructor', is_active: true, is_blocked: false });
    h.db.instructor_profiles.push({ id: `ip-${n}`, user_id: `u-i${n}`, is_verified: true, is_available: true, categories: ['B'], vehicle_model: 'Cobalt', vehicle_plate: `01A00${n}AA`, ...extra });
  };
  ins(1, 'Aziz Karimov', { categories: ['B', 'A'] }); ins(2, 'Komila Sobirova'); ins(3, 'Faol emas', { is_available: false });
  for (const [id, name, phone] of [['c1', 'Ali Valiyev', '+998901234567'], ['c2', 'Vali Aliyev', '+998907654321'], ['c3', 'Soli', '+998935551122']]) {
    h.db.users.push({ id, full_name: name, phone, role: 'customer', is_active: true, is_blocked: false });
  }
  const set = (key: string, value: any) => h.db.admin_settings.push({ key, value, updated_at: at('08:00') });
  set('work_start', { value: '07:00' }); set('work_end', { value: '19:00' });
  set('instructor_schedule:ip-1', { week: { '3': { off: false, closed: [['07:00', '08:00'], ['13:00', '14:00']] } }, dates: {} });
  set('instructor_schedule:ip-2', { week: { '3': { off: true, closed: [] } }, dates: {} });
  set('instructor_busy:ip-1', { blocks: [{ start_at: at('16:00'), end_at: at('17:00') }] });
  set(`booking_sheet:${D}`, { cells: { 'ip-2|12': { t: 'BAND', by: 'oper', at: at('08:30') }, 'ip-1|11': { t: '907654321 /A', b: 'b2', by: 'boss', at: at('08:10') }, 'ip-1|12': { t: '907654321 /A', b: 'b2', by: 'boss', at: at('08:10') } } });
  const bk = (id: string, ins: string, c: string, s: string, e: string, status: string, extra: any = {}, d = D) =>
    h.db.bookings.push({ id, instructor_id: ins, customer_id: c, start_at: at(s, d), end_at: at(e, d), booking_date: at(s, d), status, pickup_code: `AVD-${id}`, source: 'app', category: 'B', ...extra });
  bk('b1', 'ip-1', 'c1', '10:00', '11:00', 'in_progress');
  bk('b2', 'ip-1', 'c2', '11:00', '13:00', 'confirmed', { category: 'A', source: 'admin' });
  bk('b3', 'ip-1', 'c3', '09:00', '10:00', 'no_show');
  bk('b4', 'ip-1', 'c3', '15:00', '16:00', 'cancelled');
  bk('b5', 'ip-2', 'c1', '09:00', '10:00', 'confirmed', {}, D2);
  h.db.payments.push({ id: 'p1', booking_id: 'b1', customer_id: 'c1', amount: 250000, status: 'paid' });
  h.db.courses.push({ id: 'c-b', name: 'B', category: 'B', price: 250000, duration_minutes: 60, is_active: true });
  h.db.courses.push({ id: 'c-a', name: 'A', category: 'A', price: 350000, duration_minutes: 60, is_active: true });
  admin = (await h.login('boss', 'parol1234')).cookie;
  operator = (await h.login('oper', 'parol1234')).cookie;
});

describe('Havola', () => {
  it('faqat admin oladi; bir xil havola qaytadi; yangilansa eskisi yopiladi', async () => {
    expect((await h.call('GET', '/api/admin/control-link', { cookie: operator })).status).toBe(403);
    expect((await h.call('GET', '/api/admin/control-link')).status).toBe(401);
    const a = await token();
    expect(a.url).toMatch(/^https:\/\/avtodrom\.vercel\.app\/nazorat\?k=[\w-]{24}$/);
    expect((await token()).k).toBe(a.k);
    expect((await view(a.k)).status).toBe(200);

    expect((await h.call('POST', '/api/admin/control-link', { cookie: operator, payload: { reset: true } })).status).toBe(403);
    const r = await h.call('POST', '/api/admin/control-link', { cookie: admin, payload: { reset: true } });
    expect(r.status).toBe(200);
    const k2 = new URL(r.body.url).searchParams.get('k') || '';
    expect(k2).not.toBe(a.k);
    expect((await view(a.k)).status).toBe(403);
    expect((await view(k2)).status).toBe(200);
    expect(h.db.admin_audit_logs.some((x) => x.action === 'CONTROL_LINK_RESET')).toBe(true);
  });

  it('kalitsiz, noto‘g‘ri yoki havola yaratilmagan — 403', async () => {
    expect((await view('')).status).toBe(403);
    expect((await view('x'.repeat(24))).status).toBe(403);
    const { k } = await token();
    expect((await view(k.slice(0, -1) + (k.endsWith('A') ? 'B' : 'A'))).status).toBe(403);
    expect((await view(k, '2020-01-01')).status).toBe(400);
  });

  it('kalit sozlamalar ro‘yxatida ko‘rinmaydi', async () => {
    await token();
    const s = await h.call('GET', '/api/admin/settings', { cookie: admin });
    expect(s.status).toBe(200);
    expect(s.body.settings.some((x: any) => x.key === 'control_link')).toBe(false);
  });
});

describe('Ma’lumot', () => {
  it('bugun: ish vaqti, bronlar, hozirgi holat, statistika', async () => {
    const { k } = await token();
    const r = await view(k);
    expect(r.status).toBe(200);
    const d = r.body;
    expect(d.date).toBe(D);
    expect(d.today).toBe(D);
    expect(d.instructors.map((i: any) => i.id)).toEqual(['ip-1', 'ip-2']);   // faol emas, broni yo'q — yo'q

    const a = d.instructors[0];
    expect(a.categories).toEqual(['A', 'B']);
    expect(a.car).toBe('Cobalt · 01A001AA');
    expect(a.day.open).toEqual([['08:00', '13:00'], ['14:00', '16:00'], ['17:00', '19:00']]);
    expect(a.day.closed).toEqual([['07:00', '08:00'], ['13:00', '14:00']]);
    expect(a.day.own).toEqual([['16:00', '17:00']]);
    expect(a.bookings.map((b: any) => [b.code, b.status, b.min])).toEqual([
      ['AVD-b3', 'no_show', 60], ['AVD-b1', 'in_progress', 60], ['AVD-b2', 'confirmed', 120]]);
    expect(a.bookings[1]).toMatchObject({ name: 'Ali Valiyev', phone: '+998901234567', paid: true, cat: 'B' });
    expect(a.bookings[2]).toMatchObject({ cat: 'A', src: 'admin', sheet: true, paid: false });
    expect(a.bookings[1].sheet).toBe(false);
    expect(a.bookings[1].who).toMatchObject({ kind: 'app', by: null });
    expect(a.bookings[2]).toMatchObject({ t: '907654321 /A', who: { kind: 'sheet', by: 'boss', at: at('08:10') } });
    expect(d.hours[0]).toBe(6);
    expect(d.hours.at(-1)).toBe(21);
    expect(a.notes).toEqual([]);                                    // bronli Excel katagi «BAND» emas
    expect(a.stats).toMatchObject({ bron: 3, booked_min: 240, work_min: 540, load: 44, no_show: 1, cancelled: 1, paid: 1 });
    expect(a.now.state).toBe('lesson');
    expect(a.now.booking.code).toBe('AVD-b1');
    expect(a.now.next.code).toBe('AVD-b2');

    const b = d.instructors[1];
    expect(b.day.off).toBe(true);
    expect(b.now.state).toBe('off');
    expect(b.notes).toEqual([{ h: 12, t: 'BAND', by: 'oper', at: at('08:30') }]);
    expect(b.stats.work_min).toBe(0);

    expect(d.stats).toMatchObject({ instructors: 2, working: 1, bron: 3, no_show: 1, cancelled: 1, lesson_now: 1, load: 44 });
  });

  it('hafta: Du–Yak, har kun ish vaqti va bronlar; ertangi kun tanlansa holat yo‘q', async () => {
    const { k } = await token();
    const r = await view(k, D2);
    expect(r.status).toBe(200);
    const d = r.body;
    expect(d.week.from).toBe('2026-10-12');
    expect(d.week.days).toHaveLength(7);
    expect(d.week.days[6]).toBe('2026-10-18');
    const b = d.instructors.find((i: any) => i.id === 'ip-2');
    expect(b.now).toBeNull();
    expect(b.bookings.map((x: any) => x.code)).toEqual(['AVD-b5']);
    expect(b.week[2]).toMatchObject({ date: D, off: true, bron: 0 });
    expect(b.week[3]).toMatchObject({ date: D2, off: false, bron: 1, booked_min: 60, work_min: 720 });
    const a = d.instructors.find((i: any) => i.id === 'ip-1');
    expect(a.week[2]).toMatchObject({ bron: 3, no_show: 1, cancelled: 1, work_min: 540 });
    expect(a.week[3]).toMatchObject({ off: false, work_min: 720, bron: 0 });
    expect(d.week.totals[2]).toMatchObject({ date: D, bron: 3, no_show: 1, cancelled: 1, working: 1 });
    expect(d.week.totals[3]).toMatchObject({ date: D2, bron: 1, working: 2 });
  });

  it('holatlar: tanaffus, o‘zi yopgan, ishdan oldin / keyin, bo‘sh', async () => {
    const { k } = await token();
    const st = async (hm: string) => { vi.setSystemTime(new Date(at(hm))); return (await view(k)).body.instructors[0].now; };
    expect(await st('11:15')).toMatchObject({ state: 'lesson', over: 15 });      // dars vaqtidan oshdi (hali yopilmagan)
    h.db.bookings.find((b) => b.id === 'b1').status = 'completed';
    expect(await st('07:30')).toMatchObject({ state: 'before', at: '08:00' });
    expect(await st('13:20')).toMatchObject({ state: 'break', until: '14:00' });
    expect(await st('14:30')).toMatchObject({ state: 'free' });
    expect(await st('16:10')).toMatchObject({ state: 'own', until: '17:00' });
    expect(await st('19:30')).toMatchObject({ state: 'done' });
    expect((await st('11:30')).state).toBe('due');                 // dars vaqti, hali boshlanmagan
  });

  it('openRanges: ish vaqtidan yopiqlar ayriladi', () => {
    expect(openRanges(420, 1140, [[420, 480], [780, 840]])).toEqual([[480, 780], [840, 1140]]);
    expect(openRanges(420, 1140, [[0, 1440]])).toEqual([]);
    expect(openRanges(420, 1140, [])).toEqual([[420, 1140]]);
  });

  it('kim yozgan: qo‘lda bron — operator logini, kassa — kassa kodi', async () => {
    const { k } = await token();
    const mb = await h.call('POST', '/api/admin/manual-booking', { cookie: operator, payload: {
      full_name: 'Yangi Mijoz', phone: '+998935550000', instructor_id: 'ip-2', category: 'B', duration_minutes: 60, start_at: at('17:00', D2) } });
    expect(mb.status).toBe(201);
    const log = h.db.admin_audit_logs.find((x) => x.action === 'MANUAL_BOOKING_CREATED');
    expect(log.new_data.by).toBe('oper');
    /* bazada bron id — UUID, audit entity_id ga yoziladi (sinov bazasida id UUID emas) */
    log.entity_id = log.entity_id || log.new_data.entity_key;
    h.db.cash_registers.push({ id: 'reg-p2', code: 'P2', name: '2-kassa', is_active: true });
    h.db.bookings.push({ id: 'b9', instructor_id: 'ip-2', customer_id: 'c2', start_at: at('15:00', D2), end_at: at('16:00', D2), booking_date: at('15:00', D2), status: 'in_progress', source: 'walk_in', category: 'B' });
    h.db.payments.push({ id: 'p9', booking_id: 'b9', customer_id: 'c2', amount: 250000, status: 'paid', register_id: 'reg-p2' });
    const r = await view(k, D2);
    const b = r.body.instructors.find((i: any) => i.id === 'ip-2');
    expect(b.bookings.find((x: any) => x.start === at('17:00', D2)).who).toMatchObject({ kind: 'manual', by: 'oper' });
    expect(b.bookings.find((x: any) => x.id === 'b9').who).toMatchObject({ kind: 'kassa', by: 'P2' });
  });
});

describe('🔍 Bronni qidirish', () => {
  const find = (k: string, q: string) => h.call('GET', `/api/control-search?k=${encodeURIComponent(k)}&q=${encodeURIComponent(q)}`);
  it('telefon oxiri: kimga (instruktor), qachon, kim yozgan; kalitsiz — 403', async () => {
    const { k } = await token();
    expect((await find('', '4567')).status).toBe(403);
    const r = await find(k, '4567');
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: any) => [x.code, x.date, x.ins?.name])).toEqual([['AVD-b1', D, 'Aziz Karimov'], ['AVD-b5', D2, 'Komila Sobirova']]);
    expect(r.body.results[0]).toMatchObject({ name: 'Ali Valiyev', phone: '+998901234567', status: 'in_progress', paid: true, who: { kind: 'app' } });
    const s2 = await find(k, '54321');
    expect(s2.body.results[0]).toMatchObject({ code: 'AVD-b2', cat: 'A', sheet: true, t: '907654321 /A', who: { kind: 'sheet', by: 'boss' } });
  });
  it('bron kodi, ism; bekor qilingan — oxirida; qisqa so‘rov — maslahat', async () => {
    const { k } = await token();
    h.db.bookings.push({ id: 'b7', instructor_id: 'ip-2', customer_id: 'c3', start_at: at('16:00', D2), end_at: at('17:00', D2), booking_date: at('16:00', D2), status: 'pending', pickup_code: 'AVD-4821', source: 'app', category: 'B' });
    expect((await find(k, 'AVD-4821')).body.results.map((x: any) => x.code)).toEqual(['AVD-4821']);
    expect((await find(k, '4821')).body.results.map((x: any) => x.code)).toEqual(['AVD-4821']);
    const r = await find(k, '1122');
    expect(r.body.results.map((x: any) => x.code).sort()).toEqual(['AVD-4821', 'AVD-b3', 'AVD-b4']);
    expect(r.body.results.map((x: any) => x.code)).toEqual(['AVD-b3', 'AVD-4821', 'AVD-b4']);   // yaqin/kelgusi — tartib bilan, bekor — oxirida
    expect(r.body.results.at(-1).status).toBe('cancelled');
    expect((await find(k, 'soli')).body.results.length).toBe(3);
    const short = await find(k, '45');
    expect(short.body.results).toEqual([]);
    expect(short.body.hint).toMatch(/3 ta raqam/);
    expect((await find(k, '000000')).body.results).toEqual([]);
  });
});

describe('＋ Nazoratdan bron qilish', () => {
  const book = (payload: any) => h.call('POST', '/api/control-book', { payload });
  it('Excel bron katagiga yoziladi: bron, kim yozgan — «Nazorat paneli»', async () => {
    const { k } = await token();
    expect((await book({ date: D2, ins: 'ip-1', h: 14, phone: '937778899' })).status).toBe(403);
    const r = await book({ k, date: D2, ins: 'ip-1', h: 14, n: 2, phone: '93 777 88 99', name: 'Bobur Karimov', cat: 'A' });
    expect(r.status).toBe(200);
    expect(r.body.booking).toMatchObject({ start: at('14:00', D2), minutes: 120, category: 'A', ins: { id: 'ip-1', name: 'Aziz Karimov' } });
    expect(r.body.booking.code).toMatch(/^AVD-/);
    const b = h.db.bookings.find((x) => x.start_at === at('14:00', D2) && x.instructor_id === 'ip-1');
    expect(b).toMatchObject({ end_at: at('16:00', D2), status: 'confirmed', category: 'A' });
    const sheet = h.db.admin_settings.find((x) => x.key === `booking_sheet:${D2}`);
    const cells = sheet.value.cells || sheet.value.value?.cells;
    expect(cells['ip-1|14']).toMatchObject({ t: '937778899/A Bobur Karimov', by: 'Nazorat paneli' });
    expect(cells['ip-1|15'].t).toBe('937778899/A Bobur Karimov');
    const v = await view(k, D2);
    const bk = v.body.instructors.find((i: any) => i.id === 'ip-1').bookings.find((x: any) => x.start === at('14:00', D2));
    expect(bk).toMatchObject({ name: 'Bobur Karimov', phone: '+998937778899', min: 120, who: { kind: 'sheet', by: 'Nazorat paneli' } });
  });
  it('30 daqiqa; band, boshlangan soat, toifa, noto‘g‘ri raqam — rad etiladi', async () => {
    const { k } = await token();
    const half = await book({ k, date: D2, ins: 'ip-2', h: 12, half: true, phone: '+998 90 555 44 33' });
    expect(half.status).toBe(200);
    expect(half.body.booking.minutes).toBe(30);
    const busy = await book({ k, date: D2, ins: 'ip-2', h: 9, phone: '905554433' });
    expect(busy.status).toBe(409);
    expect(busy.body.error).toMatch(/boshqa bron/);
    const again = await book({ k, date: D2, ins: 'ip-2', h: 12, phone: '901112233' });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/band/);
    const started = await book({ k, date: D, ins: 'ip-1', h: 10, phone: '901112233' });
    expect(started.status).toBe(400);
    expect(started.body.error).toMatch(/boshlanib ketgan/);
    expect((await book({ k, date: D2, ins: 'ip-2', h: 15, cat: 'A', phone: '901112233' })).body.error).toMatch(/A toifani o‘rgatmaydi/);
    expect((await book({ k, date: D2, ins: 'ip-2', h: 15, phone: '12345' })).body.error).toMatch(/Telefon/);
    expect((await book({ k, date: '2020-01-01', ins: 'ip-2', h: 15, phone: '901112233' })).status).toBe(400);
    expect((await book({ k, date: D2, ins: 'nope', h: 15, phone: '901112233' })).status).toBe(404);
  });
  it('🚗 avtomat mashina bitta: bir vaqtga ikki instruktor yozolmaydi; kunlik bandlik ko‘rinadi', async () => {
    const { k } = await token();
    const a = await book({ k, date: D2, ins: 'ip-1', h: 15, auto: true, phone: '931112233' });
    expect(a.status).toBe(200);
    expect(a.body.booking.auto).toBe(true);
    const sheet = h.db.admin_settings.find((x) => x.key === `booking_sheet:${D2}`);
    expect((sheet.value.cells || sheet.value.value?.cells)['ip-1|15'].t).toBe('931112233 AVTOMAT');
    const b = await book({ k, date: D2, ins: 'ip-2', h: 15, auto: true, phone: '931112244' });
    expect(b.status).toBe(409);
    expect(b.body.error).toMatch(/Avtomat mashina 15:00–16:00 da band \(Aziz Karimov\)/);
    expect((await book({ k, date: D2, ins: 'ip-2', h: 15, phone: '931112244' })).status).toBe(200);     // mexanika — mumkin
    expect((await book({ k, date: D2, ins: 'ip-2', h: 16, auto: true, phone: '931112255' })).status).toBe(200);
    const v = await view(k, D2);
    expect(v.body.auto.map((x: any) => [x.start, x.end, x.name])).toEqual([[at('15:00', D2), at('16:00', D2), 'Aziz Karimov'], [at('16:00', D2), at('17:00', D2), 'Komila Sobirova']]);
    const bk = v.body.instructors.find((i: any) => i.id === 'ip-1').bookings.find((x: any) => x.start === at('15:00', D2));
    expect(bk.auto).toBe(true);
    /* 2 soatlik bron, belgi faqat ikkinchi katakda — baribir avtomat deb ko'rinadi */
    const put = (changes: any[]) => h.call('PUT', '/api/admin/booking-sheet', { cookie: admin, payload: { date: D2, changes } });
    await put([{ key: 'ip-1|17', t: '931112266', prev: '' }, { key: 'ip-1|18', t: '931112266 avtomat', prev: '' }]);
    const v2 = await view(k, D2);
    expect(v2.body.auto.some((x: any) => x.start === at('18:00', D2))).toBe(true);
  });
});

