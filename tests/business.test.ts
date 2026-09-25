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

/* =========================================================================
   MIJOZ MINI APP — Telegram orqali bron
   ========================================================================= */
import crypto from 'node:crypto';

/** Telegram WebApp initData'ni haqiqiydek imzolaydi (bot tokeni: harness'dagi CUSTOMER_BOT_TOKEN). */
function signedInitData(user: Record<string, unknown>, botToken = '1:customer') {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAtest',
    user: JSON.stringify(user),
  });
  const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dataCheck).digest('hex'));
  return params.toString();
}

describe('Mijoz Mini App', () => {
  const init = () => signedInitData({ id: 777001, first_name: 'Mijoz', last_name: 'Test' });
  const tgCall = (method: string, url: string, payload?: any) =>
    h.app.inject({ method, url, headers: { 'x-telegram-init-data': init() }, payload });

  beforeEach(() => {
    h.db.users.push({ id: 'u-tg', telegram_id: 777001, full_name: 'Mijoz Test', role: 'customer', is_active: true, is_blocked: false });
    Object.assign(h.db.instructor_profiles[0], { vehicle_model: 'Chevrolet Cobalt', vehicle_plate: '01 A 555 AA' });
  });

  it('onlayn bronga kassa kodi beradi va narxni tarifdan hisoblaydi', async () => {
    const start = new Date(Date.now() + 26 * 3600e3).toISOString();
    const r = await tgCall('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', hours: 2, start_at: start });
    expect(r.statusCode).toBe(201);
    const b = JSON.parse(r.body).booking;
    expect(b.pickup_code).toMatch(/^AVD-\d{4,5}$/);      // kassir shu kod bilan topadi
    expect(b.duration_minutes).toBe(120);
    expect(b.price).toBe(500000);                         // B: 250 000 × 2 soat
    expect(h.db.bookings[0].pickup_code).toBe(b.pickup_code);
  });

  it('instruktor kartasida mashina ma’lumoti bor', async () => {
    const r = await tgCall('GET', '/api/instructors');
    expect(r.statusCode).toBe(200);
    const i = JSON.parse(r.body).instructors.find((x: any) => x.id === 'ip-1');
    expect(i.vehicle_model).toBe('Chevrolet Cobalt');
    expect(i.vehicle_plate).toBe('01 A 555 AA');
  });

  it('imzosiz so‘rovni rad etadi', async () => {
    const r = await h.app.inject({ method: 'GET', url: '/api/me', headers: { 'x-telegram-init-data': init().replace(/hash=[0-9a-f]+/, 'hash=00') } });
    expect(r.statusCode).toBe(401);
  });
});

describe('Mijoz telefoni — kassada ro‘yxatdan o‘tgan mijozni ulash', () => {
  const TG_ID = 777002;
  const init = () => signedInitData({ id: TG_ID, first_name: 'Vali' });
  const patchMe = (payload: any) =>
    h.app.inject({ method: 'PATCH', url: '/api/me', headers: { 'x-telegram-init-data': init() }, payload });
  /** requestContact javobi — Telegram imzolagandek */
  const contact = (phone: string, userId = TG_ID, token = '1:customer') => {
    const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), contact: JSON.stringify({ user_id: userId, phone_number: phone, first_name: 'Vali' }) });
    const chk = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    p.set('hash', crypto.createHmac('sha256', secret).update(chk).digest('hex'));
    return p.toString();
  };

  beforeEach(() => {
    // Mini App ochilganda yaratilgan bo'sh yozuv
    h.db.users.push({ id: 'u-new', telegram_id: TG_ID, full_name: 'Vali', role: 'customer', is_active: true, is_blocked: false });
    // Kassada / telefon orqali yaratilgan yozuv (Telegram'siz), bronlari bilan
    h.db.users.push({ id: 'u-old', telegram_id: null, full_name: 'Vali Aliyev', phone: '+998935554433', role: 'customer', is_active: true, is_blocked: false });
    h.db.bookings.push({ id: 'bk-old', customer_id: 'u-old', status: 'confirmed', start_at: new Date(Date.now() + 864e5).toISOString() });
  });

  it('bo‘sh raqamni formatlab saqlaydi', async () => {
    const r = await patchMe({ phone: '90 123 45 67', first_name: 'Vali', last_name: 'Sobirov' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).profile.phone).toBe('+998901234567');
  });

  it('band raqamni tasdiqsiz ulamaydi — Telegram raqamini so‘raydi', async () => {
    const r = await patchMe({ phone: '93 555 44 33' });
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).code).toBe('PHONE_NEEDS_CONTACT');
    expect(h.db.users.find((u) => u.id === 'u-old')!.telegram_id).toBeNull();
  });

  it('soxta imzoli kontakt bilan ulamaydi', async () => {
    const r = await patchMe({ phone: '93 555 44 33', contact: contact('998935554433', TG_ID, '9:boshqa-bot') });
    expect(r.statusCode).toBe(409);
    expect(h.db.users.find((u) => u.id === 'u-old')!.telegram_id).toBeNull();
  });

  it('boshqa odamning kontakti bilan ulamaydi', async () => {
    const r = await patchMe({ phone: '93 555 44 33', contact: contact('998935554433', 123456) });
    expect(r.statusCode).toBe(409);
  });

  it('Telegram tasdiqlagan raqam bilan eski hisobni ulaydi — bronlari ko‘rinadi', async () => {
    const r = await patchMe({ phone: '+998 93 555 44 33', first_name: 'Vali', last_name: 'Aliyev', contact: contact('998935554433') });
    expect(r.statusCode).toBe(200);
    const b = JSON.parse(r.body);
    expect(b.linked).toBe(true);
    expect(b.profile.id).toBe('u-old');
    expect(h.db.users.find((u) => u.id === 'u-old')!.telegram_id).toBe(TG_ID);
    expect(h.db.users.find((u) => u.id === 'u-new')).toBeUndefined();
    // Endi Mini App eski bronlarni ko'radi
    const list = await h.app.inject({ method: 'GET', url: '/api/bookings', headers: { 'x-telegram-init-data': init() } });
    expect(JSON.parse(list.body).bookings.map((x: any) => x.id)).toContain('bk-old');
  });

  it('boshqa Telegram hisobidagi raqamni bermaydi', async () => {
    h.db.users.find((u) => u.id === 'u-old')!.telegram_id = 999;
    const r = await patchMe({ phone: '93 555 44 33', contact: contact('998935554433') });
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).code).toBe('PHONE_TAKEN');
  });
});

describe('Bron qidiruvi (ism, telefon oxiri, bron kodi)', () => {
  const day = (offsetDays: number, hour = 10) => {
    const d = new Date(Date.now() + offsetDays * 864e5);
    const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(d);
    return new Date(`${ymd}T${String(hour).padStart(2, '0')}:00:00+05:00`).toISOString();
  };
  beforeEach(() => {
    h.db.users.push({ id: 'u-dil', full_name: 'Dilnoza Rahimova', phone: '+998935550011', role: 'customer', is_active: true });
    h.db.bookings.push(
      { id: 'bk-ali', customer_id: 'u-mijoz', instructor_id: 'ip-1', course_id: 'c-b', pickup_code: 'AVD-4821',
        booking_date: day(0, 10), start_at: day(0, 10), duration_minutes: 60, status: 'confirmed', category: 'B' },
      { id: 'bk-dil', customer_id: 'u-dil', instructor_id: 'ip-1', course_id: 'c-c', pickup_code: 'AVD-1357',
        booking_date: day(1, 14), start_at: day(1, 14), duration_minutes: 90, status: 'pending', category: 'C' },
      { id: 'bk-old', customer_id: 'u-dil', instructor_id: 'ip-1', course_id: 'c-b', pickup_code: 'AVD-2468',
        booking_date: day(-30, 9), start_at: day(-30, 9), status: 'completed' },
    );
  });

  const ids = (r: any) => (r.body.bookings || []).map((b: any) => b.id).sort();

  it('Bronlar ro‘yxati ism, familiya, telefon oxiri va kod bilan topadi', async () => {
    const get = (qs: string) => h.call('GET', `/api/admin/bookings?${qs}`, { cookie: admin });
    expect(ids(await get('q=ali'))).toEqual(['bk-ali']);
    expect(ids(await get('q=' + encodeURIComponent('dilnoza rahim')))).toEqual(['bk-dil', 'bk-old']);
    expect(ids(await get('q=2233'))).toEqual(['bk-ali']);            // telefon oxiri
    expect(ids(await get('q=0011'))).toEqual(['bk-dil', 'bk-old']);
    expect(ids(await get('q=AVD-4821'))).toEqual(['bk-ali']);
    expect(ids(await get('q=avd1357'))).toEqual(['bk-dil']);
    expect(ids(await get('q=4821'))).toEqual(['bk-ali']);            // faqat raqam — kod
    expect(ids(await get('q=hechkim'))).toEqual([]);
  });

  it('sana oralig‘i va tartib ishlaydi', async () => {
    const t = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
    const r = await h.call('GET', `/api/admin/bookings?from=${t}&order=asc`, { cookie: admin });
    expect(r.body.bookings.map((b: any) => b.id)).toEqual(['bk-ali', 'bk-dil']);
    const only = await h.call('GET', `/api/admin/bookings?from=${t}&to=${t}`, { cookie: admin });
    expect(ids(only)).toEqual(['bk-ali']);
  });

  it('kassa qidiruvi faqat to‘lanmagan, yaqin bronlarni beradi', async () => {
    h.db.payments.push({ id: 'p-dil', booking_id: 'bk-dil', amount: 600000, status: 'paid', receipt_code: 'R-1' });
    const k = await h.call('GET', '/api/admin/cashier/find?q=' + encodeURIComponent('Ali Valiyev'), { cookie: admin });
    expect(k.status).toBe(200);
    expect(ids(k)).toEqual(['bk-ali']);
    expect(k.body.bookings[0].category).toBe('B');
    expect(k.body.bookings[0].customer.full_name).toBe('Ali Valiyev');
    expect(k.body.bookings[0].instructor.profile.full_name).toBe('Aziz Karimov');

    // To'langan (bk-dil) va eski (bk-old) chiqmaydi
    const d = await h.call('GET', '/api/admin/cashier/find?q=0011', { cookie: admin });
    expect(ids(d)).toEqual([]);
    const empty = await h.call('GET', '/api/admin/cashier/find?q=', { cookie: admin });
    expect(empty.body.bookings).toEqual([]);
  });

  it('kassa qidiruvi kirmagan foydalanuvchiga yopiq', async () => {
    const r = await h.call('GET', '/api/admin/cashier/find?q=ali');
    expect(r.status).toBe(401);
  });

  it('PostgREST ni buzadigan belgilar tozalanadi', async () => {
    const r = await h.call('GET', '/api/admin/bookings?q=' + encodeURIComponent('ali),(id.eq.x'), { cookie: admin });
    expect(r.status).toBe(200);
  });
});

describe('Instruktor rasmi', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('admin rasm yuklaydi va u darhol instruktorga yoziladi', async () => {
    const r = await h.call('POST', '/api/admin/instructors/ip-1/photo', { cookie: admin, payload: { photo_data_url: PNG } });
    expect(r.status).toBe(200);
    expect(r.body.avatar_url).toMatch(/^https:\/\/test\.supabase\.co\/storage\/v1\/object\/public\/customer-media\/avatars\/ip-1-\d+\.png$/);
    expect(h.db.instructor_profiles[0].avatar_url).toBe(r.body.avatar_url);
  });

  it('noto‘g‘ri fayl va kirmagan foydalanuvchi rad etiladi', async () => {
    const bad = await h.call('POST', '/api/admin/instructors/ip-1/photo', { cookie: admin, payload: { photo_data_url: 'data:text/html;base64,PGgxPg==' } });
    expect(bad.status).toBe(400);
    const anon = await h.call('POST', '/api/admin/instructors/ip-1/photo', { payload: { photo_data_url: PNG } });
    expect(anon.status).toBe(401);
  });

  it('rasm manzili faqat o‘z storage’imizdan qabul qilinadi', async () => {
    const ok = await h.call('PATCH', '/api/admin/instructors/ip-1', { cookie: admin,
      payload: { avatar_url: 'https://test.supabase.co/storage/v1/object/public/customer-media/avatars/a.jpg' } });
    expect(ok.status).toBe(200);
    const bad = await h.call('PATCH', '/api/admin/instructors/ip-1', { cookie: admin, payload: { avatar_url: 'https://evil.example/a.jpg' } });
    expect(bad.status).toBe(400);
    const clear = await h.call('PATCH', '/api/admin/instructors/ip-1', { cookie: admin, payload: { avatar_url: '' } });
    expect(clear.status).toBe(200);
    expect(h.db.instructor_profiles[0].avatar_url).toBeNull();
  });

  it('eski tizimdagi photo_url mijozga ham ko‘rinadi', async () => {
    h.db.instructor_profiles[0].photo_url = 'https://test.supabase.co/storage/v1/object/public/customer-media/old.jpg';
    const r = await h.app.inject({ method: 'GET', url: '/api/instructors', headers: { 'x-telegram-init-data': signedInitData({ id: 5150, first_name: 'Test' }) } });
    const body = JSON.parse(r.body);
    expect(r.statusCode).toBe(200);
    const ins = body.instructors.find((i: any) => i.id === 'ip-1');
    expect(ins?.avatar_url).toBe('https://test.supabase.co/storage/v1/object/public/customer-media/old.jpg');
  });
});

/* =========================================================================
   INSTRUKTOR PANELI — hisob-kitob, sharhlar yopiq, eslatmalar
   ========================================================================= */
describe('Instruktor paneli', () => {
  const INS_TG = 880001;
  const insInit = () => signedInitData({ id: INS_TG, first_name: 'Aziz' }, '1:instructor');
  const insCall = (method: string, url: string, payload?: any) =>
    h.app.inject({ method, url, headers: { 'x-telegram-init-data': insInit() }, payload })
      .then((r: any) => ({ status: r.statusCode, body: JSON.parse(r.body || '{}') }));

  const bk = (id: string, start: string, extra: Record<string, unknown> = {}) => ({
    id, customer_id: 'u-mijoz', instructor_id: 'ip-1', course_id: 'c-b',
    start_at: start, booking_date: start,
    end_at: new Date(new Date(start).getTime() + 3600e3).toISOString(),
    status: 'completed', source: 'app', ...extra,
  });

  beforeEach(() => {
    const u = h.db.users.find((x: any) => x.id === 'u-instr');
    u.telegram_id = INS_TG;
    h.db.instructor_profiles[0].total_reviews = 12;
    h.db.bookings.push(
      bk('b-school', '2026-09-05T05:00:00.000Z', { source: 'avtodrom12', school_receipt_code: 'AVS-12345' }),
      bk('b-paid',   '2026-09-06T06:00:00.000Z', { duration_minutes: 90 }),
      bk('b-late',   '2026-09-10T18:30:00.000Z', { status: 'in_progress' }),   // Toshkent: 10-sent 23:30
      bk('b-noshow', '2026-09-07T06:00:00.000Z', { status: 'no_show' }),
      bk('b-other',  '2026-09-06T08:00:00.000Z', { instructor_id: 'ip-2' }),     // boshqa instruktor
      bk('b-out',    '2026-09-10T20:00:00.000Z'),                                 // Toshkent: 11-sent 01:00
    );
  });

  it('hisob-kitob: dan–gacha, avtoshkola va pullik alohida, soat bilan', async () => {
    const r = await insCall('GET', '/api/instructor/summary?from=2026-09-01&to=2026-09-10');
    expect(r.status).toBe(200);
    const s = r.body.summary;
    expect(s.school).toMatchObject({ lessons: 1, completed: 1, minutes: 60 });
    expect(s.paid).toMatchObject({ lessons: 2, completed: 1, in_progress: 1, minutes: 90 });
    expect(s.minutes).toBe(150);
    expect(s.no_show).toBe(1);
    const ids = r.body.rows.map((x: any) => x.id).sort();
    expect(ids).toEqual(['b-late', 'b-noshow', 'b-paid', 'b-school']);
    // Pul summalari instruktorga ko'rsatilmaydi
    expect(JSON.stringify(r.body)).not.toMatch(/amount|revenue/);
    expect(r.body.days.map((d: any) => d.date)).toEqual(['2026-09-05', '2026-09-06', '2026-09-10']);
  });

  it('hisob-kitob: sanalar teskari berilsa ham ishlaydi, 1 yildan uzun rad etiladi', async () => {
    const r = await insCall('GET', '/api/instructor/summary?from=2026-09-10&to=2026-09-01');
    expect(r.status).toBe(200);
    expect(r.body.from).toBe('2026-09-01');
    const long = await insCall('GET', '/api/instructor/summary?from=2024-01-01&to=2026-09-01');
    expect(long.status).toBe(400);
  });

  it('sharhlar va reyting instruktorga ko‘rinmaydi', async () => {
    const rv = await insCall('GET', '/api/instructor/reviews');
    expect(rv.status).toBe(403);
    const me = await insCall('GET', '/api/instructor/me');
    expect(me.status).toBe(200);
    expect(me.body.instructor.categories).toEqual(['A', 'B']);
    expect(me.body.instructor.rating).toBeUndefined();
    expect(me.body.instructor.total_reviews).toBeUndefined();
    const st = await insCall('GET', '/api/instructor/stats');
    expect(st.body.stats.rating).toBeUndefined();
  });

  it('instruktor mijozga eslatma yuboradi, 10 daqiqada bir martadan ko‘p emas', async () => {
    h.db.users.find((x: any) => x.id === 'u-mijoz').telegram_id = 555001;
    const start = new Date(Date.now() + 3 * 3600e3).toISOString();
    h.db.bookings.push(bk('b-soon', start, { status: 'pending' }));
    const r = await insCall('POST', '/api/instructor/bookings/b-soon/remind');
    expect(r.status).toBe(200);
    const msg = h.telegram.find((m) => m.chat === 555001);
    expect(msg?.text).toMatch(/Instruktor Aziz Karimov eslatmoqda/);
    expect(msg?.text).toMatch(/3 soat qoldi/);
    const again = await insCall('POST', '/api/instructor/bookings/b-soon/remind');
    expect(again.status).toBe(429);
    // Boshqa instruktorning broni — yo'q
    const other = await insCall('POST', '/api/instructor/bookings/b-other/remind');
    expect(other.status).toBe(404);
    // Tugagan dars — eslatma kerak emas
    const done = await insCall('POST', '/api/instructor/bookings/b-paid/remind');
    expect(done.status).toBe(400);
  });

  it('Telegrami yo‘q mijoz uchun telefon raqami qaytadi', async () => {
    const start = new Date(Date.now() + 3600e3).toISOString();
    h.db.bookings.push(bk('b-walkin', start, { status: 'confirmed' }));
    const r = await insCall('POST', '/api/instructor/bookings/b-walkin/remind');
    expect(r.status).toBe(400);
    expect(r.body.phone).toBe('+998901112233');
  });
});

describe('Avtomatik eslatmalar', () => {
  it('kutilayotgan (pending) bron egasiga ham eslatma ketadi va takrorlanmaydi', async () => {
    h.db.users.find((x: any) => x.id === 'u-mijoz').telegram_id = 555002;
    const start = new Date(Date.now() + 25 * 60000 + 30000).toISOString();
    h.db.bookings.push({ id: 'b-pend', customer_id: 'u-mijoz', instructor_id: 'ip-1', course_id: 'c-b',
      start_at: start, booking_date: start, status: 'pending', pickup_code: 'AVD-4321' });

    const cron = () => h.app.inject({ method: 'GET', url: '/api/cron/reminders', headers: { authorization: 'Bearer test-cron-secret' } });
    const r1 = JSON.parse((await cron()).body);
    expect(r1.sent).toBe(1);
    const msg = h.telegram.find((m) => m.chat === 555002)!;
    expect(msg.text).toMatch(/25 daqiqa qoldi/);
    expect(msg.text).toMatch(/AVD-4321/);
    expect(h.db.booking_reminders[0]).toMatchObject({ booking_id: 'b-pend', kind: 30 });

    const r2 = JSON.parse((await cron()).body);
    expect(r2.sent).toBe(0);
    expect(h.telegram.filter((m) => m.chat === 555002)).toHaveLength(1);

    // Oxirgi ishga tushish yozib qo'yildi — admin kartasi shuni ko'rsatadi
    const lr = h.db.admin_settings.find((x: any) => x.key === 'reminders_last_run');
    expect(lr?.value?.source).toBe('cron');
  });

  it('jadval mos bo‘lmasa xato jim yutilmaydi', async () => {
    const start = new Date(Date.now() + 20 * 60000).toISOString();
    h.db.users.find((x: any) => x.id === 'u-mijoz').telegram_id = 555003;
    h.db.bookings.push({ id: 'b-x', customer_id: 'u-mijoz', instructor_id: 'ip-1', start_at: start, booking_date: start, status: 'confirmed' });
    const orig = globalThis.fetch;
    globalThis.fetch = (async (u: any, o: any = {}) => {
      if (String(u).includes('/rest/v1/booking_reminders') && String(o.method).toUpperCase() === 'POST') {
        return { ok: false, status: 400, text: async () => JSON.stringify({ code: '42703', message: 'column "kind" does not exist' }), headers: new Map() } as any;
      }
      return orig(u, o);
    }) as any;
    try {
      const r = await h.app.inject({ method: 'GET', url: '/api/cron/reminders', headers: { authorization: 'Bearer test-cron-secret' } });
      const body = JSON.parse(r.body);
      expect(body.failed).toBe(1);
      expect(body.details.join(' ')).toMatch(/booking_reminders jadvali xatosi/);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('panel «tick»i faqat kirgan xodimga va daqiqasiga bir marta', async () => {
    const { _resetTickForTests } = await import('../backend/src/reminders.js');
    _resetTickForTests();
    const anon = await h.call('POST', '/api/admin/reminders/tick');
    expect(anon.status).toBe(401);
    const a = await h.call('POST', '/api/admin/reminders/tick', { cookie: admin });
    expect(a.status).toBe(200);
    expect(a.body.ran).toBe(true);
    const b = await h.call('POST', '/api/admin/reminders/tick', { cookie: admin });
    expect(b.body.ran).toBe(false);
  });

  it('admin tekshiruvi jadval va oxirgi ishga tushishni ko‘rsatadi', async () => {
    const r = await h.call('GET', '/api/admin/reminder-check', { cookie: admin });
    expect(r.status).toBe(200);
    const names = r.body.checks.map((c: any) => c.name);
    expect(names).toContain('Eslatmalar jadvali');
    expect(names).toContain('Oxirgi tekshiruv');
  });
});

/* =========================================================================
   INSTRUKTOR O'Z VAQTINI YOPADI — mijoz ham, operator ham bron qila olmaydi
   ========================================================================= */
describe('Instruktor yopgan soatlar', () => {
  const INS_TG = 880002, CUST_TG = 777777;
  const insCall = (method: string, url: string, payload?: any) =>
    h.app.inject({ method, url, headers: { 'x-telegram-init-data': signedInitData({ id: INS_TG, first_name: 'Aziz' }, '1:instructor') }, payload })
      .then((r: any) => ({ status: r.statusCode, body: JSON.parse(r.body || '{}') }));
  const custCall = (method: string, url: string, payload?: any) =>
    h.app.inject({ method, url, headers: { 'x-telegram-init-data': signedInitData({ id: CUST_TG, first_name: 'Ali' }) }, payload })
      .then((r: any) => ({ status: r.statusCode, body: JSON.parse(r.body || '{}') }));
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date(Date.now() + 2 * 864e5));
  const at = (hm: string) => new Date(`${day}T${hm}:00+05:00`).toISOString();

  beforeEach(() => {
    h.db.users.find((x: any) => x.id === 'u-instr').telegram_id = INS_TG;
    h.db.users.push({ id: 'u-cust', telegram_id: CUST_TG, full_name: 'Ali Mijoz', phone: '+998901119999', role: 'customer', is_active: true, is_blocked: false });
  });

  it('instruktor soatni yopadi — mijoz ko‘radi va bron qila olmaydi', async () => {
    const put = await insCall('PUT', '/api/instructor/blocks', { date: day, slots: [{ from: '14:00', to: '15:00' }] });
    expect(put.status).toBe(200);
    expect(put.body.blocks).toHaveLength(1);
    const get = await insCall('GET', `/api/instructor/blocks?from=${day}&to=${day}`);
    expect(get.body.blocks[0].start_at).toBe(at('14:00'));

    const av = await custCall('GET', `/api/instructors/ip-1/availability?date=${day}`);
    expect(av.body.busy.some((b: any) => b.start_at === at('14:00') && b.end_at === at('15:00'))).toBe(true);

    const bad = await custCall('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', hours: 1, start_at: at('14:00') });
    expect(bad.status).toBe(409);
    const ok = await custCall('POST', '/api/bookings', { instructor_id: 'ip-1', course_id: 'c-b', hours: 1, start_at: at('16:00') });
    expect(ok.status).toBe(201);
  });

  it('qo‘lda bron va bo‘sh instruktorlar ro‘yxati ham hisobga oladi', async () => {
    await insCall('PUT', '/api/instructor/blocks', { date: day, slots: [{ from: '09:00', to: '12:00' }] });
    const manual = await h.call('POST', '/api/admin/manual-booking', { cookie: admin, payload: {
      full_name: 'Qo‘lda Mijoz', phone: '+998905550000', instructor_id: 'ip-1', category: 'B', duration_minutes: 60, start_at: at('10:00') } });
    expect(manual.status).toBe(409);
    expect(manual.body.error).toMatch(/band qilgan/);
    const free = await h.call('GET', `/api/admin/cashier/free-instructors?at=${encodeURIComponent(at('10:00'))}&minutes=60&category=B`, { cookie: admin });
    expect(free.body.free.map((x: any) => x.id)).not.toContain('ip-1');
    const b = free.body.busy.find((x: any) => x.id === 'ip-1');
    expect(b.blocked).toBe(true);
    expect(b.free_at).toBe(at('12:00'));
    const later = await h.call('POST', '/api/admin/manual-booking', { cookie: admin, payload: {
      full_name: 'Qo‘lda Mijoz', phone: '+998905550000', instructor_id: 'ip-1', category: 'B', duration_minutes: 60, start_at: at('12:00') } });
    expect(later.status).toBeLessThan(300);
  });

  it('qayta ochadi; bron bor soatni va o‘tgan kunni yopib bo‘lmaydi', async () => {
    await insCall('PUT', '/api/instructor/blocks', { date: day, slots: [{ from: '14:00', to: '15:00' }] });
    const open = await insCall('PUT', '/api/instructor/blocks', { date: day, slots: [] });
    expect(open.body.blocks).toEqual([]);
    const av = await custCall('GET', `/api/instructors/ip-1/availability?date=${day}`);
    expect(av.body.busy).toEqual([]);

    h.db.bookings.push({ id: 'b-bor', customer_id: 'u-mijoz', instructor_id: 'ip-1', start_at: at('11:00'), end_at: at('12:00'), booking_date: at('11:00'), status: 'confirmed' });
    const clash = await insCall('PUT', '/api/instructor/blocks', { date: day, slots: [{ from: '11:00', to: '12:00' }] });
    expect(clash.status).toBe(409);
    const past = await insCall('PUT', '/api/instructor/blocks', { date: '2020-01-01', slots: [] });
    expect(past.status).toBe(400);
    const badTime = await insCall('PUT', '/api/instructor/blocks', { date: day, slots: [{ from: '15:00', to: '14:00' }] });
    expect(badTime.status).toBe(400);
  });

  it('boshqa kunning yopiq soatlariga tegmaydi', async () => {
    const day2 = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date(Date.now() + 3 * 864e5));
    await insCall('PUT', '/api/instructor/blocks', { date: day, slots: [{ from: '08:00', to: '09:00' }] });
    await insCall('PUT', '/api/instructor/blocks', { date: day2, slots: [{ from: '10:00', to: '11:00' }] });
    const all = await insCall('GET', `/api/instructor/blocks?from=${day}&to=${day2}`);
    expect(all.body.blocks).toHaveLength(2);
  });
});
