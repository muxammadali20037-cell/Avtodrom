/**
 * DAVRLI HISOBOTLAR: «12-dan 28-gacha» kabi oraliq va yillik davr.
 *  · Instruktorlar hisoboti — har instruktor nechta o'quvchi haydadi,
 *    nechta avtoshkola va nechta pullik dars.
 *  · Cheklar — bir kun emas, istalgan oraliq.
 * Kassalar bir-birini ko'rmaydi: P1 kassiri P2 sotgan darsni ko'rmaydi.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import { makeRegisterToken } from '../backend/src/shift-routes.js';

let h: Harness;
let admin = '', operator = '', kassa1 = '', kassa2 = '';

const Y = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent', year: 'numeric' }).format(new Date());
/* O'tgan yilning sentabri — sanalar har doim o'tmishda bo'lsin */
const YR = String(Number(Y) - 1);
const at = (day: number, hm: string, month = '09') => new Date(`${YR}-${month}-${String(day).padStart(2, '0')}T${hm}:00+05:00`).toISOString();

let seq = 0;
function lesson(o: { ins: string; cust: string; day: number; hm?: string; status?: string; school?: boolean; pay?: { reg: string; amount: number; method?: string } | null; month?: string }) {
  const id = `b-${++seq}`;
  const start = at(o.day, o.hm || '10:00', o.month);
  h.db.bookings.push({
    id, customer_id: o.cust, instructor_id: o.ins, course_id: 'c-b', start_at: start, booking_date: start,
    end_at: new Date(Date.parse(start) + 3600e3).toISOString(), duration_minutes: 60,
    status: o.status || 'completed', source: o.school ? 'avtodrom12' : 'cashier',
    school_receipt_code: o.school ? `SCH-${seq}` : null,
  });
  if (o.pay) {
    h.db.payments.push({ id: `p-${seq}`, booking_id: id, amount: o.pay.amount, method: o.pay.method || 'cash',
      cash_amount: o.pay.method === 'card' ? 0 : o.pay.amount, card_amount: o.pay.method === 'card' ? o.pay.amount : 0,
      status: 'paid', register_id: o.pay.reg, receipt_code: `AVD-${seq}`, paid_at: start });
  }
  return id;
}

beforeAll(async () => { h = await makeHarness(); });

beforeEach(async () => {
  h.reset(); seq = 0;
  h.db.cash_registers.push({ id: 'reg-p1', code: 'P1', name: '1-kassa', is_active: true });
  h.db.cash_registers.push({ id: 'reg-p2', code: 'P2', name: '2-kassa', is_active: true });
  const st = (id: string, login: string, role: string, register_id: string | null) =>
    h.db.staff.push({ id, login, password_hash: hashPassword('parol1234'), role, register_id, full_name: login, is_active: true });
  st('st-admin', 'boss', 'admin', null);
  st('st-op', 'operator1', 'operator', null);
  st('st-k1', 'kassa1', 'cashier', 'reg-p1');
  st('st-k2', 'kassa2', 'cashier', 'reg-p2');
  h.db.users.push({ id: 'u-admin', full_name: 'Admin', role: 'admin', is_active: true, is_blocked: false });
  for (const [id, name] of [['u-a', 'Ali'], ['u-b', 'Bek'], ['u-c', 'Sardor'], ['u-d', 'Dilnoza']]) {
    h.db.users.push({ id, full_name: name, phone: '+99890' + id, role: 'customer', is_active: true, is_blocked: false });
  }
  h.db.users.push({ id: 'u-i1', full_name: 'Aziz Karimov', phone: '+998901', role: 'instructor', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-i2', full_name: 'Bobur Aliyev', phone: '+998902', role: 'instructor', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-i3', full_name: 'Jasur Bo‘sh', phone: '+998903', role: 'instructor', is_active: true, is_blocked: false });
  h.db.instructor_profiles.push({ id: 'ip-1', user_id: 'u-i1', is_verified: true, is_available: true, categories: ['B'] });
  h.db.instructor_profiles.push({ id: 'ip-2', user_id: 'u-i2', is_verified: true, is_available: true, categories: ['B'] });
  h.db.instructor_profiles.push({ id: 'ip-3', user_id: 'u-i3', is_verified: true, is_available: true, categories: ['B'] });
  h.db.courses.push({ id: 'c-b', name: 'B toifa', category: 'B', price: 250000, duration_minutes: 60, is_active: true });

  /* ip-1: 12-sentabr — Ali (avtoshkola), 15 — Ali (pullik, P1), 20 — Bek (pullik, P2),
           28 — Sardor (avtoshkola), 29 — Dilnoza (oraliqdan tashqarida), 14 — kelmadi (P1)
     ip-2: 13 — Bek (pullik, P1, karta), 25 — Bek (avtoshkola)
     ip-3: dars yo'q */
  lesson({ ins: 'ip-1', cust: 'u-a', day: 12, school: true });
  lesson({ ins: 'ip-1', cust: 'u-a', day: 15, pay: { reg: 'reg-p1', amount: 250000 } });
  lesson({ ins: 'ip-1', cust: 'u-b', day: 20, pay: { reg: 'reg-p2', amount: 300000 } });
  lesson({ ins: 'ip-1', cust: 'u-c', day: 28, hm: '19:30', school: true });
  lesson({ ins: 'ip-1', cust: 'u-d', day: 29, pay: { reg: 'reg-p1', amount: 250000 } });
  lesson({ ins: 'ip-1', cust: 'u-c', day: 14, status: 'no_show', pay: { reg: 'reg-p1', amount: 125000 } });
  lesson({ ins: 'ip-2', cust: 'u-b', day: 13, pay: { reg: 'reg-p1', amount: 250000, method: 'card' } });
  lesson({ ins: 'ip-2', cust: 'u-b', day: 25, school: true });

  admin = (await h.login('boss', 'parol1234')).cookie;
  operator = (await h.login('operator1', 'parol1234')).cookie;
  kassa1 = (await h.login('kassa1', 'parol1234')).cookie;
  kassa2 = (await h.login('kassa2', 'parol1234')).cookie;
});

const rep = (cookie: string, qs: string) => h.call('GET', `/api/admin/instructor-report?${qs}`, { cookie });
const range = `from=${YR}-09-12&to=${YR}-09-28`;

describe('Instruktorlar hisoboti — oraliq (12 dan 28 gacha)', () => {
  it('administrator: har instruktor nechta o‘quvchi, avtoshkola va pullik', async () => {
    const r = await rep(admin, range);
    expect(r.status).toBe(200);
    const i1 = r.body.instructors.find((x: any) => x.id === 'ip-1');
    const i2 = r.body.instructors.find((x: any) => x.id === 'ip-2');
    // ip-1: Ali (2 dars), Bek, Sardor → 3 o'quvchi, 4 dars; 29-sentabr kirmaydi
    expect(i1.students).toBe(3);
    expect(i1.lessons).toBe(4);
    expect(i1.school).toMatchObject({ lessons: 2, students: 2 });
    expect(i1.paid).toMatchObject({ lessons: 2, students: 2, revenue: 550000 });
    expect(i1.no_show).toBe(1);
    expect(i1.revenue).toBe(675000);          // kelmagan, lekin to'langan ham tushum
    expect(i1.minutes).toBe(240);
    expect(i1.work_days).toBe(4);
    expect(i2.students).toBe(1);
    expect(i2.school.lessons).toBe(1);
    expect(i2.paid.lessons).toBe(1);
    expect(i2.card).toBe(250000);
    // Dars o'tmagan instruktor ham ro'yxatda — 0 bilan
    const i3 = r.body.instructors.find((x: any) => x.id === 'ip-3');
    expect(i3).toMatchObject({ lessons: 0, students: 0 });
    // Jami
    expect(r.body.totals.lessons).toBe(6);
    expect(r.body.totals.students).toBe(3);          // Ali, Bek, Sardor
    expect(r.body.totals.school.lessons).toBe(3);
    expect(r.body.totals.paid.lessons).toBe(3);
    expect(r.body.totals.working).toBe(2);
    expect(r.body.from_day).toBe(`${YR}-09-12`);
    expect(r.body.to_day).toBe(`${YR}-09-28`);
    // Eng ko'p o'quvchi haydagan birinchi
    expect(r.body.instructors[0].id).toBe('ip-1');
    // Kunlar kesimi
    expect(r.body.days.map((d: any) => d.day)).toContain(`${YR}-09-28`);
    expect(r.body.days.find((d: any) => d.day === `${YR}-09-12`)).toMatchObject({ lessons: 1, school: 1, paid: 0 });
  });

  it('oxirgi kun (28-sentabr, kechqurun) ham kiradi; 29 kirmaydi', async () => {
    const r = await rep(admin, `from=${YR}-09-28&to=${YR}-09-28`);
    expect(r.body.totals.lessons).toBe(1);
    const r2 = await rep(admin, `from=${YR}-09-29&to=${YR}-09-29`);
    expect(r2.body.totals.lessons).toBe(1);
    expect(r2.body.totals.paid.revenue).toBe(250000);
  });

  it('yillik davr — butun yil', async () => {
    const r = await rep(admin, `period=year&date=${YR}-03-01`);
    expect(r.status).toBe(200);
    expect(r.body.totals.lessons).toBe(7);
    expect(r.body.totals.students).toBe(4);
  });

  it('P1 kassiri faqat P1 da sotilgan darslarni va avtoshkolani ko‘radi', async () => {
    const r = await rep(kassa1, range);
    expect(r.status).toBe(200);
    expect(r.body.scoped_to_register).toBe(true);
    const i1 = r.body.instructors.find((x: any) => x.id === 'ip-1');
    expect(i1.paid.lessons).toBe(1);                  // 20-sentabrdagi P2 darsi yo'q
    expect(i1.paid.revenue).toBe(250000);
    expect(i1.revenue).toBe(375000);
    expect(i1.school.lessons).toBe(2);
    const r2 = await rep(kassa2, range);
    const j1 = r2.body.instructors.find((x: any) => x.id === 'ip-1');
    expect(j1.paid.lessons).toBe(1);
    expect(j1.paid.revenue).toBe(300000);
    expect(r2.body.totals.revenue).toBe(300000);
  });

  it('operatorga yopiq', async () => {
    expect((await rep(operator, range)).status).toBe(403);
  });

  it('noto‘g‘ri sana — 400', async () => {
    expect((await rep(admin, `from=${YR}-13-45&to=${YR}-09-28`)).status).toBe(400);
  });
});

describe('Instruktor tafsiloti (own=1) — kassa ajratilgan', () => {
  it('P1 kassiri P2 sotgan darsni tafsilotda ham ko‘rmaydi', async () => {
    const all = await h.call('GET', `/api/admin/instructor-control/ip-1?${range}`, { cookie: admin });
    expect(all.body.rows.length).toBe(5);
    const own = await h.call('GET', `/api/admin/instructor-control/ip-1?${range}&own=1`, { cookie: kassa1 });
    expect(own.status).toBe(200);
    const ids = own.body.rows.map((r: any) => r.customer_id);
    expect(own.body.rows.length).toBe(4);             // P2 darsi (Bek, 20-sentabr) yo'q
    expect(own.body.rows.some((r: any) => r.amount === 300000)).toBe(false);
    expect(ids).toContain('u-c');
    // Administrator own=1 bersa ham hammasini ko'radi
    const adm = await h.call('GET', `/api/admin/instructor-control/ip-1?${range}&own=1`, { cookie: admin });
    expect(adm.body.rows.length).toBe(5);
  });
});

describe('Cheklar — oraliq', () => {
  it('12–28 oraliqdagi P1 cheklari, kunlar bo‘yicha jami', async () => {
    const t = makeRegisterToken('reg-p1');
    const r = await h.call('GET', `/api/admin/cashier/receipts?token=${t}&${range}`, { cookie: kassa1 });
    expect(r.status).toBe(200);
    const codes = r.body.receipts.map((x: any) => x.code).sort();
    expect(codes).toEqual(['AVD-2', 'AVD-6', 'AVD-7']);    // 29-sentabr va P2 kirmaydi
    expect(r.body.summary.amount).toBe(625000);
    expect(r.body.summary.card).toBe(250000);
    expect(r.body.days.length).toBe(3);
    expect(r.body.from).toBe(`${YR}-09-12`);
    expect(r.body.to).toBe(`${YR}-09-28`);
    expect(r.body.truncated).toBe(false);
  });

  it('bitta kun (?date=) avvalgidek ishlaydi', async () => {
    const t = makeRegisterToken('reg-p1');
    const r = await h.call('GET', `/api/admin/cashier/receipts?token=${t}&date=${YR}-09-15`, { cookie: kassa1 });
    expect(r.body.receipts.map((x: any) => x.code)).toEqual(['AVD-2']);
  });

  it('serverda qidiruv (q) — butun davr bo‘yicha', async () => {
    const t = makeRegisterToken('reg-p1');
    const r = await h.call('GET', `/api/admin/cashier/receipts?token=${t}&period=year&date=${YR}-01-01&q=dilnoza`, { cookie: kassa1 });
    expect(r.body.receipts.map((x: any) => x.code)).toEqual(['AVD-5']);
    expect(r.body.summary.total).toBe(4);               // jami — filtrsiz
  });

  it('1 yildan uzun oraliq — 400', async () => {
    const t = makeRegisterToken('reg-p1');
    const r = await h.call('GET', `/api/admin/cashier/receipts?token=${t}&from=${Number(YR) - 2}-01-01&to=${YR}-09-28`, { cookie: kassa1 });
    expect(r.status).toBe(400);
  });

  it('P1 kassiri P2 tokeni bilan oraliq cheklarini ko‘ra olmaydi', async () => {
    const r = await h.call('GET', `/api/admin/cashier/receipts?token=${makeRegisterToken('reg-p2')}&${range}`, { cookie: kassa1 });
    expect([401, 403]).toContain(r.status);
  });
});
