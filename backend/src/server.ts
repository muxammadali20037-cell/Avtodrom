import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { sendCustomerStart, startCustomerPolling, validateTelegramInitData, type TelegramWebAppUser } from './telegram.js';
import { registerBookingRoutes } from './booking-routes.js';
import { registerAdminRoutes } from './admin-routes.js';

const app = Fastify({ logger: true });
const PORT = Number(process.env.PORT || 3000);
const CUSTOMER_BOT_TOKEN = process.env.CUSTOMER_BOT_TOKEN || '';
const MINI_APP_URL = process.env.MINI_APP_URL || '';

await app.register(cors, {
  origin: process.env.FRONTEND_ORIGIN ? [process.env.FRONTEND_ORIGIN] : true,
  credentials: true,
});
await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

app.get('/health', async () => ({ ok: true, service: 'avtodrom-index-api' }));

app.post<{ Body: { initData?: string } }>('/api/telegram/auth', async (request, reply) => {
  try {
    const user = validateTelegramInitData(request.body?.initData || '', CUSTOMER_BOT_TOKEN);
    return { ok: true, user };
  } catch { return reply.code(401).send({ ok: false, error: 'Telegram authentication failed' }); }
});

async function authenticate(request: any): Promise<TelegramWebAppUser> {
  const initData = String(request.headers['x-telegram-init-data'] || '').trim();
  if (!initData) throw new Error('Telegram initData missing');
  return validateTelegramInitData(initData, CUSTOMER_BOT_TOKEN);
}

await registerBookingRoutes(app, authenticate);
await registerAdminRoutes(app, authenticate);

app.post<{ Body: { chatId?: number } }>('/api/telegram/customer/start', async (request, reply) => {
  if (!CUSTOMER_BOT_TOKEN || !MINI_APP_URL) return reply.code(503).send({ ok: false, error: 'Telegram bot is not configured' });
  const chatId = Number(request.body?.chatId);
  if (!Number.isSafeInteger(chatId)) return reply.code(400).send({ ok: false, error: 'Invalid chatId' });
  await sendCustomerStart(CUSTOMER_BOT_TOKEN, chatId, MINI_APP_URL);
  return { ok: true };
});

await app.listen({ port: PORT, host: '0.0.0.0' });
if (CUSTOMER_BOT_TOKEN && MINI_APP_URL) void startCustomerPolling(CUSTOMER_BOT_TOKEN, MINI_APP_URL);
else app.log.warn('CUSTOMER_BOT_TOKEN or MINI_APP_URL is missing; Telegram polling is disabled.');
