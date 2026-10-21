/**
 * KIRISH SAHIFASI FONI — admin rasm yuklaydi, kirish oynasi (login) shu rasmni
 * ko'k fon o'rnida ko'rsatadi. Manzil kirishdan OLDIN kerak — endpoint ochiq,
 * lekin yuklash va o'chirish faqat administratorga.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';

let h: Harness;
let admin = '', operator = '';
const PUB = 'https://test.supabase.co/storage/v1/object/public/customer-media/';

beforeAll(async () => { h = await makeHarness(); });
beforeEach(async () => {
  h.reset();
  h.db.staff.push({ id: 'st-admin', login: 'boss', password_hash: hashPassword('admin1234'), role: 'admin', register_id: null, is_active: true });
  h.db.staff.push({ id: 'st-op', login: 'op', password_hash: hashPassword('op123456'), role: 'operator', register_id: null, is_active: true });
  h.db.users.push({ id: 'u-admin', full_name: 'Admin', role: 'admin', is_active: true, is_blocked: false });
  admin = (await h.login('boss', 'admin1234')).cookie;
  operator = (await h.login('op', 'op123456')).cookie;
});

describe('Kirish sahifasi foni', () => {
  it('rasm yo‘q — url null (ko‘k fon); kirmasdan ham o‘qiladi', async () => {
    const r = await h.app.inject({ method: 'GET', url: '/api/admin/login-bg' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, url: null });
  });

  it('admin yuklaydi → kirish sahifasi shu rasmni oladi; Mini App ro‘yxatiga tushmaydi', async () => {
    const sign = await h.call('POST', '/api/admin/media/sign', { cookie: admin, payload: { title: 'Kirish foni', media_type: 'image', slot: 'login', content_type: 'image/jpeg', file_name: 'fon.jpg' } });
    expect(sign.status).toBe(200);
    expect(sign.body.key).toBe('login_bg');
    expect(sign.body.path).toMatch(/^login_bg\//);
    const c = await h.call('POST', '/api/admin/media/commit', { cookie: admin, payload: { title: 'Kirish foni', media_type: 'image', slot: 'login', path: sign.body.path, public_url: PUB + sign.body.path } });
    expect(c.status).toBe(200);
    expect(h.db.admin_media.find((m: any) => m.key === 'login_bg')).toMatchObject({ is_active: true, public_url: PUB + sign.body.path });
    const r = await h.app.inject({ method: 'GET', url: '/api/admin/login-bg' });
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, url: PUB + sign.body.path });
    /* mijoz ilovasi uchun kontentda ko'rinmaydi */
    const ct = await h.app.inject({ method: 'GET', url: '/api/content' });
    expect(JSON.parse(ct.body).media.some((m: any) => m.key === 'login_bg')).toBe(false);
    /* almashtirish: bitta yozuv qoladi */
    const s2 = await h.call('POST', '/api/admin/media/sign', { cookie: admin, payload: { title: 'Yangi', media_type: 'image', slot: 'login', content_type: 'image/png', file_name: 'b.png' } });
    await h.call('POST', '/api/admin/media/commit', { cookie: admin, payload: { title: 'Yangi', media_type: 'image', slot: 'login', path: s2.body.path, public_url: PUB + s2.body.path } });
    expect(h.db.admin_media.filter((m: any) => m.key === 'login_bg')).toHaveLength(1);
    /* o'chirish → yana ko'k fon */
    const id = h.db.admin_media.find((m: any) => m.key === 'login_bg').id;
    expect((await h.call('DELETE', `/api/admin/media/${id}`, { cookie: admin })).status).toBe(200);
    expect(JSON.parse((await h.app.inject({ method: 'GET', url: '/api/admin/login-bg' })).body).url).toBeNull();
  });

  it('faqat rasm; video va begona papka rad etiladi; operator yuklay olmaydi', async () => {
    const v = await h.call('POST', '/api/admin/media/sign', { cookie: admin, payload: { title: 'x', media_type: 'video', slot: 'login', content_type: 'video/mp4', file_name: 'a.mp4' } });
    expect(v.status).toBe(400);
    const bad = await h.call('POST', '/api/admin/media/commit', { cookie: admin, payload: { title: 'x', media_type: 'image', slot: 'login', path: 'home_image/a.jpg', public_url: PUB + 'home_image/a.jpg' } });
    expect(bad.status).toBe(400);
    const op = await h.call('POST', '/api/admin/media/sign', { cookie: operator, payload: { title: 'x', media_type: 'image', slot: 'login', content_type: 'image/jpeg', file_name: 'a.jpg' } });
    expect(op.status).toBe(403);
  });
});
