import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import { sendBookingNotification } from './telegram.js';
import type { TelegramWebAppUser } from './telegram.js';
import { q, findUserByTelegram } from './identity.js';

const MAX_LEN = 2000;

function clean(v: unknown) {
  return String(v ?? '').trim();
}

/** Adminga Telegram orqali xabar beradi. Yiqilsa asosiy oqim to'xtamaydi. */
async function pingAdmins(fromName: string, body: string) {
  try {
    const token = String(process.env.ADMIN_BOT_TOKEN || process.env.TELEGRAM_ADMIN_BOT_TOKEN || '');
    if (!token) return;
    const admins = await supabaseRest<any[]>('telegram_admins', { query: '?select=telegram_chat_id' });
    const url = String(process.env.ADMIN_MINI_APP_URL || '');
    const text = `💬 AVTODROM — yangi savol\n\n${fromName}:\n${body.slice(0, 500)}`;
    for (const a of admins) {
      const chatId = Number(a.telegram_chat_id);
      if (Number.isSafeInteger(chatId) && chatId > 0) {
        await sendBookingNotification(token, chatId, text, url, '⚙️ Admin panel');
      }
    }
  } catch (e) {
    console.error('Support: admin ping failed', e);
  }
}

export async function registerSupportRoutes(
  app: FastifyInstance,
  authenticateCustomer: (request: any) => Promise<TelegramWebAppUser>,
  requireAdmin: (request: any) => Promise<void>,
  adminUser: () => Promise<any>,
) {
  /* ------------------------- MIJOZ ------------------------- */

  app.get('/api/support/messages', async (request, reply) => {
    try {
      const tg = await authenticateCustomer(request);
      const user = await findUserByTelegram(tg.id);
      if (!user) return { ok: true, messages: [] };

      const rows = await supabaseRest<any[]>('support_messages', {
        query: `?user_id=eq.${q(String(user.id))}&select=id,sender,body,created_at,is_read&order=created_at.asc&limit=200`,
      });

      // Admin javoblarini o'qilgan deb belgilaymiz
      const unread = rows.filter((m) => m.sender === 'admin' && !m.is_read);
      if (unread.length) {
        await supabaseRest('support_messages', {
          method: 'PATCH',
          query: `?user_id=eq.${q(String(user.id))}&sender=eq.admin&is_read=eq.false`,
          body: JSON.stringify({ is_read: true }),
        }).catch(() => { /* o'qilgan belgisi kritik emas */ });
      }

      return { ok: true, messages: rows };
    } catch (e) {
      return reply.code(401).send({ ok: false, error: e instanceof Error ? e.message : 'Unauthorized' });
    }
  });

  app.post('/api/support/messages', async (request, reply) => {
    try {
      const tg = await authenticateCustomer(request);
      const user = await findUserByTelegram(tg.id);
      if (!user) return reply.code(401).send({ ok: false, error: 'Profil topilmadi' });
      if (user.is_blocked) return reply.code(403).send({ ok: false, error: 'Hisobingiz bloklangan' });

      const body = clean((request.body as any)?.body);
      if (!body) return reply.code(400).send({ ok: false, error: 'Xabar bo‘sh bo‘lmasin' });
      if (body.length > MAX_LEN) return reply.code(400).send({ ok: false, error: `Xabar ${MAX_LEN} belgidan oshmasin` });

      const rows = await supabaseRest<any[]>('support_messages', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ user_id: user.id, sender: 'customer', body }),
      });

      await pingAdmins(user.full_name || 'Mijoz', body);
      return reply.code(201).send({ ok: true, message: rows[0] });
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Xabar yuborilmadi' });
    }
  });

  /* ------------------------- ADMIN ------------------------- */

  /** Suhbatlar ro'yxati: har bir mijoz uchun oxirgi xabar va o'qilmagan soni. */
  app.get('/api/admin/support', async (request, reply) => {
    try {
      await requireAdmin(request);
      const rows = await supabaseRest<any[]>('support_messages', {
        query: '?select=id,user_id,sender,body,created_at,is_read&order=created_at.desc&limit=1000',
      });

      const byUser = new Map<string, { user_id: string; last: any; unread: number; total: number }>();
      for (const m of rows) {
        const key = String(m.user_id);
        const cur = byUser.get(key) || { user_id: key, last: m, unread: 0, total: 0 };
        cur.total += 1;
        if (m.sender === 'customer' && !m.is_read) cur.unread += 1;
        byUser.set(key, cur);
      }

      const ids = [...byUser.keys()];
      const users = ids.length
        ? await supabaseRest<any[]>('users', { query: `?id=in.(${ids.map(q).join(',')})&select=id,full_name,phone,telegram_id` })
        : [];
      const um = new Map(users.map((u) => [String(u.id), u]));

      return {
        ok: true,
        threads: [...byUser.values()]
          .map((t) => ({ ...t, user: um.get(t.user_id) || null }))
          .sort((a, b) => new Date(b.last.created_at).getTime() - new Date(a.last.created_at).getTime()),
      };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Suhbatlar yuklanmadi' });
    }
  });

  /** Bitta mijoz bilan yozishma. */
  app.get('/api/admin/support/:userId', async (request, reply) => {
    try {
      await requireAdmin(request);
      const userId = String((request.params as any).userId);
      const rows = await supabaseRest<any[]>('support_messages', {
        query: `?user_id=eq.${q(userId)}&select=id,sender,body,created_at,is_read&order=created_at.asc&limit=300`,
      });
      await supabaseRest('support_messages', {
        method: 'PATCH',
        query: `?user_id=eq.${q(userId)}&sender=eq.customer&is_read=eq.false`,
        body: JSON.stringify({ is_read: true }),
      }).catch(() => {});
      return { ok: true, messages: rows };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Yozishma yuklanmadi' });
    }
  });

  /** Admin javobi + mijozga Telegram xabari. */
  app.post('/api/admin/support/:userId/reply', async (request, reply) => {
    try {
      await requireAdmin(request);
      const admin = await adminUser();
      const userId = String((request.params as any).userId);
      const body = clean((request.body as any)?.body);
      if (!body) return reply.code(400).send({ ok: false, error: 'Xabar bo‘sh bo‘lmasin' });
      if (body.length > MAX_LEN) return reply.code(400).send({ ok: false, error: `Xabar ${MAX_LEN} belgidan oshmasin` });

      const rows = await supabaseRest<any[]>('support_messages', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ user_id: userId, sender: 'admin', admin_id: admin?.id ?? null, body }),
      });

      try {
        const u = (await supabaseRest<any[]>('users', { query: `?id=eq.${q(userId)}&select=telegram_id&limit=1` }))[0];
        const token = String(process.env.CUSTOMER_BOT_TOKEN || process.env.TELEGRAM_CUSTOMER_BOT_TOKEN || '');
        const chatId = Number(u?.telegram_id);
        if (token && Number.isSafeInteger(chatId) && chatId > 0) {
          await sendBookingNotification(
            token, chatId,
            `💬 AVTODROM javobi\n\n${body.slice(0, 500)}`,
            String(process.env.CUSTOMER_MINI_APP_URL || process.env.MINI_APP_URL || ''),
            '🚗 Mini App',
          );
        }
      } catch (e) { console.error('Support: customer notify failed', e); }

      return reply.code(201).send({ ok: true, message: rows[0] });
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: e?.message || 'Javob yuborilmadi' });
    }
  });
}
