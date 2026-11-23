/**
 * SO'MLIK CHEK — ADMIN RUXSATI (Telegram orqali).
 *
 * Kassir narxni maxsus parol bilan 1 000 so'mdan kam qilsa (0, 1, 2 so'm…),
 * chek darhol chiqmaydi: admin botiga (telegram_admins dagi har bir faol
 * chat) «✅ Ruxsat berish / ❌ Rad etish» tugmali xabar boradi.
 *
 *  · Admin bosganda Telegram ichida kichik sahifa (/ruxsat) ochiladi va
 *    qarorni darhol yuboradi. Kim bosgani Telegram imzosi (initData) bilan
 *    tekshiriladi — faqat faol admin. Guruh chatlarida web_app tugma ishlamaydi,
 *    u yerda imzolangan havola beriladi.
 *    (Admin botning webhook'i Supabase funksiyasida — oddiy callback tugmalar
 *    u yerga ketadi. Sahifa usuli faqat Vercel bilan ishlaydi.)
 *  · Kassa paneli holatni 2 soniyada bir so'raydi: ruxsat berilishi bilan
 *    chek o'zi chiqadi, sahifani yangilash shart emas.
 *
 * Ruxsat AYNAN shu chekka bog'langan: kassa, xodim, summa, avtomatik narx,
 * mijoz/bron, toifa, davomiylik. Boshqa narsaga ishlatib bo'lmaydi, bir marta
 * ishlatiladi, 15 daqiqa amal qiladi. Hammasi audit jurnaliga yoziladi.
 *
 * Saqlash: admin_settings, kalit `price_ok:<id>` (migratsiya kerak emas).
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import { telegramApi, validateTelegramInitData } from './telegram.js';
import { adminBotToken, adminChatIds, adminPanelUrl, escHtml } from './admin-notify.js';

/** Shundan KAM summa — «so'mlik chek», admin ruxsati bilan */
export const TINY_LIMIT = 1000;
export const APPROVAL_PREFIX = 'price_ok:';
const PENDING_MS = 15 * 60 * 1000;      // admin shu vaqt ichida javob beradi
const APPROVED_MS = 15 * 60 * 1000;     // ruxsatdan keyin chek shu vaqt ichida chiqadi
const REJECT_COOLDOWN_MS = 60 * 1000;   // rad etilgandan keyin darhol qayta so'ralmaydi

const q = (v: string) => encodeURIComponent(v);
const nf = (v: number) => String(Math.round(Number(v) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const ID_RE = /^[a-f0-9]{20}$/;
const TZ = 'Asia/Tashkent';
const hm = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

export const needsApproval = (total: number, expected: number) =>
  Math.round(Number(total)) < TINY_LIMIT && Math.round(Number(total)) !== Math.round(Number(expected));

export interface ApprovalRecord {
  status: 'pending' | 'approved' | 'rejected' | 'used' | 'cancelled' | 'expired';
  fp: string;
  total: number;
  expected: number;
  register: string;
  staff: string;
  customer: string;
  what: string;
  text: string;
  created_at: string;
  expires_at: string;
  valid_until?: string;
  decided_at?: string;
  decided_by?: string;
  used_at?: string;
  msgs: { chat_id: number; message_id: number }[];
}

/* ---------- kalit va imzo ---------- */
const norm = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
/** Ruxsat qaysi chekka tegishli — shu satr bir xil bo'lsagina ishlaydi */
export function approvalFingerprint(x: { registerId: string; staff: string; total: number; expected: number; minutes: number; body: any }) {
  const b = x.body || {};
  return [
    x.registerId, x.staff, Math.round(x.total), Math.round(x.expected), Math.round(Number(x.minutes) || 0),
    String(b.booking_id || ''), b.pay_package ? 'pkg' : '',
    norm(b.full_name), String(b.phone || '').replace(/\D/g, ''), norm(b.category).toUpperCase(),
    b.test_drive === true || b.test_drive === 'true' ? 'td' : '',
    b.test_drive_hour === true || b.test_drive_hour === 'true' ? 'h' : '',
    b.krug === true || b.krug === 'true' ? 'k' : '',
    Array.isArray(b.sessions) ? b.sessions.length : 0,
  ].join('|');
}
export const approvalIdOf = (fp: string) => createHash('sha256').update(fp).digest('hex').slice(0, 20);
const SECRET = () => String(process.env.ADMIN_SESSION_SECRET || '').trim() || 'avtodrom-fallback';
/** Guruh chatlari uchun havola imzosi (u yerda web_app tugma ishlamaydi) */
export const decisionSig = (id: string, d: string) => createHmac('sha256', SECRET()).update(`price-ok:${id}:${d}`).digest('hex').slice(0, 32);
const safeEq = (a: string, b: string) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/* ---------- baza ---------- */
export async function loadApproval(id: string): Promise<ApprovalRecord | null> {
  if (!ID_RE.test(id)) return null;
  const rows = await supabaseRest<any[]>('admin_settings', { query: `?key=eq.${q(APPROVAL_PREFIX + id)}&select=value&limit=1` });
  const v = rows?.[0]?.value;
  return v && typeof v === 'object' ? v as ApprovalRecord : null;
}
async function saveNew(id: string, value: ApprovalRecord, exists: boolean) {
  const now = new Date().toISOString();
  if (exists) {
    await supabaseRest('admin_settings', { method: 'PATCH', query: `?key=eq.${q(APPROVAL_PREFIX + id)}`, body: JSON.stringify({ value, updated_at: now }) });
  } else {
    await supabaseRest('admin_settings', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ key: APPROVAL_PREFIX + id, value, updated_at: now }) });
  }
}
/** Holatni faqat `from` holatda bo'lsa o'zgartiradi (bir vaqtda ikki bosish — bittasi o'tadi) */
async function transition(id: string, from: string, value: ApprovalRecord): Promise<boolean> {
  const rows = await supabaseRest<any[]>('admin_settings', {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    query: `?key=eq.${q(APPROVAL_PREFIX + id)}&value->>status=eq.${q(from)}`,
    body: JSON.stringify({ value, updated_at: new Date().toISOString() }),
  });
  return Array.isArray(rows) && rows.length > 0;
}
/** Kutilayotgan, lekin muddati o'tgan so'rov — «expired» deb ko'rsatiladi */
export function effectiveStatus(r: ApprovalRecord | null, now = Date.now()): ApprovalRecord['status'] | 'none' {
  if (!r) return 'none';
  if (r.status === 'pending' && now > Date.parse(r.expires_at)) return 'expired';
  if (r.status === 'approved' && r.valid_until && now > Date.parse(r.valid_until)) return 'expired';
  return r.status;
}

/* ---------- Telegram ---------- */
function pageUrl(id: string, d: 'ok' | 'no', chatId: number) {
  let origin = 'https://avtodrom.vercel.app';
  try { origin = new URL(adminPanelUrl()).origin; } catch {}
  const u = new URL('/ruxsat', origin);
  u.searchParams.set('id', id);
  u.searchParams.set('d', d);
  if (chatId < 0) u.searchParams.set('s', decisionSig(id, d));
  return u.toString();
}
function keyboard(id: string, chatId: number) {
  const btn = (text: string, d: 'ok' | 'no') => chatId > 0 ? { text, web_app: { url: pageUrl(id, d, chatId) } } : { text, url: pageUrl(id, d, chatId) };
  return { inline_keyboard: [[btn('✅ Ruxsat berish', 'ok'), btn('❌ Rad etish', 'no')]] };
}
function requestText(r: Pick<ApprovalRecord, 'register' | 'staff' | 'customer' | 'what' | 'expected' | 'total'>, at: Date) {
  const lines = ['🔐 <b>So‘mlik chek — ruxsat so‘raladi</b>', ''];
  lines.push(`💳 Kassa: <b>${escHtml(r.register)}</b>${r.staff ? ` · ${escHtml(r.staff)}` : ''}`);
  if (r.customer) lines.push(`👤 Mijoz: <b>${escHtml(r.customer)}</b>`);
  if (r.what) lines.push(`🚗 ${escHtml(r.what)}`);
  lines.push(`💰 Narx: <s>${nf(r.expected)}</s> → <b>${nf(r.total)} so‘m</b>`, `🕐 ${hm(at)}`, '',
    'Ruxsat berilsa — kassir chekni darhol chiqaradi (15 daqiqa ichida).');
  return lines.join('\n');
}
async function sendToAdmins(id: string, text: string) {
  const token = adminBotToken();
  if (!token) return { sent: 0, msgs: [] as ApprovalRecord['msgs'], reason: 'no_token' };
  const chats = await adminChatIds();
  if (!chats.length) return { sent: 0, msgs: [] as ApprovalRecord['msgs'], reason: 'no_admins' };
  const res = await Promise.allSettled(chats.map((chat) => telegramApi<any>(token, 'sendMessage', {
    chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: keyboard(id, chat),
  })));
  const msgs: ApprovalRecord['msgs'] = [];
  res.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value && (r.value as any).message_id) msgs.push({ chat_id: chats[i], message_id: Number((r.value as any).message_id) });
    else if (r.status === 'rejected') console.error('Ruxsat so‘rovi yuborilmadi:', chats[i], r.reason);
  });
  return { sent: msgs.length, msgs, reason: msgs.length ? '' : 'send_failed' };
}
/** Hamma adminlardagi xabarni yangilaydi: tugmalar olinadi, natija yoziladi */
async function closeMessages(r: ApprovalRecord, status: string) {
  const token = adminBotToken();
  if (!token || !r.msgs?.length) return;
  const text = `${r.text}\n\n${status}`;
  await Promise.allSettled(r.msgs.map((m) => telegramApi(token, 'editMessageText', {
    chat_id: m.chat_id, message_id: m.message_id, text, parse_mode: 'HTML', disable_web_page_preview: true,
  })));
}

/* ---------- chek chiqarishdagi to'siq ---------- */
export type GateResult = { ok: true; id?: string } | { ok: false; code: number; body: Record<string, unknown> };

/**
 * Chek chiqarishda chaqiriladi (maxsus parol tekshiruvidan KEYIN).
 * So'mlik chek bo'lmasa — o'tkazadi. Bo'lsa:
 *  · ruxsat berilgan bo'lsa — uni «ishlatildi» qiladi va o'tkazadi;
 *  · bo'lmasa — so'rov yaratadi (yoki borini qaytaradi) va 403 needs_approval.
 */
export async function approvalGate(ctx: {
  registerId: string; registerCode: string; staffKey: string; staffName: string;
  total: number; expected: number; minutes: number; body: any; customer: string; what: string;
}): Promise<GateResult> {
  if (!needsApproval(ctx.total, ctx.expected)) return { ok: true };
  const fp = approvalFingerprint({ registerId: ctx.registerId, staff: ctx.staffKey, total: ctx.total, expected: ctx.expected, minutes: ctx.minutes, body: ctx.body });
  const id = approvalIdOf(fp);
  const rec = await loadApproval(id);
  const now = Date.now();
  const st = rec && rec.fp === fp ? effectiveStatus(rec, now) : 'none';
  const wait = (status: string, extra: Record<string, unknown> = {}) => ({
    ok: false as const, code: 403,
    body: { ok: false, needs_approval: true, approval: { id, status, total: ctx.total, expected: ctx.expected, expires_at: rec?.expires_at, ...extra },
      error: status === 'rejected' ? 'Admin bu so‘mlik chekka ruxsat bermadi.' : 'So‘mlik chek — admin ruxsati kerak. So‘rov Telegram’ga yuborildi.' },
  });

  if (st === 'approved' && rec) {
    const used = { ...rec, status: 'used' as const, used_at: new Date(now).toISOString() };
    if (await transition(id, 'approved', used)) return { ok: true, id };
  }
  if (st === 'pending') return wait('pending');
  if (st === 'rejected' && rec?.decided_at && now - Date.parse(rec.decided_at) < REJECT_COOLDOWN_MS) return wait('rejected', { decided_by: rec.decided_by });

  /* Yangi so'rov */
  const at = new Date(now);
  const base = { register: ctx.registerCode, staff: ctx.staffName, customer: ctx.customer, what: ctx.what, expected: ctx.expected, total: ctx.total };
  const text = requestText(base, at);
  const value: ApprovalRecord = {
    ...base, status: 'pending', fp, text, msgs: [],
    created_at: at.toISOString(), expires_at: new Date(now + PENDING_MS).toISOString(),
  };
  await saveNew(id, value, !!rec);
  const s = await sendToAdmins(id, text);
  if (!s.sent) {
    await transition(id, 'pending', { ...value, status: 'cancelled' }).catch(() => false);
    const why = s.reason === 'no_token' ? 'Admin bot sozlanmagan (ADMIN_BOT_TOKEN yo‘q)'
      : s.reason === 'no_admins' ? 'Admin botda faol admin yo‘q'
      : 'Admin botga xabar yuborilmadi';
    return { ok: false, code: 503, body: { ok: false, error: `${why} — so‘mlik chekka ruxsat so‘rab bo‘lmadi.` } };
  }
  await transition(id, 'pending', { ...value, msgs: s.msgs }).catch(() => false);
  const { audit, adminUser } = await import('./admin-password-routes.js');
  const admin = await adminUser().catch(() => null);
  await audit(admin?.id ?? null, 'PRICE_APPROVAL_ASKED', 'price_approval', id, null,
    { total: ctx.total, expected: ctx.expected, register: ctx.registerCode, customer: ctx.customer, what: ctx.what, sent: s.sent });
  return { ok: false, code: 403, body: { ok: false, needs_approval: true, approval: { id, status: 'pending', total: ctx.total, expected: ctx.expected, expires_at: value.expires_at, sent: s.sent },
    error: 'So‘mlik chek — admin ruxsati kerak. So‘rov Telegram’ga yuborildi.' } };
}

/* ---------- marshrutlar ---------- */
export async function registerPriceApprovalRoutes(app: FastifyInstance) {
  /** Kassa paneli: so'rov holati (2 soniyada bir). Bekor qilish: { id, cancel: true } */
  app.get('/api/admin/price-approval', async (req: any, reply: any) => {
    try {
      const { currentStaff } = await import('./admin-password-routes.js');
      await currentStaff(req);
      const id = String(req.query?.id || '');
      const r = await loadApproval(id);
      if (!r) return reply.code(404).send({ ok: false, error: 'So‘rov topilmadi' });
      return { ok: true, id, status: effectiveStatus(r), decided_by: r.decided_by || null, decided_at: r.decided_at || null,
        total: r.total, expected: r.expected, expires_at: r.expires_at, valid_until: r.valid_until || null };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: e?.message || 'Holat o‘qilmadi' });
    }
  });

  app.post('/api/admin/price-approval', async (req: any, reply: any) => {
    try {
      const { currentStaff, audit, adminUser } = await import('./admin-password-routes.js');
      const me: any = await currentStaff(req);
      const id = String(req.body?.id || '');
      if (!req.body?.cancel) return reply.code(400).send({ ok: false, error: 'Amal noma’lum' });
      const r = await loadApproval(id);
      if (!r) return reply.code(404).send({ ok: false, error: 'So‘rov topilmadi' });
      if (r.status !== 'pending') return { ok: true, status: effectiveStatus(r) };
      const by = String(me?.login || 'kassir');
      if (await transition(id, 'pending', { ...r, status: 'cancelled', decided_at: new Date().toISOString(), decided_by: by })) {
        await closeMessages(r, `↩️ Kassir so‘rovni bekor qildi (${escHtml(by)})`);
        const admin = await adminUser().catch(() => null);
        await audit(admin?.id ?? null, 'PRICE_APPROVAL_CANCELLED', 'price_approval', id, null, { by });
      }
      return { ok: true, status: 'cancelled' };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: e?.message || 'Bekor qilinmadi' });
    }
  });

  /**
   * Admin qarori — /ruxsat sahifasidan. Kimligi:
   *  · initData (Telegram ichida ochilgan sahifa, admin bot imzosi) → faol admin bo'lishi shart;
   *  · yoki guruh havolasidagi imzo `s`.
   */
  app.post('/api/price-ok', async (req: any, reply: any) => {
    try {
      const b = req.body || {};
      const id = String(b.id || ''), d = String(b.d || '');
      if (!ID_RE.test(id) || (d !== 'ok' && d !== 'no')) return reply.code(400).send({ ok: false, error: 'Havola noto‘g‘ri' });

      let by = '';
      const initData = String(b.initData || '').trim();
      if (initData) {
        const token = adminBotToken();
        if (!token) return reply.code(503).send({ ok: false, error: 'Admin bot sozlanmagan' });
        let user: any;
        try { user = validateTelegramInitData(initData, token, 3600); }
        catch { return reply.code(401).send({ ok: false, error: 'Telegram tasdig‘i noto‘g‘ri yoki eskirgan — xabardagi tugmani qayta bosing.' }); }
        const admins = await adminChatIds();
        if (!admins.includes(Number(user?.id))) return reply.code(403).send({ ok: false, error: 'Faqat admin ruxsat bera oladi' });
        by = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || (user?.username ? `@${user.username}` : `ID ${user?.id}`);
      } else if (b.s && safeEq(String(b.s), decisionSig(id, d))) {
        by = 'admin (guruh)';
      } else {
        return reply.code(401).send({ ok: false, error: 'Bu sahifani admin botdagi tugma orqali oching.' });
      }

      const r = await loadApproval(id);
      if (!r) return reply.code(404).send({ ok: false, error: 'So‘rov topilmadi' });
      const st = effectiveStatus(r);
      if (st !== 'pending') {
        return { ok: true, status: st, already: true, decided_by: r.decided_by || null, total: r.total, expected: r.expected };
      }
      const now = new Date();
      const ok = d === 'ok';
      const next: ApprovalRecord = {
        ...r, status: ok ? 'approved' : 'rejected', decided_at: now.toISOString(), decided_by: by.slice(0, 80),
        ...(ok ? { valid_until: new Date(now.getTime() + APPROVED_MS).toISOString() } : {}),
      };
      if (!(await transition(id, 'pending', next))) {
        const again = await loadApproval(id);
        return { ok: true, status: effectiveStatus(again), already: true, decided_by: again?.decided_by || null, total: r.total, expected: r.expected };
      }
      await closeMessages(r, ok ? `✅ <b>Ruxsat berildi</b> — ${escHtml(by)}, ${hm(now)}` : `❌ <b>Rad etildi</b> — ${escHtml(by)}, ${hm(now)}`);
      const { audit, adminUser } = await import('./admin-password-routes.js');
      const admin = await adminUser().catch(() => null);
      await audit(admin?.id ?? null, ok ? 'PRICE_APPROVAL_OK' : 'PRICE_APPROVAL_NO', 'price_approval', id, null,
        { by, total: r.total, expected: r.expected, register: r.register, customer: r.customer, what: r.what, staff: r.staff });
      return { ok: true, status: next.status, decided_by: by, total: r.total, expected: r.expected };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Saqlanmadi' });
    }
  });
}
