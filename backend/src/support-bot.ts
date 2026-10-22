import { supabaseRest } from './supabase.js';

/**
 * YORDAM — AVTOMATIK JAVOB
 *
 * Mijozlar Mini App «Yordam» chatiga va mijoz botiga ko'p savol yozadi — admin
 * har biriga javob berib ulgurmaydi. Endi savolga avval bot javob beradi:
 *   1) admin o'zi qo'shgan savol-javoblar (bilim bazasi, `support_kb`);
 *   2) tayyor mavzular: narx, ish vaqti, manzil, bron qilish, bekor qilish,
 *      ko'chirish, to'lov, kechikish, toifalar, kurs muddati, imtihon,
 *      «mening bronim» (mijozning o'z bronlari va kodi) va boshqalar —
 *      javob ADMIN SOZLAMALARIDAN olinadi (narx o'zgarsa, javob ham o'zgaradi);
 *   3) topilmasa — mijozga «adminga yubordim» deyiladi, savol admin panelda
 *      o'qilmagan bo'lib turadi va admin botiga «❓ Javobsiz savol» keladi.
 * Admin javob berganda «avto-javobga saqlash»ni belgilasa — keyingi safar
 * shunga o'xshash savolga bot o'zi javob beradi (o'rganadi).
 *
 * Matn o'zbekcha (lotin/kirill) va ruscha tushuniladi: kirill lotinga
 * o'giriladi, apostroflar, h/x, q/k farqi olib tashlanadi.
 */

export const KB_KEY = 'support_kb';
export const BOT_KEY = 'support_bot';
export const BOT_PREFIX = '🤖 ';

/* ------------------------------------------------------------------ */
/* Matnni tayyorlash                                                   */
/* ------------------------------------------------------------------ */
const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh',
  ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya', ў: 'o', қ: 'k', ғ: 'g', ҳ: 'x',
};
/** Ruscha savolmi (javob tili) — kirillda o'zbekcha harflar (ў қ ғ ҳ) yo'q va ruscha so'zlar bor */
export function isRussian(text: string): boolean {
  const s = String(text || '').toLowerCase();
  if (!/[а-яё]/.test(s) || /[ўқғҳ]/.test(s)) return false;
  return /(^|[^а-яё])(как|сколько|где|когда|можно|есть|это|что|цен|стоит|запис|отмен|адрес|работ|здравств|привет|спасибо|хочу|нужно|подскаж|пожалуйст|вы|ли|у меня|вопрос|мо[яйё]|время|брон|перенес|найти|права|получ)/.test(s);
}
/** Lotin, kichik harf, apostrofsiz; h→x (sh/ch dan tashqari), q→k */
export function normalize(text: string): string {
  let s = String(text || '').toLowerCase().replace(/[‘’ʻʼ`'ʼ]/g, '');
  s = [...s].map((c) => CYR[c] ?? c).join('');
  s = s.replace(/(^|[^sc])h/g, '$1x').replace(/q/g, 'k');
  return s.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const STOP = new Set(['men', 'sen', 'siz', 'sizlar', 'biz', 'bu', 'shu', 'va', 'bilan', 'uchun', 'xam', 'yoki', 'iltimos', 'aka', 'opa', 'uka',
  'brat', 'edi', 'ekan', 'bormi', 'bor', 'yok', 'kerak', 'mumkin', 'mi', 'ni', 'da', 'ga', 'dan', 'ya', 'eto', 'chto', 'mne', 'vi', 'vas', 'mojno',
  'li', 'est', 'pojaluysta', 'xochu', 'nujno', 'salom', 'assalomu', 'alaykum', 'zdravstvuyte', 'privet', 'raxmat', 'spasibo']);
const tokensOf = (norm: string) => norm.split(' ').filter((t) => t.length >= 2 && !STOP.has(t));

/** Ibora yoki o'zak bor-yo'qligi: «ish vakt» → «ish vaktingiz», «narx» → «narxi».
    «=so'z» — aynan shu so'z («=bosh» — «bo'sh», lekin «boshqa» emas) */
function has(norm: string, kw: string): boolean {
  const words = kw.split(' ');
  const toks = norm.split(' ');
  const eq = (t: string, w: string) => (w.startsWith('=') ? t === w.slice(1) : t.startsWith(w));
  for (let i = 0; i + words.length <= toks.length; i++) {
    if (words.every((w, j) => eq(toks[i + j], w))) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Kontekst: sozlamalar, narxlar, mijozning bronlari                   */
/* ------------------------------------------------------------------ */
export type KbItem = { id: string; q: string[]; a: string; on?: boolean; hits?: number; at?: string; by?: string | null };
export type BotCtx = {
  s: Record<string, any>;
  tariff: Record<'A' | 'B' | 'C', { half: number; hour: number; h3?: number }>;
  pkg: number; lateMin: number;
  bookings: Array<{ start_at: string; end_at: string; status: string; code: string | null; instructor: string | null; category: string | null }> | null;
};
const SETTING_KEYS = ['system_name', 'contact_phone', 'address', 'working_hours', 'location', 'work_start', 'work_end',
  'half_a', 'half_b', 'half_c', 'rate_a', 'rate_b', 'rate_c', 'tarif3_a', 'tarif3_b', 'tarif3_c', 'paket5_b', 'late_cancel_min', KB_KEY, BOT_KEY];
const DEF_T = { A: { half: 200000, hour: 350000 }, B: { half: 150000, hour: 250000 }, C: { half: 250000, hour: 400000 } };
const val = (v: any) => (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v ? v.value : v);

export async function loadSettings(): Promise<Record<string, any>> {
  const rows = await supabaseRest<any[]>('admin_settings', { query: `?key=in.(${SETTING_KEYS.map(encodeURIComponent).join(',')})&select=key,value` }).catch(() => []);
  const s: Record<string, any> = {};
  for (const r of rows || []) s[r.key] = val(r.value);
  if (typeof s.location === 'string') { try { s.location = JSON.parse(s.location); } catch { s.location = { address: s.location }; } }
  return s;
}
export function kbOf(s: Record<string, any>): KbItem[] {
  const raw = s[KB_KEY];
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : [];
  return list.filter((x: any) => x && Array.isArray(x.q) && typeof x.a === 'string' && x.a.trim());
}
export const botOn = (s: Record<string, any>) => {
  const v = s[BOT_KEY];
  return !(v === false || v === 'false' || v === 0 || (v && typeof v === 'object' && v.on === false));
};

async function ctxFor(s: Record<string, any>, userId: string | null, need: boolean): Promise<BotCtx> {
  const num = (k: string) => { const n = Number(s[k]); return Number.isFinite(n) && n > 0 ? n : 0; };
  /* 3 soatlik tarif: sozlama yo'q — B 700 000, A/C yo'q; 0 — o'chiq (pricing.ts bilan bir xil) */
  const h3 = (k: string, d: number) => { const v = s[k]; const n = Number(v); return v === undefined || v === null || v === '' || !Number.isFinite(n) ? d : Math.max(0, n); };
  const tariff = {
    A: { half: num('half_a') || DEF_T.A.half, hour: num('rate_a') || DEF_T.A.hour, h3: h3('tarif3_a', 0) },
    B: { half: num('half_b') || DEF_T.B.half, hour: num('rate_b') || DEF_T.B.hour, h3: h3('tarif3_b', 700000) },
    C: { half: num('half_c') || DEF_T.C.half, hour: num('rate_c') || DEF_T.C.hour, h3: h3('tarif3_c', 0) },
  };
  const pk = s.paket5_b === undefined || s.paket5_b === null || s.paket5_b === '' ? 1100000 : Number(s.paket5_b) || 0;
  const lm = s.late_cancel_min === undefined || s.late_cancel_min === null || s.late_cancel_min === '' ? 15 : Number(s.late_cancel_min);
  let bookings: BotCtx['bookings'] = null;
  if (need && userId) {
    const from = new Date(Date.now() - 2 * 3600e3).toISOString();
    const rows = await supabaseRest<any[]>('bookings', {
      query: `?customer_id=eq.${encodeURIComponent(userId)}&status=in.(pending,confirmed,in_progress)&end_at=gte.${encodeURIComponent(from)}`
        + '&select=start_at,end_at,status,pickup_code,instructor_id,category&order=start_at.asc&limit=5',
    }).catch(() => []);
    const ids = [...new Set((rows || []).map((b) => b.instructor_id).filter(Boolean))];
    const ins = ids.length ? await supabaseRest<any[]>('instructor_profiles', { query: `?id=in.(${ids.map(encodeURIComponent).join(',')})&select=id,user_id` }).catch(() => []) : [];
    const uids = [...new Set((ins || []).map((i: any) => i.user_id).filter(Boolean))];
    const us = uids.length ? await supabaseRest<any[]>('users', { query: `?id=in.(${uids.map(encodeURIComponent).join(',')})&select=id,full_name` }).catch(() => []) : [];
    const un = new Map((us || []).map((u: any) => [String(u.id), u.full_name || null]));
    const nm = new Map((ins || []).map((i: any) => [String(i.id), un.get(String(i.user_id)) || null]));
    bookings = (rows || []).map((b) => ({ start_at: b.start_at, end_at: b.end_at, status: b.status, code: b.pickup_code || null, instructor: nm.get(String(b.instructor_id)) || null, category: b.category || null }));
  }
  return { s, tariff, pkg: pk, lateMin: Number.isFinite(lm) ? lm : 15, bookings };
}

/* ------------------------------------------------------------------ */
/* Mavzular                                                            */
/* ------------------------------------------------------------------ */
const money = (n: number) => `${Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ')} so‘m`;
const moneyRu = (n: number) => `${Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ')} сум`;
const fmtWhen = (iso: string, ru = false) => {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit' }).format(d);
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit' }).format(d);
  return `${day}, ${t}`;
};
function locLinks(s: Record<string, any>) {
  const l = s.location || {};
  const lat = Number(l.latitude ?? l.lat), lng = Number(l.longitude ?? l.lng);
  const has = Number.isFinite(lat) && Number.isFinite(lng) && !!(lat || lng);
  const address = String(l.address || s.address || '').trim();
  const q = has ? `${lat},${lng}` : address;
  if (!q) return { address, google: '', yandex: '' };
  return {
    address,
    google: String(l.google_url || l.google || '') || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`,
    yandex: String(l.yandex_url || l.yandex || '') || (has ? `https://yandex.uz/maps/?pt=${lng},${lat}&z=17&l=map` : `https://yandex.uz/maps/?text=${encodeURIComponent(q)}`),
  };
}
const hoursOf = (s: Record<string, any>) => String(s.working_hours || '').trim() || `${s.work_start || '07:00'}–${s.work_end || '19:00'}`;

type Ans = { uz: string; ru: string } | null;           // null — ma'lumot yo'q (adminga)
export type Intent = { id: string; title: string; kw: Array<[string, number]>; escalate?: boolean; need?: 'bookings'; answer: (c: BotCtx) => Ans };

export const INTENTS: Intent[] = [
  {
    id: 'prices', title: 'Narxlar',
    kw: [['narx', 1.2], ['tsen', 1.2], ['stoim', 1.2], ['tarif', 1], ['kancha tur', 1.2], ['kancha bol', 1], ['kancha pul', 1.2], ['necha pul', 1.2], ['soati kancha', 1.2], ['soat kancha', 1.2], ['soati necha', 1.2], ['skolko stoit', 1.5], ['skolk', 0.6], ['kancha', 0.6], ['pul', 0.6], ['som', 0.4], ['prays', 1]],
    answer: (c) => {
      const t = c.tariff;
      const row = (k: 'A' | 'B' | 'C', uz: string) => `• ${k} toifa (${uz}): 30 daqiqa — ${money(t[k].half)}, 1 soat — ${money(t[k].hour)}${Number(t[k].h3) > 0 ? `, 3 soat — ${money(Number(t[k].h3))}` : ''}`;
      const rowRu = (k: 'A' | 'B' | 'C', ru: string) => `• Категория ${k} (${ru}): 30 минут — ${moneyRu(t[k].half)}, 1 час — ${moneyRu(t[k].hour)}${Number(t[k].h3) > 0 ? `, 3 часа — ${moneyRu(Number(t[k].h3))}` : ''}`;
      return {
        uz: ['💰 Narxlar (amaliy haydash):', row('A', 'mototsikl'), row('B', 'yengil avtomobil'), row('C', 'yuk avtomobili'),
          '2 soat va undan ko‘pi — soatlik narxdan.', c.pkg > 0 ? `🎁 5 soatlik paket (B toifa) — ${money(c.pkg)}.` : '', 'To‘lov — avtodrom kassasida.'].filter(Boolean).join('\n'),
        ru: ['💰 Цены (практическое вождение):', rowRu('A', 'мотоцикл'), rowRu('B', 'легковой'), rowRu('C', 'грузовой'),
          '2 часа и больше — по часовой цене.', c.pkg > 0 ? `🎁 Пакет 5 часов (категория B) — ${moneyRu(c.pkg)}.` : '', 'Оплата — в кассе автодрома.'].filter(Boolean).join('\n'),
      };
    },
  },
  {
    id: 'package', title: '5 soatlik paket',
    kw: [['paket', 1.5], ['5 soat', 1], ['besh soat', 1.2], ['pakyet', 1.5], ['chegirma', 1.3], ['skidk', 1.3], ['aktsiya', 1.2], ['aksiya', 1.2]],
    answer: (c) => c.pkg > 0 ? {
      uz: `🎁 5 soatlik paket — faqat B toifa: ${money(c.pkg)} (alohida olganda ${money(c.tariff.B.hour * 5)}).\n5 soatni bir necha kunga bo‘lib olasiz. Ilova → «Bron» → B toifa → «5 soatlik paket».`,
      ru: `🎁 Пакет 5 часов — только категория B: ${moneyRu(c.pkg)} (по отдельности ${moneyRu(c.tariff.B.hour * 5)}).\nЧасы можно разделить на несколько дней. Приложение → «Бронь» → категория B → «Пакет 5 часов».`,
    } : null,
  },
  {
    id: 'hours', title: 'Ish vaqti',
    kw: [['ish vakt', 1.5], ['ish soat', 1.3], ['ishlaysiz', 1.2], ['ishlaysizlar', 1.2], ['nechagacha', 1.2], ['nechigacha', 1.2], ['soat nech', 1], ['ochik', 1], ['grafik', 0.8], ['rabota', 1.2], ['rabotaet', 1.2], ['vremya rabot', 1.5], ['vixodn', 1.2], ['dam olish kun', 1.2], ['yakshanba', 0.8], ['bayram', 0.8]],
    answer: (c) => ({
      uz: `🕘 Ish vaqti: ${hoursOf(c.s)}.\nBo‘sh vaqtlarni ilovadagi «Bron» bo‘limida ko‘rasiz — u yerda faqat bo‘sh soatlar chiqadi.`,
      ru: `🕘 Время работы: ${hoursOf(c.s)}.\nСвободное время видно в приложении в разделе «Бронь» — там только свободные часы.`,
    }),
  },
  {
    id: 'free_time', title: 'Bo‘sh vaqt va bronsiz kelish',
    kw: [['=bosh vakt', 1.4], ['=bosh joy', 1.4], ['=bosh soat', 1.4], ['=bosh instruktor', 1.4], ['=bosh mi', 1], ['=boshmi', 1], ['svobod', 1.3], ['kelsam', 1.1], ['kelaversam', 1.2], ['bronsiz', 1.3], ['bez zapis', 1.4], ['priyti', 1.1], ['xozir kel', 1.2]],
    answer: () => ({
      uz: '🗓 Bo‘sh vaqtlar: Ilova → «Bron» → toifa → necha soat — kunni tanlasangiz faqat bo‘sh soatlar chiqadi (qaysi instruktor bo‘shligi bilan).\nBron qilib kelganingiz ma’qul — vaqtingiz kafolatlanadi. Bronsiz kelsangiz, kassada bo‘sh instruktor bo‘lsa darhol chek beriladi.',
      ru: '🗓 Свободное время: Приложение → «Бронь» → категория → сколько часов — выберите день, и появятся только свободные часы (и свободные инструкторы).\nЛучше приходить по брони — время гарантировано. Без брони — в кассе выдадут чек, если есть свободный инструктор.',
    }),
  },
  {
    id: 'address', title: 'Manzil',
    kw: [['manzil', 1.5], ['kayer', 1.2], ['adres', 1.5], ['lokats', 1.5], ['location', 1.5], ['joylash', 1.2], ['moljal', 1.2], ['gde', 1.2], ['kak doyt', 1.5], ['doyti', 1], ['xarita', 1.2], ['kartada', 1], ['geo', 0.8]],
    answer: (c) => {
      const L = locLinks(c.s);
      if (!L.address && !L.google) return null;
      return {
        uz: ['📍 Manzil:', L.address, L.google ? `Google xarita: ${L.google}` : '', L.yandex ? `Yandex xarita: ${L.yandex}` : '', 'Ilova → «Avtodrom haqida» → «Manzil» — xarita va rasm.'].filter(Boolean).join('\n'),
        ru: ['📍 Адрес:', L.address, L.google ? `Google Карты: ${L.google}` : '', L.yandex ? `Яндекс Карты: ${L.yandex}` : '', 'Приложение → «Об автодроме» → «Адрес» — карта и фото.'].filter(Boolean).join('\n'),
      };
    },
  },
  {
    id: 'my_booking', title: 'Mening bronim va kodim', need: 'bookings',
    kw: [['bronim', 1.5], ['bronlarim', 1.5], ['kodim', 1.5], ['darsim', 1.5], ['mening bron', 1.5], ['menda bron', 1.2], ['bron kod', 1.2], ['kassa kod', 1.2], ['kachon dars', 1.2], ['moya zapis', 1.5], ['moy kod', 1.5], ['moya bron', 1.5]],
    answer: (c) => {
      const list = c.bookings || [];
      if (!list.length) return {
        uz: 'Hozircha faol broningiz yo‘q. Bron qilish: Ilova → «Bron» → toifa → vaqt → instruktor. Bron qilgach kassa kodi (AVD-1234) beriladi.',
        ru: 'Сейчас активных броней нет. Забронировать: Приложение → «Бронь» → категория → время → инструктор. После брони вы получите код для кассы (AVD-1234).',
      };
      const st = (x: string, ru: boolean) => ({ pending: ru ? 'ждёт подтверждения' : 'tasdiq kutilmoqda', confirmed: ru ? 'подтверждена' : 'tasdiqlangan', in_progress: ru ? 'идёт урок' : 'dars ketmoqda' }[x] || x);
      return {
        uz: ['📋 Bronlaringiz:', ...list.map((b) => `• ${fmtWhen(b.start_at)} · ${b.category || 'B'} toifa${b.instructor ? ` · ${b.instructor}` : ''} · ${st(b.status, false)}${b.code ? `\n  Kassa kodi: ${b.code}` : ''}`),
          'Kassaga shu kodni aytasiz. Batafsil — Ilova → «Bronlarim».'].join('\n'),
        ru: ['📋 Ваши брони:', ...list.map((b) => `• ${fmtWhen(b.start_at, true)} · категория ${b.category || 'B'}${b.instructor ? ` · ${b.instructor}` : ''} · ${st(b.status, true)}${b.code ? `\n  Код для кассы: ${b.code}` : ''}`),
          'Назовите этот код в кассе. Подробнее — Приложение → «Мои брони».'].join('\n'),
      };
    },
  },
  {
    id: 'book_how', title: 'Qanday bron qilaman',
    kw: [['kanday bron', 1.5], ['bron kanday', 1.5], ['bron kil', 1.2], ['yozil', 1.2], ['kanday yozil', 1.5], ['zapis', 1.2], ['zabronir', 1.5], ['kak zapis', 1.5], ['bron', 0.6]],
    answer: () => ({
      uz: '📝 Bron qilish: Ilova → «Bron» → toifa (A, B, C) → necha soat → kun va vaqt → bo‘sh instruktor → «Tasdiqlash».\nBron qilgach sizga kassa kodi (AVD-1234) keladi — kassaga shuni aytasiz. Tasdiqlanganda Telegram’ga xabar keladi.',
      ru: '📝 Как забронировать: Приложение → «Бронь» → категория (A, B, C) → сколько часов → день и время → свободный инструктор → «Подтвердить».\nПосле брони вы получите код для кассы (AVD-1234). Когда бронь подтвердят — придёт сообщение в Telegram.',
    }),
  },
  {
    id: 'reschedule', title: 'Boshqa vaqtga o‘tkazish', escalate: true,
    kw: [['otkaz', 1.3], ['kochir', 1.3], ['boshka vakt', 1.3], ['boshka kun', 1.3], ['vaktini ozgart', 1.5], ['kunini ozgart', 1.5], ['perenes', 1.5], ['perenos', 1.5], ['drugoe vremya', 1.3], ['drugoy den', 1.3]],
    answer: () => ({
      uz: '🔁 Bronni boshqa vaqtga o‘tkazishda admin yordam beradi — so‘rovingizni adminga yubordim, shu yerda javob beradi.\nXohlasangiz o‘zingiz ham qila olasiz: «Bronlarim» → eski bronni bekor qiling → «Bron» orqali yangi vaqtni tanlang.',
      ru: '🔁 Перенести бронь поможет администратор — я передал ваш запрос, ответ придёт здесь.\nМожно и самому: «Мои брони» → отмените старую бронь → выберите новое время в «Бронь».',
    }),
  },
  {
    id: 'cancel', title: 'Bekor qilish',
    kw: [['bekor', 1.5], ['otmen', 1.5], ['kelolmay', 1.5], ['kela olmay', 1.5], ['borolmay', 1.2], ['bora olmay', 1.2], ['ne smogu', 1.2], ['ne pridu', 1.2]],
    answer: (c) => ({
      uz: `❌ Bekor qilish: Ilova → «Bronlarim» → bronni tanlang → «Bekor qilish».\nTasdiqlanmagan bron darhol bekor bo‘ladi, tasdiqlangan bron uchun sabab yozib so‘rov yuborasiz — admin ko‘rib chiqadi.${c.lateMin > 0 ? `\n⚠️ Dars vaqtidan ${c.lateMin} daqiqa kechiksangiz, bron avtomatik bekor bo‘ladi.` : ''}`,
      ru: `❌ Отмена: Приложение → «Мои брони» → выберите бронь → «Отменить».\nНеподтверждённая бронь отменяется сразу, для подтверждённой — отправьте запрос с причиной, администратор рассмотрит.${c.lateMin > 0 ? `\n⚠️ При опоздании на ${c.lateMin} минут бронь отменяется автоматически.` : ''}`,
    }),
  },
  {
    id: 'late', title: 'Kechiksam nima bo‘ladi',
    kw: [['kechik', 1.5], ['kech kol', 1.5], ['kech kel', 1.5], ['opozd', 1.5], ['ulgurmay', 1.2], ['ulgurolmay', 1.2]],
    answer: (c) => ({
      uz: c.lateMin > 0 ? `⏰ Dars vaqtidan ${c.lateMin} daqiqa kechiksangiz, bron avtomatik bekor bo‘ladi va vaqt boshqaga beriladi. Kechikadigan bo‘lsangiz — oldindan shu yerga yozing.` : '⏰ Kechikadigan bo‘lsangiz — oldindan shu yerga yozing.',
      ru: c.lateMin > 0 ? `⏰ При опоздании на ${c.lateMin} минут бронь отменяется автоматически и время отдаётся другому. Если опаздываете — напишите заранее здесь.` : '⏰ Если опаздываете — напишите заранее здесь.',
    }),
  },
  {
    id: 'payment', title: 'To‘lov',
    kw: [['tolov', 1.2], ['tola', 0.8], ['nakd', 1.2], ['karta', 0.9], ['click', 1.2], ['klik', 1.2], ['payme', 1.2], ['uzcard', 1.2], ['xumo', 1.2], ['oplat', 1.5], ['nalich', 1.2], ['perevod', 1.2], ['kartoy', 1.2]],
    answer: () => ({
      uz: '💳 To‘lov avtodrom kassasida — naqd yoki karta orqali. Bron qilgach sizga kassa kodi (AVD-1234) beriladi — kassaga shuni aytasiz. Oldindan onlayn to‘lash shart emas.',
      ru: '💳 Оплата в кассе автодрома — наличными или картой. После брони вы получите код для кассы (AVD-1234). Заранее оплачивать онлайн не нужно.',
    }),
  },
  {
    id: 'categories', title: 'Toifalar',
    kw: [['toifa', 1.2], ['kategor', 1.2], ['moto', 1.2], ['yuk mashin', 1.2], ['yuk avto', 1.2], ['gruzov', 1.2], ['legkov', 1]],
    answer: () => ({
      uz: '🚗 Toifalar:\nA — mototsikl.\nB — yengil avtomobil.\nC — yuk avtomobili (faqat amaliy haydash).',
      ru: '🚗 Категории:\nA — мотоцикл.\nB — легковой автомобиль.\nC — грузовой автомобиль (только практическое вождение).',
    }),
  },
  {
    id: 'duration', title: 'Kurs muddati',
    kw: [['davom', 1.3], ['necha kun', 1.2], ['necha oy', 1.2], ['kurs', 0.8], ['dlit', 1.3], ['srok', 1.2], ['skolko dney', 1.5], ['skolko mesyats', 1.5]],
    answer: () => ({
      uz: '📅 Kurs muddati:\nA toifa — 15 kun.\nB toifa — 2 oy 15 kun.\nC toifa — to‘liq kurs yo‘q, faqat soatlik amaliy haydash.',
      ru: '📅 Длительность курса:\nКатегория A — 15 дней.\nКатегория B — 2 месяца 15 дней.\nКатегория C — полного курса нет, только почасовое вождение.',
    }),
  },
  {
    id: 'exam', title: 'Imtihon',
    kw: [['imtixon', 1.5], ['ekzamen', 1.5], ['gai', 1], ['yxxb', 1], ['davlat imtix', 1.5]],
    answer: () => ({
      uz: '📝 Bu — imtihonga TAYYORLOV maydonchasi. Imtihonning o‘zi rasmiy imtihon markazida topshiriladi.',
      ru: '📝 Это площадка для ПОДГОТОВКИ к экзамену. Сам экзамен сдаётся в официальном экзаменационном центре.',
    }),
  },
  {
    id: 'contact', title: 'Telefon va bog‘lanish',
    kw: [['telefon', 1.2], ['nomer', 1], ['kongirok', 1.2], ['boglan', 1.2], ['zvon', 1.2], ['kontakt', 1.2], ['svyaz', 1.2], ['raqamingiz', 1.2]],
    answer: (c) => {
      const p = String(c.s.contact_phone || '').trim();
      return p ? {
        uz: `📞 Telefon: ${p}\nYoki shu yerga yozing — admin javob beradi.`,
        ru: `📞 Телефон: ${p}\nИли напишите здесь — администратор ответит.`,
      } : null;
    },
  },
  {
    id: 'instructors', title: 'Instruktorlar',
    kw: [['instruktor', 1.2], ['ustoz', 1.2], ['uchitel', 1], ['ayol instr', 1.5], ['jenshchin', 1.2]],
    answer: () => ({
      uz: '👨‍🏫 Instruktorni bron qilishda o‘zingiz tanlaysiz — rasmi, reytingi va tajribasi ko‘rinadi. Ro‘yxat: Ilova → «Avtodrom haqida» → «Instruktorlar».',
      ru: '👨‍🏫 Инструктора вы выбираете сами при брони — видно фото, рейтинг и опыт. Список: Приложение → «Об автодроме» → «Инструкторы».',
    }),
  },
  /* Ma'lumot yo'q — adminga (admin javobini «avto-javobga saqlash» bilan o'rgatsa bo'ladi) */
  { id: 'docs', title: 'Hujjatlar, guvohnoma', escalate: true, kw: [['guvoxnoma', 1.5], ['prava', 1.3], ['=prav', 1.3], ['voditelsk', 1.3], ['udostover', 1.3], ['xujjat', 1.5], ['dokument', 1.5], ['pasport', 1.2], ['spravka', 1.2], ['medspravk', 1.5], ['litsenz', 1.2]], answer: () => null },
  { id: 'cars', title: 'Mashinalar', escalate: true, kw: [['avtomat', 1.2], ['mexanik', 1.2], ['kobalt', 1.3], ['gentra', 1.3], ['neksiya', 1.3], ['nexia', 1.3], ['spark', 1.3], ['damas', 1.3], ['korobk', 1.2], ['mashina', 0.8]], answer: () => null },
  { id: 'human', title: 'Admin bilan gaplashish', escalate: true, kw: [['operator', 1.2], ['jonli', 1], ['odam bilan', 1.2], ['admin bilan', 1.2], ['administrator', 1.2]], answer: () => null },
];
const GREET: Array<[string, number]> = [['salom', 1], ['assalom', 1], ['alaykum', 1], ['privet', 1], ['zdravst', 1], ['xayrli', 0.8], ['dobriy', 1], ['xell', 1]];
const THANKS: Array<[string, number]> = [['raxmat', 1], ['tashakkur', 1], ['spasib', 1], ['sps', 1], ['blagodar', 1]];
/* «ok», «xo'p», «tushunarli» — javob shart emas, adminni ham bezovta qilmaydi */
const ACK: Array<[string, number]> = [['=ok', 1], ['=okey', 1], ['=xop', 1], ['=xopp', 1], ['tushun', 1], ['=yaxshi', 1], ['=zor', 1], ['ponyat', 1], ['ponyal', 1], ['=ladno', 1], ['=xorosho', 1], ['=aniq', 1], ['=mayli', 1], ['=boldi', 1]];
const scoreOf = (norm: string, kw: Array<[string, number]>) => {
  const seen = new Set<string>();
  let s = 0;
  for (const [k, w] of kw) if (!seen.has(k) && has(norm, k)) { seen.add(k); s += w; }
  return s;
};

/* ------------------------------------------------------------------ */
/* Bilim bazasi (admin qo'shgan savol-javoblar)                         */
/* ------------------------------------------------------------------ */
export function kbMatch(norm: string, kb: KbItem[]): { item: KbItem; score: number } | null {
  const toks = tokensOf(norm);
  if (!toks.length) return null;
  let best: { item: KbItem; score: number } | null = null;
  for (const item of kb) {
    if (item.on === false) continue;
    for (const q of item.q) {
      const st = tokensOf(normalize(q));
      if (!st.length) continue;
      const hit = st.filter((w) => toks.some((t) => t.slice(0, 5) === w.slice(0, 5) || (w.length >= 4 && t.startsWith(w)) || (t.length >= 4 && w.startsWith(t)))).length;
      const need = Math.min(2, st.length);
      if (hit < need) continue;
      const score = hit / st.length;
      if (score >= 0.6 && (!best || score > best.score)) best = { item, score };
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Javob                                                               */
/* ------------------------------------------------------------------ */
export type BotAnswer = {
  text: string;                          // mijozga (🤖 bilan boshlanadi)
  kind: 'kb' | 'intent' | 'greet' | 'thanks' | 'ack' | 'unknown';
  topics: string[];                      // topilgan mavzular / KB id
  escalate: boolean;                     // adminga ham yuborilsinmi (javobsiz yoki admin kerak)
};
const UNKNOWN = {
  uz: 'Savolingizni adminga yubordim ✅ Tez orada shu yerda javob beradi.\n\nMen darhol javob bera oladigan mavzular: narxlar, ish vaqti, manzil, bron qilish, bekor qilish, to‘lov, kechikish, «mening bronim».',
  ru: 'Ваш вопрос передан администратору ✅ Ответ придёт здесь.\n\nСразу могу ответить про: цены, время работы, адрес, бронь, отмену, оплату, опоздание, «моя бронь».',
};
const ESC = { uz: '📨 Savolingizni adminga ham yubordim — shu yerda javob beradi.', ru: '📨 Вопрос передан и администратору — ответ придёт здесь.' };

export async function answerQuestion(text: string, o: { userId?: string | null; settings?: Record<string, any> } = {}): Promise<BotAnswer> {
  const s = o.settings || await loadSettings();
  const ru = isRussian(text);
  const L = (a: { uz: string; ru: string }) => (ru ? a.ru : a.uz);
  const norm = normalize(text);
  const wrap = (t: string) => BOT_PREFIX + t;

  /* 1) admin o'rgatgan javob */
  const kb = kbMatch(norm, kbOf(s));
  if (kb) return { text: wrap(kb.item.a), kind: 'kb', topics: [kb.item.id], escalate: false };

  /* 2) tayyor mavzular */
  const scored = INTENTS.map((it) => ({ it, sc: scoreOf(norm, it.kw) })).filter((x) => x.sc >= 1).sort((a, b) => b.sc - a.sc);
  if (scored.length) {
    /* ikkinchi mavzu — faqat aniq bo'lsa («B toifa 1 soat qancha» — toifalar emas, narx) */
    const top = scored.slice(0, 2).filter((x, i) => i === 0 || (x.sc >= 1.3 && x.sc >= 0.6 * scored[0].sc));
    const ctx = await ctxFor(s, o.userId || null, top.some((x) => x.it.need === 'bookings'));
    const parts: string[] = [];
    let escalate = false;
    for (const { it } of top) {
      const a = it.answer(ctx);
      if (a) parts.push(L(a));
      if (!a || it.escalate) escalate = true;
    }
    if (!parts.length) return { text: wrap(L(UNKNOWN)), kind: 'unknown', topics: top.map((x) => x.it.id), escalate: true };
    if (escalate && !top.some((x) => x.it.id === 'reschedule')) parts.push(L(ESC));
    return { text: wrap(parts.join('\n\n')), kind: 'intent', topics: top.map((x) => x.it.id), escalate };
  }

  /* 3) salom / rahmat / «ok» — faqat shu bo'lsa */
  const words = norm.split(' ').filter(Boolean).length;
  const ackOnly = words > 0 && words <= 3 && norm.split(' ').every((t) => ACK.some(([k]) => (k.startsWith('=') ? t === k.slice(1) : t.startsWith(k))));
  if (ackOnly) return { text: '', kind: 'ack', topics: [], escalate: false };
  if (scoreOf(norm, THANKS) >= 1 && words <= 6) {
    return { text: wrap(L({ uz: 'Arzimaydi! 😊 Yana savol bo‘lsa — yozing.', ru: 'Пожалуйста! 😊 Если будут вопросы — пишите.' })), kind: 'thanks', topics: [], escalate: false };
  }
  if (scoreOf(norm, GREET) >= 1 && words <= 6) {
    return {
      text: wrap(L({
        uz: 'Assalomu alaykum! 👋 Men avtodrom yordamchisiman. Savolingizni yozing — narxlar, ish vaqti, manzil, bron qilish, bekor qilish, to‘lov… Javob topolmasam, adminga yuboraman.',
        ru: 'Здравствуйте! 👋 Я помощник автодрома. Напишите вопрос — цены, время работы, адрес, бронь, отмена, оплата… Если не найду ответ — передам администратору.',
      })),
      kind: 'greet', topics: [], escalate: false,
    };
  }
  return { text: wrap(L(UNKNOWN)), kind: 'unknown', topics: [], escalate: true };
}
