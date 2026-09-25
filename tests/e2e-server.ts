/**
 * QO'LDA SINOV SERVERI — haqiqiy backend + xotiradagi soxta baza.
 * Brauzerda to'rt panelni (Admin, Kassa P1, Kassa P2, Operator) ochib
 * ko'rish uchun. Ishga tushirish:  npx vite-node tests/e2e-server.ts
 * Production bazasiga TEGMAYDI.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';

const PORT = Number(process.env.PORT || 8770);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const h = await makeHarness();
const db = h.db;
const TZ_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
const at = (hm: string, day = TZ_DAY) => new Date(`${day}T${hm}:00+05:00`).toISOString();

/* ---- rpc: chek kodi va kassa hisoboti ---- */
const baseFetch = globalThis.fetch;
let seq = 100;
globalThis.fetch = (async (u: any, o: any = {}) => {
  const url = String(u);
  const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body, headers: new Map() }) as any;
  if (url.includes('/rest/v1/rpc/generate_receipt_code')) {
    const d = TZ_DAY.slice(2).replace(/-/g, '');
    return ok(`AVD-${d}-${String.fromCharCode(65 + (seq % 26))}${(seq++).toString(36).toUpperCase().padStart(4, 'X')}`);
  }
  if (url.includes('/rest/v1/rpc/register_report')) {
    const start = new Date(`${TZ_DAY}T00:00:00+05:00`).getTime();
    return ok(db.cash_registers.map((r: any) => {
      const ps = db.payments.filter((p: any) => p.register_id === r.id && p.status === 'paid' && new Date(p.paid_at).getTime() >= start);
      const sum = (m: string) => ps.reduce((a: number, p: any) => a + (m === 'cash' ? Number(p.cash_amount ?? (p.method === 'cash' ? p.amount : 0)) : Number(p.card_amount ?? (p.method === 'card' ? p.amount : 0))), 0);
      return { register_id: r.id, code: r.code, name: r.name, receipts: ps.length, cash: sum('cash'), card: sum('card'), total: ps.reduce((a: number, p: any) => a + Number(p.amount), 0) };
    }));
  }
  if (url.includes('/rest/v1/rpc/get_instructor_registration_status')) {
    // Bazadagi funksiya o'rniga: instruktor users'da bo'lsa — tasdiqlangan
    const tg = Number(JSON.parse(String(o.body || '{}')).p_telegram_user_id);
    const u = db.users.find((x: any) => Number(x.telegram_id) === tg && x.role === 'instructor');
    return ok(u ? [{ status: 'APPROVED', first_name: u.full_name.split(' ')[0], last_name: u.full_name.split(' ')[1] || '', rejection_reason: null }] : []);
  }
  if (url.includes('/rest/v1/rpc/')) return ok({});
  return baseFetch(u, o);
}) as any;

/* ---- ma'lumotlar ---- */
db.cash_registers.push({ id: 'reg-p1', code: 'P1', name: 'Kassa P1', is_active: true, pin_hash: null });
db.cash_registers.push({ id: 'reg-p2', code: 'P2', name: 'Kassa P2', is_active: true, pin_hash: null });
const st = (id: string, login: string, role: string, register_id: string | null, full_name: string) =>
  db.staff.push({ id, login, password_hash: hashPassword('parol1234'), role, register_id, full_name, is_active: true });
st('st-admin', 'admin', 'admin', null, 'Bosh administrator');
st('st-op', 'operator', 'operator', null, 'Dilfuza (operator)');
st('st-k1', 'kassa1', 'cashier', 'reg-p1', 'Kassir P1');
st('st-k2', 'kassa2', 'cashier', 'reg-p2', 'Kassir P2');

db.users.push({ id: 'u-admin', full_name: 'Admin', role: 'admin', is_active: true, is_blocked: false });
const people = [
  ['u-1', 'Sardor Rahimov', '+998901234501', 5550001], ['u-2', 'Madina Karimova', '+998901234502', 5550002],
  ['u-3', 'Jasur Aliyev', '+998935550011', 5550003], ['u-4', 'Dilnoza Tursunova', '+998977770022', 5550004],
  ['u-5', 'Bekzod Nazarov', '+998901119933', null], ['u-6', 'Aziza Olimova', '+998909990011', 5550006],
  ['u-7', 'Otabek Yusupov', '+998909990012', 5550007], ['u-8', 'Shahzoda Mirzayeva', '+998909990013', 5550008],
] as const;
for (const [id, full_name, phone, tg] of people) {
  db.users.push({ id, full_name, phone, telegram_id: tg, role: 'customer', is_active: true, is_blocked: false, created_at: at('08:00') });
}
db.users.push({ id: 'u-ins1', full_name: 'Aziz Karimov', phone: '+998901114455', telegram_id: 880001, role: 'instructor', is_active: true, is_blocked: false });
db.users.push({ id: 'u-ins2', full_name: 'Anvar Sobirov', phone: '+998901114466', role: 'instructor', is_active: true, is_blocked: false });
db.instructor_profiles.push({ id: 'ip-1', user_id: 'u-ins1', is_verified: true, is_available: true, categories: ['B', 'C'], experience_years: 7,
  avatar_url: 'https://test.supabase.co/storage/v1/object/public/customer-media/avatars/ip-1.jpg', vehicle_model: 'Chevrolet Cobalt', vehicle_plate: '01 A 777 AA' });
db.instructor_profiles.push({ id: 'ip-2', user_id: 'u-ins2', is_verified: true, is_available: true, categories: ['B'], experience_years: 4 });
db.courses.push({ id: 'c-b', name: 'B toifa — yengil', category: 'B', price: 250000, duration_minutes: 60, is_active: true });
db.courses.push({ id: 'c-c', name: 'C toifa — yuk', category: 'C', price: 400000, duration_minutes: 60, is_active: true });
for (const [key, value] of Object.entries({ half_b: 150000, rate_b: 250000, half_c: 250000, rate_c: 400000, half_a: 200000, rate_a: 350000,
  work_start: '08:00', work_end: '18:00', slot_step_min: 60, address: 'Toshkent, Yangihayot tumani', mgmt_pin: { hash: 'maxfiy' },
  contact_phone: '+998507525555 +998703084888' })) {
  db.admin_settings.push({ key, value });
}

let bn = 0;
const bk = (customer: string, ins: string, hm: string, status: string, extra: any = {}) => {
  const id = `00000000-0000-4000-8000-${String(++bn).padStart(12, '0')}`;
  const start = extra.start || at(hm);
  db.bookings.push({ id, customer_id: customer, instructor_id: ins, course_id: 'c-b', category: 'B', duration_minutes: 60, hours: 1,
    start_at: start, booking_date: start, end_at: new Date(new Date(start).getTime() + 3600e3).toISOString(),
    status, source: 'app', pickup_code: `AVD-${4000 + bn}`, created_at: at('07:30'), ...extra });
  return id;
};
const pay = (booking_id: string, customer_id: string, code: string, hm: string, register_id: string, extra: any = {}) =>
  db.payments.push({ id: `pay-${code}`, booking_id, customer_id, amount: 250000, cash_amount: 250000, card_amount: 0, method: 'cash',
    status: 'paid', paid_at: at(hm), receipt_code: code, register_id, created_at: at(hm), ...extra });

// P1 kassasining bugungi cheklari
const d = TZ_DAY.slice(2).replace(/-/g, '');
const b1 = bk('u-1', 'ip-1', '09:00', 'completed', { arrived_at: at('09:02'), departed_at: at('10:00') });
pay(b1, 'u-1', `AVD-${d}-K7Q2M`, '08:52', 'reg-p1');
db.attendance_verifications.push({ booking_id: b1, receipt_code: `AVD-${d}-K7Q2M`, created_at: at('09:02') });
const b2 = bk('u-2', 'ip-2', '10:00', 'in_progress', { arrived_at: at('10:03') });
pay(b2, 'u-2', `AVD-${d}-P4X8N`, '09:47', 'reg-p1', { method: 'card', cash_amount: 0, card_amount: 250000 });
db.attendance_verifications.push({ booking_id: b2, receipt_code: `AVD-${d}-P4X8N`, created_at: at('10:03') });
const b3 = bk('u-3', 'ip-1', '14:00', 'confirmed');
pay(b3, 'u-3', `AVD-${d}-H2B9R`, '10:15', 'reg-p1');
const b4 = bk('u-4', 'ip-2', '15:00', 'confirmed', { category: 'B' });
pay(b4, 'u-4', `AVD-${d}-T6W3C`, '10:40', 'reg-p1', { method: 'mixed', cash_amount: 150000, card_amount: 100000 });
const b5 = bk('u-5', 'ip-1', '08:00', 'no_show');
pay(b5, 'u-5', `AVD-${d}-M8V1D`, '07:55', 'reg-p1');
const b6 = bk('u-6', 'ip-2', '11:00', 'confirmed');
pay(b6, 'u-6', `AVD-${d}-R5N7F`, '08:20', 'reg-p1', { status: 'refunded' });
// P2 kassasining cheklari — P1 ularni ko'rmasligi kerak
const b7 = bk('u-7', 'ip-1', '16:00', 'confirmed');
pay(b7, 'u-7', `AVD-${d}-Z9Y4P`, '09:10', 'reg-p2');
const b8 = bk('u-8', 'ip-2', '12:00', 'completed', { arrived_at: at('12:01') });
pay(b8, 'u-8', `AVD-${d}-W2L6S`, '11:05', 'reg-p2');

// Operator uchun: yangi (tasdiq kutayotgan) bronlar va bekor so'rovi
const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date(Date.now() + 864e5));
bk('u-6', 'ip-1', '17:00', 'pending', { start: at('10:00', tomorrow) });
bk('u-7', 'ip-2', '17:00', 'pending', { start: at('13:00', tomorrow) });
bk('u-8', 'ip-1', '17:00', 'confirmed', { start: at('15:00', tomorrow),
  cancel_requested_at: at('09:30'), cancel_request_reason: 'Ishim chiqib qoldi', cancel_requested_by: 'u-8' });
// 2 soatlik bron (ertaga 10:00–12:00) — ikkala soat ham band ko'rinishi kerak
bk('u-2', 'ip-2', '17:00', 'confirmed', { start: at('10:00', tomorrow), end_at: at('12:00', tomorrow), duration_minutes: 120, hours: 2, price: 500000 });
// Instruktor o'zi yopgan soat: bugun 13:00–14:00
db.admin_settings.push({ key: 'instructor_busy:ip-2', value: { blocks: [{ start_at: at('13:00'), end_at: at('14:00') }] } });
db.support_messages = [
  { id: 'sm-1', user_id: 'u-2', sender: 'customer', body: 'Assalomu alaykum, ertaga soat 10 ga bo‘sh joy bormi?', created_at: at('09:12'), is_read: false },
];

/* ---- HTTP: /api → Fastify, qolgani — statik fayllar ---- */
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json' };
http.createServer(async (req, res) => {
  const url = String(req.url || '/');
  if (url.startsWith('/api/')) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const r = await h.app.inject({ method: req.method as any, url, headers: req.headers as any, payload: chunks.length ? Buffer.concat(chunks) : undefined });
    const hdrs: Record<string, any> = {};
    for (const [k, v] of Object.entries(r.headers)) if (v !== undefined && k !== 'content-length' && k !== 'transfer-encoding') hdrs[k] = v;
    res.writeHead(r.statusCode, hdrs); res.end(r.rawPayload); return;
  }
  let p = decodeURIComponent(url.split('?')[0]);
  if (p === '/admin' || p === '/admin/') p = '/admin/index.html';
  if (p === '/instructor' || p === '/instructor/') p = '/instructor/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`E2E server: http://localhost:${PORT}/admin`));
