import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { sendCustomerStart, validateTelegramInitData, type TelegramWebAppUser } from './telegram.js';
import { registerBookingRoutes } from './booking-routes.js';
import { registerInstructorRoutes } from './instructor-routes.js';
import { registerAdminPasswordRoutes } from './admin-password-routes.js';

const app = Fastify({ logger: true });
const CUSTOMER_BOT_TOKEN = process.env.CUSTOMER_BOT_TOKEN || '';
const MINI_APP_URL = process.env.MINI_APP_URL || '';
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';

await app.register(cors, {
  origin: process.env.FRONTEND_ORIGIN ? [process.env.FRONTEND_ORIGIN] : true,
  credentials: true,
});
await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

app.get('/api/health', async () => ({ ok: true, service: 'avtodrom-api' }));

app.post<{ Body: { initData?: string } }>('/api/telegram/auth', async (request, reply) => {
  try {
    return { ok: true, user: validateTelegramInitData(request.body?.initData || '', CUSTOMER_BOT_TOKEN) };
  } catch {
    return reply.code(401).send({ ok: false, error: 'Telegram authentication failed' });
  }
});

export async function authenticate(request: any): Promise<TelegramWebAppUser> {
  const initData = String(request.headers['x-telegram-init-data'] || '').trim();
  if (!initData) throw new Error('Telegram initData missing');
  return validateTelegramInitData(initData, CUSTOMER_BOT_TOKEN);
}

await registerBookingRoutes(app, authenticate);
await registerInstructorRoutes(app, authenticate);
await registerAdminPasswordRoutes(app);

app.post('/api/telegram/webhook', async (request, reply) => {
  const secret = String(request.headers['x-telegram-bot-api-secret-token'] || '');
  if (TELEGRAM_WEBHOOK_SECRET && secret !== TELEGRAM_WEBHOOK_SECRET) {
    return reply.code(401).send({ ok: false, error: 'Invalid webhook secret' });
  }

  const update = request.body as any;
  const message = update?.message;
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  const chatId = Number(message?.chat?.id);

  if (CUSTOMER_BOT_TOKEN && MINI_APP_URL && Number.isSafeInteger(chatId) && chatId > 0) {
    if (/^\/start(?:@\w+)?(?:\s.*)?$/i.test(text)) {
      await sendCustomerStart(CUSTOMER_BOT_TOKEN, chatId, MINI_APP_URL);
    }
  }

  return { ok: true };
});

app.post<{ Body: { chatId?: number } }>('/api/telegram/customer/start', async (request, reply) => {
  if (!CUSTOMER_BOT_TOKEN || !MINI_APP_URL) {
    return reply.code(503).send({ ok: false, error: 'Telegram bot is not configured' });
  }
  const chatId = Number(request.body?.chatId);
  if (!Number.isSafeInteger(chatId)) {
    return reply.code(400).send({ ok: false, error: 'Invalid chatId' });
  }
  await sendCustomerStart(CUSTOMER_BOT_TOKEN, chatId, MINI_APP_URL);
  return { ok: true };
});

export default app;
export { app };
