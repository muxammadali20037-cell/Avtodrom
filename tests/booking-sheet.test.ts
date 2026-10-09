/**
 * EXCEL BRON — adminlar Excel'dagidek yozadi: ustun — instruktor, qator — soat.
 * Katakda telefon raqam bo'lsa haqiqiy bron yaratiladi, raqamsiz yozuv
 * («BAND», ism) — shu soat band. Ikkalasida ham Mini App, operator va kassa
 * u vaqtga bron qila olmaydi.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import { parsePhone, parseCategory, parseHalf, nameFrom, buildRuns, cellKey } from '../backend/src/booking-sheet.js';

let h: Harness;
let admin = '', kassa = '', operator = '';
const CUST_TG = 777088, INS_TG = 880088;
const TZ = 'Asia/Tashkent';
const ymd = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + n * 864e5));
const day = ymd(2);
const at = (hm: string, d = day) => new Date(`${d}T${hm}:00+05:00`).toISOString();
const K = (ins: string, hh: number) => cellKey(ins, hh);

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

const get = (cookie = admin, d = day) => h.call('GET', `/api/admin/booking-sheet?date=${d}`, { cookie });
/** Kataklarni yozib saqlaydi. prev — sahifada ko'ringan eski matn (bo'lmasa serverdagi). */
async function save(cells: Record<string, string>, cookie = admin, d = day) {
  const cur = (await get(admin, d)).body.cells || {};
  const changes = Object.entries(cells).map(([key, t]) => ({ key, t, prev: cur[key]?.t || '' }));
  return h.call('PUT', '/api/admin/booking-sheet', { cookie, payload: { date: d, changes } });
}
const active = () => h.db.bookings.filter((b: any) => ['pending', 'confirmed', 'in_progress'].includes(b.status));

beforeAll(async () => { h = await makeHarness(); });
beforeEach(async () => {
  h.reset();
  h.db.cash_registers.push({ id: 'reg-p1', code: 'P1', name: '1-kassa', pin_hash: null });
  h.db.staff.push({ id: 'st-admin', login: 'boss', password_hash: hashPassword('admin1234'), role: 'admin', register_id: null, is_active: true });
  h.db.staff.push({ id: 'st-k1', login: 'kassa1', password_hash: hashPassword('parol1234'), role: 'cashier', register_id: 'reg-p1', full_name: 'Kassa', is_active: true });
  h.db.staff.push({ id: 'st-op', login: 'oper', password_hash: hashPassword('parol1234'), role: 'operator', register_id: null, full_name: 'Operator', is_active: true });
  h.db.users.push({ id: 'u-admin', full_name: 'Admin', role: 'admin', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-instr', full_name: 'Aziz Karimov', phone: '+998901114455', telegram_id: INS_TG, role: 'instructor', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-ins2', full_name: 'Komila Sobirova', phone: '+998901114466', role: 'instructor', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-cust', telegram_id: CUST_TG, full_name: 'Ali Mijoz', phone: '+998901119999', role: 'customer', is_active: true, is_blocked: false });
  h.db.instructor_profiles.push({ id: 'ip-1', user_id: 'u-instr', is_verified: true, is_available: true, categories: ['B'], rating: 4.9 });
  h.db.instructor_profiles.push({ id: 'ip-2', user_id: 'u-ins2', is_verified: true, is_available: true, categories: ['B', 'C'], rating: 4.5 });
  h.db.courses.push({ id: 'c-b', name: 'B kategoriya', category: 'B', price: 250000, duration_minutes: 60, is_active: true });
  h.db.courses.push({ id: 'c-c', name: 'C kategoriya', category: 'C', price: 300000, duration_minutes: 60, is_active: true });
  admin = (await h.login('boss', 'admin1234')).cookie;
  kassa = (await h.login('kassa1', 'parol1234')).cookie;
  operator = (await h.login('oper', 'parol1234')).cookie;
});

describe('Excel bron — matnni o‘qish', () => {
  it('Exceldagi har xil yozilgan raqamlarni taniydi', () => {
    expect(parsePhone('994188549')).toBe('+998994188549');
    expect(parsePhone('99-313-56-26')).toBe('+998993135626');
    expect(parsePhone('50 150 05 08')).toBe('+998501500508');
    expect(parsePhone('947372906/C')).toBe('+998947372906');
    expect(parsePhone('977737646/30 MIN')).toBe('+998977737646');
    expect(parsePhone('953905171 3/10')).toBe('+998953905171');
    expect(parsePhone('946644952/автомат')).toBe('+998946644952');
    expect(parsePhone('+998 90 123 45 67')).toBe('+998901234567');
    expect(parsePhone('998651363')).toBe('+998998651363');
    expect(parsePhone('Мансур')).toBeNull();
    expect(parsePhone('BAND')).toBeNull();
    expect(parsePhone('Дурдона/П')).toBeNull();
    expect(parsePhone('3/10')).toBeNull();
  });
  it('toifa, yarim soat va ism', () => {
    expect(parseCategory('947372906/C')).toBe('C');
    expect(parseCategory('947372906/С')).toBe('C');           // kirill С
    expect(parseCategory('BAND')).toBeNull();
    expect(parseCategory('Дурдона/П')).toBeNull();
    expect(parseHalf('977737646/30 MIN')).toBe(true);
    expect(parseHalf('953905171 3/10')).toBe(false);
    expect(nameFrom('Дурдона 901234567')).toBe('Дурдона');
    expect(nameFrom('901234567 band')).toBeNull();
  });
  it('tugmalar yozadigan matn: «/C/30 MIN» — toifa ham, yarim soat ham, raqam ham o‘qiladi', () => {
    for (const t of ['901112233/C/30 MIN', 'Dilshod 901112233/C/30 MIN']) {
      expect(parsePhone(t)).toBe('+998901112233');
      expect(parseCategory(t)).toBe('C');
      expect(parseHalf(t)).toBe(true);
    }
    expect(parseCategory('901112233/30 MIN')).toBeNull();     // toifa yozilmasa — instruktorniki
    expect(nameFrom('Dilshod 901112233/C/30 MIN')).toBe('Dilshod');
  });
  it('ketma-ket soatlarda bir xil raqam — bitta bron', () => {
    const c = (h: number, phone: string, half = false) => ({ h, key: K('ip-1', h), phone, cat: null, half, text: phone });
    const runs = buildRuns([c(11, '+998932417301'), c(12, '+998932417301'), c(14, '+998932417301'), c(15, '+998977737646', true)]);
    expect(runs.map((r) => [r.h0, r.n, r.minutes])).toEqual([[11, 2, 120], [14, 1, 60], [15, 1, 30]]);
  });
});

describe('Excel bron — kim nima qila oladi', () => {
  it('admin va operator yozadi, kassa faqat ko‘radi', async () => {
    const g = await get(kassa);
    expect(g.status).toBe(200);
    expect(g.body.can_edit).toBe(false);
    expect(g.body.instructors.map((i: any) => i.name)).toEqual(['Aziz Karimov', 'Komila Sobirova']);
    expect(g.body.hours[0]).toBe(6);
    expect(g.body.hours[g.body.hours.length - 1]).toBe(21);
    expect((await get(operator)).body.can_edit).toBe(true);
    expect((await save({ [K('ip-1', 10)]: 'BAND' }, kassa)).status).toBe(403);
    expect((await save({ [K('ip-1', 10)]: 'BAND' }, operator)).status).toBe(200);
    expect((await h.call('GET', `/api/admin/booking-sheet?date=${day}`)).status).toBe(401);
  });
  it('o‘tgan kunga yozib bo‘lmaydi', async () => {
    const r = await h.call('PUT', '/api/admin/booking-sheet', { cookie: admin, payload: { date: ymd(-1), changes: [{ key: K('ip-1', 10), t: 'BAND', prev: '' }] } });
    expect(r.status).toBe(400);
    expect((await get(admin, ymd(-1))).body.can_edit).toBe(false);
  });
});

describe('Excel bron — bron va band vaqt', () => {
  it('raqam yozilsa tasdiqlangan bron yaratiladi (kod bilan), mijoz yangi bo‘lsa — yoziladi', async () => {
    const r = await save({ [K('ip-1', 10)]: 'Дурдона 994188549' });
    expect(r.status).toBe(200);
    expect(r.body.result.errors).toEqual([]);
    expect(r.body.result.created).toHaveLength(1);
    const b = active()[0];
    expect(b).toMatchObject({ instructor_id: 'ip-1', status: 'confirmed', source: 'admin', category: 'B', duration_minutes: 60, start_at: at('10:00'), end_at: at('11:00') });
    expect(b.pickup_code).toMatch(/^AVD-\d{4,5}$/);
    expect(b.customer_note).toBe('Excel bron: Дурдона 994188549');
    const u = h.db.users.find((x: any) => x.id === b.customer_id);
    expect(u).toMatchObject({ phone: '+998994188549', full_name: 'Дурдона', role: 'customer' });
    const cell = r.body.cells[K('ip-1', 10)];
    expect(cell.k).toBe('sheet');
    expect(cell.bk).toMatchObject({ code: b.pickup_code, phone: '+998994188549', status: 'confirmed' });
    /* Mini App'da shu vaqt band, boshqa instruktor bo'sh */
    const av = await cust('GET', `/api/instructors/ip-1/availability?date=${day}`);
    expect(av.body.busy.some((x: any) => x.start_at === at('10:00'))).toBe(true);
    expect((await cust('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', hours: 1, start_at: at('10:00') })).status).toBe(409);
    /* Kassa bronni raqam bo'yicha topadi */
    const f = await h.call('GET', `/api/admin/cashier/find?q=${encodeURIComponent('4188549')}`, { cookie: kassa });
    expect(f.body.bookings.map((x: any) => x.pickup_code)).toEqual([b.pickup_code]);
    const c = await h.call('GET', `/api/admin/cashier/find?q=${encodeURIComponent(b.pickup_code)}`, { cookie: kassa });
    expect(c.body.bookings.map((x: any) => x.id)).toEqual([b.id]);
  });

  it('bor mijoz raqami — o‘sha mijozga bron (yangi mijoz yozilmaydi)', async () => {
    const n = h.db.users.length;
    const r = await save({ [K('ip-1', 9)]: '90 111 99 99' });
    expect(r.body.result.created[0].name).toBe('Ali Mijoz');
    expect(h.db.users.length).toBe(n);
    expect(active()[0].customer_id).toBe('u-cust');
  });

  it('raqamsiz yozuv («BAND», ism) — bron emas, lekin vaqt band', async () => {
    const r = await save({ [K('ip-1', 12)]: 'BAND', [K('ip-1', 13)]: 'Мансур' });
    expect(r.body.result.created).toEqual([]);
    expect(active()).toHaveLength(0);
    expect(r.body.cells[K('ip-1', 12)]).toMatchObject({ k: 'note', t: 'BAND' });
    const av = await cust('GET', `/api/instructors/ip-1/availability?date=${day}`);
    expect(av.body.busy).toEqual([{ start_at: at('12:00'), end_at: at('13:00') }, { start_at: at('13:00'), end_at: at('14:00') }]);
    expect((await cust('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', hours: 1, start_at: at('12:00') })).status).toBe(409);
    const mb = await h.call('POST', '/api/admin/manual-booking', { cookie: operator, payload: {
      full_name: 'Vali', phone: '+998901112233', instructor_id: 'ip-1', category: 'B', duration_minutes: 60, start_at: at('13:00') } });
    expect(mb.status).toBe(409);
    expect(mb.body.error).toMatch(/band/);
    const fr = await h.call('GET', `/api/admin/cashier/free-instructors?at=${encodeURIComponent(at('12:00'))}&minutes=60&category=B`, { cookie: kassa });
    expect(fr.body.free.map((x: any) => x.id)).toEqual(['ip-2']);
    /* Jadvalda va instruktor panelida ham ko'rinadi */
    const sch = await h.call('GET', `/api/admin/schedule?date=${day}`, { cookie: kassa });
    expect(sch.body.blocks.filter((x: any) => x.sheet).map((x: any) => x.text)).toEqual(['BAND', 'Мансур']);
    const ib = await ins('GET', `/api/instructor/blocks?from=${day}&to=${day}`);
    expect(ib.body.sheet.map((x: any) => x.text)).toEqual(['BAND', 'Мансур']);
  });

  it('ketma-ket ikki soatga bir xil raqam — bitta 2 soatlik bron', async () => {
    const r = await save({ [K('ip-1', 11)]: '932417301', [K('ip-1', 12)]: '932417301' });
    expect(r.body.result.created).toHaveLength(1);
    expect(active()[0]).toMatchObject({ start_at: at('11:00'), end_at: at('13:00'), duration_minutes: 120, hours: 2 });
    expect(r.body.cells[K('ip-1', 11)].bk.id).toBe(r.body.cells[K('ip-1', 12)].bk.id);
  });

  it('katak o‘chirilsa bron bekor qilinadi va vaqt bo‘shaydi', async () => {
    await save({ [K('ip-1', 10)]: '994188549' });
    const r = await save({ [K('ip-1', 10)]: '' });
    expect(r.body.result.cancelled).toBe(1);
    expect(active()).toHaveLength(0);
    expect(h.db.bookings[0]).toMatchObject({ status: 'cancelled', cancellation_reason: 'Excel bron: katak o‘zgartirildi' });
    expect(r.body.cells[K('ip-1', 10)]).toBeUndefined();
    expect((await cust('GET', `/api/instructors/ip-1/availability?date=${day}`)).body.busy).toEqual([]);
  });

  it('raqam almashtirilsa — eski bron bekor, yangisi yaratiladi', async () => {
    await save({ [K('ip-1', 10)]: '994188549' });
    const r = await save({ [K('ip-1', 10)]: '947494944' });
    expect(r.body.result.cancelled).toBe(1);
    expect(r.body.result.created).toHaveLength(1);
    expect(active()).toHaveLength(1);
    expect(h.db.users.find((u: any) => u.id === active()[0].customer_id).phone).toBe('+998947494944');
  });

  it('faqat ism qo‘shilsa (raqam o‘sha) — bron o‘zgarmaydi', async () => {
    await save({ [K('ip-1', 10)]: '994188549' });
    const id = active()[0].id;
    const r = await save({ [K('ip-1', 10)]: '994188549 Аброр' });
    expect(r.body.result).toMatchObject({ cancelled: 0, created: [] });
    expect(active().map((b: any) => b.id)).toEqual([id]);
    expect(r.body.cells[K('ip-1', 10)].bk.id).toBe(id);
  });

  it('bronga yana bir soat qo‘shilsa — bitta 2 soatlik bronga aylanadi; bir soati o‘chirilsa — 1 soatlik qoladi', async () => {
    await save({ [K('ip-1', 10)]: '994188549' });
    let r = await save({ [K('ip-1', 11)]: '994188549' });
    expect(r.body.result.cancelled).toBe(1);
    expect(active()).toHaveLength(1);
    expect(active()[0]).toMatchObject({ start_at: at('10:00'), end_at: at('12:00') });
    r = await save({ [K('ip-1', 11)]: '' });
    expect(active()).toHaveLength(1);
    expect(active()[0]).toMatchObject({ start_at: at('10:00'), end_at: at('11:00') });
    expect(r.body.cells[K('ip-1', 10)].k).toBe('sheet');
  });

  it('«30 MIN» — 30 daqiqalik bron, soatning qolgan yarmi ham band', async () => {
    await save({ [K('ip-1', 12)]: '977737646/30 MIN' });
    expect(active()[0]).toMatchObject({ duration_minutes: 30, start_at: at('12:00'), end_at: at('12:30') });
    const av = await cust('GET', `/api/instructors/ip-1/availability?date=${day}`);
    expect(av.body.busy.map((x: any) => [x.start_at, x.end_at])).toEqual(expect.arrayContaining([[at('12:30'), at('13:00')]]));
  });

  it('«/C» — C toifa; instruktor C o‘rgatmasa xato, vaqt baribir band', async () => {
    let r = await save({ [K('ip-2', 10)]: '947372906/C' });
    expect(active()[0]).toMatchObject({ category: 'C', course_id: 'c-c', instructor_id: 'ip-2' });
    r = await save({ [K('ip-1', 10)]: '947372907/C' });
    expect(r.body.result.created).toEqual([]);
    expect(r.body.result.errors[0].error).toMatch(/C toifani o‘rgatmaydi/);
    expect(r.body.cells[K('ip-1', 10)]).toMatchObject({ k: 'note', e: expect.stringMatching(/C toifani/) });
    expect((await cust('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', hours: 1, start_at: at('10:00') })).status).toBe(409);
  });

  it('bitta mijoz bir vaqtda ikki instruktorda bo‘la olmaydi', async () => {
    const r = await save({ [K('ip-1', 10)]: '994188549', [K('ip-2', 10)]: '994188549' });
    expect(r.body.result.created).toHaveLength(1);
    expect(r.body.result.errors[0].error).toMatch(/boshqa bron bor/);
  });

  it('Mini App broni bor katak — qulf; to‘langan bron katagi — qulf', async () => {
    const mini = await cust('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', hours: 1, start_at: at('15:00') });
    expect(mini.status).toBe(201);
    let g = await get();
    expect(g.body.cells[K('ip-1', 15)]).toMatchObject({ k: 'bk', lock: 'bk' });
    expect(g.body.cells[K('ip-1', 15)].bk.name).toBe('Ali Mijoz');
    let r = await save({ [K('ip-1', 15)]: 'BAND' });
    expect(r.body.result.errors[0].error).toMatch(/boshqa bron bor/);
    expect(r.body.result.saved).toBe(0);

    await save({ [K('ip-1', 10)]: '994188549' });
    h.db.payments.push({ id: 'pay-1', booking_id: active().find((b: any) => b.start_at === at('10:00')).id, status: 'paid', amount: 250000 });
    g = await get();
    expect(g.body.cells[K('ip-1', 10)].lock).toBe('paid');
    r = await save({ [K('ip-1', 10)]: '' });
    expect(r.body.result.errors[0].error).toMatch(/to‘langan/);
    expect(active()).toHaveLength(2);
  });

  it('boshqa xodim o‘zgartirib ulgurgan katak yozilmaydi', async () => {
    await save({ [K('ip-1', 10)]: 'BAND' });
    const r = await h.call('PUT', '/api/admin/booking-sheet', { cookie: operator, payload: { date: day, changes: [{ key: K('ip-1', 10), t: 'Мансур', prev: '' }] } });
    expect(r.body.result.errors[0].error).toMatch(/boshqa xodim/);
    expect(r.body.cells[K('ip-1', 10)].t).toBe('BAND');
  });

  it('ish grafigi bo‘yicha dam soat — qulf', async () => {
    const wd = String(new Date(`${day}T12:00:00+05:00`).getUTCDay());
    h.db.admin_settings.push({ key: 'instructor_schedule:ip-1', value: { week: { [wd]: { off: false, closed: [['13:00', '14:00']] } }, dates: {} } });
    const g = await get();
    expect(g.body.cells[K('ip-1', 13)]).toMatchObject({ k: 'off', lock: 'off' });
    const r = await save({ [K('ip-1', 13)]: '994188549' });
    expect(r.body.result.errors[0].error).toMatch(/ishlamaydi/);
    expect(active()).toHaveLength(0);
  });

  it('Sozlamalar ro‘yxatida Excel bron yozuvlari ko‘rinmaydi', async () => {
    await save({ [K('ip-1', 10)]: 'BAND' });
    const st = await h.call('GET', '/api/admin/settings', { cookie: admin });
    expect(JSON.stringify(st.body)).not.toContain('booking_sheet');
  });
});
