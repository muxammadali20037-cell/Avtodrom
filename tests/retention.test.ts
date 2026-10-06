/**
 * O'QUVCHINI QAYTARISH — instruktor «sotuvchi»:
 * nechta yangi pullik o'quvchi jalb qildi, nechtasi 7 kun ichida o'zi
 * bilan qaytdi, nechta marta kelishiga sababchi bo'ldi.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import { computeRetention, personKey } from '../backend/src/retention.js';

let h: Harness;
let admin = '', kassa = '';
const TZ = 'Asia/Tashkent';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const D = (n: number) => { const [y, m, d] = today.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const at = (day: string, hm = '10:00') => new Date(`${day}T${hm}:00+05:00`).toISOString();

beforeAll(async () => { h = await makeHarness(); });

let bn = 0;
const lesson = (customer: string, ins: string, day: string, extra: any = {}) => {
  const id = `b-${++bn}`;
  const start = at(day, extra.hm || '10:00');
  h.db.bookings.push({ id, customer_id: customer, instructor_id: ins, start_at: start, booking_date: start,
    end_at: new Date(Date.parse(start) + 3600e3).toISOString(), duration_minutes: 60, status: 'completed', source: 'app', ...extra });
  return id;
};
const pay = (booking_id: string, amount: number) => h.db.payments.push({ id: `p-${booking_id}`, booking_id, amount, status: 'paid', method: 'cash' });

beforeEach(async () => {
  h.reset(); bn = 0;
  h.db.staff.push({ id: 'st-admin', login: 'boss', password_hash: hashPassword('admin1234'), role: 'admin', register_id: null, is_active: true });
  h.db.staff.push({ id: 'st-k1', login: 'kassa1', password_hash: hashPassword('parol1234'), role: 'cashier', register_id: 'reg-p1', full_name: 'Kassa', is_active: true });
  h.db.cash_registers.push({ id: 'reg-p1', code: 'P1', name: '1-kassa', pin_hash: null });
  h.db.users.push({ id: 'u-ins1', full_name: 'Aziz Karimov', phone: '+998901114455', role: 'instructor', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-ins2', full_name: 'Anvar Sobirov', phone: '+998901114466', role: 'instructor', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-ins3', full_name: 'Bekzod Yangi', phone: '+998901114477', role: 'instructor', is_active: true, is_blocked: false });
  h.db.instructor_profiles.push({ id: 'ip-1', user_id: 'u-ins1', is_verified: true, is_available: true, vehicle_plate: '01 A 111 AA' });
  h.db.instructor_profiles.push({ id: 'ip-2', user_id: 'u-ins2', is_verified: true, is_available: true });
  h.db.instructor_profiles.push({ id: 'ip-3', user_id: 'u-ins3', is_verified: true, is_available: true });
  const cust = (id: string, name: string, phone: string | null) => h.db.users.push({ id, full_name: name, phone, role: 'customer', is_active: true, is_blocked: false });
  cust('u-ali', 'Ali', '+998901111111'); cust('u-vali', 'Vali', '+998902222222'); cust('u-gani', 'Gani', '+998903333333');
  cust('u-soli', 'Soli', '+998904444444'); cust('u-dup1', 'Dilshod', '+998905555555'); cust('u-dup2', 'Dilshod (kassa)', '90 555 55 55');
  cust('u-shk', 'Shkola o‘quvchisi', '+998906666666'); cust('u-old', 'Eski mijoz', '+998907777777'); cust('u-day', 'Bir kunda', '+998908888888');

  // ip-1: Ali — 3 kunda qaytdi, keyin yana keldi (2 ta takroriy kelish)
  lesson('u-ali', 'ip-1', D(-20));
  pay(lesson('u-ali', 'ip-1', D(-17)), 250000);
  pay(lesson('u-ali', 'ip-1', D(-10)), 250000);
  // ip-1: Vali — 5 kunda keldi, lekin BOSHQA instruktorga
  lesson('u-vali', 'ip-1', D(-20)); lesson('u-vali', 'ip-2', D(-15));
  // ip-1: Gani — 15 kundan keyin keldi (7 kundan kech) → qaytmadi, lekin takroriy kelish 1
  lesson('u-gani', 'ip-1', D(-20)); pay(lesson('u-gani', 'ip-1', D(-5)), 150000);
  // ip-1: avtoshkola o'quvchisi — avtoshkola darsi hisobga kirmaydi, birinchi PULLIK darsi D(-12)
  lesson('u-shk', 'ip-1', D(-20), { source: 'avtodrom12', school_receipt_code: 'SH-1' });
  lesson('u-shk', 'ip-1', D(-12));
  // ip-1: eski mijoz — birinchi darsi davrdan oldin → yangi emas
  lesson('u-old', 'ip-1', D(-40)); lesson('u-old', 'ip-1', D(-19));
  // ip-2: Soli — 2 kun oldin keldi, keyingi bron bor → kutilmoqda, band qilgan
  lesson('u-soli', 'ip-2', D(-2));
  h.db.bookings.push({ id: 'b-up', customer_id: 'u-soli', instructor_id: 'ip-2', start_at: at(D(2)), booking_date: at(D(2)), status: 'confirmed', source: 'app' });
  // ip-2: bitta odam ikki yozuvda (telefon bir xil) — qaytgan hisoblanadi
  lesson('u-dup1', 'ip-2', D(-20)); lesson('u-dup2', 'ip-2', D(-18));
  // ip-2: o'sha kuni ikkinchi dars — «qaytish» emas
  lesson('u-day', 'ip-2', D(-20), { hm: '10:00' }); lesson('u-day', 'ip-2', D(-20), { hm: '14:00' });
  // bekor qilingan bron hisobga kirmaydi
  lesson('u-ali', 'ip-2', D(-19), { status: 'cancelled' });

  admin = (await h.login('boss', 'admin1234')).cookie;
  kassa = (await h.login('kassa1', 'parol1234')).cookie;
});

const get = (cookie = admin, from = D(-21), to = D(0)) => h.call('GET', `/api/admin/retention?from=${from}&to=${to}`, { cookie });

describe('O‘quvchini qaytarish hisoboti', () => {
  it('faqat administrator ko‘radi', async () => {
    expect((await get(kassa)).status).toBe(403);
    expect((await h.call('GET', `/api/admin/retention?from=${D(-7)}&to=${D(0)}`)).status).toBe(401);
  });

  it('instruktor bo‘yicha: jalb qildi, qaytdi, boshqaga o‘tdi, qaytmadi, foiz', async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.window_days).toBe(7);
    const i1 = r.body.instructors.find((x: any) => x.id === 'ip-1');
    const i2 = r.body.instructors.find((x: any) => x.id === 'ip-2');
    expect(i1).toMatchObject({ new: 4, returned: 1, moved: 1, lost: 2, waiting: 0, rate: 25, visits: 3 });
    expect(i2).toMatchObject({ new: 3, returned: 1, waiting: 1, booked: 1, lost: 1, moved: 0, rate: 50 });
    // reyting: foiz bo'yicha
    expect(r.body.instructors.map((x: any) => x.id).slice(0, 2)).toEqual(['ip-2', 'ip-1']);
    // yangi o'quvchisi yo'q faol instruktor ham ro'yxatda (0 bilan)
    expect(r.body.instructors.find((x: any) => x.id === 'ip-3')).toMatchObject({ new: 0, rate: null });
    expect(r.body.totals).toMatchObject({ new: 7, returned: 2, waiting: 1, booked: 1, moved: 1, lost: 3, rate: 33.3 });
  });

  it('o‘quvchilar ro‘yxati: holat, necha kunda qaytdi, kimga o‘tdi, takroriy tushum', async () => {
    const r = await get();
    const i1 = r.body.instructors.find((x: any) => x.id === 'ip-1');
    const by = (n: string) => i1.students.find((s: any) => s.name === n);
    expect(by('Ali')).toMatchObject({ status: 'returned', days_to_return: 3, visits: 2, revenue: 500000 });
    expect(by('Vali')).toMatchObject({ status: 'moved', moved_to_name: 'Anvar Sobirov', visits: 0 });
    expect(by('Gani')).toMatchObject({ status: 'lost', visits: 1, revenue: 150000 });
    expect(by('Shkola o‘quvchisi')).toMatchObject({ status: 'lost', first_day: D(-12) });
    expect(i1.students.some((s: any) => s.name === 'Eski mijoz')).toBe(false);
    expect(i1.revenue).toBe(650000);
    const i2 = r.body.instructors.find((x: any) => x.id === 'ip-2');
    expect(i2.students.find((s: any) => s.name === 'Soli')).toMatchObject({ status: 'waiting', booked: true });
    expect(i2.students.find((s: any) => s.name === 'Dilshod')).toMatchObject({ status: 'returned', days_to_return: 2 });
    expect(i2.students.find((s: any) => s.name === 'Bir kunda')).toMatchObject({ status: 'lost', visits: 0 });
    // ichki ID'lar javobga chiqmaydi
    expect(JSON.stringify(r.body)).not.toContain('repeat_ids');
  });

  it('davr — birinchi dars sanasi bo‘yicha', async () => {
    const r = await get(admin, D(-3), D(0));
    expect(r.body.totals.new).toBe(1);                 // faqat Soli
    expect(r.body.instructors.find((x: any) => x.id === 'ip-2').new).toBe(1);
  });
});

describe('Qaytish qoidasi (sof hisob)', () => {
  const people = new Map([['c1', { name: 'A', phone: '+998901234567' }]]);
  const L = (id: string, ins: string, day: string) => ({ id, customer_id: 'c1', instructor_id: ins, day, at: `${day}T05:00:00Z`, minutes: 60 });
  const run = (lessons: any[], todayDay = '2026-10-30') =>
    computeRetention({ lessons, upcoming: [], people, fromDay: '2026-10-01', toDay: '2026-10-31', today: todayDay });

  it('7-kuni qaytsa — hisoblanadi, 8-kuni — yo‘q', () => {
    const a = run([L('1', 'i1', '2026-10-01'), L('2', 'i1', '2026-10-08')]);
    expect(a.perIns.get('i1')!.students[0]).toMatchObject({ status: 'returned', days_to_return: 7 });
    const b = run([L('1', 'i1', '2026-10-01'), L('2', 'i1', '2026-10-09')]);
    expect(b.perIns.get('i1')!.students[0]).toMatchObject({ status: 'lost', visits: 1 });
  });

  it('7 kun tugamagan bo‘lsa — kutilmoqda, foizga kirmaydi', () => {
    const r = run([L('1', 'i1', '2026-10-25')], '2026-10-28');
    expect(r.perIns.get('i1')!.agg).toMatchObject({ new: 1, waiting: 1, rate: null });
  });

  it('telefon bo‘yicha birlashtirish', () => {
    expect(personKey('x', '+998 90 123 45 67')).toBe(personKey('y', '901234567'));
    expect(personKey('x', null)).toBe('c:x');
  });
});
