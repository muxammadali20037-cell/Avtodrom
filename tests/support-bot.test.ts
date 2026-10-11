/**
 * YORDAM — AVTOMATIK JAVOB
 *  · ko'p beriladigan savollarga bot o'zi javob beradi (o'zbekcha lotin/kirill, ruscha);
 *  · javob admin sozlamalaridan (narx o'zgarsa — javob ham);
 *  · topilmasa — «adminga yubordim», savol o'qilmagan qoladi, admin botiga xabar;
 *  · admin javobini «avto-javobga saqlash» — keyingi safar bot o'zi javob beradi;
 *  · mijoz botiga oddiy matn yozilsa ham xuddi shunday.
 */
process.env.ADMIN_BOT_TOKEN = '1:admin';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import { answerQuestion, normalize, isRussian } from '../backend/src/support-bot.js';

let h: Harness;
let admin = '', operator = '';
const CUST_TG = 777120, ADMIN_CHAT = 6140529649;
const at = (d: number, hm: string) => new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date(Date.now() + d * 864e5))}T${hm}:00+05:00`).toISOString();

function signedInitData(user: Record<string, unknown>, botToken = '1:customer') {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAtest', user: JSON.stringify(user) });
  const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dataCheck).digest('hex'));
  return params.toString();
}
const cust = (method: string, url: string, payload?: any) =>
  h.app.inject({ method, url, payload, headers: { 'x-telegram-init-data': signedInitData({ id: CUST_TG, first_name: 'Ali' }) } })
    .then((r: any) => ({ status: r.statusCode, body: JSON.parse(r.body || '{}') }));
const ask = (text: string) => cust('POST', '/api/support/messages', { body: text });
const adminPings = () => h.telegram.filter((m) => m.chat === ADMIN_CHAT);
const settings = (kv: Record<string, any>) => { for (const [key, value] of Object.entries(kv)) h.db.admin_settings.push({ key, value: { value } }); };

beforeAll(async () => { h = await makeHarness(); });
beforeEach(async () => {
  h.reset();
  h.db.staff.push({ id: 'st-admin', login: 'boss', password_hash: hashPassword('admin1234'), role: 'admin', register_id: null, is_active: true });
  h.db.staff.push({ id: 'st-op', login: 'oper', password_hash: hashPassword('parol1234'), role: 'operator', register_id: null, full_name: 'Operator', is_active: true });
  h.db.users.push({ id: 'u-admin', full_name: 'Admin', role: 'admin', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-cust', telegram_id: CUST_TG, full_name: 'Ali Mijoz', phone: '+998901119999', role: 'customer', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-ins', full_name: 'Aziz Karimov', role: 'instructor', is_active: true, is_blocked: false });
  h.db.instructor_profiles.push({ id: 'ip-1', user_id: 'u-ins', is_verified: true, is_available: true, categories: ['B'] });
  h.db.telegram_admins.push({ id: 1, telegram_chat_id: ADMIN_CHAT, is_active: true });
  settings({ rate_b: 260000, half_b: 160000, work_start: '07:00', work_end: '20:00', contact_phone: '+998 90 000 11 22', address: 'Toshkent, Chilonzor 5' });
  admin = (await h.login('boss', 'admin1234')).cookie;
  operator = (await h.login('oper', 'parol1234')).cookie;
});

describe('Matnni tushunish', () => {
  it('kirill, apostrof, h/x, q/k farqi yo‘qoladi; ruscha aniqlanadi', () => {
    expect(normalize('Нархлари қанча?')).toBe('narxlari kancha');
    expect(normalize('O‘tkazmoqchiman, rahmat')).toBe('otkazmokchiman raxmat');
    expect(isRussian('Сколько стоит час?')).toBe(true);
    expect(isRussian('Нархи қанча')).toBe(false);
  });

  it('tayyor mavzular: narx (sozlamadan), ish vaqti, manzil, bekor, to‘lov, kechikish', async () => {
    const s = { rate_b: 260000, half_b: 160000, work_start: '07:00', work_end: '20:00', address: 'Toshkent, Chilonzor 5', late_cancel_min: 15 };
    const t = async (q: string) => (await answerQuestion(q, { settings: s }));
    let a = await t('Narxlar qancha?');
    expect(a).toMatchObject({ kind: 'intent', escalate: false, topics: ['prices'] });
    expect(a.text).toMatch(/^🤖 /);
    expect(a.text).toMatch(/B toifa .*1 soat — 260 000 so‘m/);
    expect((await t('1 soati necha pul')).topics[0]).toBe('prices');
    expect((await t('Ish vaqtingiz qanaqa?')).text).toMatch(/07:00–20:00/);
    expect((await t('Qayerda joylashgansiz')).text).toMatch(/Chilonzor 5[\s\S]*google\.com\/maps/);
    expect((await t('Бронни бекор қилмоқчиман')).topics).toContain('cancel');
    expect((await t('karta orqali to‘lasa bo‘ladimi')).topics[0]).toBe('payment');
    expect((await t('10 minut kechiksam nima bo‘ladi')).text).toMatch(/15 daqiqa kechiksangiz/);
    const ru = await t('Сколько стоит час вождения?');
    expect(ru.text).toMatch(/Цены[\s\S]*1 час — 260 000 сум/);
  });

  it('ma’lumot yo‘q yoki admin kerak — adminga (escalate)', async () => {
    const s = {};
    expect(await answerQuestion('Mashinangiz avtomatmi yoki mexanika?', { settings: s })).toMatchObject({ kind: 'unknown', escalate: true });
    expect(await answerQuestion('Guvohnoma olish uchun nima kerak?', { settings: s })).toMatchObject({ escalate: true });
    const r = await answerQuestion('Bronimni boshqa vaqtga o‘tkazmoqchiman', { settings: s });
    expect(r).toMatchObject({ kind: 'intent', escalate: true });
    expect(r.topics[0]).toBe('reschedule');
    expect(await answerQuestion('Kecha futbol kim yutdi', { settings: s })).toMatchObject({ kind: 'unknown', escalate: true });
  });

  it('salom va rahmat — muloyim javob, adminni bezovta qilmaydi', async () => {
    expect(await answerQuestion('Assalomu alaykum', { settings: {} })).toMatchObject({ kind: 'greet', escalate: false });
    expect(await answerQuestion('Katta rahmat!', { settings: {} })).toMatchObject({ kind: 'thanks', escalate: false });
  });
});

describe('Mini App chati', () => {
  it('javobi bor savol — bot darhol javob beradi, adminga xabar yo‘q, savol o‘qilgan', async () => {
    const r = await ask('Narxlar haqida savolim bor');
    expect(r.status).toBe(201);
    expect(r.body.reply.body).toMatch(/^🤖 💰 Narxlar/);
    expect(h.db.support_messages.find((m: any) => m.sender === 'customer').is_read).toBe(true);
    expect(adminPings()).toHaveLength(0);
    const list = await h.call('GET', '/api/admin/support', { cookie: operator });
    expect(list.body.threads[0].unread).toBe(0);
  });

  it('«mening bronim» — mijozning o‘z bronlari va kassa kodi', async () => {
    h.db.bookings.push({ id: 'b1', customer_id: 'u-cust', instructor_id: 'ip-1', status: 'confirmed', start_at: at(1, '10:00'), end_at: at(1, '11:00'), category: 'B', pickup_code: 'AVD-4821' });
    const r = await ask('Mening bronim qachon? kodim qaysi');
    expect(r.body.reply.body).toMatch(/Bronlaringiz[\s\S]*10:00 · B toifa · Aziz Karimov[\s\S]*AVD-4821/);
  });

  it('javobsiz savol — «adminga yubordim», o‘qilmagan qoladi, admin botiga xabar; ketma-ket qatorlarda bitta', async () => {
    const r = await ask('Mashinangiz qaysi rangda?');
    expect(r.body.reply.body).toMatch(/adminga yubordim/);
    expect(h.db.support_messages.find((m: any) => m.sender === 'customer').is_read).toBe(false);
    expect(adminPings()).toHaveLength(1);
    expect(adminPings()[0].text).toMatch(/❓ Javobsiz savol — Mini App[\s\S]*Ali Mijoz \(\+998901119999\)[\s\S]*qaysi rangda/);
    const r2 = await ask('Oq rangdami?');
    expect(r2.body.reply).toBeNull();                                   // yana «adminga yubordim» demaydi
    expect(adminPings()).toHaveLength(1);                                // admin ham bitta xabar oladi
    const list = await h.call('GET', '/api/admin/support', { cookie: admin });
    expect(list.body.threads[0].unread).toBe(2);
  });

  it('admin javobini «avto-javobga saqlash» — keyingi o‘xshash savolga bot o‘zi javob beradi', async () => {
    await ask('Mashinangiz qaysi rangda?');
    const rep = await h.call('POST', '/api/admin/support/u-cust/reply', { cookie: operator, payload: { body: 'Mashinalarimiz oq rangli Cobalt.', save_kb: true } });
    expect(rep.status).toBe(201);
    expect(rep.body.learned).toMatchObject({ q: ['Mashinangiz qaysi rangda?'], a: 'Mashinalarimiz oq rangli Cobalt.' });
    const r = await ask('mashinalar qanaqa rangda?');
    expect(r.body.reply.body).toBe('🤖 Mashinalarimiz oq rangli Cobalt.');
    expect(adminPings()).toHaveLength(1);                                // faqat birinchi savolda
  });

  it('bot o‘chirilsa — eskicha: javob yo‘q, adminga xabar', async () => {
    const off = await h.call('PUT', '/api/admin/support-bot', { cookie: admin, payload: { on: false } });
    expect(off.body.on).toBe(false);
    const r = await ask('Narxlar qancha?');
    expect(r.body.reply).toBeNull();
    expect(adminPings()).toHaveLength(1);
  });
});

describe('Mijoz boti (Mini App ochmasdan yozsa)', () => {
  const botSays = (text: string, id = 880777) => h.app.inject({
    method: 'POST', url: '/api/telegram/customer/webhook',
    headers: { 'x-telegram-bot-api-secret-token': 'test-webhook-secret' },
    payload: { update_id: 9, message: { message_id: 9, chat: { id, type: 'private' }, from: { id, first_name: 'Vali', last_name: 'Botov' }, text } },
  });
  it('savol → Telegram’da javob, yozishma admin chatida; yangi foydalanuvchi yaratiladi', async () => {
    const r = await botSays('Ish vaqtingiz qanaqa?');
    expect(r.statusCode).toBe(200);
    const sent = h.telegram.filter((m) => m.chat === 880777).pop()!;
    expect(sent.text).toMatch(/^🤖 🕘 Ish vaqti: 07:00–20:00/);
    expect(sent.markup.inline_keyboard[0][0].web_app.url).toBeTruthy();
    const u = h.db.users.find((x: any) => Number(x.telegram_id) === 880777);
    expect(u.full_name).toBe('Vali Botov');
    expect(h.db.support_messages.filter((m: any) => m.user_id === u.id).map((m: any) => m.sender)).toEqual(['customer', 'admin']);
  });
  it('javobsiz savol — adminga «Telegram bot» belgisi bilan', async () => {
    await botSays('Siz bilan hamkorlik qilsak bo‘ladimi?');
    expect(adminPings()[0].text).toMatch(/❓ Javobsiz savol — Telegram bot/);
  });
});

describe('Admin: avto-javob sozlamalari', () => {
  it('mavzular, bilim bazasini tahrirlash, sinab ko‘rish', async () => {
    const g = await h.call('GET', '/api/admin/support-bot', { cookie: operator });
    expect(g.status).toBe(200);
    expect(g.body.on).toBe(true);
    expect(g.body.topics.find((t: any) => t.id === 'prices').preview).toMatch(/260 000/);
    const p = await h.call('PUT', '/api/admin/support-bot', { cookie: admin, payload: { kb: [{ q: ['Wi-Fi bormi?', 'internet bormi'], a: 'Ha, bepul Wi-Fi bor.' }] } });
    expect(p.status).toBe(200);
    expect(p.body.kb).toHaveLength(1);
    const t = await h.call('POST', '/api/admin/support-bot-test', { cookie: operator, payload: { text: 'Sizda internet bormi?' } });
    expect(t.body).toMatchObject({ kind: 'kb', text: 'Ha, bepul Wi-Fi bor.' });
    const bad = await h.call('PUT', '/api/admin/support-bot', { cookie: admin, payload: { kb: [{ q: [''], a: 'x' }] } });
    expect(bad.status).toBe(400);
  });
});
