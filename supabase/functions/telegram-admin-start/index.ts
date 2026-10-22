/**
 * TASH INDEX AVTODROM — mijoz boti (@avtodrom_index_bot) webhook'i.
 *
 * Supabase Edge Function: telegram-start. Telegram shu manzilga update yuboradi.
 *
 *  • /start, /bron, /bronlarim, /narxlar, /manzil, /aloqa, /yordam (+ ruscha matn)
 *  • hamma tugmalar — «📱 Ilovani ochish» (eski «Mini Appni ochish» yo'q)
 *  • «Bronlarim» — kelgusi bronlar, holati va kassa kodi bot ichida
 *  • narx, manzil (xarita), telefon — admin sozlamalaridan (admin_settings)
 *  • oddiy savol — Vercel'dagi avto-javob/yordam tizimiga uzatiladi
 *    (u ishlamasa — bot o'zi qisqa javob beradi)
 *  • bot profili (bio, qisqa tavsif, buyruqlar, menyu tugmasi) — o'zi o'rnatiladi:
 *    PROFILE_VERSION o'zgarsa birinchi update'da yangilanadi
 *  • kanal: bot kanalga admin qilib qo'shilsa eslab qoladi; /kanal — kanalga
 *    «Onlayn bron» e'lonini yuborish (faqat o'sha kanal adminlari)
 *
 * Xavfsizlik: webhook `secret_token` bilan o'rnatiladi. Sir noto'g'ri bo'lsa —
 * 401. Shaxsiy ma'lumot faqat o'sha odamning shaxsiy chatiga yuboriladi; kanalga
 * yozish va sozlamani o'zgartirish faqat sir tasdiqlangan update'da.
 */

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/telegram-start`;
const APP_URL = 'https://avtodrom.vercel.app/';
const BACKEND_WEBHOOK = 'https://avtodrom.vercel.app/api/telegram/customer/webhook';
const INSTAGRAM_URL = 'https://www.instagram.com/avtodrom_index_/';
const CHANNEL_URL = 'https://t.me/avtodromindex';
const DEFAULT_CHANNEL = '@avtodromindex';
const BOT_USERNAME_FALLBACK = 'avtodrom_index_bot';

/** Bio / buyruqlar / menyu o'zgarsa — shu raqamni oshiring, bot o'zi yangilaydi */
const PROFILE_VERSION = 4;
const PROFILE_KEY = 'customer_bot_profile';
const CHANNELS_KEY = 'customer_bot_channels';
const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member'];

type Lang = 'uz' | 'ru';
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

/* ------------------------------------------------------------------ */
/* Telegram va Supabase                                                */
/* ------------------------------------------------------------------ */
async function tg(method: string, body: Record<string, unknown> = {}): Promise<any> {
  if (!BOT_TOKEN) return { ok: false, description: 'TELEGRAM_BOT_TOKEN yo‘q' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { ok: false, description: text.slice(0, 200) }; }
  } catch (e) { return { ok: false, description: String(e) }; }
}

async function rest(path: string, init: { method?: string; body?: unknown; prefer?: string } = {}): Promise<any> {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  const headers: Record<string, string> = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
  if (init.prefer) headers.Prefer = init.prefer;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: init.method || 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!r.ok) throw new Error(`${path.split('?')[0]}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
const unwrap = (v: any) => (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v ? v.value : v);

async function settings(keys: string[]): Promise<Record<string, any>> {
  try {
    const rows = await rest(`admin_settings?key=in.(${keys.map(encodeURIComponent).join(',')})&select=key,value`);
    const out: Record<string, any> = {};
    for (const r of rows || []) out[r.key] = unwrap(r.value);
    return out;
  } catch (e) { console.error('settings:', e); return {}; }
}
async function saveSetting(key: string, value: unknown) {
  await rest('admin_settings?on_conflict=key', {
    method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
    body: { key, value, updated_at: new Date().toISOString() },
  });
}

async function saveUser(user: any) {
  if (!user?.id || user.is_bot) return;
  try {
    await rest('telegram_users', {
      method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
      body: { telegram_id: user.id, first_name: user.first_name || null, last_name: user.last_name || null, username: user.username || null, language_code: user.language_code || null, updated_at: new Date().toISOString() },
    });
  } catch (e) { console.error('saveUser:', e); }
}

let SECRET = '';
async function webhookSecret(): Promise<string> {
  if (SECRET || !BOT_TOKEN) return SECRET;
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`avtodrom-webhook:${BOT_TOKEN}`));
  SECRET = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
  return SECRET;
}

let BOT: { id: number; username: string } | null = null;
async function me() {
  if (BOT) return BOT;
  const r = await tg('getMe');
  BOT = r?.ok ? { id: Number(r.result.id), username: String(r.result.username || BOT_USERNAME_FALLBACK) } : { id: 0, username: BOT_USERNAME_FALLBACK };
  return BOT;
}

/* ------------------------------------------------------------------ */
/* Matnlar                                                             */
/* ------------------------------------------------------------------ */
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (n: unknown) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const langOf = (u: any): Lang => (String(u?.language_code || '').toLowerCase().startsWith('ru') ? 'ru' : 'uz');
const app = (open?: string) => (open ? `${APP_URL}?open=${encodeURIComponent(open)}` : APP_URL);
const OFF = [false, 'false', 0, '0', 'off', 'no'];
const autoOn = (s: Record<string, any>) => !OFF.includes(s.booking_auto_confirm);

const L = {
  uz: {
    open: '📱 Ilovani ochish', book: '🚗 Bron qilish', my: '📅 Bronlarim', prices: '💵 Narxlar', loc: '📍 Manzil',
    contact: '☎️ Aloqa', other: '🇷🇺 Русский', insta: '📸 Instagram', channel: '📢 Kanal', back: '⬅️ Menyu',
    help: '❓ Yordam', ask: '💬 Savol berish', menuBtn: '📱 Ilovani ochish',
  },
  ru: {
    open: '📱 Открыть приложение', book: '🚗 Забронировать', my: '📅 Мои брони', prices: '💵 Цены', loc: '📍 Адрес',
    contact: '☎️ Контакты', other: '🇺🇿 O‘zbekcha', insta: '📸 Instagram', channel: '📢 Канал', back: '⬅️ Меню',
    help: '❓ Помощь', ask: '💬 Задать вопрос', menuBtn: '📱 Приложение',
  },
};

const MON = {
  uz: ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'],
  ru: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
};
const WD = {
  uz: ['yakshanba', 'dushanba', 'seshanba', 'chorshanba', 'payshanba', 'juma', 'shanba'],
  ru: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'],
};
/** Toshkent vaqti (UTC+5, yozgi vaqt yo'q) */
const tk = (iso: string) => new Date(Date.parse(iso) + 5 * 3600e3);
const hm = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
function when(startIso: string, endIso: string | null, lang: Lang) {
  const s = tk(startIso);
  const day = lang === 'ru'
    ? `${s.getUTCDate()} ${MON.ru[s.getUTCMonth()]}, ${WD.ru[s.getUTCDay()]}`
    : `${s.getUTCDate()}-${MON.uz[s.getUTCMonth()]}, ${WD.uz[s.getUTCDay()]}`;
  return `${day} · ${hm(s)}${endIso ? `–${hm(tk(endIso))}` : ''}`;
}
const fmtPhone = (p: string) => {
  const d = p.replace(/\D/g, '');
  return /^998\d{9}$/.test(d) ? `+998 ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8, 10)} ${d.slice(10, 12)}` : p.trim();
};

function homeText(name: string, lang: Lang, auto: boolean) {
  return lang === 'ru'
    ? `👋 Здравствуйте, <b>${esc(name)}</b>!\n\n🚗 <b>TASH INDEX AVTODROM</b> — официальный бот для записи на занятия на автодроме.\n\n` +
      `⚡ Онлайн-бронь — за 1 минуту\n${auto ? '✅ Бронь подтверждается сразу — без ожидания' : '✅ Подтверждение придёт сюда, в Telegram'}\n` +
      `🎫 Назовите код в кассе — и сразу в машину\n🔔 Напоминание о занятии придёт сюда\n\n👇 Откройте приложение или выберите раздел`
    : `👋 Assalomu alaykum, <b>${esc(name)}</b>!\n\n🚗 <b>TASH INDEX AVTODROM</b> — avtodromda mashq darslari uchun rasmiy bot.\n\n` +
      `⚡ Onlayn bron — 1 daqiqada\n${auto ? '✅ Bron darhol tasdiqlanadi — kutish yo‘q' : '✅ Tasdiq shu yerga, Telegram’ga keladi'}\n` +
      `🎫 Kassada kodni ayting — to‘g‘ri mashinaga\n🔔 Dars oldidan eslatma shu yerga keladi\n\n👇 Ilovani oching yoki bo‘limni tanlang`;
}
function homeKb(lang: Lang) {
  const t = L[lang], o: Lang = lang === 'ru' ? 'uz' : 'ru';
  return { inline_keyboard: [
    [{ text: t.open, web_app: { url: app() } }],
    [{ text: t.book, web_app: { url: app('book') } }, { text: t.my, callback_data: `my:${lang}` }],
    [{ text: t.prices, callback_data: `pr:${lang}` }, { text: t.loc, callback_data: `loc:${lang}` }],
    [{ text: t.contact, callback_data: `ct:${lang}` }, { text: t.other, callback_data: `home:${o}` }],
    [{ text: t.insta, url: INSTAGRAM_URL }, { text: t.channel, url: CHANNEL_URL }],
  ] };
}
const backKb = (lang: Lang, extra: any[][] = []) => ({ inline_keyboard: [...extra, [{ text: L[lang].open, web_app: { url: app() } }], [{ text: L[lang].back, callback_data: `home:${lang}` }]] });

function bookText(lang: Lang, auto: boolean) {
  return lang === 'ru'
    ? `🚗 <b>Запись на занятие</b>\n\n1️⃣ Категория — A, B или C\n2️⃣ Длительность — 30 минут, 1 или 2 часа (или пакет 5 часов)\n3️⃣ День и время\n4️⃣ Свободный инструктор\n\n` +
      `${auto ? '✅ Бронь подтверждается сразу, код для кассы придёт сюда.' : '✅ Подтверждение и код для кассы придут сюда.'}\n\n👇 Нажмите кнопку, чтобы начать`
    : `🚗 <b>Dars bron qilish</b>\n\n1️⃣ Toifa — A, B yoki C\n2️⃣ Davomiylik — 30 daqiqa, 1 yoki 2 soat (yoki 5 soatlik paket)\n3️⃣ Kun va vaqt\n4️⃣ Bo‘sh instruktor\n\n` +
      `${auto ? '✅ Bron darhol tasdiqlanadi, kassa kodi shu yerga keladi.' : '✅ Tasdiq va kassa kodi shu yerga keladi.'}\n\n👇 Boshlash uchun tugmani bosing`;
}
const bookKb = (lang: Lang) => ({ inline_keyboard: [
  [{ text: L[lang].book, web_app: { url: app('book') } }],
  [{ text: L[lang].my, callback_data: `my:${lang}` }, { text: L[lang].back, callback_data: `home:${lang}` }],
] });

function helpText(lang: Lang) {
  return lang === 'ru'
    ? `❓ <b>Помощь</b>\n\n/bron — записаться на занятие\n/bronlarim — мои брони и код для кассы\n/narxlar — цены\n/manzil — адрес и карта\n/aloqa — телефон и часы работы\n/start — главное меню\n\n💬 Есть вопрос? Напишите его сюда — ответим.`
    : `❓ <b>Yordam</b>\n\n/bron — dars bron qilish\n/bronlarim — bronlarim va kassa kodi\n/narxlar — narxlar\n/manzil — manzil va xarita\n/aloqa — telefon va ish vaqti\n/start — bosh menyu\n\n💬 Savolingiz bo‘lsa — shu yerga yozing, javob beramiz.`;
}

const DEF_T: Record<string, { half: number; hour: number }> = { A: { half: 200000, hour: 350000 }, B: { half: 150000, hour: 250000 }, C: { half: 250000, hour: 400000 } };
async function pricesText(lang: Lang) {
  const s = await settings(['half_a', 'half_b', 'half_c', 'rate_a', 'rate_b', 'rate_c', 'paket5_b']);
  const num = (k: string, d: number) => { const n = Number(s[k]); return s[k] !== undefined && s[k] !== null && s[k] !== '' && Number.isFinite(n) && n > 0 ? n : d; };
  const icon: Record<string, string> = { A: '🏍', B: '🚗', C: '🚚' };
  const rows = ['A', 'B', 'C'].map((c) => {
    const half = num(`half_${c.toLowerCase()}`, DEF_T[c].half), hour = num(`rate_${c.toLowerCase()}`, DEF_T[c].hour);
    return lang === 'ru'
      ? `${icon[c]} <b>Категория ${c}</b>\n      30 мин — ${money(half)} · 1 час — ${money(hour)}`
      : `${icon[c]} <b>${c} toifa</b>\n      30 daqiqa — ${money(half)} · 1 soat — ${money(hour)}`;
  });
  const hourB = num('rate_b', DEF_T.B.hour);
  const pkRaw = s.paket5_b;
  const pk = pkRaw === undefined || pkRaw === null || pkRaw === '' ? 1100000 : Math.max(0, Number(pkRaw) || 0);
  const pkLine = pk > 0
    ? (lang === 'ru'
      ? `\n\n🎁 <b>Пакет 5 часов (B)</b> — ${money(pk)} сум${hourB * 5 > pk ? ` <s>${money(hourB * 5)}</s>` : ''}\n      Делите 5 часов как удобно: 5, 3+2, 2+2+1…`
      : `\n\n🎁 <b>5 soatlik paket (B)</b> — ${money(pk)} so‘m${hourB * 5 > pk ? ` <s>${money(hourB * 5)}</s>` : ''}\n      5 soatni xohlagancha bo‘ling: 5, 3+2, 2+2+1…`)
    : '';
  return lang === 'ru'
    ? `💵 <b>Цены</b> (сум)\n\n${rows.join('\n\n')}${pkLine}\n\n2 часа — по часовой цене. Оплата в кассе.`
    : `💵 <b>Narxlar</b> (so‘m)\n\n${rows.join('\n\n')}${pkLine}\n\n2 soat — soatlik narx bo‘yicha. To‘lov kassada.`;
}

async function contactText(lang: Lang) {
  const s = await settings(['contact_phone', 'work_start', 'work_end', 'address', 'location']);
  const phones = String(s.contact_phone || '').split(/[,;]+/).map((x) => x.trim()).filter(Boolean).map(fmtPhone);
  const ws = String(s.work_start || '07:00').slice(0, 5), we = String(s.work_end || '19:00').slice(0, 5);
  const addr = String(s.location?.address || s.address || '').trim();
  const P = phones.map((p) => `📞 ${esc(p)}`).join('\n');
  return lang === 'ru'
    ? `☎️ <b>Контакты</b>\n\n${P || '📞 —'}\n🕘 Часы работы: ${ws}–${we}${addr ? `\n📍 ${esc(addr)}` : ''}\n\n💬 Вопрос можно написать прямо сюда.`
    : `☎️ <b>Aloqa</b>\n\n${P || '📞 —'}\n🕘 Ish vaqti: ${ws}–${we}${addr ? `\n📍 ${esc(addr)}` : ''}\n\n💬 Savolni shu yerga yozsangiz ham bo‘ladi.`;
}

const STATUS = {
  uz: { pending: '⏳ Tasdiq kutilmoqda', confirmed: '✅ Tasdiqlangan', in_progress: '🚗 Dars ketmoqda' } as Record<string, string>,
  ru: { pending: '⏳ Ожидает подтверждения', confirmed: '✅ Подтверждена', in_progress: '🚗 Идёт урок' } as Record<string, string>,
};
async function myBookingsText(telegramId: number, lang: Lang): Promise<{ text: string; empty: boolean }> {
  const head = lang === 'ru' ? '📅 <b>Мои брони</b>' : '📅 <b>Bronlarim</b>';
  try {
    const u = (await rest(`users?telegram_id=eq.${telegramId}&select=id&limit=1`))?.[0];
    const rows = u ? await rest(
      `bookings?customer_id=eq.${encodeURIComponent(u.id)}&status=in.(pending,confirmed,in_progress)` +
      `&end_at=gte.${encodeURIComponent(new Date().toISOString())}` +
      `&select=start_at,end_at,status,pickup_code,category,duration_minutes,instructor_name,instructor:instructor_id(user:user_id(full_name))` +
      `&order=start_at.asc&limit=6`,
    ) : [];
    if (!rows?.length) {
      return { empty: true, text: lang === 'ru'
        ? `${head}\n\nПока нет предстоящих броней.\nЗапишитесь за 1 минуту 👇`
        : `${head}\n\nHozircha kelgusi bron yo‘q.\n1 daqiqada bron qiling 👇` };
    }
    const lines = rows.map((b: any, i: number) => {
      const ins = b.instructor?.user?.full_name || b.instructor_name || '';
      const cat = b.category ? (lang === 'ru' ? `Кат. ${b.category}` : `${b.category} toifa`) : '';
      const meta = [cat, ins ? `👨‍🏫 ${esc(ins)}` : ''].filter(Boolean).join(' · ');
      const code = b.pickup_code ? ` · 🎫 <code>${esc(b.pickup_code)}</code>` : '';
      return `<b>${i + 1}) ${esc(when(b.start_at, b.end_at, lang))}</b>${meta ? `\n      ${meta}` : ''}\n      ${STATUS[lang][b.status] || esc(b.status)}${code}`;
    });
    const tail = lang === 'ru' ? '\n\n🎫 Назовите код в кассе. Отменить или перенести — в приложении.' : '\n\n🎫 Kassada kodni ayting. Bekor qilish yoki ko‘chirish — ilovada.';
    return { empty: false, text: `${head}\n\n${lines.join('\n\n')}${tail}` };
  } catch (e) {
    console.error('my bookings:', e);
    return { empty: false, text: lang === 'ru' ? `${head}\n\nНе удалось загрузить. Откройте приложение 👇` : `${head}\n\nYuklab bo‘lmadi. Ilovani oching 👇` };
  }
}

/* ------------------------------------------------------------------ */
/* Bot profili: bio, qisqa tavsif, buyruqlar, menyu tugmasi, webhook   */
/* ------------------------------------------------------------------ */
function profileTexts(auto: boolean) {
  const okUz = auto ? '✅ Bron darhol tasdiqlanadi — admin javobini kutish yo‘q' : '✅ Tasdiq va kassa kodi Telegram’ga keladi';
  const okRu = auto ? '✅ Бронь подтверждается сразу — без ожидания администратора' : '✅ Подтверждение и код для кассы приходят в Telegram';
  return {
    description: {
      uz: `🚗 TASH INDEX AVTODROM — rasmiy bron boti\n\n⚡ Avtodromda mashq darsini 1 daqiqada onlayn bron qiling\n${okUz}\n🎫 Kassada kodni ayting va to‘g‘ri mashinaga chiqing\n👨‍🏫 A, B, C toifalar · tajribali instruktorlar\n🔔 Eslatma va kassa kodi shu yerga keladi\n\n📍 Toshkent, Yangihayot tumani\n👇 Pastdagi tugmani bosing`,
      ru: `🚗 TASH INDEX AVTODROM — официальный бот бронирования\n\n⚡ Запишитесь на занятие на автодроме онлайн за 1 минуту\n${okRu}\n🎫 Назовите код в кассе — и сразу в машину\n👨‍🏫 Категории A, B, C · опытные инструкторы\n🔔 Напоминания и код для кассы приходят сюда\n\n📍 Ташкент, Янгихаётский район\n👇 Нажмите кнопку ниже`,
    },
    short: {
      uz: `🚗 TASH INDEX AVTODROM: mashq darsini 1 daqiqada onlayn bron qiling.${auto ? ' Darhol tasdiq, kutishsiz.' : ''}`,
      ru: `🚗 TASH INDEX AVTODROM: онлайн-запись на занятие за 1 минуту.${auto ? ' Сразу подтверждение.' : ''}`,
    },
    commands: {
      uz: [
        { command: 'start', description: '🏠 Bosh menyu' },
        { command: 'bron', description: '🚗 Dars bron qilish' },
        { command: 'bronlarim', description: '📅 Bronlarim va kassa kodi' },
        { command: 'narxlar', description: '💵 Narxlar' },
        { command: 'manzil', description: '📍 Manzil va xarita' },
        { command: 'aloqa', description: '☎️ Telefon va ish vaqti' },
        { command: 'yordam', description: '❓ Yordam' },
      ],
      ru: [
        { command: 'start', description: '🏠 Главное меню' },
        { command: 'bron', description: '🚗 Записаться на занятие' },
        { command: 'bronlarim', description: '📅 Мои брони и код для кассы' },
        { command: 'narxlar', description: '💵 Цены' },
        { command: 'manzil', description: '📍 Адрес и карта' },
        { command: 'aloqa', description: '☎️ Телефон и часы работы' },
        { command: 'yordam', description: '❓ Помощь' },
      ],
    },
  };
}

let profileSig = '';
async function ensureProfile(force = false): Promise<any> {
  const s = await settings([PROFILE_KEY, 'booking_auto_confirm']);
  const auto = autoOn(s);
  const sig = `${PROFILE_VERSION}:${auto ? 1 : 0}`;
  if (!force && (profileSig === sig || s[PROFILE_KEY]?.sig === sig)) { profileSig = sig; return s[PROFILE_KEY]; }
  profileSig = sig;                      // shu nusxada qayta-qayta urinmaslik uchun
  const p = profileTexts(auto);
  const steps: Array<[string, string, Record<string, unknown>]> = [
    ['description', 'setMyDescription', { description: p.description.uz }],
    ['description_ru', 'setMyDescription', { description: p.description.ru, language_code: 'ru' }],
    ['short', 'setMyShortDescription', { short_description: p.short.uz }],
    ['short_ru', 'setMyShortDescription', { short_description: p.short.ru, language_code: 'ru' }],
    ['commands', 'setMyCommands', { commands: p.commands.uz, scope: { type: 'all_private_chats' } }],
    ['commands_ru', 'setMyCommands', { commands: p.commands.ru, scope: { type: 'all_private_chats' }, language_code: 'ru' }],
    ['commands_default', 'setMyCommands', { commands: p.commands.uz }],
    ['menu', 'setChatMenuButton', { menu_button: { type: 'web_app', text: L.uz.menuBtn, web_app: { url: APP_URL } } }],
    ['webhook', 'setWebhook', { url: WEBHOOK_URL, secret_token: await webhookSecret(), allowed_updates: ALLOWED_UPDATES, drop_pending_updates: false }],
  ];
  const results: Record<string, string> = {};
  for (const [name, method, body] of steps) {
    const r = await tg(method, body);
    results[name] = r?.ok ? 'ok' : String(r?.description || 'xato').slice(0, 120);
  }
  const state = { sig, version: PROFILE_VERSION, auto, at: new Date().toISOString(), ok: Object.values(results).every((v) => v === 'ok'), results };
  try { await saveSetting(PROFILE_KEY, state); } catch (e) { console.error('profile save:', e); }
  console.log('bot profile:', JSON.stringify(state));
  return state;
}

/* ------------------------------------------------------------------ */
/* Yuborish yordamchilari                                              */
/* ------------------------------------------------------------------ */
const send = (chatId: number, text: string, kb?: unknown) =>
  tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...(kb ? { reply_markup: kb } : {}) });
/** Tugma bosilganda — o'sha xabarni almashtiramiz (ilova kabi), bo'lmasa yangisini yuboramiz */
async function show(chatId: number, msgId: number | undefined, text: string, kb?: unknown) {
  if (msgId) {
    const r = await tg('editMessageText', { chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...(kb ? { reply_markup: kb } : {}) });
    if (r?.ok || /not modified/i.test(String(r?.description))) return r;
  }
  return send(chatId, text, kb);
}

async function screen(view: string, chatId: number, user: any, lang: Lang, msgId?: number) {
  if (view === 'home') {
    const s = await settings(['booking_auto_confirm']);
    return show(chatId, msgId, homeText(user?.first_name || (lang === 'ru' ? 'друг' : 'mehmon'), lang, autoOn(s)), homeKb(lang));
  }
  if (view === 'book') {
    const s = await settings(['booking_auto_confirm']);
    return show(chatId, msgId, bookText(lang, autoOn(s)), bookKb(lang));
  }
  if (view === 'my') {
    const r = await myBookingsText(Number(user.id), lang);
    return show(chatId, msgId, r.text, r.empty
      ? bookKb(lang)
      : { inline_keyboard: [[{ text: L[lang].open, web_app: { url: app('bookings') } }], [{ text: L[lang].book, web_app: { url: app('book') } }, { text: L[lang].back, callback_data: `home:${lang}` }]] });
  }
  if (view === 'pr') return show(chatId, msgId, await pricesText(lang), backKb(lang, [[{ text: L[lang].book, web_app: { url: app('book') } }]]));
  if (view === 'ct') return show(chatId, msgId, await contactText(lang), backKb(lang, [[{ text: L[lang].ask, web_app: { url: app('support') } }]]));
  if (view === 'help') return show(chatId, msgId, helpText(lang), backKb(lang));
  if (view === 'loc') {
    const s = await settings(['location', 'address']);
    const loc = s.location || {};
    const lat = Number(loc.latitude), lng = Number(loc.longitude);
    const addr = String(loc.address || s.address || '').trim();
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat && lng) {
      await tg('sendVenue', { chat_id: chatId, latitude: lat, longitude: lng, title: String(loc.name || 'TASH INDEX AVTODROM'), address: addr || 'Toshkent' });
    }
    const maps: any[] = [];
    if (loc.google_url) maps.push({ text: 'Google Maps', url: String(loc.google_url) });
    if (loc.yandex_url) maps.push({ text: 'Yandex', url: String(loc.yandex_url) });
    if (loc.two_gis_url) maps.push({ text: '2GIS', url: String(loc.two_gis_url) });
    const text = lang === 'ru'
      ? `📍 <b>Адрес</b>\n\n${esc(addr || '—')}\n\nОткройте карту и постройте маршрут 👇`
      : `📍 <b>Manzil</b>\n\n${esc(addr || '—')}\n\nXaritani oching va yo‘nalish oling 👇`;
    /* Joylashuv yangi xabar bo'lib ketdi — matnni ham yangi xabar qilamiz, tartib buzilmasin */
    return send(chatId, text, backKb(lang, maps.length ? [maps] : []));
  }
  return show(chatId, msgId, homeText(user?.first_name || '', lang, true), homeKb(lang));
}

/** Buyruq → bo'lim. Ruscha/inglizcha muqobillar ham. */
const COMMANDS: Record<string, string> = {
  start: 'home', menu: 'home', menyu: 'home',
  bron: 'book', book: 'book',
  bronlarim: 'my', mybookings: 'my', my: 'my',
  narxlar: 'pr', narx: 'pr', prices: 'pr', price: 'pr',
  manzil: 'loc', address: 'loc', location: 'loc',
  aloqa: 'ct', contact: 'ct', contacts: 'ct',
  yordam: 'help', help: 'help',
};
/** /start parametri (t.me/bot?start=bron) */
const START_PAYLOAD: Record<string, string> = { bron: 'book', book: 'book', bronlarim: 'my', narx: 'pr', narxlar: 'pr', manzil: 'loc', aloqa: 'ct' };

/* ------------------------------------------------------------------ */
/* Vercel'dagi yordam tizimiga uzatish (avto-javob + admin chati)       */
/* ------------------------------------------------------------------ */
async function forwardToBackend(update: unknown): Promise<boolean> {
  try {
    const r = await fetch(BACKEND_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': await webhookSecret() },
      body: JSON.stringify(update),
      signal: AbortSignal.timeout(25000),
    });
    if (!r.ok) { console.warn('backend forward:', r.status); return false; }
    const j = await r.json().catch(() => null);
    return j?.ok === true;
  } catch (e) { console.warn('backend forward failed:', String(e)); return false; }
}

async function fallbackReply(chatId: number, lang: Lang) {
  const text = lang === 'ru'
    ? '🚗 <b>TASH INDEX AVTODROM</b>\n\nЗапись и ваши брони — в приложении.\nЕсть вопрос? Напишите в разделе «Помощь» приложения — ответим быстро.'
    : '🚗 <b>TASH INDEX AVTODROM</b>\n\nBron qilish va bronlaringiz — ilovada.\nSavolingiz bo‘lsa, ilovadagi «Yordam» bo‘limiga yozing — tez javob beramiz.';
  return send(chatId, text, { inline_keyboard: [
    [{ text: L[lang].open, web_app: { url: app() } }],
    [{ text: L[lang].ask, web_app: { url: app('support') } }, { text: L[lang].back, callback_data: `home:${lang}` }],
  ] });
}

/* ------------------------------------------------------------------ */
/* Kanal                                                               */
/* ------------------------------------------------------------------ */
type Channel = { id: number; title: string; username: string | null; at: string };
async function loadChannels(): Promise<Channel[]> {
  const s = await settings([CHANNELS_KEY]);
  const list = s[CHANNELS_KEY]?.list;
  return Array.isArray(list) ? list.filter((c: any) => Number.isSafeInteger(Number(c?.id))) : [];
}
async function storeChannels(list: Channel[]) {
  await saveSetting(CHANNELS_KEY, { list: list.slice(0, 20) });
}

const ADMIN_ST = ['creator', 'administrator'];
/** Kanal: bot u yerda post yoza oladimi va shu odam kanal adminimi */
async function checkChannel(ref: string | number, userId: number) {
  const chat = await tg('getChat', { chat_id: ref });
  if (!chat?.ok || chat.result?.type !== 'channel') return null;
  const c = chat.result;
  const bot = await me();
  const [mb, mu] = await Promise.all([
    tg('getChatMember', { chat_id: c.id, user_id: bot.id }),
    tg('getChatMember', { chat_id: c.id, user_id: userId }),
  ]);
  const botOk = mb?.ok && mb.result?.status === 'administrator' && mb.result?.can_post_messages !== false;
  const userOk = mu?.ok && ADMIN_ST.includes(String(mu.result?.status));
  return { id: Number(c.id), title: String(c.title || 'Kanal'), username: c.username ? String(c.username) : null, botOk: !!botOk, userOk: !!userOk };
}

async function promo() {
  const s = await settings(['contact_phone', 'location', 'address', 'booking_auto_confirm']);
  const bot = await me();
  const auto = autoOn(s);
  const phones = String(s.contact_phone || '').split(/[,;]+/).map((x) => x.trim()).filter(Boolean).map(fmtPhone);
  const text =
    `🚗 <b>TASH INDEX AVTODROM — endi onlayn bron!</b>\n\n` +
    `Navbatda turib vaqt yo‘qotmang. Telegram ilovamiz orqali mashq darsini <b>1 daqiqada</b> bron qiling:\n\n` +
    `1️⃣ Toifani tanlang — A, B yoki C\n2️⃣ Kun va vaqtni belgilang\n3️⃣ Bo‘sh instruktorni tanlang\n\n` +
    `${auto ? '✅ Bron darhol tasdiqlanadi — kutish yo‘q\n' : '✅ Tasdiq Telegram’ga keladi\n'}` +
    `🎫 Kassada kodni aytasiz — to‘g‘ri mashinaga\n🔔 Dars oldidan eslatma keladi\n` +
    (phones.length ? `\n☎️ ${phones.map(esc).join(' · ')}\n` : '') +
    `\n🇷🇺 <i>Онлайн-запись на занятие за 1 минуту — нажмите кнопку ниже.</i>`;
  const row: any[] = [{ text: '🚗 Onlayn bron qilish', url: `https://t.me/${bot.username}?start=bron` }];
  const kb: any[][] = [row];
  if (s.location?.google_url) kb.push([{ text: '📍 Xaritada ko‘rish', url: String(s.location.google_url) }]);
  return { text, reply_markup: { inline_keyboard: kb } };
}

async function channelMenu(chatId: number, user: any, arg: string, trusted: boolean) {
  if (!trusted) return send(chatId, '⏳ Bot sozlanmoqda. Bir daqiqadan keyin /kanal ni qayta yuboring.');
  const refs = new Map<string, string | number>();
  for (const c of await loadChannels()) refs.set(String(c.id), c.id);
  refs.set(DEFAULT_CHANNEL, DEFAULT_CHANNEL);
  const a = arg.trim().replace(/^https?:\/\/t\.me\//i, '@').replace(/^@?/, '@');
  if (arg.trim() && /^@[A-Za-z0-9_]{4,}$/.test(a)) refs.set(a.toLowerCase(), a);
  const checked = (await Promise.all([...refs.values()].map((r) => checkChannel(r, Number(user.id)).catch(() => null)))).filter(Boolean) as any[];
  const seen = new Set<number>();
  const mine = checked.filter((c) => c.userOk && !seen.has(c.id) && seen.add(c.id));
  if (!mine.length) {
    return send(chatId, '📢 <b>Kanalga e’lon</b>\n\nSiz admin bo‘lgan kanal topilmadi.\n\n1) Botni kanalga <b>administrator</b> qilib qo‘shing («Xabar yuborish» huquqi bilan)\n2) Shu yerga yozing: <code>/kanal @kanal_nomi</code>');
  }
  const kb: any[][] = [];
  const lines: string[] = [];
  for (const c of mine) {
    lines.push(`${c.botOk ? '✅' : '⚠️'} <b>${esc(c.title)}</b>${c.username ? ` (@${esc(c.username)})` : ''}${c.botOk ? '' : ' — botga «Xabar yuborish» huquqini bering'}`);
    if (c.botOk) kb.push([{ text: `📢 «${c.title.slice(0, 24)}» ga yuborish`, callback_data: `chp:${c.id}:0` }, { text: '📌 Yuborib, mahkamlash', callback_data: `chp:${c.id}:1` }]);
  }
  /* Bot ulangan kanallarni eslab qolamiz */
  try {
    const old = await loadChannels();
    const map = new Map(old.map((c) => [c.id, c]));
    for (const c of mine.filter((x) => x.botOk)) map.set(c.id, { id: c.id, title: c.title, username: c.username, at: new Date().toISOString() });
    await storeChannels([...map.values()]);
  } catch (e) { console.error('channels save:', e); }
  const p = await promo();
  await tg('sendMessage', { chat_id: chatId, text: p.text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: p.reply_markup });
  return send(chatId, `👆 <b>E’lon ko‘rinishi</b>\n\n${lines.join('\n')}\n\nQaysi kanalga yuboramiz?`, kb.length ? { inline_keyboard: kb } : undefined);
}

async function channelPost(cq: any, channelId: number, pin: boolean, trusted: boolean) {
  const chatId = Number(cq.from?.id);
  if (!trusted) return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Bir daqiqadan keyin qayta urinib ko‘ring', show_alert: true });
  const c = await checkChannel(channelId, chatId).catch(() => null);
  if (!c?.userOk) return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Siz bu kanal admini emassiz', show_alert: true });
  if (!c.botOk) return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Botga kanalda «Xabar yuborish» huquqini bering', show_alert: true });
  const p = await promo();
  const r = await tg('sendMessage', { chat_id: c.id, text: p.text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: p.reply_markup });
  if (!r?.ok) {
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Yuborilmadi', show_alert: true });
    return send(chatId, `❌ Kanalga yuborilmadi: ${esc(r?.description || 'xato')}`);
  }
  await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Yuborildi ✅' });
  let pinNote = '';
  if (pin) {
    const pr = await tg('pinChatMessage', { chat_id: c.id, message_id: r.result.message_id, disable_notification: true });
    pinNote = pr?.ok ? '\n📌 Mahkamlandi.' : `\n⚠️ Mahkamlanmadi: ${esc(pr?.description || 'huquq yo‘q')}`;
  }
  const link = c.username ? `https://t.me/${c.username}/${r.result.message_id}` : '';
  return send(chatId, `✅ E’lon «${esc(c.title)}» kanaliga yuborildi.${pinNote}${link ? `\n\n🔗 ${link}` : ''}`);
}

/** Bot kanalga admin qilib qo'shildi / olib tashlandi */
async function onMyChatMember(u: any, trusted: boolean) {
  const chat = u?.chat, st = String(u?.new_chat_member?.status || '');
  if (!trusted || chat?.type !== 'channel') return 'ignored';
  const list = await loadChannels();
  const others = list.filter((c) => c.id !== Number(chat.id));
  if (st === 'administrator') {
    others.push({ id: Number(chat.id), title: String(chat.title || 'Kanal'), username: chat.username ? String(chat.username) : null, at: new Date().toISOString() });
    await storeChannels(others);
    const canPost = u.new_chat_member?.can_post_messages !== false;
    if (u.from?.id && !u.from.is_bot) {
      await send(Number(u.from.id),
        `✅ Bot «<b>${esc(chat.title || 'kanal')}</b>» kanaliga ulandi.\n\n` +
        (canPost ? 'Kanalga «Onlayn bron» e’lonini (tugmasi bilan) yuborish uchun /kanal ni bosing.' : '⚠️ Botga «Xabar yuborish» huquqini bering, keyin /kanal ni bosing.'));
    }
    return 'channel_added';
  }
  if (['left', 'kicked', 'member', 'restricted'].includes(st)) { await storeChannels(others); return 'channel_removed'; }
  return 'ignored';
}

/* ------------------------------------------------------------------ */
/* Webhook                                                             */
/* ------------------------------------------------------------------ */
Deno.serve(async (req) => {
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url);
      if (url.searchParams.get('setup') === '1') {
        const profile = await ensureProfile(true);
        return json({ ok: profile?.ok === true, webhook_url: WEBHOOK_URL, profile });
      }
      const [info, s] = await Promise.all([tg('getWebhookInfo'), settings([PROFILE_KEY])]);
      const w = info?.result || {};
      return json({ ok: info?.ok === true, expected_url: WEBHOOK_URL, webhook: { url: w.url, pending_update_count: w.pending_update_count, last_error_message: w.last_error_message, allowed_updates: w.allowed_updates }, profile: s[PROFILE_KEY] || null });
    }
    if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
    if (!BOT_TOKEN) return json({ ok: false, error: 'TELEGRAM_BOT_TOKEN mavjud emas' }, 500);

    /* Sir: o'rnatilgandan keyin Telegram har so'rovga qo'shadi */
    const hdr = req.headers.get('x-telegram-bot-api-secret-token') || '';
    const secret = await webhookSecret();
    if (hdr && hdr !== secret) return json({ ok: false, error: 'Invalid webhook secret' }, 401);
    const trusted = !!hdr && hdr === secret;

    let update: any;
    try { update = await req.json(); } catch { return json({ ok: true, action: 'invalid_json' }); }

    /* Bio, buyruqlar, menyu va webhook (sir + kanal xabarlari) — bir marta */
    await ensureProfile().catch((e) => console.error('profile:', e));

    if (update?.my_chat_member) {
      const action = await onMyChatMember(update.my_chat_member, trusted).catch((e) => { console.error('my_chat_member:', e); return 'error'; });
      return json({ ok: true, action });
    }

    if (update?.message) {
      const m = update.message, user = m.from, chat = m.chat;
      /* Faqat shaxsiy chat; javob — o'sha odamning o'ziga */
      if (!chat || chat.type !== 'private' || !user || Number(chat.id) !== Number(user.id)) return json({ ok: true, action: 'not_private' });
      const chatId = Number(chat.id), lang = langOf(user);
      await saveUser(user);
      const text = String(m.text || '').trim();
      const cmd = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text);
      if (cmd) {
        const name = cmd[1].toLowerCase(), arg = String(cmd[2] || '').trim();
        if (name === 'kanal' || name === 'channel') { await channelMenu(chatId, user, arg, trusted); return json({ ok: true, action: 'channel_menu' }); }
        if (name === 'start') {
          /* Rus tilidagi foydalanuvchiga — menyu tugmasi ham ruscha */
          if (lang === 'ru') await tg('setChatMenuButton', { chat_id: chatId, menu_button: { type: 'web_app', text: L.ru.menuBtn, web_app: { url: APP_URL } } });
          const view = START_PAYLOAD[arg.toLowerCase()] || 'home';
          const r = await screen(view, chatId, user, lang);
          console.log('START telegram result:', JSON.stringify({ ok: r?.ok, view }));
          return json({ ok: true, action: `start:${view}`, telegram_ok: r?.ok === true });
        }
        const view = COMMANDS[name];
        if (view) { await screen(view, chatId, user, lang); return json({ ok: true, action: view }); }
        await screen('help', chatId, user, lang);
        return json({ ok: true, action: 'unknown_command' });
      }
      /* Oddiy savol — yordam tizimiga (avto-javob, topilmasa admin) */
      if (text && trusted && await forwardToBackend(update)) return json({ ok: true, action: 'support' });
      await fallbackReply(chatId, lang);
      return json({ ok: true, action: 'fallback' });
    }

    if (update?.callback_query) {
      const c = update.callback_query, user = c.from;
      const data = String(c.data || '');
      const chatId = Number(c.message?.chat?.id || user?.id);
      const msgId = c.message?.message_id ? Number(c.message.message_id) : undefined;
      if (!user?.id || chatId !== Number(user.id)) { await tg('answerCallbackQuery', { callback_query_id: c.id }); return json({ ok: true, action: 'not_private' }); }
      await saveUser(user);

      /* Eslatma tugmalari («Kelaman» / «Bekor») — Vercel hal qiladi */
      if (/^(come|cxl):/.test(data)) {
        if (trusted && await forwardToBackend(update)) return json({ ok: true, action: 'reminder' });
        await tg('answerCallbackQuery', { callback_query_id: c.id, text: 'Ilovada oching', show_alert: false });
        await fallbackReply(chatId, langOf(user));
        return json({ ok: true, action: 'reminder_fallback' });
      }
      const ch = /^chp:(-?\d+):([01])$/.exec(data);
      if (ch) { await channelPost(c, Number(ch[1]), ch[2] === '1', trusted); return json({ ok: true, action: 'channel_post' }); }

      await tg('answerCallbackQuery', { callback_query_id: c.id });
      /* Eski xabarlardagi tugmalar ham ishlaydi */
      const legacy: Record<string, string> = { my_bookings: 'my', main_menu: 'home' };
      const mm = /^(home|my|pr|loc|ct|help|book):(uz|ru)$/.exec(data);
      const view = mm ? mm[1] : legacy[data];
      const lang: Lang = mm ? (mm[2] as Lang) : langOf(user);
      if (view) { await screen(view, chatId, user, lang, msgId); return json({ ok: true, action: view }); }
      return json({ ok: true, action: 'ignored_callback' });
    }

    return json({ ok: true, action: 'ignored' });
  } catch (e) {
    console.error('telegram-start error:', e);
    /* Telegram 200 olmasa bir xil update'ni qayta-qayta yuboradi */
    return json({ ok: true, error: String(e) });
  }
});
