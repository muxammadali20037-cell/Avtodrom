import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import type { TelegramWebAppUser } from './telegram.js';
import { q, userForTelegram } from './identity.js';

export async function registerChatRoutes(
  app: FastifyInstance,
  authenticateCustomer: (request: any) => Promise<TelegramWebAppUser>,
) {
  app.get('/api/customer/chats/community/messages', async (request, reply) => {
    try {
      const tg = await authenticateCustomer(request);
      const user = await userForTelegram(tg);
      const rows = await supabaseRest<any[]>('community_messages', {
        query: '?select=id,sender_user_id,sender_role,message,created_at&order=created_at.asc&limit=200',
      });
      return {
        ok: true,
        messages: rows.map((row) => ({
          id: row.id,
          sender_id: row.sender_user_id,
          sender_role: row.sender_role,
          sender_name: String(row.sender_user_id) === String(user.id) ? 'Siz' : row.sender_role === 'admin' ? 'AVTODROM Admin' : 'AVTODROM',
          text: row.message,
          created_at: row.created_at,
          mine: String(row.sender_user_id) === String(user.id),
        })),
      };
    } catch (e) {
      return reply.code(401).send({ ok: false, error: e instanceof Error ? e.message : 'Chat yuklanmadi' });
    }
  });

  app.post('/api/customer/chats/community/messages', async (request, reply) => {
    try {
      const tg = await authenticateCustomer(request);
      const user = await userForTelegram(tg);
      const text = String((request.body as any)?.message ?? (request.body as any)?.text ?? '').trim();
      if (!text) return reply.code(400).send({ ok: false, error: 'Xabar bo‘sh bo‘lishi mumkin emas' });
      if (text.length > 4000) return reply.code(400).send({ ok: false, error: 'Xabar 4000 belgidan oshmasin' });

      const rows = await supabaseRest<any[]>('community_messages', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          sender_user_id: user.id,
          sender_role: user.role,
          message: text,
        }),
      });
      const row = rows[0];
      return reply.code(201).send({
        ok: true,
        message: row ? {
          id: row.id,
          sender_id: row.sender_user_id,
          sender_role: row.sender_role,
          sender_name: 'Siz',
          text: row.message,
          created_at: row.created_at,
          mine: true,
        } : null,
      });
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Xabar yuborilmadi' });
    }
  });
}
