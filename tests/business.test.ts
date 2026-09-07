import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';

let h: Harness;
let admin: string;

beforeAll(async () => { h = await makeHarness(); });

beforeEach(async () => {
  h.reset();
  h.db.cash_registers.push({ id: 'reg-p1', code: 'P1', name: '1-kassa', pin_hash: null });
  h.db.staff.push({
    id: 'st-admin', login: 'boss', password_hash: hashPassword('admin1234'),
    role: 'admin', register_id: null, is_active: true,
  });
  h.db.users.push({ id: 'u-admin', full_name: 'Admin', role: 'admin', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-mijoz', full_name: 'Ali Valiyev', phone: '+998901112233', role: 'customer', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-instr', full_name: 'Aziz Karimov', phone: '+998901114455', role: 'instructor', is_active: true, is_blocked: false });
  h.db.instructor_profiles.push({
    id: 'ip-1', user_id: 'u-instr', experience_years: 5, rating: 4.8,
    is_verified: true, is_available: true, categories: ['A', 'B'],
  });
  h.db.courses.push({ id: 'c-b', name: 'B kategoriya', category: 'B', price: 250000, duration_minutes: 60, is_active: true });
  h.db.courses.push({ id: 'c-c', name: 'C kategoriya', category: 'C', price: 400000, duration_minutes: 60, is_active: true });

  admin = (await h.login('boss', 'admin1234')).cookie;
});

describe('Ochiq API', () => {
  it('health tekshiruvi ishlaydi', async () => {
    const r = await h.call('GET', '/api/health');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('kurslar kategoriya bilan qaytadi', async () => {
    // Telegram initData talab qilinadi — 401 kutiladi, lekin route mavjud
    const r = await h.call('GET', '/api/courses');
    expect([200, 401]).toContain(r.status);
  });
});

describe('Fail-closed himoya', () => {
  it('cron siri noto‘g‘ri bo‘lsa rad etadi', async () => {
    const r = await h.call('GET', '/api/cron/reminders');
    expect(r.status).toBe(401);
  });

  it('to‘g‘ri cron siri bilan ishlaydi', async () => {
    const r = await h.app.inject({
      method: 'GET', url: '/api/cron/reminders',
      headers: { authorization: 'Bearer test-cron-secret' },
    });
    expect(r.statusCode).toBe(200);
  });

  it('webhook siri noto‘g‘ri bo‘lsa rad etadi', async () => {
    const r = await h.app.inject({
      method: 'POST', url: '/api/telegram/customer/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'notogri' }, payload: {},
    });
    expect(r.statusCode).toBe(401);
  });

  it('to‘g‘ri webhook siri bilan qabul qiladi', async () => {
    const r = await h.app.inject({
      method: 'POST', url: '/api/telegram/customer/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' },
      payload: { message: { chat: { id: 1 }, text: '/start' } },
    });
    expect(r.statusCode).toBeLessThan(400);
  });
});

describe('Qo‘lda bron', () => {
  const startAt = () => new Date(Date.now() + 3600e3).toISOString();

  it('kategoriyaga mos kelmaydigan instruktorni rad etadi', async () => {
    // ip-1 faqat A va B ni o'rgatadi
    const r = await h.call('POST', '/api/admin/manual-booking', {
      cookie: admin,
      payload: { full_name: 'Yangi mijoz', instructor_id: 'ip-1', category: 'C', duration_minutes: 60, start_at: startAt() },
    });
    expect(r.status).toBe(409);
    expect(String(r.body.error)).toMatch(/C/);
  });

  it('mos kategoriyada bron yaratadi', async () => {
    const r = await h.call('POST', '/api/admin/manual-booking', {
      cookie: admin,
      payload: { full_name: 'Yangi mijoz', phone: '+998901119999', instructor_id: 'ip-1', category: 'B', duration_minutes: 60, start_at: startAt() },
    });
    expect(r.status).toBe(201);
    expect(h.db.bookings.length).toBe(1);
    expect(h.db.bookings[0].status).toBe('confirmed');
    expect(h.db.bookings[0].source).toBe('admin');
  });

  it('end_at ni SERVER hisoblaydi — mijoz yuborganini olmaydi', async () => {
    const start = startAt();
    await h.call('POST', '/api/admin/manual-booking', {
      cookie: admin,
      payload: {
        full_name: 'Test Mijoz', instructor_id: 'ip-1', category: 'B',
        duration_minutes: 60, start_at: start,
        end_at: '2099-01-01T00:00:00Z',      // soxta qiymat
      },
    });
    const b = h.db.bookings[0];
    const mins = (new Date(b.end_at).getTime() - new Date(b.start_at).getTime()) / 60000;
    expect(mins).toBe(60);
    expect(b.end_at).not.toContain('2099');
  });

  it('davomiylikni chegarada ushlaydi', async () => {
    await h.call('POST', '/api/admin/manual-booking', {
      cookie: admin,
      payload: { full_name: 'Test Mijoz', instructor_id: 'ip-1', category: 'B', duration_minutes: 99999, start_at: startAt() },
    });
    expect(h.db.bookings[0].duration_minutes).toBeLessThanOrEqual(600);
  });

  it('ismsiz bron yaratmaydi', async () => {
    const r = await h.call('POST', '/api/admin/manual-booking', {
      cookie: admin,
      payload: { instructor_id: 'ip-1', category: 'B', duration_minutes: 60, start_at: startAt() },
    });
    expect(r.status).toBe(400);
  });

  it('noto‘g‘ri sanani rad etadi', async () => {
    const r = await h.call('POST', '/api/admin/manual-booking', {
      cookie: admin,
      payload: { full_name: 'Test Mijoz', instructor_id: 'ip-1', category: 'B', duration_minutes: 60, start_at: 'axlat' },
    });
    expect(r.status).toBe(400);
  });
});

describe('Instruktor tahriri', () => {
  it('kategoriyani saqlaydi va qaytaradi', async () => {
    const r = await h.call('PATCH', '/api/admin/instructors/ip-1', {
      cookie: admin,
      payload: { categories: ['A', 'B', 'C'] },
    });
    expect(r.status).toBe(200);
    expect(h.db.instructor_profiles[0].categories).toEqual(['A', 'B', 'C']);
    // Server nimani saqlaganini tasdiqlaydi
    expect(r.body.not_saved).toEqual([]);
  });

  it('bo‘sh kategoriya ro‘yxatini rad etadi', async () => {
    const r = await h.call('PATCH', '/api/admin/instructors/ip-1', {
      cookie: admin, payload: { categories: [] },
    });
    expect(r.status).toBe(400);
  });

  it('noma‘lum kategoriyani tashlab yuboradi', async () => {
    await h.call('PATCH', '/api/admin/instructors/ip-1', {
      cookie: admin, payload: { categories: ['A', 'Z', 'B'] },
    });
    expect(h.db.instructor_profiles[0].categories).toEqual(['A', 'B']);
  });

  it('tashqi rasm manzilini rad etadi', async () => {
    const r = await h.call('PATCH', '/api/admin/instructors/ip-1', {
      cookie: admin, payload: { avatar_url: 'https://evil.example.com/x.jpg' },
    });
    expect(r.status).toBe(400);
  });

  it('tajribani chegarada ushlaydi', async () => {
    const r = await h.call('PATCH', '/api/admin/instructors/ip-1', {
      cookie: admin, payload: { experience_years: 500 },
    });
    expect(r.status).toBe(400);
  });

  it('bronlari bor instruktorni oddiy usulda o‘chirmaydi', async () => {
    h.db.bookings.push({ id: 'b-1', instructor_id: 'ip-1', customer_id: 'u-mijoz', status: 'completed' });
    const r = await h.call('DELETE', '/api/admin/instructors/ip-1', { cookie: admin });
    expect(r.status).toBe(409);
    expect(h.db.instructor_profiles.length).toBe(1);
  });

  it('force bilan o‘chiradi, lekin BRONLARNI SAQLAYDI', async () => {
    h.db.bookings.push({ id: 'b-1', instructor_id: 'ip-1', customer_id: 'u-mijoz', status: 'completed' });
    const r = await h.call('DELETE', '/api/admin/instructors/ip-1?force=1', { cookie: admin });
    expect(r.status).toBe(200);
    expect(h.db.instructor_profiles.length).toBe(0);
    // Bron qoldi va instruktor ismi yozildi — hisobot buzilmasin
    expect(h.db.bookings.length).toBe(1);
    expect(h.db.bookings[0].instructor_name).toBe('Aziz Karimov');
    expect(h.db.bookings[0].instructor_id).toBe(null);
  });
});

describe('Media xavfsizligi', () => {
  it('begona domendagi URL ni rad etadi', async () => {
    const r = await h.call('POST', '/api/admin/media/commit', {
      cookie: admin,
      payload: { title: 'x', media_type: 'image', slot: 'home', path: 'home_image/a.jpg', public_url: 'https://evil.com/a.jpg' },
    });
    expect(r.status).toBe(400);
  });

  it('papkadan chiqib ketuvchi yo‘lni rad etadi', async () => {
    const r = await h.call('POST', '/api/admin/media/commit', {
      cookie: admin,
      payload: {
        title: 'x', media_type: 'image', slot: 'home', path: '../../secret.jpg',
        public_url: 'https://test.supabase.co/storage/v1/object/public/customer-media/a.jpg',
      },
    });
    expect(r.status).toBe(400);
  });

  it('ruxsat etilmagan fayl turini rad etadi', async () => {
    const r = await h.call('POST', '/api/admin/media/sign', {
      cookie: admin,
      payload: { title: 'x', media_type: 'image', content_type: 'application/x-msdownload' },
    });
    expect(r.status).toBe(400);
  });

  it('galereya uchun noyob kalit beradi', async () => {
    const a = await h.call('POST', '/api/admin/media/sign', {
      cookie: admin, payload: { title: 'A', media_type: 'image', slot: 'gallery', content_type: 'image/jpeg', file_name: 'a.jpg' },
    });
    const b = await h.call('POST', '/api/admin/media/sign', {
      cookie: admin, payload: { title: 'B', media_type: 'image', slot: 'gallery', content_type: 'image/jpeg', file_name: 'b.jpg' },
    });
    expect(a.body.key).not.toBe(b.body.key);
    expect(a.body.key).toMatch(/^gallery_\d+_[a-z0-9]+$/i);
  });
});

describe('Lokatsiya', () => {
  it('koordinata chegaralarini tekshiradi', async () => {
    for (const [lat, lng] of [[91, 60], [-91, 60], [41, 181], [41, -181]]) {
      const r = await h.call('PUT', '/api/admin/settings/location', {
        cookie: admin,
        payload: { name: 'Avtodrom', address: 'Toshkent', latitude: lat, longitude: lng },
      });
      expect(r.status, `${lat},${lng} o‘tib ketdi`).toBe(400);
    }
  });

  it('to‘g‘ri koordinatani saqlaydi', async () => {
    const r = await h.call('PUT', '/api/admin/settings/location', {
      cookie: admin,
      payload: { name: 'TASH INDEX', address: 'Toshkent', latitude: 41.31, longitude: 69.24 },
    });
    expect(r.status).toBe(200);
    const saved = h.db.admin_settings.find((s) => s.key === 'location');
    expect(saved.value.latitude).toBe(41.31);
  });
});

describe('Sahifalash', () => {
  it('umumiy sonni va sahifani qaytaradi', async () => {
    for (let i = 0; i < 120; i++) {
      h.db.bookings.push({
        id: `b-${i}`, customer_id: 'u-mijoz', instructor_id: 'ip-1', course_id: 'c-b',
        booking_date: new Date(Date.now() - i * 3600e3).toISOString(), status: 'confirmed',
      });
    }
    const p1 = await h.call('GET', '/api/admin/bookings?page=1&per_page=50', { cookie: admin });
    expect(p1.body.total).toBe(120);
    expect(p1.body.has_more).toBe(true);

    const p3 = await h.call('GET', '/api/admin/bookings?page=3&per_page=50', { cookie: admin });
    expect(p3.body.page).toBe(3);
    expect(p3.body.has_more).toBe(false);
  });

  it('per_page ni 200 bilan cheklaydi', async () => {
    const r = await h.call('GET', '/api/admin/bookings?per_page=99999', { cookie: admin });
    expect(r.body.per_page).toBeLessThanOrEqual(200);
  });
});

describe('To‘lovni bekor qilish', () => {
  beforeEach(() => {
    h.db.payments.push({
      id: 'pay-1', booking_id: 'b-1', customer_id: 'u-mijoz', register_id: 'reg-p1',
      amount: 250000, method: 'cash', status: 'paid',
      paid_at: new Date().toISOString(), receipt_code: 'AVD-TEST-1',
    });
    h.db.bookings.push({ id: 'b-1', customer_id: 'u-mijoz', instructor_id: 'ip-1', status: 'confirmed' });
  });

  it('sababsiz bekor qilmaydi', async () => {
    const r = await h.call('POST', '/api/admin/payments/pay-1/refund', {
      cookie: admin, payload: { reason: '' },
    });
    expect(r.status).toBe(400);
    expect(h.db.payments[0].status).toBe('paid');
  });

  it('sabab bilan bekor qiladi va yozuvni SAQLAYDI', async () => {
    const r = await h.call('POST', '/api/admin/payments/pay-1/refund', {
      cookie: admin, payload: { reason: 'Xato chek chiqarildi' },
    });
    expect(r.status).toBe(200);

    const pay = h.db.payments[0];
    expect(pay.status).toBe('refunded');
    expect(pay.refund_reason).toBe('Xato chek chiqarildi');
    expect(pay.refunded_by).toBe('boss');
    expect(pay.amount).toBe(250000);        // summa o'zgarmaydi — tarix saqlanadi
  });

  it('ikki marta bekor qilmaydi', async () => {
    await h.call('POST', '/api/admin/payments/pay-1/refund', {
      cookie: admin, payload: { reason: 'Birinchi' },
    });
    const r = await h.call('POST', '/api/admin/payments/pay-1/refund', {
      cookie: admin, payload: { reason: 'Ikkinchi' },
    });
    expect(r.status).toBe(409);
    expect(h.db.payments[0].refund_reason).toBe('Birinchi');
  });

  it('bronni ham bekor qiladi', async () => {
    await h.call('POST', '/api/admin/payments/pay-1/refund', {
      cookie: admin, payload: { reason: 'Mijoz voz kechdi' },
    });
    expect(h.db.bookings.find((b) => b.id === 'b-1').status).toBe('cancelled');
  });

  it('mavjud bo‘lmagan to‘lovda 404', async () => {
    const r = await h.call('POST', '/api/admin/payments/yoq/refund', {
      cookie: admin, payload: { reason: 'test sababi' },
    });
    expect(r.status).toBe(404);
  });
});

describe('Null instruktor xavfsizligi (regressiya)', () => {
  it('instructor_id=null bo‘lgan bron ro‘yxatni buzmaydi', async () => {
    // ARALASH: bittasida instruktor bor, bittasida null.
    // Shunda in.(...) ro'yxatiga null tushib qolishi mumkin edi.
    h.db.bookings.push({
      id: 'b-real', customer_id: 'u-mijoz', instructor_id: 'ip-1', course_id: 'c-b',
      booking_date: new Date().toISOString(), status: 'confirmed',
    });
    h.db.bookings.push({
      id: 'b-null', customer_id: 'u-mijoz', instructor_id: null, course_id: null,
      booking_date: new Date().toISOString(), status: 'confirmed', instructor_name: 'O‘chirilgan',
    });
    const r = await h.call('GET', '/api/admin/bookings', { cookie: admin });
    expect(r.status).toBe(200);
    // "null" matni so'rovga ketmaganini bilvosita tekshiramiz:
    // ro'yxat qaytdi va ogohlantirish yo'q
    expect(r.body.warnings || []).toEqual([]);
    expect(r.body.bookings.length).toBeGreaterThan(0);
  });

  it('barcha instruktori null bronlar ham ishlaydi', async () => {
    for (let i = 0; i < 5; i++) {
      h.db.bookings.push({
        id: `bn-${i}`, customer_id: 'u-mijoz', instructor_id: null, course_id: null,
        booking_date: new Date().toISOString(), status: 'pending',
      });
    }
    const r = await h.call('GET', '/api/admin/bookings', { cookie: admin });
    expect(r.status).toBe(200);
    expect(r.body.warnings || []).toEqual([]);
  });
});
