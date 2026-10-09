/**
 * CHEK — HISOBNING YAGONA MANBASI
 *  · chekni istalgan instruktor uradi; bron boshqasiga yozilgan bo'lsa — urganga o'tadi;
 *  · «KELDI» (cheksiz boshlash) yo'q;
 *  · chekdagi vaqt o'tsa dars o'zi yopiladi;
 *  · admin, kassa va instruktor hisobotlari — urilgan chek bo'yicha (kuni — urilgan kun).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import { makeRegisterToken } from '../backend/src/shift-routes.js';
import { finishDueLessons, loadLedger } from '../backend/src/lesson-ledger.js';
import { cellKey } from '../backend/src/booking-sheet.js';

let h: Harness;
let admin = '', kassa1 = '';
const TZ = 'Asia/Tashkent';
const ymd = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + n * 864e5));
const A_TG = 880501, B_TG = 880502, C_TG = 880503;

function signedInitData(user: Record<string, unknown>, botToken = '1:instructor') {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAtest', user: JSON.stringify(user) });
  const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dataCheck).digest('hex'));
  return params.toString();
}
const ins = (tg: number) => (method: string, url: string, payload?: any) =>
  h.app.inject({ method, url, payload, headers: { 'x-telegram-init-data': signedInitData({ id: tg, first_name: 'I' }) } })
    .then((r: any) => ({ status: r.statusCode, body: JSON.parse(r.body || '{}') }));
const A = ins(A_TG), B = ins(B_TG), C = ins(C_TG);

let seq = 0;
/** Kassada to'langan bron: chek kodi bilan */
function paidBooking(o: { ins: string | null; startMin?: number; minutes?: number; cat?: string; amount?: number; reg?: string; cust?: string }) {
  seq++;
  const start = new Date(Date.now() + (o.startMin ?? 0) * 60000);
  const minutes = o.minutes ?? 60;
  const id = `bk-${seq}`;
  h.db.bookings.push({
    id, customer_id: o.cust || 'u-cust', instructor_id: o.ins, course_id: 'c-b', status: 'confirmed', source: 'walk_in',
    booking_date: start.toISOString(), start_at: start.toISOString(), end_at: new Date(start.getTime() + minutes * 60000).toISOString(),
    duration_minutes: minutes, category: o.cat ?? 'B', pickup_code: `AVD-${1000 + seq}`, created_at: new Date().toISOString(),
  });
  const code = `AVD-261008-${String(seq).padStart(5, 'Z')}`;
  h.db.payments.push({ id: `pay-${seq}`, booking_id: id, customer_id: o.cust || 'u-cust', amount: o.amount ?? 250000, status: 'paid',
    method: 'cash', cash_amount: o.amount ?? 250000, card_amount: 0, receipt_code: code, register_id: o.reg || 'reg-p1', paid_at: new Date().toISOString() });
  return { id, code };
}
const bk = (id: string) => h.db.bookings.find((b: any) => b.id === id);

beforeAll(async () => {
  h = await makeHarness();
  const base = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async (u: any, o: any) => {
    if (String(u).includes('/rest/v1/rpc/generate_receipt_code')) {
      const code = `AVD-261008-T${String(++n).padStart(4, '0')}`;
      return { ok: true, status: 200, text: async () => JSON.stringify(code), json: async () => code, headers: new Map() } as any;
    }
    return base(u, o);
  }) as any;
});

beforeEach(async () => {
  h.reset();
  h.db.cash_registers.push({ id: 'reg-p1', code: 'P1', name: '1-kassa', is_active: true }, { id: 'reg-p2', code: 'P2', name: '2-kassa', is_active: true });
  const st = (id: string, login: string, role: string, register_id: string | null) =>
    h.db.staff.push({ id, login, password_hash: hashPassword('parol1234'), role, register_id, full_name: login, is_active: true });
  st('st-admin', 'boss', 'admin', null);
  st('st-k1', 'kassa1', 'cashier', 'reg-p1');
  h.db.users.push({ id: 'u-admin', full_name: 'Admin', role: 'admin', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-cust', full_name: 'Ali Mijoz', phone: '+998901119999', role: 'customer', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-cust2', full_name: 'Vali Mijoz', phone: '+998901118888', role: 'customer', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-a', full_name: 'Aziz Karimov', phone: '+998901114455', telegram_id: A_TG, role: 'instructor', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-b', full_name: 'Bobur Aliyev', phone: '+998901114466', telegram_id: B_TG, role: 'instructor', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-c', full_name: 'Sardor C', phone: '+998901114477', telegram_id: C_TG, role: 'instructor', is_active: true, is_blocked: false });
  h.db.instructor_profiles.push({ id: 'ip-a', user_id: 'u-a', is_verified: true, is_available: true, categories: ['B'] });
  h.db.instructor_profiles.push({ id: 'ip-b', user_id: 'u-b', is_verified: true, is_available: true, categories: ['B'] });
  h.db.instructor_profiles.push({ id: 'ip-c', user_id: 'u-c', is_verified: true, is_available: true, categories: ['C'] });
  h.db.courses.push({ id: 'c-b', name: 'B toifa', category: 'B', price: 250000, duration_minutes: 60, is_active: true });
  h.db.admin_settings.push({ key: 'rate_b', value: 250000 });
  admin = (await h.login('boss', 'parol1234')).cookie;
  kassa1 = (await h.login('kassa1', 'parol1234')).cookie;
});

describe('Chekni istalgan instruktor uradi', () => {
  it('bron egasi uradi — dars boshlanadi, chek yoziladi', async () => {
    const { id, code } = paidBooking({ ins: 'ip-a' });
    const v = await A('POST', '/api/instructor/scan', { code });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ can_start: true, transfer_from: null });
    const s = await A('POST', '/api/instructor/scan/start', { code });
    expect(s.status).toBe(200);
    expect(bk(id)).toMatchObject({ status: 'in_progress', instructor_id: 'ip-a' });
    expect(bk(id).arrived_at).toBeTruthy();
    const av = h.db.attendance_verifications;
    expect(av).toHaveLength(1);
    expect(av[0]).toMatchObject({ booking_id: id, customer_id: 'u-cust', telegram_user_id: A_TG, scanned_by: 'u-a', receipt_code: code, method: 'qr' });
    expect(av[0].token_epoch).toBeGreaterThan(0);
    expect(av[0].verification_snapshot).toMatchObject({ instructor_id: 'ip-a', from_instructor_id: null, amount: 250000, minutes: 60 });
  });

  it('boshqa instruktor uradi — bron unga o‘tadi, eski egasiga xabar, Excel katagi ko‘chadi', async () => {
    const { id, code } = paidBooking({ ins: 'ip-a' });
    /* Excel bron soatlari 6–21: bronni ertaga 10:00 ga qo'yamiz */
    const day = ymd(1), hh = 10;
    Object.assign(bk(id), { start_at: `${day}T10:00:00+05:00`, end_at: `${day}T11:00:00+05:00`, booking_date: `${day}T10:00:00+05:00` });
    h.db.admin_settings.push({ key: `booking_sheet:${day}`, value: { cells: { [cellKey('ip-a', hh)]: { t: '901119999', b: id } } } });
    const v = await B('POST', '/api/instructor/scan', { code });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ can_start: true, transfer_from: 'Aziz Karimov' });
    const before = h.telegram.length;
    const s = await B('POST', '/api/instructor/scan/start', { code });
    expect(s.status).toBe(200);
    expect(s.body.transferred_from).toBe('Aziz Karimov');
    expect(bk(id)).toMatchObject({ status: 'in_progress', instructor_id: 'ip-b', instructor_name: 'Bobur Aliyev' });
    expect(h.db.attendance_verifications[0].verification_snapshot).toMatchObject({ instructor_id: 'ip-b', from_instructor_id: 'ip-a' });
    const toA = h.telegram.slice(before).find((m) => m.chat === A_TG);
    expect(toA?.text).toMatch(/Bron boshqa instruktorga o‘tdi[\s\S]*Bobur Aliyev/);
    const cells = h.db.admin_settings.find((r: any) => r.key === `booking_sheet:${day}`).value.cells;
    expect(cells[cellKey('ip-a', hh)]).toBeUndefined();
    expect(cells[cellKey('ip-b', hh)]).toMatchObject({ b: id, t: '901119999' });
    expect(h.db.admin_audit_logs.some((x: any) => x.action === 'BOOKING_TRANSFERRED_BY_SCAN')).toBe(true);
  });

  it('toifa mos kelmasa yoki o‘sha vaqtda o‘z broni bo‘lsa — urolmaydi', async () => {
    const { code } = paidBooking({ ins: 'ip-a' });
    const c = await C('POST', '/api/instructor/scan/start', { code });
    expect(c.status).toBe(409);
    expect(c.body.error).toMatch(/B toifa uchun/);
    paidBooking({ ins: 'ip-b', startMin: 30 });               // B ning o'z broni 30 daqiqadan keyin
    const b = await B('POST', '/api/instructor/scan/start', { code });
    expect(b.status).toBe(409);
    expect(b.body.error).toMatch(/boshqa bron bor/);
    expect(h.db.bookings.filter((x: any) => x.status === 'in_progress')).toHaveLength(0);
  });

  it('boshlangan darsning chekini boshqasi urolmaydi', async () => {
    const { code } = paidBooking({ ins: 'ip-a' });
    await A('POST', '/api/instructor/scan/start', { code });
    const v = await B('POST', '/api/instructor/scan', { code });
    expect(v.status).toBe(409);
    expect(v.body.error).toMatch(/allaqachon boshlangan \(Aziz Karimov\)/);
  });

  it('chek yozuvi yozilmasa — dars ortga qaytadi (hisobdan tushib qolmasin)', async () => {
    const { id, code } = paidBooking({ ins: 'ip-a' });
    const base = globalThis.fetch;
    globalThis.fetch = ((u: any, o: any) => (/attendance_verifications/.test(String(u)) && String(o?.method).toUpperCase() === 'POST'
      ? Promise.resolve({ ok: false, status: 400, text: async () => JSON.stringify({ message: 'null value in column "token_epoch"' }), headers: new Map() } as any)
      : base(u, o))) as any;
    try {
      const r = await B('POST', '/api/instructor/scan/start', { code });
      expect(r.status).toBe(500);
      expect(r.body.error).toMatch(/Chek yozilmadi/);
    } finally { globalThis.fetch = base; }
    expect(bk(id)).toMatchObject({ status: 'confirmed', instructor_id: 'ip-a' });
    expect(bk(id).arrived_at).toBeNull();
    // qayta urinish — ishlaydi
    expect((await B('POST', '/api/instructor/scan/start', { code })).status).toBe(200);
    expect(bk(id)).toMatchObject({ status: 'in_progress', instructor_id: 'ip-b' });
  });

  it('bron qayta ochilib, chek yana urilsa (yozuv bor) — dars boshlanadi', async () => {
    const { id, code } = paidBooking({ ins: 'ip-a' });
    await A('POST', '/api/instructor/scan/start', { code });
    Object.assign(bk(id), { status: 'confirmed', arrived_at: null });           // admin bronni qayta ochdi
    const base = globalThis.fetch;
    globalThis.fetch = ((u: any, o: any) => (/attendance_verifications/.test(String(u)) && String(o?.method).toUpperCase() === 'POST'
      ? Promise.resolve({ ok: false, status: 409, text: async () => JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint "attendance_verifications_booking_unique"' }), headers: new Map() } as any)
      : base(u, o))) as any;
    try {
      expect((await B('POST', '/api/instructor/scan/start', { code })).status).toBe(200);
    } finally { globalThis.fetch = base; }
    expect(bk(id)).toMatchObject({ status: 'in_progress', instructor_id: 'ip-b' });
    const l = await loadLedger({ from: new Date(Date.now() - 3600e3), to: new Date(Date.now() + 3600e3) });
    expect(l.rows.find((r) => r.booking_id === id)?.instructor_id).toBe('ip-b');   // egasi — hozirgi bron instruktori
  });

  it('«KELDI» endi yo‘q — faqat chek bilan (boshqa yo‘l bilan ham boshlab bo‘lmaydi)', async () => {
    const { id } = paidBooking({ ins: 'ip-a' });
    const r = await A('POST', `/api/instructor/bookings/${id}/arrived`, {});
    expect(r.status).toBe(410);
    expect(r.body.error).toMatch(/chekini skanerlang/);
    const p = await A('PATCH', `/api/bookings/${id}/status`, { status: 'in_progress' });
    expect(p.status).toBe(410);
    expect(bk(id).status).toBe('confirmed');
  });

  it('bloklangan instruktor chek urolmaydi', async () => {
    const { id, code } = paidBooking({ ins: 'ip-a' });
    h.db.users.find((u: any) => u.id === 'u-b').is_blocked = true;
    expect((await B('POST', '/api/instructor/scan/start', { code })).status).toBe(403);
    expect((await B('POST', '/api/instructor/scan', { code })).status).toBe(403);
    expect(bk(id)).toMatchObject({ status: 'confirmed', instructor_id: 'ip-a' });
  });

  it('toifa yozilmagan chek — mashg‘ulot toifasi bo‘yicha tekshiriladi', async () => {
    const { code } = paidBooking({ ins: null, cat: '' });
    const c = await C('POST', '/api/instructor/scan/start', { code });     // C toifa instruktori, chek — B mashg'uloti
    expect(c.status).toBe(409);
    expect(c.body.error).toMatch(/B toifa uchun/);
    expect((await B('POST', '/api/instructor/scan/start', { code })).status).toBe(200);
  });
});

describe('Kassa: bronsiz chekda instruktor ixtiyoriy', () => {
  it('instruktorsiz chek chiqadi, uni urgan instruktor oladi', async () => {
    const r = await h.call('POST', '/api/admin/cashier/issue', { cookie: kassa1, payload: {
      register_token: makeRegisterToken('reg-p1'), full_name: 'Ko‘chadan Kelgan', phone: '+998901230055', instructor_id: null,
      course_id: 'c-b', category: 'B', duration_minutes: 60, amount: 250000, cash_amount: 250000, card_amount: 0,
    } });
    expect(r.status).toBeLessThan(300);
    const code = r.body.receipt?.code || r.body.receipts?.[0]?.code;
    const b = h.db.bookings.find((x: any) => x.source === 'walk_in');
    expect(b.instructor_id).toBeNull();
    const v = await B('POST', '/api/instructor/scan', { code });
    expect(v.body).toMatchObject({ can_start: true, transfer_from: '' });
    expect((await B('POST', '/api/instructor/scan/start', { code })).status).toBe(200);
    expect(b).toMatchObject({ instructor_id: 'ip-b', status: 'in_progress' });
  });
});

describe('Chekdagi vaqt tugasa — dars o‘zi yopiladi', () => {
  it('1 soatlik chek: urilganidan 60 daqiqa o‘tgach yopiladi', async () => {
    const { id, code } = paidBooking({ ins: 'ip-a', minutes: 60 });
    await A('POST', '/api/instructor/scan/start', { code });
    const started = Date.parse(bk(id).arrived_at);
    expect((await finishDueLessons(started + 59 * 60000)).closed).toBe(0);
    expect(bk(id).status).toBe('in_progress');
    const r = await finishDueLessons(started + 61 * 60000);
    expect(r.closed).toBe(1);
    expect(bk(id).status).toBe('completed');
    expect(bk(id).departed_at).toBe(new Date(started + 60 * 60000).toISOString());
    expect(h.db.admin_audit_logs.some((x: any) => x.action === 'LESSON_AUTO_FINISHED')).toBe(true);
  });
  it('2 soatlik chek 2 soatdan keyin yopiladi', async () => {
    const { id, code } = paidBooking({ ins: 'ip-a', minutes: 120 });
    await A('POST', '/api/instructor/scan/start', { code });
    const started = Date.parse(bk(id).arrived_at);
    expect((await finishDueLessons(started + 90 * 60000)).closed).toBe(0);
    expect((await finishDueLessons(started + 121 * 60000)).closed).toBe(1);
    expect(bk(id).departed_at).toBe(new Date(started + 120 * 60000).toISOString());
  });
});

describe('Hisobot — urilgan chek bo‘yicha', () => {
  async function scenario() {
    const x1 = paidBooking({ ins: 'ip-a', amount: 250000 });                  // A o'zi uradi
    const x2 = paidBooking({ ins: 'ip-a', startMin: 90, amount: 300000, cust: 'u-cust2' }); // B uradi (A ning broni)
    const x3 = paidBooking({ ins: 'ip-a', startMin: 200, amount: 400000, reg: 'reg-p2' }); // hech kim urmagan
    await A('POST', '/api/instructor/scan/start', { code: x1.code });
    Object.assign(bk(x1.id), { status: 'completed', departed_at: new Date().toISOString() });   // A darsni tugatdi
    expect((await B('POST', '/api/instructor/scan/start', { code: x2.code })).status).toBe(200);
    return { x1, x2, x3 };
  }

  it('admin: dars va pul chekni urganga, urilmagan chek alohida', async () => {
    await scenario();
    const r = await h.call('GET', `/api/admin/instructor-report?period=day&date=${ymd(0)}`, { cookie: admin });
    expect(r.status).toBe(200);
    expect(r.body.basis).toBe('scanned_receipts');
    const by = (id: string) => r.body.instructors.find((i: any) => i.id === id);
    expect(by('ip-a')).toMatchObject({ lessons: 1, revenue: 250000, minutes: 60, students: 1 });
    expect(by('ip-b')).toMatchObject({ lessons: 1, revenue: 300000, minutes: 60, transferred_in: 1 });
    expect(r.body.totals).toMatchObject({ lessons: 2, revenue: 550000, transferred_in: 1 });
    expect(r.body.totals.unscanned).toEqual({ receipts: 1, amount: 400000 });
  });

  it('chek urmasdan (qo‘lda) boshlangan to‘langan dars — hisobda emas, «urilmagan»da', async () => {
    await scenario();                                                            // birinchi chek urildi
    const y = paidBooking({ ins: 'ip-b', startMin: 30, amount: 111000 });
    Object.assign(bk(y.id), { status: 'in_progress', arrived_at: new Date(Date.now() + 60000).toISOString() });   // admin qo'lda
    const r = await h.call('GET', `/api/admin/instructor-report?period=day&date=${ymd(0)}`, { cookie: admin });
    expect(r.body.instructors.find((i: any) => i.id === 'ip-b').revenue).toBe(300000);
    expect(r.body.totals.unscanned).toEqual({ receipts: 2, amount: 400000 + 111000 });
  });

  it('kassir batafsil hisobotda boshqa kassaning chekini va pulini ko‘rmaydi', async () => {
    const x = paidBooking({ ins: 'ip-a', reg: 'reg-p2', amount: 333000 });
    await A('POST', '/api/instructor/scan/start', { code: x.code });
    const r = await h.call('GET', `/api/admin/instructor-control/ip-a?period=day&date=${ymd(0)}`, { cookie: kassa1 });
    const row = r.body.rows.find((z: any) => z.id === x.id);
    expect(row).toMatchObject({ amount: 0, receipt_code: null });
    expect(r.body.summary.revenue).toBe(0);
  });

  it('kassa (P1) faqat o‘z kassasi cheklarini ko‘radi', async () => {
    await scenario();
    const r = await h.call('GET', `/api/admin/instructor-report?period=day&date=${ymd(0)}`, { cookie: kassa1 });
    expect(r.status).toBe(200);
    expect(r.body.totals.unscanned).toEqual({ receipts: 0, amount: 0 });       // P2 cheki P1 ga ko'rinmaydi
    expect(r.body.totals.revenue).toBe(550000);
  });

  it('admin batafsil: B ning darslari, qaysi bron o‘tgani', async () => {
    const { x2 } = await scenario();
    const r = await h.call('GET', `/api/admin/instructor-control/ip-b?period=day&date=${ymd(0)}`, { cookie: admin });
    expect(r.status).toBe(200);
    expect(r.body.summary).toMatchObject({ scanned: 1, revenue: 300000, transferred_in: 1, minutes: 60 });
    const row = r.body.rows.find((x: any) => x.id === x2.id);
    expect(row).toMatchObject({ transferred_from: 'Aziz Karimov', amount: 300000, scanned: true });
    const ra = await h.call('GET', `/api/admin/instructor-control/ip-a?period=day&date=${ymd(0)}`, { cookie: admin });
    expect(ra.body.summary).toMatchObject({ scanned: 1, revenue: 250000 });
  });

  it('instruktor paneli: o‘zi urgan cheklar', async () => {
    const { x3 } = await scenario();
    const r = await B('GET', `/api/instructor/summary?from=${ymd(0)}&to=${ymd(0)}`);
    expect(r.status).toBe(200);
    expect(r.body.basis).toBe('scanned_receipts');
    expect(r.body.summary).toMatchObject({ lessons: 1, in_progress: 1, minutes: 60, transferred_in: 1 });
    const ra = await A('GET', `/api/instructor/summary?from=${ymd(0)}&to=${ymd(0)}`);
    expect(ra.body.summary).toMatchObject({ lessons: 1, completed: 1, minutes: 60 });
    /* urilmagan bron — hali dars emas (kun oxirida test ishlasa ertangi kunga tushadi) */
    const x3Day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(bk(x3.id).start_at));
    expect(ra.body.summary.upcoming).toBe(x3Day === ymd(0) ? 1 : 0);
    expect(ra.body.summary.lessons).toBe(1);
  });

  it('kun — chek urilgan kun (bron boshqa kunga bo‘lsa ham)', async () => {
    const x = paidBooking({ ins: 'ip-a', startMin: -24 * 60 });                // bron kecha edi
    await A('POST', '/api/instructor/scan/start', { code: x.code });
    Object.assign(bk(x.id), { status: 'completed' });
    const y = paidBooking({ ins: 'ip-b', startMin: 5 * 24 * 60 });             // bron 5 kundan keyin edi
    await B('POST', '/api/instructor/scan/start', { code: y.code });
    const l = await loadLedger({ from: new Date(Date.now() - 2 * 3600e3), to: new Date(Date.now() + 3600e3) });
    expect(l.rows.map((r) => r.booking_id).sort()).toEqual([x.id, y.id].sort());
    expect(l.rows.every((r) => r.day === ymd(0))).toBe(true);
  });

  it('eski darslar (birinchi chek yozuvidan oldin) bron instruktoriga sanaladi', async () => {
    const old = paidBooking({ ins: 'ip-a', startMin: -180 });
    Object.assign(bk(old.id), { status: 'completed', arrived_at: bk(old.id).start_at });
    const free = paidBooking({ ins: 'ip-a', startMin: -120 });              // to'lovsiz, KELDI bilan boshlangan
    Object.assign(bk(free.id), { status: 'completed', arrived_at: bk(free.id).start_at });
    h.db.payments = h.db.payments.filter((p: any) => p.booking_id !== free.id);
    const l = await loadLedger({ from: new Date(Date.now() - 5 * 3600e3), to: new Date(Date.now() + 3600e3) });
    expect(l.rows).toHaveLength(1);
    expect(l.rows[0]).toMatchObject({ booking_id: old.id, instructor_id: 'ip-a', source: 'legacy', amount: 250000 });
    // birinchi chek urilgandan keyin cheksiz boshlangan dars sanalmaydi
    const now = paidBooking({ ins: 'ip-a', startMin: 5 });
    await A('POST', '/api/instructor/scan/start', { code: now.code });
    const later = paidBooking({ ins: 'ip-b', startMin: 10 });
    Object.assign(bk(later.id), { status: 'completed', arrived_at: new Date(Date.now() + 10 * 60000).toISOString() });
    const l2 = await loadLedger({ from: new Date(Date.now() - 5 * 3600e3), to: new Date(Date.now() + 3600e3) });
    expect(l2.rows.map((r) => r.booking_id).sort()).toEqual([old.id, now.id].sort());
  });
});
