import crypto from 'node:crypto';
import { supabaseRest } from './supabase.js';
import { selectIn } from './rest-chunks.js';

/**
 * CHEKNING 4 XONALI RAQAMI (1234)
 *
 * QR ostida yoziladi. Instruktor QR ni skanerlay olmasa — raqamni
 * instruktor botiga yozadi yoki panelda kiritadi, chek o'zi urilib dars
 * boshlanadi.
 *
 * Raqam faqat FAOL cheklar orasida takrorlanmaydi (hali urilmagan yoki
 * dars ketayotgan). Ishlatib bo'lingan chekning raqami keyinroq boshqa
 * chekka berilishi mumkin — 9000 ta raqam shu tufayli hech qachon
 * tugamaydi. Chekda raqam doim saqlanib qoladi (tarix uchun).
 */

const q = (v: string) => encodeURIComponent(v);
export const SHORT_RE = /^\d{4}$/;
const LIVE = new Set(['pending', 'confirmed', 'in_progress']);

/** «12 34», «1-234» kabi yozilganini ham qabul qiladi. 4 raqam bo'lmasa — null. */
export function shortCodeOf(raw: unknown): string | null {
  const s = String(raw ?? '').trim().replace(/[\s\-–.]/g, '');
  return SHORT_RE.test(s) ? s : null;
}

const rnd = () => String(1000 + crypto.randomInt(0, 9000));

/** Hozir faol chekda turgan raqamlar (berilgan nomzodlar orasidan) */
async function busyAmong(codes: string[]): Promise<Set<string>> {
  if (!codes.length) return new Set();
  const pays = await supabaseRest<any[]>('payments', {
    query: `?short_code=in.(${codes.map(q).join(',')})&status=eq.paid&select=short_code,booking_id&limit=1000`,
  });
  if (!pays?.length) return new Set();
  const bks = await selectIn<any>('bookings', 'id', pays.map((p) => p.booking_id).filter(Boolean), 'id,status');
  const live = new Set(bks.filter((b) => LIVE.has(String(b.status))).map((b) => String(b.id)));
  return new Set(pays.filter((p) => live.has(String(p.booking_id))).map((p) => String(p.short_code)));
}

/**
 * n ta yangi, bir-biridan va faol cheklardan farqli raqam.
 * Odatda bitta so'rov (nomzodlar ishlatilmagan bo'lsa).
 * Ustun yo'q yoki baza javob bermasa — tasodifiy raqamlar (chek baribir chiqadi).
 */
export async function newShortCodes(n: number): Promise<string[]> {
  const out: string[] = [];
  for (let round = 0; round < 4 && out.length < n; round++) {
    const cands = new Set<string>();
    while (cands.size < Math.max(12, n * 4)) { const c = rnd(); if (!out.includes(c)) cands.add(c); }
    let busy: Set<string>;
    try { busy = await busyAmong([...cands]); } catch { busy = new Set(); }
    for (const c of cands) { if (out.length >= n) break; if (!busy.has(c)) out.push(c); }
  }
  while (out.length < n) { const c = rnd(); if (!out.includes(c)) out.push(c); }
  return out;
}

/**
 * Raqam bo'yicha chek: to'langan to'lov va uning broni.
 *  · faol (urilmagan / dars ketayotgan) chek bo'lsa — o'sha;
 *  · faoli yo'q — eng oxirgisi (instruktorga «ishlatilgan» deb aytish uchun);
 *  · ikkita faol chekda bir xil raqam (juda kam) — `ambiguous`.
 */
export async function findByShortCode(code: string): Promise<{ payment: any; booking: any } | { ambiguous: true } | null> {
  const pays = await supabaseRest<any[]>('payments', {
    query: `?short_code=eq.${q(code)}&status=eq.paid&select=*&order=paid_at.desc&limit=50`,
  });
  if (!pays?.length) return null;
  const bks = await selectIn<any>('bookings', 'id', pays.map((p) => p.booking_id).filter(Boolean), '*');
  const bm = new Map(bks.map((b) => [String(b.id), b]));
  const pairs = pays.map((p) => ({ payment: p, booking: bm.get(String(p.booking_id)) })).filter((x) => x.booking);
  if (!pairs.length) return null;
  const waiting = pairs.filter((x) => String(x.booking.status) === 'confirmed');
  if (waiting.length > 1) return { ambiguous: true };
  if (waiting.length === 1) return waiting[0];
  const running = pairs.filter((x) => String(x.booking.status) === 'in_progress');
  if (running.length) return running[0];
  return pairs[0];
}
