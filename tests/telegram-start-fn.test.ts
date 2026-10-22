/**
 * MIJOZ BOTI (Supabase Edge Function `telegram-start`) — Node'da, Deno va
 * fetch soxtalashtirilib tekshiriladi.
 *  - hamma tugmalar «Ilovani ochish», «Mini App» so'zi yo'q
 *  - bio / qisqa tavsif / buyruqlar / menyu / webhook (sir) — bir marta o'rnatiladi
 *  - Bronlarim, Narxlar, Manzil, Aloqa; ruscha
 *  - oddiy savol Vercel yordam tizimiga uzatiladi (faqat sir tasdiqlansa)
 *  - kanal: ulanish, /kanal, e'lon yuborish va mahkamlash
 */
import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { webhookSecret as backendSecret } from '../backend/src/webhook-secret.js';

const TOKEN = '123:ABC';
const SB = 'https://proj.supabase.co';
const ENV: Record<string, string> = { TELEGRAM_BOT_TOKEN: TOKEN, SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: 'svc' };
const SECRET = crypto.createHash('sha256').update(`avtodrom-webhook:${TOKEN}`).digest('hex').slice(0, 48);
const USER = 901043970, CHANNEL = -1001777;

type Call = { method: string; body: any };
let calls: Call[] = [];
let db: Record<string, any[]> = {};
let backend: { status: number; ok: boolean; got: any[] } = { status: 200, ok: true, got: [] };
let handler: (req: Request) => Promise<Response>;
let msgId = 100;

function resetDb() {
  db = {
    admin_settings: [
      { key: 'rate_a', value: { value: 350000 } }, { key: 'rate_b', value: { value: 250000 } }, { key: 'rate_c', value: { value: 400000 } },
      { key: 'half_a', value: { value: 200000 } }, { key: 'half_b', value: { value: 150000 } }, { key: 'half_c', value: { value: 250000 } },
      { key: 'paket5_b', value: { value: 1100000 } },
      { key: 'contact_phone', value: { value: '+998507525555, +998703084888' } },
      { key: 'work_start', value: { value: '06:00' } }, { key: 'work_end', value: { value: '20:00' } },
      { key: 'location', value: { name: 'TASH INDEX AVTODROM', address: 'Rayxon ko‘chasi, 107-uy', latitude: 41.2995, longitude: 69.2041, google_url: 'https://maps.app.goo.gl/x', yandex_url: 'https://yandex.uz/maps/-/y' } },
    ],
    users: [{ id: 'u1', telegram_id: USER }],
    bookings: [],
    telegram_users: [],
  };
}

const tgResult: Record<string, (b: any) => any> = {
  getMe: () => ({ id: 8554237228, is_bot: true, username: 'avtodrom_index_bot' }),
  sendMessage: (b) => ({ message_id: ++msgId, chat: { id: b.chat_id } }),
  getChat: (b) => (String(b.chat_id) === '@avtodromindex' || Number(b.chat_id) === CHANNEL
    ? { id: CHANNEL, type: 'channel', title: 'AVTODROM INDEX', username: 'avtodromindex' } : null),
  getChatMember: (b) => defaultMember(b),
};
const defaultMember = (b: any) => (Number(b.user_id) === 8554237228 ? { status: 'administrator', can_post_messages: true }
  : Number(b.user_id) === USER ? { status: 'creator' } : { status: 'member' });

async function fakeFetch(input: any, init: any = {}): Promise<Response> {
  const url = String(input);
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (url.startsWith(`https://api.telegram.org/bot${TOKEN}/`)) {
    const method = url.split('/').pop()!;
    calls.push({ method, body });
    const f = tgResult[method];
    const result = f ? f(body) : true;
    return result === null ? ok({ ok: false, description: 'Bad Request: chat not found' }) : ok({ ok: true, result });
  }
  if (url.startsWith('https://avtodrom.vercel.app/api/telegram/customer/webhook')) {
    backend.got.push({ headers: init.headers, body });
    return ok({ ok: backend.ok }, backend.status);
  }
  if (url.startsWith(`${SB}/rest/v1/`)) {
    const u = new URL(url);
    const table = u.pathname.split('/').pop()!;
    const method = String(init.method || 'GET');
    if (method === 'POST') {
      const key = table === 'admin_settings' ? 'key' : 'telegram_id';
      const i = db[table].findIndex((r) => r[key] === body[key]);
      if (i >= 0) db[table][i] = { ...db[table][i], ...body }; else db[table].push(body);
      return new Response('', { status: 201 });
    }
    let rows = [...(db[table] || [])];
    for (const [k, v] of u.searchParams.entries()) {
      if (['select', 'order', 'limit'].includes(k)) continue;
      const [op, ...rest] = v.split('.'); const val = rest.join('.');
      if (op === 'eq') rows = rows.filter((r) => String(r[k]) === val);
      if (op === 'in') { const l = val.replace(/^\(|\)$/g, '').split(','); rows = rows.filter((r) => l.includes(String(r[k]))); }
      if (op === 'gte') rows = rows.filter((r) => Date.parse(r[k]) >= Date.parse(val));
    }
    return ok(rows);
  }
  throw new Error('unexpected fetch ' + url);
}

async function load() {
  vi.resetModules();
  (globalThis as any).Deno = { env: { get: (k: string) => ENV[k] }, serve: (h: any) => { handler = h; } };
  vi.stubGlobal('fetch', fakeFetch);
  await import('../supabase/functions/telegram-start/index.ts');
}
async function post(update: any, secret: string | null = SECRET) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret) headers['x-telegram-bot-api-secret-token'] = secret;
  const r = await handler(new Request(`${SB}/functions/v1/telegram-start`, { method: 'POST', headers, body: JSON.stringify(update) }));
  return { status: r.status, body: await r.json() };
}
const from = (lang = 'uz') => ({ id: USER, is_bot: false, first_name: 'Ali', language_code: lang });
const msg = (text: string, lang = 'uz') => ({ update_id: 1, message: { message_id: 5, from: from(lang), chat: { id: USER, type: 'private' }, text } });
const cb = (data: string, lang = 'uz') => ({ update_id: 2, callback_query: { id: 'cq1', from: from(lang), data, message: { message_id: 77, chat: { id: USER, type: 'private' } } } });
const sent = () => calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method));
const all = () => JSON.stringify(calls.map((c) => c.body));

beforeEach(async () => {
  calls = []; backend = { status: 200, ok: true, got: [] }; resetDb();
  tgResult.getChatMember = defaultMember;
  await load();
});

describe('Bot profili', () => {
  it('birinchi update’da bio, qisqa tavsif, buyruqlar, menyu va webhook (sir bilan) o‘rnatiladi — bir marta', async () => {
    const r = await post(msg('/start'), null);
    expect(r.status).toBe(200);
    const m = (name: string) => calls.filter((c) => c.method === name);
    expect(m('setMyDescription')).toHaveLength(2);
    expect(m('setMyShortDescription')).toHaveLength(2);
    expect(m('setMyCommands').length).toBe(3);
    for (const d of m('setMyDescription')) expect(d.body.description.length).toBeLessThanOrEqual(512);
    for (const d of m('setMyShortDescription')) expect(d.body.short_description.length).toBeLessThanOrEqual(120);
    expect(m('setMyDescription')[0].body.description).toContain('darhol tasdiqlanadi');
    expect(m('setMyDescription')[1].body.language_code).toBe('ru');
    const cmds = m('setMyCommands')[0].body.commands.map((c: any) => c.command);
    expect(cmds).toEqual(['start', 'bron', 'bronlarim', 'narxlar', 'manzil', 'aloqa', 'yordam']);
    const menu = m('setChatMenuButton')[0].body.menu_button;
    expect(menu).toEqual({ type: 'web_app', text: '📱 Ilovani ochish', web_app: { url: 'https://avtodrom.vercel.app/' } });
    const wh = m('setWebhook')[0].body;
    expect(wh.secret_token).toBe(SECRET);
    expect(wh.secret_token).toBe(backendSecret('', TOKEN));          // Vercel bilan bir xil sir
    expect(wh.allowed_updates).toContain('my_chat_member');
    expect(wh.drop_pending_updates).toBe(false);
    const st = db.admin_settings.find((s) => s.key === 'customer_bot_profile')!.value;
    expect(st.ok).toBe(true);

    calls = [];
    await post(msg('/start'));
    expect(calls.some((c) => c.method === 'setMyDescription')).toBe(false);
  });

  it('avto-tasdiq o‘chirilsa — bio qayta yoziladi («darhol» so‘zisiz)', async () => {
    await post(msg('/start'));
    db.admin_settings.push({ key: 'booking_auto_confirm', value: { value: false } });
    calls = [];
    await post(msg('/start'));
    const d = calls.find((c) => c.method === 'setMyDescription')!;
    expect(d.body.description).not.toContain('darhol');
  });

  it('noto‘g‘ri sir — 401', async () => {
    expect((await post(msg('/start'), 'wrong')).status).toBe(401);
  });
});

describe('Xabarlar va tugmalar', () => {
  it('/start: bosh menyu, «Ilovani ochish», «Mini App» so‘zi hech qayerda yo‘q', async () => {
    await post(msg('/start'));
    const s = sent()[0];
    expect(s.body.text).toContain('Assalomu alaykum');
    expect(s.body.text).toContain('darhol tasdiqlanadi');
    const kb = s.body.reply_markup.inline_keyboard;
    expect(kb[0][0]).toEqual({ text: '📱 Ilovani ochish', web_app: { url: 'https://avtodrom.vercel.app/' } });
    expect(kb[1][0].web_app.url).toBe('https://avtodrom.vercel.app/?open=book');
    expect(all()).not.toMatch(/Mini App/i);
  });

  it('/start bron (kanal havolasi) — bron bo‘limi', async () => {
    await post(msg('/start bron'));
    expect(sent()[0].body.text).toContain('Dars bron qilish');
  });

  it('ruscha foydalanuvchi — ruscha menyu va ruscha menyu tugmasi', async () => {
    await post(msg('/start', 'ru'));
    const s = sent()[0];
    expect(s.body.text).toContain('Здравствуйте');
    expect(s.body.reply_markup.inline_keyboard[0][0].text).toBe('📱 Открыть приложение');
    const chatMenu = calls.find((c) => c.method === 'setChatMenuButton' && c.body.chat_id === USER)!;
    expect(chatMenu.body.menu_button.text).toBe('📱 Приложение');
  });

  it('/bronlarim — kelgusi bronlar, holat va kassa kodi', async () => {
    const t = (h: number) => new Date(Date.now() + h * 3600e3).toISOString();
    db.bookings.push(
      { customer_id: 'u1', status: 'confirmed', start_at: t(24), end_at: t(25), pickup_code: 'AVD-4821', category: 'B', instructor: { user: { full_name: 'Aziz Karimov' } } },
      { customer_id: 'u1', status: 'cancelled', start_at: t(30), end_at: t(31), pickup_code: 'AVD-1111' },
      { customer_id: 'u2', status: 'confirmed', start_at: t(26), end_at: t(27), pickup_code: 'AVD-2222' },
    );
    await post(msg('/bronlarim'));
    const s = sent()[0].body;
    expect(s.text).toContain('AVD-4821');
    expect(s.text).toContain('✅ Tasdiqlangan');
    expect(s.text).toContain('Aziz Karimov');
    expect(s.text).not.toContain('AVD-1111');
    expect(s.text).not.toContain('AVD-2222');
    expect(s.reply_markup.inline_keyboard[0][0].web_app.url).toBe('https://avtodrom.vercel.app/?open=bookings');
  });

  it('bron yo‘q — «1 daqiqada bron qiling» va Bron tugmasi', async () => {
    await post(msg('/bronlarim'));
    expect(sent()[0].body.text).toContain('kelgusi bron yo‘q');
  });

  it('Narxlar tugmasi (ruscha) — xabar almashtiriladi, narxlar sozlamadan', async () => {
    await post(cb('pr:ru', 'ru'));
    const e = calls.find((c) => c.method === 'editMessageText')!;
    expect(e.body.message_id).toBe(77);
    expect(e.body.text).toContain('Цены');
    expect(e.body.text).toContain('250 000');
    expect(e.body.text).toContain('1 100 000');
    expect(e.body.text).toContain('3 часа — <b>700 000</b> <s>750 000</s>');   // 3 soatlik tarif (standart)
  });

  it('Manzil — xaritadagi joy va Google/Yandex tugmalari', async () => {
    await post(cb('loc:uz'));
    const v = calls.find((c) => c.method === 'sendVenue')!;
    expect(v.body.latitude).toBe(41.2995);
    const s = sent().pop()!.body;
    expect(JSON.stringify(s.reply_markup)).toContain('Google Maps');
  });

  it('Aloqa — telefonlar chiroyli, ish vaqti', async () => {
    await post(msg('/aloqa'));
    const t = sent()[0].body.text;
    expect(t).toContain('+998 50 752 55 55');
    expect(t).toContain('06:00–20:00');
  });

  it('eski xabardagi «Bronlarim» tugmasi ham ishlaydi', async () => {
    await post(cb('my_bookings'));
    expect(calls.find((c) => c.method === 'editMessageText')!.body.text).toContain('Bronlarim');
  });

  it('shaxsiy bo‘lmagan chat — javob yo‘q (begona chatga ma’lumot ketmaydi)', async () => {
    const u = msg('/bronlarim');
    u.message.chat = { id: 555, type: 'private' } as any;
    const r = await post(u);
    expect(r.body.action).toBe('not_private');
    expect(sent()).toHaveLength(0);
  });
});

describe('Savollar — yordam tizimiga', () => {
  it('sir tasdiqlangan oddiy savol Vercel’ga sir bilan uzatiladi, bot o‘zi javob yozmaydi', async () => {
    const r = await post(msg('Narxi qancha?'));
    expect(r.body.action).toBe('support');
    expect(backend.got).toHaveLength(1);
    expect(backend.got[0].headers['x-telegram-bot-api-secret-token']).toBe(SECRET);
    expect(sent()).toHaveLength(0);
  });

  it('Vercel javob bermasa — bot o‘zi qisqa javob va «Ilovani ochish»', async () => {
    backend = { status: 401, ok: false, got: [] };
    const r = await post(msg('Salom'));
    expect(r.body.action).toBe('fallback');
    const s = sent()[0].body;
    expect(s.reply_markup.inline_keyboard[0][0].text).toBe('📱 Ilovani ochish');
    expect(s.text).not.toMatch(/Mini App/i);
  });

  it('sirsiz (tasdiqlanmagan) update uzatilmaydi', async () => {
    await post(msg('Salom'), null);
    expect(backend.got).toHaveLength(0);
    expect(sent()).toHaveLength(1);
  });
});

describe('Kanal', () => {
  it('bot kanalga admin qilib qo‘shilsa — eslab qoladi va qo‘shgan odamga /kanal ni aytadi', async () => {
    const r = await post({ update_id: 3, my_chat_member: { chat: { id: CHANNEL, type: 'channel', title: 'AVTODROM INDEX', username: 'avtodromindex' }, from: from(), new_chat_member: { status: 'administrator', can_post_messages: true } } });
    expect(r.body.action).toBe('channel_added');
    expect(db.admin_settings.find((s) => s.key === 'customer_bot_channels')!.value.list[0].id).toBe(CHANNEL);
    expect(sent()[0].body.chat_id).toBe(USER);
    expect(sent()[0].body.text).toContain('/kanal');
  });

  it('sirsiz my_chat_member — e’tiborsiz', async () => {
    const r = await post({ update_id: 3, my_chat_member: { chat: { id: CHANNEL, type: 'channel' }, from: from(), new_chat_member: { status: 'administrator' } } }, null);
    expect(r.body.action).toBe('ignored');
  });

  it('/kanal — e’lon ko‘rinishi va tugmalar; tugma bosilsa kanalga yuboriladi va mahkamlanadi', async () => {
    await post(msg('/kanal'));
    const preview = sent()[0].body;
    expect(preview.text).toContain('endi onlayn bron');
    expect(preview.reply_markup.inline_keyboard[0][0].url).toBe('https://t.me/avtodrom_index_bot?start=bron');
    const pick = sent()[1].body.reply_markup.inline_keyboard[0];
    expect(pick[1].callback_data).toBe(`chp:${CHANNEL}:1`);

    calls = [];
    await post(cb(`chp:${CHANNEL}:1`));
    const toCh = calls.find((c) => c.method === 'sendMessage' && c.body.chat_id === CHANNEL)!;
    expect(toCh.body.text).toContain('TASH INDEX AVTODROM');
    expect(calls.some((c) => c.method === 'pinChatMessage' && c.body.chat_id === CHANNEL)).toBe(true);
    expect(sent().pop()!.body.text).toContain('https://t.me/avtodromindex/');
  });

  it('kanal admini bo‘lmagan odam yubora olmaydi', async () => {
    tgResult.getChatMember = (b) => (Number(b.user_id) === 8554237228 ? { status: 'administrator', can_post_messages: true } : { status: 'member' });
    await post(cb(`chp:${CHANNEL}:0`));
    expect(calls.some((c) => c.method === 'sendMessage' && c.body.chat_id === CHANNEL)).toBe(false);
    expect(calls.find((c) => c.method === 'answerCallbackQuery')!.body.text).toMatch(/admini emassiz/);
  });

  it('sirsiz tugma bosilsa — kanalga yuborilmaydi', async () => {
    await post(cb(`chp:${CHANNEL}:0`), null);
    expect(calls.some((c) => c.method === 'sendMessage' && c.body.chat_id === CHANNEL)).toBe(false);
  });
});
