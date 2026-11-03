/**
 * 2-noyabr tuzatishlari:
 *  · Instruktor ilovasida tugagan dars «darsda» qolib ketmasin (server o'zi yopadi, kirish 24 soat);
 *  · Jarayonda → Tugagan — kun bo'yicha (bugun / tanlangan kun);
 *  · Cheklar — P1 va P2 bir-birinikini ko'radi (alohida test: audit.test.ts);
 *  · Instruktorlar nazorati — kim qachon bo'shaydi, eng tezi tepada.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import { validateTelegramInitData } from '../backend/src/telegram.js';

let h: Harness;
let kassa1 = '', admin = '';
const A_TG = 880801, B_TG = 880802;

function signed(user: Record<string, unknown>, botToken = '1:instructor', ageSec = 0) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000) - ageSec), query_id: 'AAtest', user: JSON.stringify(user) });
  const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dataCheck).digest('hex'));
  return params.toString();
}
const ins = (tg: number, ageSec = 0) => (method: string, url: string, payload?: any) =>
  h.app.inject({ method, url, payload, headers: { 'x-telegram-init-data': signed({ id: tg, first_name: 'I' }, '1:instructor', ageSec) } })
    .then((r: any) => ({ status: r.statusCode, body: JSON.parse(r.body || '{}') }));
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const ymd = (ms = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date(ms));
const bk = (id: string) => h.db.bookings.find((b: any) => b.id === id);
function lesson(id: string, insId: string, startedMinAgo: number, minutes = 60, o: any = {}) {
  const st = iso(startedMinAgo * 60000);
  h.db.bookings.push({ id, customer_id: 'u-m', instructor_id: insId, course_id: 'c-b', start_at: st, booking_date: st, arrived_at: st,
    end_at: new Date(Date.parse(st) + minutes * 60000).toISOString(), duration_minutes: minutes, status: 'in_progress', source: 'walk_in', ...o });
}

beforeAll(async () => { h = await makeHarness(); });
beforeEach(async () => {
  h.reset();
  h.db.cash_registers.push({ id: 'reg-p1', code: 'P1', name: '1-kassa', is_active: true });
  h.db.staff.push({ id: 'st-k1', login: 'kassa1', password_hash: hashPassword('parol1234'), role: 'cashier', register_id: 'reg-p1', full_name: 'kassa1', is_active: true });
  h.db.staff.push({ id: 'st-ad', login: 'boss', password_hash: hashPassword('parol1234'), role: 'admin', register_id: null, is_active: true });
  h.db.users.push({ id: 'u-admin', full_name: 'Admin', role: 'admin', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-a', full_name: 'Aziz Karimov', phone: '+998901114455', telegram_id: A_TG, role: 'instructor', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-b', full_name: 'Bobur Aliyev', phone: '+998901114466', telegram_id: B_TG, role: 'instructor', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-c', full_name: 'Sardor Olimov', phone: '+998901114477', role: 'instructor', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-m', full_name: 'Hayotxon', phone: '+998901112200', role: 'customer', is_active: true, is_blocked: false });
  for (const [id, u] of [['ip-a', 'u-a'], ['ip-b', 'u-b'], ['ip-c', 'u-c']]) {
    h.db.instructor_profiles.push({ id, user_id: u, is_verified: true, is_available: true, categories: ['B'] });
  }
  h.db.courses.push({ id: 'c-b', name: 'B toifa', category: 'B', price: 250000, duration_minutes: 60, is_active: true });
  h.db.admin_settings.push({ key: 'work_start', value: '00:00' }, { key: 'work_end', value: '23:59' });
  kassa1 = (await h.login('kassa1', 'parol1234')).cookie;
  admin = (await h.login('boss', 'parol1234')).cookie;
});

describe('Instruktor ilovasi: tugagan dars «darsda» qolmaydi', () => {
  it('ro‘yxat so‘ralganda vaqti tugagan dars yopiladi (avval faqat admin paneli yopardi)', async () => {
    lesson('b-over', 'ip-a', 103);                       // 13:19 da boshlangan, 14:19 da tugashi kerak edi
    lesson('b-run', 'ip-a', 20);                         // hali ketayapti
    const r = await ins(A_TG)('GET', `/api/instructor/bookings?from=${encodeURIComponent(iso(864e5))}`);
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.bookings.map((b: any) => [b.id, b.status]));
    expect(by).toEqual({ 'b-over': 'completed', 'b-run': 'in_progress' });
    expect(Date.parse(bk('b-over').departed_at)).toBe(Date.parse(bk('b-over').arrived_at) + 60 * 60000);
    expect(h.db.admin_audit_logs.some((a: any) => a.action === 'LESSON_AUTO_FINISHED' && a.entity_id === 'b-over')).toBe(true);
  });

  it('kirish ma’lumoti 24 soat amal qiladi: 2 soatlik — ishlaydi, 25 soatlik — yo‘q', async () => {
    expect((await ins(A_TG, 2 * 3600)('GET', '/api/instructor/bookings')).status).toBe(200);
    const old = await ins(A_TG, 25 * 3600)('GET', '/api/instructor/bookings');
    expect(old.status).toBeGreaterThanOrEqual(400);
    expect(old.body.error).toMatch(/expired/);
    expect(() => validateTelegramInitData(signed({ id: 1 }, '1:instructor', 23 * 3600), '1:instructor')).not.toThrow();
  });
});

describe('Jarayonda → Tugagan: kun bo‘yicha', () => {
  it('standart — bugun tugaganlar; ?date= — o‘sha kun; jarayondagilar har doim', async () => {
    const yest = Date.now() - 864e5;
    const done = (id: string, at: number) => h.db.bookings.push({ id, customer_id: 'u-m', instructor_id: 'ip-b', course_id: 'c-b',
      start_at: new Date(at - 3600e3).toISOString(), booking_date: new Date(at - 3600e3).toISOString(), end_at: new Date(at).toISOString(),
      arrived_at: new Date(at - 3600e3).toISOString(), departed_at: new Date(at).toISOString(), duration_minutes: 60, status: 'completed', source: 'walk_in' });
    done('b-today', Date.now() - 60000);
    done('b-yest', yest);
    lesson('b-now', 'ip-a', 10);
    const t = await h.call('GET', '/api/admin/in-progress', { cookie: admin });
    expect(t.status).toBe(200);
    expect(t.body.day).toBe(ymd());
    expect(t.body.rows.filter((r: any) => r.level === 'done').map((r: any) => r.id)).toEqual(['b-today']);
    expect(t.body.counts.active).toBe(1);
    const y = await h.call('GET', `/api/admin/in-progress?date=${ymd(yest)}`, { cookie: admin });
    expect(y.body.day).toBe(ymd(yest));
    expect(y.body.rows.filter((r: any) => r.level === 'done').map((r: any) => r.id)).toEqual(['b-yest']);
    expect(y.body.counts.active).toBe(1);                                     // jarayondagi dars kun tanlansa ham ko'rinadi
  });
});

describe('Instruktorlar nazorati: kim qachon bo‘shaydi', () => {
  it('bo‘sh → tez tugaydigan dars → keyin tugaydigan; kassa ko‘radi, tizimga kirmagan — yo‘q', async () => {
    lesson('b-long', 'ip-a', 5);                          // 55 daqiqadan keyin bo'shaydi
    lesson('b-short', 'ip-b', 50);                        // 10 daqiqadan keyin bo'shaydi
    expect((await h.call('GET', '/api/admin/instructors-free')).status).toBe(401);
    const r = await h.call('GET', '/api/admin/instructors-free', { cookie: kassa1 });
    expect(r.status).toBe(200);
    expect(r.body.rows.map((x: any) => x.name)).toEqual(['Sardor Olimov', 'Bobur Aliyev', 'Aziz Karimov']);
    const [c, b, a] = r.body.rows;
    expect(c.state).toBe('free');
    expect(b.state).toBe('lesson');
    expect(Math.round((Date.parse(b.free_at) - Date.now()) / 60000)).toBe(10);
    expect(b.lesson.name).toBe('Hayotxon');
    expect(Math.round((Date.parse(a.free_at) - Date.now()) / 60000)).toBe(55);
    expect(r.body.counts).toMatchObject({ free: 1, lesson: 2 });
  });

  it('vaqti tugagan dars avval yopiladi — instruktor «bo‘sh» chiqadi', async () => {
    lesson('b-over', 'ip-a', 90);
    const r = await h.call('GET', '/api/admin/instructors-free', { cookie: kassa1 });
    expect(bk('b-over').status).toBe('completed');
    expect(r.body.rows.find((x: any) => x.id === 'ip-a').state).toBe('free');
  });
});

describe('Kengaytirilgan panel: 1000 dan ortiq foydalanuvchi', () => {
  it('Instruktorlar — ro‘yxat kesilmaydi: 1000-qatordan keyingi instruktor ham ismi bilan, «faol», ogohlantirishsiz', async () => {
    for (let i = 0; i < 1100; i++) {
      h.db.users.push({ id: `u-c${String(i).padStart(4, '0')}`, full_name: `Mijoz ${i}`, role: 'customer', is_active: true, is_blocked: false, created_at: iso(i * 1000) });
    }
    h.db.users.push({ id: 'u-zz', full_name: 'Kech Qo‘shilgan Instruktor', phone: '+998900000099', role: 'instructor', is_active: true, is_blocked: false });
    h.db.instructor_profiles.push({ id: 'ip-zz', user_id: 'u-zz', is_verified: true, is_available: true, categories: ['B'] });
    const r = await h.call('GET', '/api/admin/instructors', { cookie: admin });
    expect(r.status).toBe(200);
    expect(r.body.warnings).toEqual([]);
    const z = r.body.instructors.find((x: any) => x.id === 'ip-zz');
    expect(z.profile?.full_name).toBe('Kech Qo‘shilgan Instruktor');
    expect(z.active).toBe(true);
    const c = await h.call('GET', '/api/admin/customers', { cookie: admin });
    expect(c.body.customers.length).toBe(1101);                              // 1100 + Hayotxon
    expect(new Set(c.body.customers.map((x: any) => x.id)).size).toBe(1101); // takror yo'q
  });
});
