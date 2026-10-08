import { telegramApi } from './telegram.js';
import { findUserByTelegram, instructorProfileForUser } from './identity.js';
import { tashkentYmdOf, addDaysYmd } from './instructor-schedule.js';
import { cellKey, parsePhone, parseHalf, nameFrom, prettyPhone, SHEET_FIRST_HOUR, SHEET_LAST_HOUR } from './booking-sheet.js';
import { applySheetChanges, instructorDay, SHEET_LOCK_MSG } from './booking-sheet-routes.js';
import { adminUser, audit } from './admin-password-routes.js';

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
  | { kind: 'book'; date: string; h0: number; h1: number; phone: string; cat: 'A' | 'B' | 'C' | null; half: boolean; name: string | null }
  | { kind: 'cancel'; date: string; h0: number | null; phone: string | null }
  | { kind: 'list'; date: string }
  | { kind: 'help'; error?: string };

const MAX_DAYS = 30;
const MAX_HOURS = 5;
const CYR: Record<string, 'A' | 'B' | 'C'> = { 'а': 'A', 'в': 'B', 'с': 'C', a: 'A', b: 'B', c: 'C' };
const STOP = /(^|\s)(bugun|ertaga|indinga|soat|da|ga|dan|gacha|kuni|bron|qil|qiling|mijoz|сегодня|завтра|послезавтра|в|на|с|до|час|часа|бронь|клиент|min|мин|daq|minut|минут)(?=\s|$)/giu;

/** Xabardan buyruq. today — Toshkent bo'yicha bugungi sana (YYYY-MM-DD). */
export function parseBotText(raw: string, today: string): BotCmd {
  const text = String(raw || '').replace(/[’'`ʻ‘]/g, "'").replace(/\s+/g, ' ').trim();
  if (!text) return { kind: 'help' };
  let s = ` ${text.toLowerCase()} `;
  const cut = (re: RegExp) => { s = s.replace(re, ' '); };

  /* --- buyruq turi --- */
  const isCancel = /^\s*\/?(bekor|otmena|отмена|отменить|o'chir|ochir|удалить|cancel)/iu.test(s);
  if (isCancel) cut(/^\s*\/?(bekor qilish|bekor qil|bekor|otmena|отмена|отменить|o'chir|ochir|удалить|cancel)/iu);

  /* --- sana --- */
  let date = today;
  if (/(^|\s)(indinga|послезавтра|poslezavtra)(?=[\s,.!]|$)/u.test(s)) { date = addDaysYmd(today, 2); cut(/(^|\s)(indinga|послезавтра|poslezavtra)(?=[\s,.!]|$)/u); }
  if (/(^|\s)(ertaga|завтра|zavtra)(?=[\s,.!]|$)/u.test(s)) { date = addDaysYmd(today, 1); cut(/(^|\s)(ertaga|завтра|zavtra)(?=[\s,.!]|$)/u); }
  if (/(^|\s)(bugun|сегодня|segodnya)(?=[\s,.!]|$)/u.test(s)) { date = today; cut(/(^|\s)(bugun|сегодня|segodnya)(?=[\s,.!]|$)/u); }
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
      s = s.replace(dm[0], ' ');
    }
  }

  /* --- vaqt: «15-17», «15:00-17:00», «с 15 до 17», «14:00», «14.00», «soat 14», «14 da» --- */
  let h0: number | null = null, h1: number | null = null, badMinute = false;
  const hh = (v: string) => Number(v);
  const range = /(^|\s)(?:с\s*)?(\d{1,2})(?:[:.](\d{2}))?\s*(?:-|–|—|до|dan)\s*(\d{1,2})(?:[:.](\d{2}))?(?:\s*(?:gacha|ga|da))?(?=[\s,]|$)/u.exec(s);
  if (range && hh(range[2]) <= 23 && hh(range[4]) <= 24) {
    h0 = hh(range[2]); h1 = hh(range[4]);
    if ((range[3] && range[3] !== '00') || (range[5] && range[5] !== '00')) badMinute = true;
    s = s.replace(range[0], ' ');
  } else {
    const one = /(^|\s)(?:soat\s*|в\s*)?(\d{1,2})[:.](\d{2})(?:\s*(?:da|ga))?(?=[\s,]|$)/u.exec(s);
    if (one && hh(one[2]) <= 23) {
      h0 = hh(one[2]); if (one[3] !== '00') badMinute = true;
      s = s.replace(one[0], ' ');
    } else {
      const word = /(^|\s)(?:soat\s*(\d{1,2})|(\d{1,2})\s*(?:da|ga|часов|час))(?=[\s,]|$)/u.exec(s);
      if (word) { h0 = hh(word[2] || word[3]); s = s.replace(word[0], ' '); }
    }
  }

  /* --- telefon (vaqt va sanadan keyin qolgan matndan) --- */
  const phone = parsePhone(s);
  if (phone) {
    /* Faqat raqamning o'zini olib tashlaymiz («901234567 14» — 14 soat bo'lib qolsin) */
    const sep = '[\\s\\-.()]{0,2}';
    const local = phone.slice(-9).split('').join(sep);
    s = s.replace(new RegExp(`(?:\\+?9${sep}9${sep}8${sep})?${local}`), ' ');
  }
  if (h0 === null) {
    /* oddiy son: «901234567 14» */
    const bare = /(^|\s)(\d{1,2})(?=[\s,]|$)/.exec(s);
    if (bare && hh(bare[2]) >= SHEET_FIRST_HOUR && hh(bare[2]) <= SHEET_LAST_HOUR) { h0 = hh(bare[2]); s = s.replace(bare[0], ' '); }
  }

  /* --- toifa: «/C», «C toifa», katta lotin harfi --- */
  let cat: 'A' | 'B' | 'C' | null = null;
  const c1 = /\/\s*([abcавс])(?=[\s,./]|$)/iu.exec(s) || /(^|\s)([abcавс])\s*(?:toifa|тоифа|kat|кат)/iu.exec(s);
  if (c1) { cat = CYR[(c1[2] || c1[1]).toLowerCase()] || null; s = s.replace(c1[0], ' '); }
  else {
    const up = /(^|\s)([ABC])(?=[\s,]|$)/.exec(` ${text} `);
    if (up) { cat = up[2] as 'A' | 'B' | 'C'; s = s.replace(new RegExp(`(^|\\s)${up[2].toLowerCase()}(?=[\\s,]|$)`), ' '); }
  }
  const half = parseHalf(text);
  s = s.replace(/(^|\s)30\s*(min|мин|daq|minut|минут)\S*/giu, ' ').replace(/toifa|тоифа/giu, ' ');
  const name = nameFrom(s.replace(STOP, ' ').replace(/[\d/]+/g, ' '));

  if (isCancel) {
    if (h0 === null && !phone) return { kind: 'help', error: 'Qaysi bronni bekor qilish kerak? Masalan: bekor 14:00' };
    return { kind: 'cancel', date, h0, phone };
  }
  if (!phone) {
    if (h0 === null && /^\s*\/?(bugun|ertaga|indinga|list|ro'yxat|royxat|jadval|bronlar|bronlarim|сегодня|завтра|послезавтра)?\s*$/iu.test(` ${text.toLowerCase()} `.replace(/[’'`ʻ‘]/g, "'")))
      return { kind: 'list', date };
    return { kind: 'help', error: h0 !== null ? 'Mijozning telefon raqamini yozing (9 ta raqam).' : undefined };
  }
  if (h0 === null) return { kind: 'help', error: 'Vaqtni yozing, masalan: 901234567 14:00' };
  if (badMinute) return { kind: 'help', error: 'Vaqt soat boshidan bo‘lsin: 14:00 (yarim soat — «30 min» deb yozing).' };
  if (h1 === null) h1 = h0 + 1;
  if (h0 < SHEET_FIRST_HOUR || h0 > SHEET_LAST_HOUR || h1 <= h0 || h1 > SHEET_LAST_HOUR + 1) {
    return { kind: 'help', error: `Vaqt ${SHEET_FIRST_HOUR}:00 dan ${SHEET_LAST_HOUR + 1}:00 gacha bo‘lishi kerak.` };
  }
  if (h1 - h0 > MAX_HOURS) return { kind: 'help', error: `Bir martada ko‘pi bilan ${MAX_HOURS} soat.` };
  if (date < today) return { kind: 'help', error: 'O‘tgan kunga bron qilib bo‘lmaydi.' };
  if (date > addDaysYmd(today, MAX_DAYS)) return { kind: 'help', error: `Ko‘pi bilan ${MAX_DAYS} kun oldinga.` };
  return { kind: 'book', date, h0, h1, phone, cat, half: half && h1 - h0 === 1, name };
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
export const BOT_HELP = [
  '📝 Bron qilish uchun shunday yozing:',
  '',
  '<code>901234567 14:00</code> — bugun 14:00, 1 soat',
  '<code>ertaga 901234567 15-17</code> — ertaga, 2 soat',
  '<code>12.10 901234567 10:00</code> — 12-oktabr',
  '<code>901234567 9:00 /C</code> — C toifa',
  '<code>901234567 9:00 30 min</code> — 30 daqiqa',
  '',
  '<code>bekor 14:00</code> — o‘zingiz yozgan bronni bekor qilish',
  '<code>bugun</code> yoki <code>ertaga</code> — jadvalingiz',
].join('\n');

const send = (token: string, chatId: number, text: string) =>
  telegramApi(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }).catch((e) => {
    console.error('instructor bot reply failed:', e instanceof Error ? e.message : e);
  });
const htmlEsc = (v: unknown) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);

/**
 * Instruktor botiga kelgan oddiy matnli xabar. Instruktor topilmasa — false
 * (chaqiruvchi o'z javobini beradi), aks holda o'zi javob yozadi.
 */
export async function handleInstructorSheetMessage(token: string, chatId: number, telegramId: number, text: string): Promise<boolean> {
  const user = await findUserByTelegram(telegramId);
  const prof = user ? await instructorProfileForUser(String(user.id), true) : null;
  if (!prof) {
    await send(token, chatId, '👋 Bron yozish faqat tasdiqlangan instruktorlar uchun. /start ni bosing.');
    return true;
  }
  const insId = String(prof.id);
  const today = tashkentYmdOf(Date.now());
  const cmd = parseBotText(text, today);

  if (cmd.kind === 'help') {
    await send(token, chatId, `${cmd.error ? `⚠️ ${htmlEsc(cmd.error)}\n\n` : ''}${BOT_HELP}`);
    return true;
  }

  const day = await instructorDay(cmd.date, insId);
  if (!day.ins) { await send(token, chatId, '⚠️ Profilingiz hozir faol emas — admin bilan bog‘laning.'); return true; }
  const actor = { login: `Bot · ${day.ins.name}`, role: 'instructor', bi: insId };

  if (cmd.kind === 'list') {
    const lines: string[] = [];
    for (const c of day.cells) {
      const o = c.out;
      if (!o) continue;
      let t = '';
      if (o.k === 'sheet') t = `${htmlEsc(o.t)} · ${htmlEsc(o.bk?.code || '')}${o.bk?.paid ? ' ✅' : ''}`;
      else if (o.k === 'note') t = `${htmlEsc(o.t)}${o.bk?.status === 'cancelled' ? ' (bekor)' : ' (band)'}`;
      else if (o.k === 'bk') t = `${htmlEsc(o.bk?.name || 'Mijoz')} · ${o.bk?.src === 'app' ? 'Mini App' : 'bron'}${o.bk?.code ? ' · ' + htmlEsc(o.bk.code) : ''}`;
      else if (o.k === 'off') t = 'dam (grafik)';
      else if (o.k === 'own') t = 'yopiq';
      if (t) lines.push(`${hText(c.h)} — ${t}`);
    }
    await send(token, chatId, `📋 <b>${dayText(cmd.date, today)}</b> (${cmd.date.split('-').reverse().join('.')})\n\n${lines.length ? lines.join('\n') : 'Hali hech narsa yozilmagan — hamma soat bo‘sh.'}`);
    return true;
  }

  if (cmd.kind === 'cancel') {
    const keys = new Set<string>();
    let reason = '';
    const targets = day.cells.filter((c) => c.sc && (cmd.h0 !== null ? c.h === cmd.h0 : parsePhone(c.sc.t) === cmd.phone));
    if (!targets.length) { await send(token, chatId, `⚠️ ${dayText(cmd.date, today)} ${cmd.h0 !== null ? hText(cmd.h0) : 'bu raqam'} uchun bot orqali yozilgan bron topilmadi.`); return true; }
    for (const c of targets) {
      if (c.sc!.bi !== insId) { reason = 'Bu yozuvni admin kiritgan — bekor qilish uchun admin bilan bog‘laning.'; continue; }
      if (c.lock) { reason = SHEET_LOCK_MSG[c.lock] || 'Bu bronni bekor qilib bo‘lmaydi.'; continue; }
      keys.add(c.key);
      /* Bir necha soatlik bron — hamma kataklari */
      if (c.sc!.b) for (const x of day.cells) if (x.sc?.b === c.sc!.b) keys.add(x.key);
    }
    if (!keys.size) { await send(token, chatId, `⚠️ ${htmlEsc(reason)}`); return true; }
    const byKey = new Map(day.cells.map((c) => [c.key, c]));
    const res = await applySheetChanges({
      date: cmd.date, actor, adminUser, audit, notePrefix: 'Instruktor boti',
      changes: [...keys].map((k) => ({ key: k, t: '', prev: byKey.get(k)?.sc?.t || '' })),
    });
    if (res.errors.length) { await send(token, chatId, `⚠️ ${htmlEsc(res.errors[0].error)}`); return true; }
    const hours = [...keys].map((k) => byKey.get(k)!.h).sort((a, b) => a - b);
    await send(token, chatId, `🗑 Bekor qilindi: ${dayText(cmd.date, today)}, ${hText(hours[0])}–${hText(hours[hours.length - 1] + 1)}${res.cancelled ? ' — bron bekor bo‘ldi, vaqt yana bo‘sh.' : '.'}`);
    return true;
  }

  /* --- bron --- */
  const hours: number[] = [];
  for (let h = cmd.h0; h < cmd.h1; h++) hours.push(h);
  const now = Date.now();
  for (const h of hours) {
    const c = day.cells.find((x) => x.h === h)!;
    if (c.end <= now) { await send(token, chatId, `⚠️ ${hText(h)} o‘tib ketgan.`); return true; }
    if (h === cmd.h0 && c.start < now - 10 * 60000) {
      await send(token, chatId, `⚠️ ${hText(h)} boshlanib ketgan — bu bronni kassa chek bilan rasmiylashtiradi.`);
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
  const cellText = `${digits}${cmd.cat ? '/' + cmd.cat : ''}${cmd.half ? ' 30 MIN' : ''}${cmd.name ? ' ' + cmd.name : ''}`;
  const res = await applySheetChanges({
    date: cmd.date, actor, adminUser, audit, strict: true, notePrefix: 'Instruktor boti',
    changes: hours.map((h) => ({ key: cellKey(insId, h), t: cellText, prev: '' })),
  });
  const b = res.created[0];
  if (!b) {
    await send(token, chatId, `⚠️ Bron qilinmadi: ${htmlEsc(res.errors[0]?.error || 'nomaʼlum xato')}`);
    return true;
  }
  const end = Date.parse(b.start) + b.minutes * 60000;
  const fmt = (ms: number) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
  await send(token, chatId, [
    '✅ <b>Bron qilindi</b>',
    `📅 ${dayText(cmd.date, today)}, ${fmt(Date.parse(b.start))}–${fmt(end)} (${b.minutes >= 60 ? `${b.minutes / 60} soat` : `${b.minutes} daqiqa`}) · ${b.category} toifa`,
    `👤 ${htmlEsc(b.name)}${String(b.name).includes(prettyPhone(b.phone)) ? '' : ` · ${htmlEsc(prettyPhone(b.phone))}`}`,
    `🔖 Kod: <b>${htmlEsc(b.code || '—')}</b> — mijoz kassada shu kodni aytadi`,
    '',
    `Bekor qilish: <code>bekor ${hText(cmd.h0)}</code>`,
  ].join('\n'));
  return true;
}
