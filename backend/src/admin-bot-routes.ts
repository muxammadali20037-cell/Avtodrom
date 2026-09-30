/**
 * ADMIN BOTI SOZLAMALARI (faqat administrator).
 *
 * Qaysi Telegram chatlar yangi bron xabarini oladi — telegram_admins.
 * Ilgari bu ro'yxatni faqat Supabase'da qo'lda o'zgartirish mumkin edi.
 *
 *   GET    /api/admin/telegram-admins           — ro'yxat (+ chat nomi Telegramdan)
 *   POST   /api/admin/telegram-admins           — { chat_id } qo'shish (avval sinov xabari)
 *   PATCH  /api/admin/telegram-admins/:id       — { is_active }
 *   DELETE /api/admin/telegram-admins/:id
 *   POST   /api/admin/telegram-admins/test      — hamma faol chatga sinov xabari
 */
import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import { telegramApi } from './telegram.js';
import { guardAdmin, adminUser, audit } from './admin-password-routes.js';
import {
  adminBotToken, adminPanelUrl, adminChatIds, sendToAdminChat, notifyAdmins,
  loadAdminContext, adminNewBookingText,
} from './admin-notify.js';

const enc = encodeURIComponent;

function fail(reply: any, e: any, fallback: string) {
  return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || fallback });
}

let botInfo: { at: number; username: string } | null = null;
async function botUsername(token: string): Promise<string> {
  if (botInfo && Date.now() - botInfo.at < 10 * 60_000) return botInfo.username;
  try {
    const me = await telegramApi<any>(token, 'getMe', {});
    botInfo = { at: Date.now(), username: String(me?.username || '') };
    return botInfo.username;
  } catch { return ''; }
}

/** Chat nomi: odam bo'lsa ism (+ @username), guruh bo'lsa sarlavha. */
async function chatTitle(token: string, chatId: number): Promise<string> {
  try {
    const c = await telegramApi<any>(token, 'getChat', { chat_id: chatId });
    const name = c?.title || [c?.first_name, c?.last_name].filter(Boolean).join(' ');
    return [name, c?.username ? '@' + c.username : ''].filter(Boolean).join(' · ');
  } catch { return ''; }
}

function parseChatId(v: unknown): number | null {
  const s = String(v ?? '').trim().replace(/\s+/g, '');
  if (!/^-?\d{5,16}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n !== 0 ? n : null;
}

/** Telegram xatosini odam tushunadigan matnga. */
function tgHuman(e: any): string {
  const m = String(e?.message || e || '');
  if (/chat not found/i.test(m)) return 'Chat topilmadi. Avval shu odam admin botga /start yozsin, keyin qayta qo‘shing.';
  if (/blocked by the user/i.test(m)) return 'Bu odam admin botni bloklagan. Botni blokdan chiqarib, /start yozsin.';
  if (/not enough rights|kicked|not a member/i.test(m)) return 'Bot bu guruhda emas yoki yozishga ruxsati yo‘q. Botni guruhga qo‘shing.';
  return `Telegram xabarni qabul qilmadi: ${m}`;
}

export async function registerAdminBotRoutes(app: FastifyInstance) {
  app.get('/api/admin/telegram-admins', async (req: any, reply: any) => {
    try {
      await guardAdmin(req);
      const token = adminBotToken();
      const rows = await supabaseRest<any[]>('telegram_admins', { query: '?select=id,telegram_chat_id,is_active,created_at&order=id.asc' });
      const titles = token
        ? await Promise.all(rows.map((r) => chatTitle(token, Number(r.telegram_chat_id))))
        : rows.map(() => '');
      return {
        ok: true,
        bot: { configured: !!token, username: token ? await botUsername(token) : '' },
        panel_url: adminPanelUrl('bookings/new'),
        chats: rows.map((r, i) => ({
          id: r.id, chat_id: String(r.telegram_chat_id), is_active: r.is_active !== false,
          created_at: r.created_at, title: titles[i] || '', group: Number(r.telegram_chat_id) < 0,
        })),
      };
    } catch (e) { return fail(reply, e, 'Ro‘yxat olinmadi'); }
  });

  app.post('/api/admin/telegram-admins', async (req: any, reply: any) => {
    try {
      await guardAdmin(req);
      const token = adminBotToken();
      if (!token) return reply.code(503).send({ ok: false, error: 'ADMIN_BOT_TOKEN Vercel sozlamalarida yo‘q — avval admin bot tokenini qo‘shing.' });
      const chatId = parseChatId((req.body ?? {}).chat_id);
      if (chatId === null) return reply.code(400).send({ ok: false, error: 'Chat ID raqam bo‘lishi kerak (masalan, 6140529649). Uni bilish uchun admin botga /start yozing.' });

      const existing = (await supabaseRest<any[]>('telegram_admins', { query: `?telegram_chat_id=eq.${chatId}&select=id,is_active&limit=1` }))[0];
      if (existing && existing.is_active !== false) return reply.code(409).send({ ok: false, error: 'Bu chat allaqachon ro‘yxatda.' });

      /* Avval xabar yuboramiz: chat haqiqatan bor va bot yoza oladimi —
         shunda ro'yxatga «o'lik» raqam tushmaydi. */
      try {
        await sendToAdminChat(token, chatId,
          '✅ <b>Bu chat AVTODROM admin xabarlariga ulandi.</b>\n\nEndi mijoz Mini App orqali bron qilsa, shu yerga darhol to‘liq ma’lumot keladi: mijoz, telefon, instruktor, mashina, sana va vaqt, narx, bron kodi.',
          { html: true, open: 'bookings/new' });
      } catch (e) {
        return reply.code(400).send({ ok: false, error: tgHuman(e) });
      }

      const admin = await adminUser().catch(() => null);
      let row: any;
      if (existing) {
        row = (await supabaseRest<any[]>('telegram_admins', {
          method: 'PATCH', headers: { Prefer: 'return=representation' },
          query: `?id=eq.${enc(String(existing.id))}`,
          body: JSON.stringify({ is_active: true, updated_at: new Date().toISOString() }),
        }))[0];
      } else {
        row = (await supabaseRest<any[]>('telegram_admins', {
          method: 'POST', headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ telegram_chat_id: chatId, is_active: true }),
        }))[0];
      }
      await audit(admin?.id ?? null, 'TELEGRAM_ADMIN_ADD', 'telegram_admins', String(row?.id ?? ''), null, { chat_id: chatId });
      const title = await chatTitle(token, chatId);
      return { ok: true, chat: { id: row?.id, chat_id: String(chatId), is_active: true, title, group: chatId < 0 } };
    } catch (e) { return fail(reply, e, 'Chat qo‘shilmadi'); }
  });

  app.patch('/api/admin/telegram-admins/:id', async (req: any, reply: any) => {
    try {
      await guardAdmin(req);
      const id = String(req.params.id);
      const on = (req.body ?? {}).is_active;
      if (typeof on !== 'boolean') return reply.code(400).send({ ok: false, error: 'is_active true yoki false bo‘lishi kerak' });
      const rows = await supabaseRest<any[]>('telegram_admins', {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        query: `?id=eq.${enc(id)}`,
        body: JSON.stringify({ is_active: on, updated_at: new Date().toISOString() }),
      });
      if (!rows[0]) return reply.code(404).send({ ok: false, error: 'Chat topilmadi' });
      const admin = await adminUser().catch(() => null);
      await audit(admin?.id ?? null, on ? 'TELEGRAM_ADMIN_ON' : 'TELEGRAM_ADMIN_OFF', 'telegram_admins', id, null, { chat_id: rows[0].telegram_chat_id });
      return { ok: true };
    } catch (e) { return fail(reply, e, 'O‘zgartirilmadi'); }
  });

  app.delete('/api/admin/telegram-admins/:id', async (req: any, reply: any) => {
    try {
      await guardAdmin(req);
      const id = String(req.params.id);
      const rows = await supabaseRest<any[]>('telegram_admins', {
        method: 'DELETE', headers: { Prefer: 'return=representation' }, query: `?id=eq.${enc(id)}`,
      });
      if (!rows[0]) return reply.code(404).send({ ok: false, error: 'Chat topilmadi' });
      const admin = await adminUser().catch(() => null);
      await audit(admin?.id ?? null, 'TELEGRAM_ADMIN_DELETE', 'telegram_admins', id, { chat_id: rows[0].telegram_chat_id }, null);
      return { ok: true };
    } catch (e) { return fail(reply, e, 'O‘chirilmadi'); }
  });

  /* Sinov: oxirgi Mini App bronini misol qilib yuboradi — admin xabar
     qanday ko'rinishini va tugma ishlashini o'zi tekshiradi. */
  app.post('/api/admin/telegram-admins/test', async (req: any, reply: any) => {
    try {
      await guardAdmin(req);
      if (!adminBotToken()) return reply.code(503).send({ ok: false, error: 'ADMIN_BOT_TOKEN Vercel sozlamalarida yo‘q.' });
      if (!(await adminChatIds()).length) return reply.code(400).send({ ok: false, error: 'Faol chat yo‘q — avval chat qo‘shing.' });
      const last = (await supabaseRest<any[]>('bookings', {
        query: '?source=eq.app&select=*&order=created_at.desc&limit=1',
      }).catch(() => [] as any[]))[0];
      let text = '🧪 <b>SINOV XABARI</b>\n\nAdmin bot ishlayapti. Mini App’dan yangi bron kelsa, shu yerga to‘liq ma’lumot bilan keladi.';
      if (last) {
        const ctx = await loadAdminContext(last);
        text = '🧪 <b>SINOV</b> — oxirgi bron misolida:\n\n' + adminNewBookingText([last], ctx);
      }
      const r = await notifyAdmins(text, { html: true, open: 'bookings/new', button: '🛡️ Admin panelda ochish' });
      return { ok: r.failed === 0, ...r, error: r.failed ? r.errors.join('; ') : undefined };
    } catch (e) { return fail(reply, e, 'Sinov xabari yuborilmadi'); }
  });
}

/** Admin botga /start yoki /id yozilganda — chat ID va holatni aytadi. */
export async function sendAdminChatInfo(token: string, chatId: number) {
  let active = false;
  try {
    active = (await adminChatIds()).includes(chatId);
  } catch { /* baribir ID ni aytamiz */ }
  const text = active
    ? `✅ Bu chat yangi bron xabarlarini oladi.\n\nChat ID: <code>${chatId}</code>`
    : `ℹ️ Yangi bron xabarlarini shu yerda olish uchun administrator panelda ushbu raqamni qo‘shsin:\n\n<code>${chatId}</code>\n\nAdmin panel → Narxlar va ish vaqti → «Admin bot — yangi bron xabarlari».`;
  return telegramApi(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' }).catch((e) => console.error('admin chat info', e));
}

