import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import { sendBookingNotification } from './telegram.js';
import { notifyAdmins } from './admin-notify.js';
import type { TelegramWebAppUser } from './telegram.js';
import { q, findUserByTelegram, userForTelegram } from './identity.js';
import { answerQuestion, loadSettings, botOn, kbOf, INTENTS, KB_KEY, BOT_KEY, BOT_PREFIX, type KbItem } from './support-bot.js';

const MAX_LEN = 2000;
const CUSTOMER_TOKEN = () => String(process.env.CUSTOMER_BOT_TOKEN || process.env.TELEGRAM_CUSTOMER_BOT_TOKEN || '');
const MINI_URL = () => String(process.env.CUSTOMER_MINI_APP_URL || process.env.MINI_APP_URL || 'https://avtodrom.vercel.app/');

async function setSetting(key: string, value: unknown) {
  const now = new Date().toISOString();
  const rows = await supabaseRest<any[]>('admin_settings', {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, query: `?key=eq.${q(key)}`,
    body: JSON.stringify({ value, updated_at: now }),
  });
  if (!rows?.length) await supabaseRest('admin_settings', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ key, value, updated_at: now }) });
}
const isBotMsg = (m: any) => m?.sender === 'admin' && !m?.admin_id && String(m?.body || '').startsWith(BOT_PREFIX);

/**
 * Mijoz savoli (Mini App chati yoki mijoz boti): saqlanadi, bot javob beradi.
 * Javob topilsa — savol «o'qilgan» (adminni bezovta qilmaydi). Topilmasa yoki
 * admin kerak bo'lsa — savol o'qilmagan qoladi (admin panelda belgi) va admin
 * botiga «❓ Javobsiz savol» ketadi. Bot o'chirilgan bo'lsa — eskicha: adminga.
 */
export async function handleCustomerQuestion(user: any, body: string, channel: 'app' | 'bot') {
  const recent = await supabaseRest<any[]>('support_messages', {
    query: `?user_id=eq.${q(String(user.id))}&select=sender,admin_id,body,created_at&order=created_at.desc&limit=6`,
  }).catch(() => []);
  const [msg] = await supabaseRest<any[]>('support_messages', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ user_id: user.id, sender: 'customer', body, is_read: false }),
  });
  const s = await loadSettings();
  const who = `${user.full_name || 'Mijoz'}${user.phone ? ` (${user.phone})` : ''}`;
  const via = channel === 'bot' ? 'Telegram bot' : 'Mini App';
  if (!botOn(s)) { await pingAdmins(`${who} · ${via}`, body); return { message: msg, reply: null as any, answer: null as any }; }

  const ans = await answerQuestion(body, { userId: String(user.id), settings: s });
  /* «adminga yubordim» ketma-ket qaytarilmasin: mijoz bir necha qator yozsa — bitta javob */
  const lastBot = (recent || []).find((m) => m.sender === 'admin');
  const heldRecently = ans.kind === 'unknown' && lastBot && isBotMsg(lastBot) && /adminga yubordim|передан администратору/.test(lastBot.body)
    && Date.now() - Date.parse(lastBot.created_at) < 20 * 60000;
  let reply: any = null;
  if (!heldRecently && ans.text) {
    [reply] = await supabaseRest<any[]>('support_messages', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ user_id: user.id, sender: 'admin', admin_id: null, body: ans.text, is_read: true }),
    }).catch(() => [null]);
  }
  if (ans.escalate) {
    /* bir necha qatorni ketma-ket yozsa — adminga bitta xabar (3 daqiqa) */
    const prevQ = (recent || []).find((m) => m.sender === 'customer');
    const burst = prevQ && Date.now() - Date.parse(prevQ.created_at) < 3 * 60000 && heldRecently;
    if (!burst) {
      const tag = ans.kind === 'unknown' ? '❓ Javobsiz savol' : `📨 Admin kerak (${ans.topics.map((t) => INTENTS.find((i) => i.id === t)?.title || t).join(', ')})`;
      try { await notifyAdmins(`${tag} — ${via}

${who}:
${body.slice(0, 500)}

🤖 Mijozga «adminga yubordim» deb javob berildi.`, { open: 'chat', button: '💬 Javob berish' }); }
      catch (e) { console.error('Support: admin ping failed', e); }
    }
  } else if (msg?.id) {
    await supabaseRest('support_messages', { method: 'PATCH', query: `?id=eq.${q(String(msg.id))}`, body: JSON.stringify({ is_read: true }) }).catch(() => {});
    msg.is_read = true;
  }
  return { message: msg, reply, answer: ans };
}

/** Mijoz botiga oddiy matn yozilsa (Mini App ochmasdan) — xuddi shu yo'l, javob Telegram’da */
export async function handleBotQuestion(from: any, chatId: number, text: string) {
  const token = CUSTOMER_TOKEN();
  if (!token || !Number.isSafeInteger(chatId) || chatId <= 0) return;
  const body = clean(text).slice(0, MAX_LEN);
  if (!body) return;
  const user = await userForTelegram({ id: Number(from?.id || chatId), first_name: from?.first_name, last_name: from?.last_name, username: from?.username } as any);
  if (!user || user.is_blocked) return;
  const r = await handleCustomerQuestion(user, body, 'bot');
  if (r.reply?.body) await sendBookingNotification(token, chatId, r.reply.body, MINI_URL(), '📱 Ilovani ochish').catch((e) => console.error('Support bot reply failed', e));
}

function clean(v: unknown) {
  return String(v ?? '').trim();
}

/** Adminga Telegram orqali xabar beradi. Yiqilsa asosiy oqim to'xtamaydi. */
async function pingAdmins(fromName: string, body: string) {
  try {
    await notifyAdmins(`💬 AVTODROM — yangi savol\n\n${fromName}:\n${body.slice(0, 500)}`, { open: 'chat', button: '💬 Chatni ochish' });
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

      const r = await handleCustomerQuestion(user, body, 'app');
      return reply.code(201).send({ ok: true, message: r.message, reply: r.reply || null });
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

      /* «Avto-javobga saqlash»: shu javobdan oldingi (javobsiz) savol(lar) → bilim bazasi */
      let learned: KbItem | null = null;
      if ((request.body as any)?.save_kb) {
        const hist = await supabaseRest<any[]>('support_messages', {
          query: `?user_id=eq.${q(userId)}&select=sender,admin_id,body,created_at&order=created_at.desc&limit=12`,
        }).catch(() => []);
        const qs: string[] = [];
        for (const m of hist || []) {
          if (m.sender === 'customer') qs.unshift(String(m.body || '').trim());
          else if (!isBotMsg(m)) break;          // oldingi admin javobigacha
        }
        const question = qs.filter(Boolean).join(' ').slice(0, 300);
        if (question) {
          const s = await loadSettings();
          const kb = kbOf(s);
          learned = { id: `kb${Date.now().toString(36)}`, q: [question], a: body, on: true, hits: 0, at: new Date().toISOString(), by: admin?.full_name || 'admin' };
          await setSetting(KB_KEY, { items: [...kb, learned].slice(-300) });
        }
      }
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
            '📱 Ilovani ochish',
          );
        }
      } catch (e) { console.error('Support: customer notify failed', e); }

      return reply.code(201).send({ ok: true, message: rows[0], learned });
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: e?.message || 'Javob yuborilmadi' });
    }
  });

  /* ------------------------- AVTO-JAVOB (admin) ------------------------- */
  /** Holat, bilim bazasi va tayyor mavzular (namuna javob bilan) */
  app.get('/api/admin/support-bot', async (request, reply) => {
    try {
      await requireAdmin(request);
      const s = await loadSettings();
      const topics = await Promise.all(INTENTS.map(async (it) => {
        const sample = it.kw.filter(([k]) => k.length > 3).slice(0, 4).map(([k]) => k).join(', ');
        let preview: string | null = null;
        if (it.need !== 'bookings') {
          const a = await answerQuestion(it.kw[0][0], { settings: { ...s, [KB_KEY]: [] } }).catch(() => null);
          preview = a && a.kind === 'intent' && a.topics[0] === it.id ? a.text.replace(BOT_PREFIX, '') : null;
        }
        return { id: it.id, title: it.title, keywords: sample, escalate: !!it.escalate, preview };
      }));
      return { ok: true, on: botOn(s), kb: kbOf(s), topics };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Yuklanmadi' });
    }
  });
  /** Yoqish/o'chirish va bilim bazasini saqlash */
  app.put('/api/admin/support-bot', async (request, reply) => {
    try {
      await requireAdmin(request);
      const b = (request.body as any) || {};
      if (typeof b.on === 'boolean') await setSetting(BOT_KEY, { on: b.on });
      if (Array.isArray(b.kb)) {
        if (b.kb.length > 300) return reply.code(400).send({ ok: false, error: 'Ko‘pi bilan 300 ta savol-javob' });
        const items: KbItem[] = [];
        for (const x of b.kb) {
          const qs = (Array.isArray(x?.q) ? x.q : [x?.q]).map((v: any) => clean(v).slice(0, 300)).filter(Boolean).slice(0, 10);
          const a = clean(x?.a).slice(0, MAX_LEN);
          if (!qs.length || !a) return reply.code(400).send({ ok: false, error: 'Har bir yozuvda savol va javob bo‘lsin' });
          items.push({ id: clean(x?.id) || `kb${Date.now().toString(36)}${items.length}`, q: qs, a, on: x?.on !== false, hits: Number(x?.hits) || 0, at: x?.at || new Date().toISOString(), by: x?.by || null });
        }
        await setSetting(KB_KEY, { items });
      }
      const s = await loadSettings();
      return { ok: true, on: botOn(s), kb: kbOf(s) };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Saqlanmadi' });
    }
  });
  /** Sinab ko'rish: shu savolga bot nima deydi */
  app.post('/api/admin/support-bot-test', async (request, reply) => {
    try {
      await requireAdmin(request);
      const text = clean((request.body as any)?.text).slice(0, MAX_LEN);
      if (!text) return reply.code(400).send({ ok: false, error: 'Savol yozing' });
      const a = await answerQuestion(text, {});
      return { ok: true, ...a, text: a.text.replace(BOT_PREFIX, '') };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Xato' });
    }
  });
}
