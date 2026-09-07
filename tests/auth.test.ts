import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword, verifyPassword } from '../backend/src/staff-auth.js';

let h: Harness;

beforeAll(async () => { h = await makeHarness(); });

beforeEach(() => {
  h.reset();
  h.db.cash_registers.push({ id: 'reg-p1', code: 'P1', name: '1-kassa' });
  h.db.cash_registers.push({ id: 'reg-p2', code: 'P2', name: '2-kassa' });
  h.db.staff.push({
    id: 'st-admin', login: 'boss', password_hash: hashPassword('admin1234'),
    role: 'admin', register_id: null, full_name: 'Bosh admin', is_active: true,
  });
  h.db.staff.push({
    id: 'st-kassir', login: 'kassir1', password_hash: hashPassword('kassir1234'),
    role: 'cashier', register_id: 'reg-p1', full_name: 'P1 kassir', is_active: true,
  });
});

describe('Parol xeshlash', () => {
  it('to‘g‘ri parolni tanidi, noto‘g‘risini rad etdi', () => {
    const hash = hashPassword('MyS3cret!');
    expect(verifyPassword('MyS3cret!', hash)).toBe(true);
    expect(verifyPassword('MyS3cret', hash)).toBe(false);
    expect(verifyPassword('', hash)).toBe(false);
  });

  it('bir xil parol har safar boshqa xesh beradi (tuz)', () => {
    expect(hashPassword('parol')).not.toBe(hashPassword('parol'));
  });

  it('buzuq xeshda yiqilmaydi', () => {
    for (const bad of ['', 'axlat', 'md5$aa$bb', 'scrypt$$', 'scrypt$zz$zz']) {
      expect(verifyPassword('x', bad)).toBe(false);
    }
  });
});

describe('Kirish', () => {
  it('xodim hisobi bilan kiradi va rolini qaytaradi', async () => {
    const r = await h.login('kassir1', 'kassir1234');
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('cashier');
    expect(r.body.register_id).toBe('reg-p1');
  });

  it('login katta-kichik harfga bog‘liq emas', async () => {
    const r = await h.login('KASSIR1', 'kassir1234');
    expect(r.status).toBe(200);
  });

  it('noto‘g‘ri parolni rad etadi', async () => {
    const r = await h.login('kassir1', 'notogri');
    expect(r.status).toBe(401);
  });

  it('eski env admin zaxira sifatida ishlaydi', async () => {
    const r = await h.login('root', 'rootpass123');
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('admin');
    expect(r.body.legacy).toBe(true);
  });
});

describe('Rol chegarasi', () => {
  const ADMIN_ONLY = [
    '/api/admin/stats', '/api/admin/instructors', '/api/admin/bookings',
    '/api/admin/customers', '/api/admin/courses', '/api/admin/applications',
    '/api/admin/audit-logs', '/api/admin/staff', '/api/admin/media',
  ];

  it('kassirni boshqaruv endpointlaridan bloklaydi', async () => {
    const k = await h.login('kassir1', 'kassir1234');
    for (const url of ADMIN_ONLY) {
      const r = await h.call('GET', url, { cookie: k.cookie });
      expect(r.status, `${url} ochiq qoldi`).toBe(403);
    }
  });

  it('kassirni o‘z bo‘limlariga qo‘yadi', async () => {
    const k = await h.login('kassir1', 'kassir1234');
    for (const url of ['/api/admin/me', '/api/admin/payments', '/api/admin/in-progress']) {
      const r = await h.call('GET', url, { cookie: k.cookie });
      expect(r.status, `${url} yopiq qoldi`).toBeLessThan(400);
    }
  });

  it('adminni hamma joyga qo‘yadi', async () => {
    const a = await h.login('boss', 'admin1234');
    for (const url of ADMIN_ONLY) {
      const r = await h.call('GET', url, { cookie: a.cookie });
      expect(r.status, `${url} adminga yopiq`).toBeLessThan(400);
    }
  });

  it('sessiyasiz 401 qaytaradi', async () => {
    const r = await h.call('GET', '/api/admin/stats');
    expect(r.status).toBe(401);
  });
});

describe('Token xavfsizligi', () => {
  it('rolni "admin" ga o‘zgartirgan soxta tokenni rad etadi', async () => {
    const forged = Buffer.from(`kassir1|st-kassir|admin|-|${Date.now()}|deadbeef`).toString('base64url');
    const r = await h.call('GET', '/api/admin/stats', { cookie: `avtodrom_admin_session=${forged}` });
    expect(r.status).toBe(401);
  });

  it('muddati o‘tgan tokenni rad etadi', async () => {
    const old = Date.now() - 13 * 60 * 60 * 1000;   // TTL 12 soat
    const stale = Buffer.from(`boss|st-admin|admin|-|${old}|x`).toString('base64url');
    const r = await h.call('GET', '/api/admin/stats', { cookie: `avtodrom_admin_session=${stale}` });
    expect(r.status).toBe(401);
  });

  it('axlat tokenni rad etadi', async () => {
    for (const bad of ['', 'abc', 'YWJj', '....']) {
      const r = await h.call('GET', '/api/admin/stats', { cookie: `avtodrom_admin_session=${bad}` });
      expect(r.status).toBe(401);
    }
  });
});

describe('Xodimlarni boshqarish', () => {
  it('parolni kamida 8 belgi talab qiladi', async () => {
    const a = await h.login('boss', 'admin1234');
    const r = await h.call('POST', '/api/admin/staff', {
      cookie: a.cookie,
      payload: { login: 'yangi1', password: '123', role: 'cashier', register_id: 'reg-p1' },
    });
    expect(r.status).toBe(400);
  });

  it('kassirga kassa biriktirilishini talab qiladi', async () => {
    const a = await h.login('boss', 'admin1234');
    const r = await h.call('POST', '/api/admin/staff', {
      cookie: a.cookie,
      payload: { login: 'yangi2', password: 'parol1234', role: 'cashier' },
    });
    expect(r.status).toBe(400);
  });

  it('admin o‘z hisobini o‘chira olmaydi', async () => {
    const a = await h.login('boss', 'admin1234');
    const r = await h.call('DELETE', '/api/admin/staff/st-admin', { cookie: a.cookie });
    expect(r.status).toBe(409);
  });

  it('yangi xodim darhol kira oladi', async () => {
    const a = await h.login('boss', 'admin1234');
    const created = await h.call('POST', '/api/admin/staff', {
      cookie: a.cookie,
      payload: { login: 'kassir9', password: 'parol1234', role: 'cashier', register_id: 'reg-p2', full_name: 'P2' },
    });
    expect(created.status).toBe(201);

    const r = await h.login('kassir9', 'parol1234');
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('cashier');
  });
});
