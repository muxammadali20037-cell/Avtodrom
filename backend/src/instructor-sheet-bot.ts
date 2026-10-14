import { telegramApi } from './telegram.js';
import { supabaseRest } from './supabase.js';
import { findUserByTelegram, instructorProfileForUser } from './identity.js';
import { tashkentYmdOf, addDaysYmd } from './instructor-schedule.js';
import { cellKey, parsePhone, parseHalf, nameFrom, prettyPhone, SHEET_FIRST_HOUR, SHEET_LAST_HOUR } from './booking-sheet.js';
import { applySheetChanges, instructorDay, SHEET_LOCK_MSG } from './booking-sheet-routes.js';
import { adminUser, audit } from './admin-password-routes.js';
import { parseMenu, MENU_KEYBOARD, latinWords } from './instructor-bot-menu.js';

/**
 * INSTRUKTOR BOTI ORQALI BRON
 *
 * Instruktorlar avval guruhga «901234567 14:00» deb yozishardi. Endi o'sha
 * xabarni o'z INSTRUKTOR BOTiga yozadi — bot uni o'qib, shu instruktorga
 * bron qiladi (Excel bron jadvalining o'sha ustuniga tushadi, kod bilan):
 *
 *   901234567 14:00               bugun 14:00, 1 soat
 *   ertaga 901234567 15-17        ertaga 15:00–17:00, 2 soat
 *   12.10 994188549 10:00 /C      12-oktabr, C toifa
 *   901234567 9:00 30 min         30 daqiqa
 *   bekor 14:00                   o'zi bot orqali yozgan, to'lanmagan bronni bekor qiladi
 *   bugun / ertaga                shu kungi jadvali
 *
 * Bron darhol tasdiqlangan. Ish grafigi, bandlik, toifa — Excel bron bilan
 * bir xil tekshiriladi (bitta yo'l: applySheetChanges).
 */

export type BotCmd =
  | { kind: 'book'; date: string; h0: number; h1: number; phone: string; cat: 'A' | 'B' | 'C' | null; half: boolean; off?: 30; name: string | null }
  /* pick — na vaqt, na raqam yozilgan: bot yaqin bronlarni tugma qilib chiqaradi */
  | { kind: 'cancel'; date: string; h0: number | null; phone: string | null; anyDay?: boolean; pick?: boolean }
  | { kind: 'list'; date: string }
  | { kind: 'help'; error?: string };

const MAX_DAYS = 30;
const MAX_HOURS = 5;
const CYR: Record<string, 'A' | 'B' | 'C'> = { 'а': 'A', 'в': 'B', 'с': 'C', a: 'A', b: 'B', c: 'C' };
/* Ism bo'la olmaydigan so'zlar (xabardagi qolgan so'zlardan mijoz ismi olinadi) */
const STOP_WORDS = new Set(('bugun ertaga ertag ertga indinga soat soatga da ga dan gacha kuni kun bron broni bronga qil qiling qilib qilish ' +
  'mijoz mijozga yoz yozib yozing yozdim qo\'y qoy qo\'ying qoying qo\'yib iltimos uchun kerak dars darsga darsi o\'quvchi oquvchi ' +
  'kechki kechqurun kechqurin ertalab tushdan keyin oldin band ber bering bor yangi raqam raqami nomer tel telefon aka opa ' +
  'keladi kelsin kelyapti kelib kelishadi birga bilan boradi oladi olib yozvoring yozvor shu ushbu mana yana ham ' +
  'bir ikki uch kishi kishiga agar kelmasa aytaman aytadi soatda soatga chek kod avans pul tolov to\'lov ' +
  'dushanba seshanba chorshanba payshanba juma shanba yakshanba min daq minut minutlik daqiqa avtomat mexanika ' +
  'сегодня завтра послезавтра бугун эртага ертага индинга в на с до час часа часов бронь клиент мин минут запиши записать ' +
  'пожалуйста ученик урок вечер вечера утра утром понедельник вторник среда среду четверг пятница пятницу суббота субботу воскресенье').split(' '));

/** Hafta kunlari → JS getDay */
const WEEKDAYS: [RegExp, number][] = [
  [/(^|\s)(dushanba|душанба|понедельник)(?=[\s,.!]|$)/u, 1], [/(^|\s)(seshanba|сешанба|вторник)(?=[\s,.!]|$)/u, 2],
  [/(^|\s)(chorshanba|чоршанба|среда|среду)(?=[\s,.!]|$)/u, 3], [/(^|\s)(payshanba|пайшанба|четверг)(?=[\s,.!]|$)/u, 4],
  [/(^|\s)(juma|жума|пятница|пятницу)(?=[\s,.!]|$)(?!\s*(?:aka|opa|akaga|opaga|ака|опа)(?:\s|$))/u, 5], [/(^|\s)(shanba|шанба|суббота|субботу)(?=[\s,.!]|$)/u, 6],
  [/(^|\s)(yakshanba|якшанба|воскресенье)(?=[\s,.!]|$)/u, 0],
];

/* ---------- so'zlar: yarim soat, bekor, ko'chirish, son so'zlari ---------- */
/* Bekor qilish so'zlari — xabarning ISTALGAN joyida («bekor 14:00», «ertaga 14:00 ni bekor qiling»,
   «901234567 otmen», «удали 14:00»). Faqat aniq so'z shakllari: «bekorga», «Udalov», «o'chirmang» — bekor emas. */
const QIL = "(?:\\s+(?:qil|qilish|qiling|qilib|qilindi|qilinsin|qilamiz|qilaylik|qilmoqchiman|qilmoqchimiz|qilsangiz|qilvoring|qilvor|qilasiz|kil|kilish|kiling|kilib)(?=\\s|$))?";
const CANCEL_RE = new RegExp(`(^|\\s)\\/?(?:(?:bekor|bekr|bkor|bekar)${QIL}|bekorlash|otmen|otmena|otmenit|otmeni|otmenite|отмена|отмени|отменить|отмените|отменяю|udali|udalit|udalite|удали|удалить|удалите|o'?chir|o'?chiring|o'?chirib|o'?chirish|o'?chirvor|o'?chirvoring|o'?chirilsin|cancel)(?=\\s|$)`, 'gu');
/* «kelmaydi», «kerak emas» — bekor degani. Xabarda telefon ham bo'lsa (bron bo'lishi mumkin) — so'raymiz */
const CANCEL_SOFT = /(^|\s)(?:kelmaydi|kelolmaydi|kelmayapti|kelmaydigan|келмайди|келолмайди|kerak\s+emas|керак\s+эмас|не\s+нужно|ne\s+nujno)(?=\s|$)/gu;
const MOVE_RE = /(^|\s)(?:ko'?chir|ko'?chiring|ko'?chirib|ko'?chirish|ko'?chirsangiz|ko'?chiramiz|ko'?chirvoring|kuchir|kuchiring|перенеси|перенесите|перенести|перенос|perenesi|perenesti|perenos)(?=\s|$)/u;
const has = (re: RegExp, s: string) => new RegExp(re.source, re.flags.replace('g', '')).test(s);

/* Son so'zlari — FAQAT vaqt/davomiylik ma'nosida: «soat ikkida», «o'n beshda», «ikki soat», «ikki yarimda».
   «bir o'quvchi», «ikki kishi», «birga» — son emas. */
const UNITS: Record<string, number> = { bir: 1, ikki: 2, uch: 3, "to'rt": 4, tort: 4, besh: 5, olti: 6, yetti: 7, sakkiz: 8, "to'qqiz": 9, toqqiz: 9 };
const NUM = "(?:(?:o'?n|yigirma)(?:\\s*(?:bir|ikki|uch|to'?rt|besh|olti|yetti|sakkiz|to'?qqiz))?|bir|ikki|uch|to'?rt|besh|olti|yetti|sakkiz|to'?qqiz)";
function numVal(w: string): number {
  const m = /^(o'?n|yigirma)?\s*(.*)$/.exec(w.trim())!;
  const tens = m[1] ? (m[1].startsWith('y') ? 20 : 10) : 0;
  const u = m[2] ? UNITS[m[2]] ?? 0 : 0;
  return tens + u;
}
const RU_NUM: Record<string, number> = { один: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5 };
function numWords(s: string): string {
  /* «ikkida», «o'n beshga» (qo'shimcha yopishgan) — «bir» faqat «soat»dan keyin («birga», «birda» — boshqa so'z) */
  s = s.replace(new RegExp(`(^|\\s)(soat\\s+)?(${NUM})(da|ga)(?=\\s|$)`, 'gu'), (m, p, soat, w, suf) =>
    (w === 'bir' && !soat ? m : `${p}${soat || ''}${numVal(w)} ${suf}`));
  /* «soat ikki», «soat o'n besh» */
  s = s.replace(new RegExp(`(^|\\s)soat\\s+(${NUM})(?=\\s|$)`, 'gu'), (_m, p, w) => `${p}soat ${numVal(w)}`);
  /* «ikki soat», «uch soatlik» — davomiylik; «ikki yarimda» — 2:30 */
  s = s.replace(new RegExp(`(^|\\s)(${NUM})\\s+(?=(?:soat|soatlik|soatga|soatli|chas|yarim)(?:\\s|$|da|ga))`, 'gu'), (_m, p, w) => `${p}${numVal(w)} `);
  s = s.replace(/(^|\s)(один|одна|два|две|три|четыре|пять)\s+(?=час)/gu, (_m, p, w) => `${p}${RU_NUM[w]} `);
  return s;
}
/** Oldidagi matn raqam bilan tugaydimi (telefon bo'lagi) */
const afterDigits = (s: string, idx: number) => /\d[\s\-.()]{0,3}$/.test(s.slice(0, idx));

/** Xabardan buyruq. today — Toshkent bo'yicha bugungi sana (YYYY-MM-DD). */
export function parseBotText(raw: string, today: string): BotCmd {
  const text = String(raw || '').replace(/[’'`ʻ‘]/g, "'").replace(/\s+/g, ' ').trim();
  if (!text) return { kind: 'help' };
  /* «ertaga13:00», «13da», «15gacha» — harf va raqam orasiga bo'shliq */
  let s = latinWords(` ${text.toLowerCase()} `.replace(/(\p{L})(?=\d)/gu, '$1 ').replace(/(\d)(?=\p{L})/gu, '$1 '));
  /* Tinish belgilari: «bekor, ertaga 14:00», «otmena!» — so'z ajratuvchi. Raqamlar orasidagisi («14:00», «12.10», «0,5») qoladi */
  s = s.replace(/[!?;«»"]/g, ' ').replace(/(?<!\d)[.,:]|[.,:](?!\d)/g, ' ');
  const cut = (re: RegExp) => { s = s.replace(re, ' '); };

  /* --- buyruq turi --- */
  if (has(MOVE_RE, s)) {
    return { kind: 'help', error: 'Ko‘chirish uchun: avval eski bronni bekor qiling (masalan «bekor 14:00»), keyin yangi vaqtni yozing (masalan «ertaga 16:00 901234567»).' };
  }
  const strongCancel = has(CANCEL_RE, s), softCancel = has(CANCEL_SOFT, s);
  if (strongCancel) cut(CANCEL_RE);
  if (softCancel) cut(CANCEL_SOFT);
  s = numWords(s);
  /* «14-00», «14,00» — soat va daqiqa (chiziqcha/vergul bilan); telefon bo'laklariga tegmaydi */
  s = s.replace(/(^|[^\d\-.:,])(\d{1,2})[-,](00|30)(?![\d\-.:,])/g, (m, p, hh, mm, idx) =>
    (Number(hh) <= 23 && !afterDigits(s, idx + p.length) ? `${p}${hh}:${mm}` : m));
  /* «14:00 30» — vaqtdan keyingi yolg'iz 30 — yarim soat */
  s = s.replace(/(\d{1,2}[:.](?:00|30))\s+30(?=\s|$)/g, '$1 30min');

  /* --- sana --- */
  let date = today;
  const s0 = s;
  const seen = new Set<string>();
  const DAY2 = /(^|\s)(indinga|indiga|indin|индинга|послезавтра|poslezavtra)(?=[\s,.!]|$)/u;
  const DAY1 = /(^|\s)(ertaga|ertag|ertga|ertaka|ertangi|ertagi|ertasiga|эртага|ертага|завтра|zavtra)(?=[\s,.!]|$)/u;
  const DAY0 = /(^|\s)(bugun|bugungi|bugn|бугун|сегодня|segodnya)(?=[\s,.!]|$)/u;
  if (DAY2.test(s)) { date = addDaysYmd(today, 2); seen.add(date); cut(DAY2); }
  if (DAY1.test(s)) { date = addDaysYmd(today, 1); seen.add(date); cut(DAY1); }
  if (DAY0.test(s)) { date = today; seen.add(date); cut(DAY0); }
  /* «payshanba», «juma» — shu haftaning (yoki keyingi) o'sha kuni */
  for (const [re, wd] of WEEKDAYS) {
    if (!re.test(s)) continue;
    const cur = new Date(`${today}T12:00:00Z`).getUTCDay();
    date = addDaysYmd(today, (wd - cur + 7) % 7);
    seen.add(date);
    cut(re);
    break;
  }
  /* Faqat nuqta bilan: «12.10». «3/10» — Excel'dagi «10 tadan 3-dars» belgisi, sana emas */
  const dm = /(^|\s)(\d{1,2})\.(\d{1,2})(?:\.(\d{2}|\d{4}))?(?=[\s,]|$)/.exec(s);
  if (dm) {
    const d = Number(dm[2]), m = Number(dm[3]);
    const isTime = dm[4] === undefined && ['00', '30'].includes(dm[3]);
    if (!isTime && d >= 1 && d <= 31 && m >= 1 && m <= 12) {
      let y = dm[4] ? Number(dm[4].length === 2 ? '20' + dm[4] : dm[4]) : Number(today.slice(0, 4));
      let cand = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (!dm[4] && cand < addDaysYmd(today, -1)) { y++; cand = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
      const check = new Date(`${cand}T12:00:00Z`);
      if (Number.isNaN(check.getTime()) || check.getUTCDate() !== d) return { kind: 'help', error: 'Sana noto‘g‘ri' };
      date = cand;
      seen.add(date);
      s = s.replace(dm[0], ' ');
    }
  }
  if (seen.size > 1) return { kind: 'help', error: 'Kun ikki xil yozilgan — qaysi kun? Bitta kunni yozing, masalan: «ertaga 14:00 901234567».' };
  const dateGiven = s !== s0;

  /* --- davomiylik --- */
  let dur: number | null = null, half = false, badDur = false;
  /* «1,5 soat», «bir yarim soat», «2 soat yarim», «1 soat 30 min» — Excel bronda faqat 30 daqiqa yoki butun soat */
  const FRAC = /(^|\s)(?:[1-5]\s*(?:[.,]5|yarim)\s*(?:soat|soatlik|soatga|chas|час|часа)|[1-5]\s*(?:soat|soatlik|chas|час|часа)\s+(?:yarim|30\s*(?:min|daq)\S*))(?=[\s,.]|$)/u;
  if (FRAC.test(s)) { badDur = true; cut(FRAC); }
  const DUR = /(^|\s)([1-5])\s*(?:soat|soatlik|soatga|soatli|соат|chas|часа|час|ч|h)(?=[\s,.]|$)/u;
  const dd = DUR.exec(s);
  if (dd && !/(^|\s)в\s*$/u.test(s.slice(0, dd.index + dd[1].length))) { dur = Number(dd[2]); s = s.replace(dd[0], ' '); }

  /* --- vaqt: «15-17», «15:00-17:00», «14:00-14:30», «с 15 до 17», «14:00», «14:30», «soat 14», «14 da», «2 yarimda» --- */
  let h0: number | null = null, h1: number | null = null, m0 = 0, m1 = 0, badMinute = false;
  const hh = (v: string) => Number(v);
  const okMin = (v: string | undefined) => !v || v === '00' || v === '30';
  const range = /(^|\s)(?:с\s*)?(\d{1,2})(?:[:.](\d{2}))?\s*(?:-|–|—|до|dan)\s*(\d{1,2})(?:[:.](\d{2}))?(?:\s*(?:gacha|ga|da))?(?=[\s,]|$)/u.exec(s);
  if (range && hh(range[2]) <= 23 && hh(range[4]) <= 24) {
    h0 = hh(range[2]); h1 = hh(range[4]);
    if (!okMin(range[3]) || !okMin(range[5])) badMinute = true;
    m0 = range[3] === '30' ? 30 : 0; m1 = range[5] === '30' ? 30 : 0;
    s = s.replace(range[0], ' ');
  } else {
    const one = /(^|\s)(?:soat\s*|в\s*)?(\d{1,2})[:.](\d{2})(?:\s*(?:da|ga|дан|dan))?(?=[\s,]|$)/u.exec(s);
    /* «2 yarimda», «soat 2 yarim» — 14:30 (telefon bo'lagi emas; «2 yarim soat» — davomiylik) */
    let yarimda: RegExpExecArray | null = null;
    for (const m of s.matchAll(/(^|\s)(soat\s*)?(\d{1,2})\s*yarim\s*(da|ga)?(?=[\s,]|$)/gu)) {
      const after = s.slice((m.index ?? 0) + m[0].length);
      if (/^\s*(?:soat|chas|час)/u.test(after)) continue;
      const ampm = /(?:^|\s)(?:kechki|kechqurun|kechqurin|ertalab|tushdan|keyin|вечером|утром)\s*$/u.test(s.slice(0, (m.index ?? 0) + m[1].length));
      if (!m[2] && !m[4] && !ampm) continue;                         // «soat 2 yarim», «2 yarimda», «kechki 6 yarim»
      if (!m[2] && afterDigits(s, (m.index ?? 0) + m[1].length)) continue;
      yarimda = m as RegExpExecArray; break;
    }
    if (one && hh(one[2]) <= 23) {
      h0 = hh(one[2]); if (!okMin(one[3])) badMinute = true;
      m0 = one[3] === '30' ? 30 : 0;
      s = s.replace(one[0], ' ');
    } else if (yarimda && hh(yarimda[3]) <= 23) {
      h0 = hh(yarimda[3]); m0 = 30;
      s = s.replace(yarimda[0], ' ');
    } else {
      const word = /(^|\s)(?:soat\s*(\d{1,2})(?:\s*(?:da|ga))?|(\d{1,2})\s*(?:da|ga|часов|час))(?=[\s,]|$)/u.exec(s);
      if (word) { h0 = hh(word[2] || word[3]); s = s.replace(word[0], ' '); }
    }
  }

  /* --- telefon (vaqt va sanadan keyin qolgan matndan) --- */
  const phone = parsePhone(s);
  if (phone) {
    /* Faqat raqamning o'zini olib tashlaymiz («901234567 14» — 14 soat bo'lib qolsin) */
    const sep = '[\\s\\-.()]{0,3}';
    const local = phone.slice(-9).split('').join(sep);
    s = s.replace(new RegExp(`(?:\\+?9${sep}9${sep}8${sep})?${local}`), ' ');
  }
  /* Yarim soat: «30 min», «yarim soat», «yarimta», «пол часа», «0,5 soat», «1/2» (telefon olib tashlangandan keyin) */
  const HALF_RES = [
    /(^|\s)(?:0[.,]5|1\/2)(?:\s*(?:soat|soatlik|soatga|chas|час|часа|ч))?(?=[\s,.)]|$)/gu,
    /(^|\s)(?:пол\s*часа?|полчаса|полчас|pol\s*chasa?|polchasa)(?=[\s,.)]|$)/gu,
    /(^|\s|\()30\s*-?\s*(?:m|mn|min|mins|minut|minutlik|minutga|minutka|minutli|мин|минут|минутка|daq|daqiqa|daqiqalik|daqiqaga|дақ|дақиқа|дак|дакика)\.?(?=[\s,.)]|$)/gu,
    /(^|\s)(?:yarim|yarm|yarimta)(?:\s*(?:soat|soatlik|soatga|soatli|chas|час|часа))?(?=[\s,.]|$)/gu,
  ];
  for (const re of HALF_RES) if (has(re, s)) { half = true; cut(re); }
  if (h0 === null) {
    /* oddiy son: «901234567 14», «soat 3» */
    const bare = /(^|\s)(\d{1,2})(?=[\s,]|$)/.exec(s);
    if (bare && hh(bare[2]) >= 1 && hh(bare[2]) <= SHEET_LAST_HOUR) { h0 = hh(bare[2]); s = s.replace(bare[0], ' '); }
  }
  /* «soat 3 da» — kunduzgi 15:00 (avtodrom 6:00 dan ishlaydi); «kechki 6» — 18:00 */
  const PM = /(^|\s)(kechki|kechqurun|kechqurin|кечки|кечкурун|вечер|вечера|вечером|tushdan)(?=[\s,.]|$)/u;
  const pm = PM.test(s);
  if (pm) cut(PM);
  if (h0 !== null && ((h0 >= 1 && h0 <= 5) || (pm && h0 < 12))) h0 += 12;
  if (h0 !== null && h1 !== null) {
    const a0 = h0 * 60 + m0, e1 = h1 * 60 + m1;
    if ((e1 <= a0 && e1 + 720 > a0) || (pm && h1 < 12)) h1 += 12;
  }

  /* --- toifa: «/C», «C toifa», katta lotin harfi --- */
  let cat: 'A' | 'B' | 'C' | null = null;
  const c1 = /\/\s*([abcавс])(?=[\s,./]|$)/iu.exec(s) || /(^|\s)([abcавс])\s*(?:toifa|тоифа|kat|кат)/iu.exec(s);
  if (c1) { cat = CYR[(c1[2] || c1[1]).toLowerCase()] || null; s = s.replace(c1[0], ' '); }
  else {
    const up = /(^|\s)([ABC])(?=[\s,]|$)/.exec(` ${text} `);
    if (up) { cat = up[2] as 'A' | 'B' | 'C'; s = s.replace(new RegExp(`(^|\\s)${up[2].toLowerCase()}(?=[\\s,]|$)`), ' '); }
  }
  if (parseHalf(text)) half = true;
  s = s.replace(/(^|\s)30\s*(min|мин|daq|minut|минут)\S*/giu, ' ').replace(/toifa|тоифа/giu, ' ');
  const name = nameFrom(s.replace(/[\d/:+().,!?-]+/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOP_WORDS.has(w)).join(' '));

  if (softCancel && !strongCancel && phone) {
    return { kind: 'help', error: 'Tushunmadim: bron qilaymi yoki bekor qilaymi? Bekor qilish uchun: «bekor 14:00» yoki «bekor 901234567». Bron uchun: «ertaga 14:00 901234567».' };
  }
  if (strongCancel || softCancel) {
    /* Na vaqt, na raqam — bot yaqin bronlarni tugma qilib chiqaradi */
    if (h0 === null && !phone) return { kind: 'cancel', date, h0: null, phone: null, pick: true, ...(!dateGiven ? { anyDay: true } : {}) };
    /* «bekor 932728766» (kunsiz) — bot yaqin kunlardan o'sha raqamni o'zi topadi */
    return { kind: 'cancel', date, h0, phone, ...(h0 === null && !dateGiven ? { anyDay: true } : {}) };
  }
  if (!phone) {
    /* «bugun», «ertaga», «12.10», «jadval» — o'sha kunning ro'yxati (rasm bilan) */
    const rest = s.replace(/(^|\s)\/?(list|ro'yxat|royxat|jadval|jadvalim|bronlar|bronlarim|o'quvchilar|oquvchilar|список)(?=\s|$)/giu, ' ').trim();
    if (h0 === null && !rest && !half) return { kind: 'list', date };
    return { kind: 'help', error: h0 !== null || half ? 'Mijozning telefon raqamini yozing (9 ta raqam).' : undefined };
  }
  if (h0 === null) return { kind: 'help', error: 'Vaqtni yozing, masalan: 901234567 14:00' };
  if (badMinute) return { kind: 'help', error: 'Bron soat boshidan (14:00) yoki yarimidan (14:30) boshlanadi.' };
  if (badDur) return { kind: 'help', error: 'Excel bronda 30 daqiqa yoki butun soat (1–5 soat) bo‘ladi. Masalan: «14:00 30 min», «14:00 2 soat».' };

  /* --- boshlanish va tugash --- */
  let off = 0;
  if (h1 !== null) {
    const len = (h1 * 60 + m1) - (h0 * 60 + m0);
    if (len === 30) { half = true; off = m0; h1 = h0 + 1; }
    else if (m0 === 30) return { kind: 'help', error: `Soat yarimidan faqat 30 daqiqalik bron bo‘ladi: ${h0}:30–${h0 + 1}:00. 1 soat kerak bo‘lsa — ${h0}:00 yoki ${h0 + 1}:00 deb yozing.` };
    else if (len <= 0 || len % 60) return { kind: 'help', error: len > 0 ? 'Excel bronda 30 daqiqa yoki butun soat (1–5 soat) bo‘ladi.' : `Vaqt ${SHEET_FIRST_HOUR}:00 dan ${SHEET_LAST_HOUR + 1}:00 gacha bo‘lishi kerak.` };
    else if (half) return { kind: 'help', error: `«Yarim soat» va ${len / 60} soatlik oraliq birga yozilgan — qaysi biri? Masalan: «${h0}:00 30 min» yoki «${h0}:00-${h1}:00».` };
  } else if (m0 === 30) {
    if (dur) return { kind: 'help', error: `Soat yarimidan faqat 30 daqiqalik bron bo‘ladi: ${h0}:30–${h0 + 1}:00. ${dur} soat kerak bo‘lsa — ${h0}:00 yoki ${h0 + 1}:00 deb yozing.` };
    half = true; off = 30; h1 = h0 + 1;
  } else if (half) {
    if (dur && dur > 1) return { kind: 'help', error: `«Yarim soat» va «${dur} soat» birga yozilgan — qaysi biri? Masalan: «${h0}:00 30 min» yoki «${h0}:00 ${dur} soat».` };
    h1 = h0 + 1;
  } else h1 = h0 + (dur || 1);

  if (h0 < SHEET_FIRST_HOUR || h0 > SHEET_LAST_HOUR || h1 <= h0 || h1 > SHEET_LAST_HOUR + 1) {
    return { kind: 'help', error: `Vaqt ${SHEET_FIRST_HOUR}:00 dan ${SHEET_LAST_HOUR + 1}:00 gacha bo‘lishi kerak.` };
  }
  if (h1 - h0 > MAX_HOURS) return { kind: 'help', error: `Bir martada ko‘pi bilan ${MAX_HOURS} soat.` };
  if (date < today) return { kind: 'help', error: 'O‘tgan kunga bron qilib bo‘lmaydi.' };
  if (date > addDaysYmd(today, MAX_DAYS)) return { kind: 'help', error: `Ko‘pi bilan ${MAX_DAYS} kun oldinga.` };
  return { kind: 'book', date, h0, h1, phone, cat, half: half && h1 - h0 === 1, ...(off ? { off: 30 as const } : {}), name };
}

/* ---------------- javob matnlari ---------------- */
const MON = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
function dayText(date: string, today: string) {
  if (date === today) return 'Bugun';
  if (date === addDaysYmd(today, 1)) return 'Ertaga';
  const [, m, d] = date.split('-').map(Number);
  return `${d}-${MON[m - 1]}`;
}
const hText = (h: number) => `${String(h).padStart(2, '0')}:00`;
const hmText = (h: number, m = 0) => `${String(h).padStart(2, '0')}:${m ? '30' : '00'}`;
const fmtHm = (ms: number) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
/** Katakdagi bronning aniq vaqti (14:30–15:00); bo'lmasa — soatlar bo'yicha */
function cellSpan(c: { h: number; sc?: SheetCellLite | null }, lastH: number): string {
  const s0 = c.sc?.s ? Date.parse(c.sc.s) : NaN, m = Number(c.sc?.m) || 0;
  if (Number.isFinite(s0) && m > 0) return `${fmtHm(s0)}–${fmtHm(s0 + m * 60000)}`;
  return `${hText(c.h)}–${hText(lastH + 1)}`;
}
type SheetCellLite = { t: string; b?: string; s?: string; m?: number; bi?: string };
export const BOT_HELP = [
  '📝 Mijoz raqami va vaqtni istalgan tartibda yozing:',
  '',
  '<code>ertaga 13:00 932728766</code> — ertaga, 1 soat',
  '<code>932728766 bugun 18</code> — bugun 18:00',
  '<code>ertaga 15-17 932728766</code> yoki <code>ertaga 2 soat 15:00 …</code> — 2 soat',
  '<code>juma 10:00 932728766</code>, <code>12.10 10:00 …</code> — hafta kuni yoki sana',
  '<code>ertaga 14:00 30 min …</code>, <code>… yarim soat</code> yoki <code>14:00-14:30</code> — yarim soat',
  '<code>ertaga 14:30 932728766</code> — 14:30–15:00, yarim soat',
  '<code>… /C</code> — C toifa, ism ham yozsa bo‘ladi',
  '',
  '<code>bekor 13:00</code>, <code>ertaga 13:00 bekor</code> yoki <code>bekor 932728766</code> — o‘zingiz yozgan bronni bekor qilish',
  'Faqat <code>bekor</code> deb yozsangiz — bronlaringiz tugma bo‘lib chiqadi, bosasiz va bekor bo‘ladi',
  '<code>bugun</code>, <code>ertaga</code> yoki <code>12.10</code> — o‘quvchilaringiz (rasm + raqamlar)',
  '',
  'Kirillda ham bo‘ladi: <code>эртага 14:00 901234567</code>, <code>бекор 14:00</code>',
  '',
  '👇 Pastdagi menyu: bugungi/ertangi jadval va bronlaringiz — raqamni bosib qo‘ng‘iroq qilasiz.',
].join('\n');

/** Javob yuboradi; xato bo'lsa — matni (aks holda null). */
const sendRaw = (token: string, chatId: number, text: string, extra: Record<string, unknown> = {}): Promise<string | null> =>
  telegramApi(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }).then(() => null, (e) => {
    const m = e instanceof Error ? e.message : String(e);
    console.error('instructor bot reply failed:', m);
    return m;
  });
const htmlEsc = (v: unknown) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);

/**
 * Instruktor botiga kelgan oddiy matnli xabar. Instruktor topilmasa — false
 * (chaqiruvchi o'z javobini beradi), aks holda o'zi javob yozadi.
 */
export async function handleInstructorSheetMessage(token: string, chatId: number, telegramId: number, text: string, log?: string[], opts: { ensureButtons?: () => Promise<unknown> } = {}): Promise<boolean> {
  /* log — bot nima javob berganini yozib boradi (bot jurnali uchun) */
  const send = async (t: string, c: number, msg: string, extra: Record<string, unknown> = {}) => {
    const err = await sendRaw(t, c, msg, extra);
    log?.push(err ? `[yuborilmadi: ${err}] ${msg}` : msg);
  };
  const user = await findUserByTelegram(telegramId);
  const prof = user ? await instructorProfileForUser(String(user.id), true) : null;
  if (!prof) {
    /* Profil bor, lekin admin o'chirib qo'ygan / bloklangan — shuni aytamiz */
    const any = user && String(user.role) === 'instructor' ? await instructorProfileForUser(String(user.id), false).catch(() => null) : null;
    await send(token, chatId, any || user?.is_blocked || user?.is_active === false
      ? '⚠️ Profilingiz hozir faol emas (admin o‘chirib qo‘ygan). Admin bilan bog‘laning.'
      : '👋 Bron yozish faqat tasdiqlangan instruktorlar uchun. /start ni bosing.');
    return true;
  }
  const insId = String(prof.id);
  const today = tashkentYmdOf(Date.now());

  /* Menyu tugmalari va «/» buyruqlari: jadval (rasm), bronlar (soat + raqam) */
  const menu = parseMenu(text, today);
  if (menu) {
    if (menu.kind === 'help') { await send(token, chatId, BOT_HELP, { reply_markup: MENU_KEYBOARD }); return true; }
    if (menu.kind === 'menu') { await send(token, chatId, '📋 Menyu pastda 👇', { reply_markup: MENU_KEYBOARD }); return true; }
    const d = await instructorDay(menu.date, insId);
    if (!d.ins) { await send(token, chatId, '⚠️ Profilingiz hozir faol emas — admin bilan bog‘laning.'); return true; }
    const notify = await import('./instructor-notify.js');
    if (menu.kind === 'bookings') {
      const r = await notify.sendInstructorBookings(chatId, menu.date, d);
      if (r !== 'sent') await send(token, chatId, '⚠️ Ro‘yxatni yuborib bo‘lmadi. Birozdan keyin qayta yozing.');
      else log?.push(`[bronlar yuborildi: ${menu.date}]`);
      return true;
    }
    const r = await notify.sendInstructorDay(chatId, menu.date, d);
    if (r !== 'sent') await send(token, chatId, '⚠️ Jadvalni yuborib bo‘lmadi. Birozdan keyin qayta yozing.');
    else log?.push(`[jadval yuborildi: ${menu.date}]`);
    return true;
  }

  const cmd = parseBotText(text, today);

  if (cmd.kind === 'help') {
    /* yordam bilan birga menyu tugmalari ham chiqadi */
    await send(token, chatId, `${cmd.error ? `⚠️ ${htmlEsc(cmd.error)}\n\n` : ''}${BOT_HELP}`, { reply_markup: MENU_KEYBOARD });
    return true;
  }

  const day = await instructorDay(cmd.date, insId);
  if (!day.ins) { await send(token, chatId, '⚠️ Profilingiz hozir faol emas — admin bilan bog‘laning.'); return true; }
  const actor = { login: `Bot · ${day.ins.name}`, role: 'instructor', bi: insId };

  if (cmd.kind === 'list') {
    /* Excel ko'rinishidagi rasm + ostida bosib qo'ng'iroq qilinadigan raqamlar */
    const { sendInstructorDay } = await import('./instructor-notify.js');
    const r = await sendInstructorDay(chatId, cmd.date, day);
    if (r !== 'sent') await send(token, chatId, '⚠️ Jadvalni yuborib bo‘lmadi. Birozdan keyin qayta yozing.');
    else log?.push(`[jadval yuborildi: ${cmd.date}]`);
    return true;
  }

  if (cmd.kind === 'cancel' && cmd.pick) {
    await opts.ensureButtons?.().catch(() => {});
    await sendCancelPicker(token, chatId, insId, cmd.anyDay ? null : cmd.date, today, send);
    return true;
  }
  if (cmd.kind === 'cancel') {
    await cancelBotBooking({ token, chatId, insId, today, send }, cmd.date, cmd.h0, cmd.phone, !!cmd.anyDay, day);
    return true;
  }

  /* --- bron --- */
  const off = cmd.off === 30 ? 30 : 0;               // «14:30» — soat yarimidan, 30 daqiqa
  const hours: number[] = [];
  for (let h = cmd.h0; h < cmd.h1; h++) hours.push(h);
  const now = Date.now();
  for (const h of hours) {
    const c = day.cells.find((x) => x.h === h)!;
    if (c.end <= now) { await send(token, chatId, `⚠️ ${hText(h)} o‘tib ketgan.`); return true; }
    if (h === cmd.h0 && c.start + off * 60000 <= now) {   // boshlangan vaqtga bron yo'q (14:10 da 14:00 ga — kassa chek beradi)
      await send(token, chatId, `⚠️ ${hmText(h, off)} boshlanib ketgan — bu bronni kassa chek bilan rasmiylashtiradi.`);
      return true;
    }
    if (c.sc) {
      const same = parsePhone(c.sc.t) === cmd.phone;
      await send(token, chatId, same
        ? `ℹ️ ${dayText(cmd.date, today)} ${hText(h)} ga bu mijoz allaqachon yozilgan${c.out?.bk?.code ? ` (${htmlEsc(c.out.bk.code)})` : ''}.`
        : `⚠️ ${dayText(cmd.date, today)} ${hText(h)} band: «${htmlEsc(c.sc.t)}». Boshqa vaqtni yozing.`);
      return true;
    }
    if (c.lock) {
      await send(token, chatId, `⚠️ ${hText(h)}: ${htmlEsc(c.lock === 'bk' ? 'bu soatda boshqa bron bor (Mini App yoki admin).' : SHEET_LOCK_MSG[c.lock] || 'band')}`);
      return true;
    }
  }
  const digits = cmd.phone.slice(-9);
  const cellText = `${digits}${cmd.cat ? '/' + cmd.cat : ''}${cmd.half || off ? ' 30 MIN' : ''}${off ? ` ${cmd.h0}:30` : ''}${cmd.name ? ' ' + cmd.name : ''}`;
  const res = await applySheetChanges({
    date: cmd.date, actor, adminUser, audit, strict: true, notePrefix: 'Instruktor boti',
    changes: hours.map((h) => ({ key: cellKey(insId, h), t: cellText, prev: '' })),
  });
  const b = res.created[0];
  if (!b) {
    await send(token, chatId, `⚠️ Bron qilinmadi: ${htmlEsc(res.errors[0]?.error || 'nomaʼlum xato')}`);
    return true;
  }
  await groupAfter(cmd.date, res.events, actor.login);
  const end = Date.parse(b.start) + b.minutes * 60000;
  const fmt = (ms: number) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
  await send(token, chatId, [
    '✅ <b>Bron qilindi</b>',
    `📅 ${dayText(cmd.date, today)}, ${fmt(Date.parse(b.start))}–${fmt(end)} (${b.minutes >= 60 ? `${b.minutes / 60} soat` : `${b.minutes} daqiqa`}) · ${b.category} toifa`,
    `👤 ${htmlEsc(b.name)}${String(b.name).includes(prettyPhone(b.phone)) ? '' : ` · ${htmlEsc(prettyPhone(b.phone))}`}`,
    `🔖 Kod: <b>${htmlEsc(b.code || '—')}</b> — mijoz kassada shu kodni aytadi`,
    '',
    `Bekor qilish: <code>bekor ${hmText(cmd.h0, off)}</code>`,
  ].join('\n'));
  return true;
}

type SendFn = (t: string, c: number, msg: string, extra?: Record<string, unknown>) => Promise<void>;
type CancelCtx = { token: string; chatId: number; insId: string; today: string; send: SendFn };
type DayView = Awaited<ReturnType<typeof instructorDay>>;

/**
 * Bot orqali yozilgan bronni bekor qiladi: vaqt (h0) yoki raqam bo'yicha.
 * anyDay — kun aytilmagan: bugundan 14 kun ichida shu raqam yozilgan birinchi kun.
 */
async function cancelBotBooking(ctx: CancelCtx, date: string, h0: number | null, phone: string | null, anyDay: boolean, dayIn?: DayView, onlyBooking?: string): Promise<void> {
  const { token, chatId, insId, today, send } = ctx;
  let day = dayIn || await instructorDay(date, insId);
  if (anyDay && phone) {
    for (let i = 0; i <= 14; i++) {
      const d = addDaysYmd(today, i);
      const dv = d === date ? day : await instructorDay(d, insId);
      if (dv.cells.some((c) => c.sc && c.sc.bi === insId && parsePhone(c.sc.t) === phone)) { date = d; day = dv; break; }
    }
  }
  const actor = { login: `Bot · ${day.ins?.name || 'instruktor'}`, role: 'instructor', bi: insId };
  const keys = new Set<string>();
  let reason = '';
  const targets = day.cells.filter((c) => c.sc && (h0 !== null ? c.h === h0 : parsePhone(c.sc.t) === phone));
  /* Vaqt ham, raqam ham yozilgan — o'sha soatda AYNAN shu mijoz bo'lishi kerak */
  if (h0 !== null && phone && targets.length && !targets.some((c) => parsePhone(c.sc!.t) === phone)) {
    const other = parsePhone(targets[0].sc!.t);
    await send(token, chatId, `⚠️ ${dayText(date, today)} ${hText(h0)} da boshqa mijoz yozilgan${other ? ` (${htmlEsc(prettyPhone(other))})` : ''} — bekor qilinmadi.\nShu bronni bekor qilish uchun: «bekor ${hText(h0)}».`);
    return;
  }
  /* Tugmadan: aynan o'sha bron (keyin shu soatga boshqa bron yozilgan bo'lsa — unga tegilmaydi) */
  if (onlyBooking && !targets.some((c) => c.sc!.b === onlyBooking)) {
    await send(token, chatId, '⚠️ Bu bron allaqachon bekor qilingan yoki o‘zgargan. Yangi ro‘yxat uchun «bekor» deb yozing.');
    return;
  }
  if (!targets.length) {
    await send(token, chatId, `⚠️ ${dayText(date, today)} ${h0 !== null ? hText(h0) : 'bu raqam'} uchun bot orqali yozilgan bron topilmadi.\n\nBronlaringizni ko‘rish: «${dayText(date, today).toLowerCase()}» deb yozing yoki faqat «bekor» deb yozing — tugmalar chiqadi.`);
    return;
  }
  for (const c of targets) {
    if (c.sc!.bi !== insId) { reason = 'Bu yozuvni admin kiritgan — bekor qilish uchun admin bilan bog‘laning.'; continue; }
    if (c.lock) { reason = SHEET_LOCK_MSG[c.lock] || 'Bu bronni bekor qilib bo‘lmaydi.'; continue; }
    keys.add(c.key);
    /* Bir necha soatlik bron — hamma kataklari */
    if (c.sc!.b) for (const x of day.cells) if (x.sc?.b === c.sc!.b) keys.add(x.key);
  }
  if (!keys.size) { await send(token, chatId, `⚠️ ${htmlEsc(reason)}`); return; }
  const byKey = new Map(day.cells.map((c) => [c.key, c]));
  const res = await applySheetChanges({
    date, actor, adminUser, audit, notePrefix: 'Instruktor boti',
    changes: [...keys].map((k) => ({ key: k, t: '', prev: byKey.get(k)?.sc?.t || '' })),
  });
  if (res.errors.length) { await send(token, chatId, `⚠️ ${htmlEsc(res.errors[0].error)}`); return; }
  await groupAfter(date, res.events, actor.login);
  const cells = [...keys].map((k) => byKey.get(k)!).sort((a, b) => a.h - b.h);
  await send(token, chatId, `🗑 Bekor qilindi: ${dayText(date, today)}, ${cellSpan(cells[0], cells[cells.length - 1].h)}${res.cancelled ? ' — bron bekor bo‘ldi, vaqt yana bo‘sh.' : '.'}`);
}

/** «bekor» (vaqtsiz, raqamsiz) — instruktorning bot orqali yozgan yaqin bronlari tugma bo'lib chiqadi */
async function sendCancelPicker(token: string, chatId: number, insId: string, onlyDate: string | null, today: string, send: SendFn): Promise<void> {
  const now = Date.now();
  const days = onlyDate ? [onlyDate] : Array.from({ length: 15 }, (_, i) => addDaysYmd(today, i));
  const views = await Promise.all(days.map((d) => instructorDay(d, insId)));
  const rows: { text: string; data: string }[] = [];
  for (const [i, d] of days.entries()) {
    const dv = views[i];
    const seen = new Set<string>();
    for (const c of dv.cells.slice().sort((a, b) => a.h - b.h)) {
      if (!c.sc || c.sc.bi !== insId || c.lock || !parsePhone(c.sc.t) || c.end <= now) continue;
      /* faqat amaldagi, hali boshlanmagan bron */
      const bk = c.out?.bk;
      if (!bk || !['pending', 'confirmed'].includes(String(bk.status)) || Date.parse(bk.start) <= now) continue;
      const id = c.sc.b || c.key;
      if (seen.has(id)) continue;
      seen.add(id);
      const last = c.sc.b ? Math.max(...dv.cells.filter((x) => x.sc?.b === c.sc!.b).map((x) => x.h)) : c.h;
      rows.push({ text: `${dayText(d, today)} ${cellSpan(c, last)} · ${prettyPhone(parsePhone(c.sc.t)!)}`, data: `bc|${d}|${c.h}${c.sc.b ? '|' + c.sc.b : ''}`.slice(0, 64) });
      if (rows.length >= 12) break;
    }
    if (rows.length >= 12) break;
  }
  if (!rows.length) {
    await send(token, chatId, `ℹ️ ${onlyDate ? dayText(onlyDate, today) + ' ' : ''}bot orqali yozgan, bekor qilsa bo‘ladigan broningiz yo‘q.\n\nAdmin yozgan bronni admin bekor qiladi.`, { reply_markup: MENU_KEYBOARD });
    return;
  }
  await send(token, chatId, '🗑 Qaysi bronni bekor qilamiz? Tugmani bosing 👇', {
    reply_markup: { inline_keyboard: rows.map((r) => [{ text: r.text, callback_data: r.data }]) },
  });
}

/**
 * Instruktor botidagi tugma (callback_query). Hozircha: «bc|YYYY-MM-DD|soat» —
 * o'sha bronni bekor qilish. Faqat tugmani bosgan instruktorning o'z broni.
 */
export async function handleInstructorCallback(token: string, cb: any, log?: string[]): Promise<void> {
  const send: SendFn = async (t, c, msg, extra = {}) => {
    const err = await sendRaw(t, c, msg, extra);
    log?.push(err ? `[yuborilmadi: ${err}] ${msg}` : msg);
  };
  const answer = (text?: string) => telegramApi(token, 'answerCallbackQuery', { callback_query_id: cb?.id, ...(text ? { text } : {}) }).catch(() => {});
  const chatId = Number(cb?.message?.chat?.id), tg = Number(cb?.from?.id);
  const m = /^bc\|(\d{4}-\d{2}-\d{2})\|(\d{1,2})(?:\|([\w-]{1,48}))?$/.exec(String(cb?.data || ''));
  if (!m || !Number.isSafeInteger(chatId) || chatId <= 0 || chatId !== tg) { await answer(); return; }
  const user = await findUserByTelegram(tg);
  const prof = user ? await instructorProfileForUser(String(user.id), true) : null;
  if (!prof) { await answer('Profil faol emas'); return; }
  await answer('Bekor qilinmoqda…');
  /* Bosilgan tugma olib tashlanadi, qolganlari turadi (keyingisini ham bekor qilsa bo'ladi) */
  if (cb?.message?.message_id) {
    const rest = (Array.isArray(cb.message.reply_markup?.inline_keyboard) ? cb.message.reply_markup.inline_keyboard : [])
      .filter((row: any) => Array.isArray(row) && !row.some((b: any) => b?.callback_data === cb.data));
    await telegramApi(token, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: rest } }).catch(() => {});
  }
  const today = tashkentYmdOf(Date.now());
  await cancelBotBooking({ token, chatId, insId: String(prof.id), today, send }, m[1], Number(m[2]), null, false, undefined, m[3]);
}

/** Instruktor botga yozgan bron/bekor ham guruhga boradi (xato bo'lsa bot javobi buzilmaydi) */
async function groupAfter(date: string, events: any, by: string) {
  try {
    const { afterSheetSave } = await import('./sheet-share.js');
    await afterSheetSave(date, events, by);
  } catch (e) { console.error('bot → group failed:', e); }
}

/* ------------------------------------------------------------------ */
/* BOT JURNALI — instruktor botiga kelgan oxirgi xabarlar va javoblar.
   Bot jim qolsa sababini topish uchun (Vercel loglari doim ham qo'l
   ostida emas). admin_settings → 'instructor_bot_log', oxirgi 40 ta. */
export const BOT_LOG_KEY = 'instructor_bot_log';
export type BotLogEntry = { at: string; sent_at: string | null; chat: number; text: string; reply: string; error: string | null; ms: number };

export async function readBotLog(): Promise<BotLogEntry[]> {
  try {
    const rows = await supabaseRest<any[]>('admin_settings', { query: `?key=eq.${BOT_LOG_KEY}&select=value&limit=1` });
    const v = rows?.[0]?.value;
    return Array.isArray(v) ? v : Array.isArray(v?.items) ? v.items : [];
  } catch { return []; }
}

export async function logBotEvent(e: Omit<BotLogEntry, 'at'>): Promise<void> {
  try {
    const entry: BotLogEntry = { ...e, at: new Date().toISOString(), text: e.text.slice(0, 120), reply: e.reply.slice(0, 300), error: e.error ? e.error.slice(0, 300) : null };
    const items = [entry, ...(await readBotLog())].slice(0, 40);
    const now = new Date().toISOString();
    const rows = await supabaseRest<any[]>('admin_settings', {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      query: `?key=eq.${BOT_LOG_KEY}`, body: JSON.stringify({ value: items, updated_at: now }),
    });
    if (!rows?.length) {
      await supabaseRest('admin_settings', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ key: BOT_LOG_KEY, value: items, updated_at: now }) });
    }
  } catch (err) {
    console.warn('bot log write failed:', err instanceof Error ? err.message : err);
  }
}
