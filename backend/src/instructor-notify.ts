import { supabaseRest } from './supabase.js';
import { selectIn } from './rest-chunks.js';
import { telegramApi, telegramSendPhoto } from './telegram.js';
import { tashkentYmdOf, addDaysYmd } from './instructor-schedule.js';
import { parsePhone } from './booking-sheet.js';
import { instructorDay, allInstructorDays, type InsDay, type SheetEvent } from './booking-sheet-routes.js';
import { renderDayPng, type DayRow } from './instructor-day-image.js';

/**
 * INSTRUKTORGA O'Z O'QUVCHILARI — instruktor botida
 *
 * Ilgari adminlar Excel jadvalning rasmini guruhga tashlashardi, har
 * instruktor undan o'z ustunini topib, raqamlarni qo'lda terib
 * qo'ng'iroq qilardi. Endi bot har instruktorga:
 *   · faqat UNING ustunini Excel ko'rinishidagi rasm qilib yuboradi;
 *   · rasm ostida — raqamlar ro'yxati (raqamni bosib qo'ng'iroq qiladi);
 *   · kechqurun 20:00 da ertangi, ertalab 07:00 da bugungi o'quvchilarni;
 *   · admin Excel bronni o'zgartirsa — nima o'zgargani va yangi rasm;
 *   · qo'lda bron yoki kassa orqali yangi bron bo'lsa — darhol xabar.
 */

const TOKEN = () => String(process.env.INSTRUCTOR_BOT_TOKEN || process.env.TELEGRAM_INSTRUCTOR_BOT_TOKEN || '');
const q = (v: string) => encodeURIComponent(v);
const MON = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
const WD = ['yakshanba', 'dushanba', 'seshanba', 'chorshanba', 'payshanba', 'juma', 'shanba'];
export const EVENING_HOUR = 20;
export const MORNING_HOUR = 7;
const esc = (v: unknown) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
const hm = (v: string | number) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit' }).format(new Date(v));
const tkHour = (ms: number) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', hour12: false }).format(new Date(ms))) % 24;
/** +998901234567 — Telegram shu ko'rinishdagi raqamni bosiladigan qiladi */
const tel = (p: unknown) => { const d = String(p ?? '').replace(/\D/g, ''); return d.length >= 9 ? '+998' + d.slice(-9) : ''; };
/** 90 123 45 67 — rasm uchun */
const short = (p: unknown) => { const m = /(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(String(p ?? '').replace(/\D/g, '')); return m ? `${m[1]} ${m[2]} ${m[3]} ${m[4]}` : String(p ?? ''); };
const realName = (n: unknown) => { const s = String(n ?? '').trim(); return s && !/^Mijoz \+?998/.test(s) ? s : ''; };

/** «Ertaga, 9-oktabr, payshanba» */
export function dayTitle(date: string, today = tashkentYmdOf(Date.now())) {
  const [, m, d] = date.split('-').map(Number);
  const wd = WD[new Date(`${date}T12:00:00Z`).getUTCDay()];
  const pre = date === today ? 'Bugun, ' : date === addDaysYmd(today, 1) ? 'Ertaga, ' : '';
  return `${pre}${d}-${MON[m - 1]}, ${wd}`;
}

/** Instruktorning Telegram chat ID si (bot yozish uchun) */
export async function instructorChats(insIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!insIds.length) return out;
  const ips = await selectIn<any>('instructor_profiles', 'id', insIds, 'id,user_id');
  const users = await selectIn<any>('users', 'id', ips.map((i) => i.user_id), 'id,telegram_id');
  const um = new Map(users.map((u) => [String(u.id), u]));
  for (const i of ips) {
    const tg = Number(um.get(String(i.user_id))?.telegram_id);
    if (Number.isSafeInteger(tg) && tg > 0) out.set(String(i.id), tg);
  }
  return out;
}

/** Kunlik ustundan: rasm qatorlari va bosiladigan raqamlar ro'yxati */
export function dayModel(day: InsDay, now = Date.now()) {
  const rows: DayRow[] = [];
  const lines: string[] = [];
  let count = 0;
  let prevId = '';
  for (const c of day.cells) {
    const o = c.out, past = c.end <= now;
    if (!o) { rows.push({ h: c.h, main: '', sub: '', tag: '', kind: 'free', past }); prevId = ''; continue; }
    if (o.k === 'sheet' || o.k === 'bk') {
      const b = o.bk || {};
      const phone = b.phone || parsePhone(o.t) || '';
      const name = realName(b.name);
      const cont = prevId && prevId === b.id;
      const app = o.k === 'bk';
      rows.push({
        h: c.h, kind: app ? 'app' : 'bron', past,
        main: cont ? '— davomi —' : phone ? short(phone) : (o.t || name || 'Mijoz'),
        sub: cont ? '' : [name, b.cat ? `${b.cat} toifa` : '', b.min && b.min < 60 ? `${b.min} daq` : ''].filter(Boolean).join(' · '),
        tag: cont ? '' : b.paid ? 'to‘langan' : app ? (b.src === 'app' ? 'Mini App' : b.src === 'walk_in' ? 'Kassa' : (b.code || 'Bron')) : (b.code || 'Bron'),
      });
      if (!cont) {
        count++;
        const end = Date.parse(b.end) || c.end;
        lines.push(`<b>${hm(Date.parse(b.start) || c.start)}–${hm(end)}</b> ${tel(phone) || esc(o.t || '')}${name ? ` · ${esc(name)}` : ''}${b.code ? ` · ${esc(b.code)}` : ''}${b.paid ? ' · ✅' : ''}${app && b.src === 'app' ? ' · Mini App' : ''}`);
      }
      prevId = b.id || '';
      continue;
    }
    prevId = '';
    if (o.k === 'note') {
      const phone = parsePhone(o.t);
      rows.push({ h: c.h, main: o.t, sub: o.e ? 'bron bo‘lmadi' : '', tag: o.bk?.status === 'cancelled' ? 'bekor' : 'band', kind: 'band', past });
      count++;
      lines.push(`<b>${c.h}:00</b> ${phone ? `${tel(phone)} · ` : ''}${esc(o.t)}${o.bk?.status === 'cancelled' ? ' (bekor qilingan)' : ''}`);
      continue;
    }
    if (o.k === 'off') { rows.push({ h: c.h, main: 'dam', sub: '', tag: 'grafik', kind: 'off', past }); continue; }
    if (o.k === 'own') { rows.push({ h: c.h, main: 'yopiq', sub: '', tag: '', kind: 'own', past }); continue; }
    rows.push({ h: c.h, main: '', sub: '', tag: '', kind: 'free', past });
  }
  return { rows, lines, count };
}

/**
 * Instruktorga bir kunlik jadvali: rasm + ostida raqamlar ro'yxati
 * (sig'sa — rasm izohida, bitta xabar). header — ustidagi matn (o'zgarishlar).
 */
export async function sendInstructorDay(chatId: number, date: string, day: InsDay, opts: { header?: string; skipEmpty?: boolean } = {}): Promise<'sent' | 'empty' | 'fail'> {
  const token = TOKEN();
  if (!token || !day.ins) return 'fail';
  const m = dayModel(day);
  if (opts.skipEmpty && !m.count) return 'empty';
  const title = dayTitle(date);
  const listHead = `📋 <b>${esc(title)}</b> — ${m.count ? `${m.count} ta yozuv` : 'hozircha bo‘sh'}`;
  const tail = m.count ? '\n\n<i>Raqamni bosing — qo‘ng‘iroq qilasiz.</i>' : '';
  const body = [opts.header ? opts.header + '\n' : '', listHead, ...(m.lines.length ? ['', ...m.lines] : [])].filter((x) => x !== '').join('\n') + tail;
  try {
    const png = await renderDayPng({
      title, insName: day.ins.name, insPhone: day.ins.phone ? short(day.ins.phone) : '', rows: m.rows,
      footer: m.count ? 'Raqamlar rasm ostida — bosib qo‘ng‘iroq qiling' : 'Bu kunga hali yozuv yo‘q',
    });
    if (png) {
      if (body.length <= 1000) {
        await telegramSendPhoto(token, chatId, png, { caption: body, parse_mode: 'HTML', filename: `jadval-${date}.png` });
      } else {
        await telegramSendPhoto(token, chatId, png, { caption: listHead, parse_mode: 'HTML', filename: `jadval-${date}.png` });
        await telegramApi(token, 'sendMessage', { chat_id: chatId, text: body.slice(0, 4000), parse_mode: 'HTML' });
      }
    } else {
      await telegramApi(token, 'sendMessage', { chat_id: chatId, text: body.slice(0, 4000), parse_mode: 'HTML' });
    }
    return 'sent';
  } catch (e) {
    console.error('instructor day send failed:', e instanceof Error ? e.message : e);
    return 'fail';
  }
}

/** Bot so'raganda («bugun», «ertaga», «12.10») */
export async function sendInstructorDayFor(chatId: number, insId: string, date: string) {
  return sendInstructorDay(chatId, date, await instructorDay(date, insId));
}

/** Bir nechtadan parallel (Telegram va Vercel vaqtiga sig'sin) */
async function eachLimited<T>(list: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) { const x = list[i++]; await fn(x).catch((e) => console.error('notify failed:', e)); }
  }));
}

/** Admin Excel bronni saqlaganda: har instruktorga nima o'zgargani + yangilangan rasm */
export async function notifySheetSave(date: string, events: Map<string, SheetEvent>, skipIns?: string) {
  const ids = [...events.keys()].filter((id) => id !== skipIns);
  if (!ids.length || !TOKEN()) return { sent: 0 };
  const [chats, days] = await Promise.all([instructorChats(ids), allInstructorDays(date)]);
  let sent = 0;
  await eachLimited(ids, 4, async (id) => {
    const chat = chats.get(id), day = days.get(id), e = events.get(id)!;
    if (!chat || !day) return;
    const lines: string[] = [];
    for (const c of e.created) {
      lines.push(`✅ Yangi bron: <b>${hm(c.start)}–${hm(Date.parse(c.start) + c.minutes * 60000)}</b> ${tel(c.phone)}${realName(c.name) ? ` · ${esc(c.name)}` : ''}${c.code ? ` · ${esc(c.code)}` : ''}`);
    }
    for (const c of e.cancelled) {
      lines.push(`❌ Bekor qilindi: <b>${hm(c.start)}–${hm(Date.parse(c.start) + c.minutes * 60000)}</b> ${tel(c.phone)}${realName(c.name) ? ` · ${esc(c.name)}` : ''} — vaqt bo‘sh`);
    }
    for (const n of e.notes) {
      lines.push(n.removed ? `🔓 <b>${n.h}:00</b> bo‘shadi («${esc(n.text)}» o‘chirildi)` : `📌 <b>${n.h}:00</b> band: «${esc(n.text)}»`);
    }
    if (!lines.length) return;
    const header = `🔔 <b>Jadvalingiz o‘zgardi</b> — ${esc(dayTitle(date))}\n${lines.join('\n')}`;
    if ((await sendInstructorDay(chat, date, day, { header })) === 'sent') sent++;
  });
  return { sent };
}

/** Qo'lda bron yoki kassa orqali yangi bron — instruktorga darhol */
export async function notifyInstructorNewBooking(bookings: any[], source: 'manual' | 'kassa') {
  const token = TOKEN();
  const list = (bookings || []).filter((b) => b?.instructor_id);
  if (!token || !list.length) return;
  try {
    const chats = await instructorChats([...new Set(list.map((b) => String(b.instructor_id)))]);
    const users = await selectIn<any>('users', 'id', list.map((b) => b.customer_id), 'id,full_name,phone');
    const um = new Map(users.map((u) => [String(u.id), u]));
    const byIns = new Map<string, any[]>();
    for (const b of list) byIns.set(String(b.instructor_id), [...(byIns.get(String(b.instructor_id)) || []), b]);
    for (const [ins, bs] of byIns) {
      const chat = chats.get(ins); if (!chat) continue;
      const u = um.get(String(bs[0].customer_id));
      const when = bs.map((b) => `📅 <b>${esc(dayTitle(tashkentYmdOf(Date.parse(b.start_at))))}, ${hm(b.start_at)}–${hm(b.end_at)}</b>${b.pickup_code ? ` · ${esc(b.pickup_code)}` : ''}`);
      const text = [
        `✅ <b>Yangi bron</b> (${source === 'manual' ? 'qo‘lda bron' : 'kassa'})`,
        ...when,
        `👤 ${esc(realName(u?.full_name) || 'Mijoz')}${u?.phone ? ` · ${tel(u.phone)}` : ''}`,
      ].join('\n');
      await telegramApi(token, 'sendMessage', { chat_id: chat, text, parse_mode: 'HTML' }).catch((e) => console.error('new booking notify failed:', e));
    }
  } catch (e) {
    console.error('notifyInstructorNewBooking failed:', e);
  }
}

/**
 * KUNLIK XABARNOMA: kechqurun 20:00 dan — ertangi, ertalab 07:00–12:00 —
 * bugungi o'quvchilar. Har biri kuniga bir marta (admin_settings belgisi).
 * Eslatmalar «tick»i (cron yoki ochiq panellar) har necha daqiqada chaqiradi.
 */
export async function runInstructorDigest(nowMs = Date.now()) {
  if (!TOKEN()) return { ran: false, reason: 'no token' };
  const h = tkHour(nowMs), today = tashkentYmdOf(nowMs);
  const kind = h >= EVENING_HOUR ? 'evening' : h >= MORNING_HOUR && h < 12 ? 'morning' : null;
  if (!kind) return { ran: false, reason: 'not time' };
  const date = kind === 'evening' ? addDaysYmd(today, 1) : today;
  const key = `instructor_digest:${kind}:${date}`;
  const done = await supabaseRest<any[]>('admin_settings', { query: `?key=eq.${q(key)}&select=key&limit=1` }).catch(() => null);
  if (!done || done.length) return { ran: false, reason: 'sent' };
  try {
    await supabaseRest('admin_settings', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ key, value: { at: new Date(nowMs).toISOString() }, updated_at: new Date(nowMs).toISOString() }),
    });
  } catch { return { ran: false, reason: 'sent' }; }        // boshqa instansiya ulgurdi
  const days = await allInstructorDays(date);
  const chats = await instructorChats([...days.keys()]);
  let sent = 0;
  const header = kind === 'evening' ? '🌙 <b>Ertangi o‘quvchilaringiz</b> — kechqurun qo‘ng‘iroq qilib chiqing.' : '☀️ <b>Bugungi o‘quvchilaringiz</b>';
  await eachLimited([...days.keys()], 4, async (id) => {
    const chat = chats.get(id), day = days.get(id);
    if (!chat || !day) return;
    if ((await sendInstructorDay(chat, date, day, { header, skipEmpty: true })) === 'sent') sent++;
  });
  return { ran: true, kind, date, sent };
}
