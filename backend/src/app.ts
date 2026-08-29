import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { sendMiniAppStart, sendCustomerStart, sendInstructorStart, sendAdminStart, validateTelegramInitData, telegramApi, type TelegramWebAppUser } from './telegram.js';
import { registerBookingRoutes } from './booking-routes.js';
import { registerInstructorRoutes } from './instructor-routes.js';
import { registerInstructorRegistrationRoutes } from './instructor-registration-routes.js';
import { handleInstructorStart } from './instructor-start.js';
import { registerAdminPasswordRoutes } from './admin-password-routes.js';
import { registerContentRoutes } from './content-routes.js';

const app = Fastify({ logger: true });
const CUSTOMER_BOT_TOKEN = process.env.CUSTOMER_BOT_TOKEN || process.env.TELEGRAM_CUSTOMER_BOT_TOKEN || '';
const INSTRUCTOR_BOT_TOKEN = process.env.INSTRUCTOR_BOT_TOKEN || process.env.TELEGRAM_INSTRUCTOR_BOT_TOKEN || '';
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || process.env.TELEGRAM_ADMIN_BOT_TOKEN || '';
const CUSTOMER_MINI_APP_URL = process.env.CUSTOMER_MINI_APP_URL || process.env.MINI_APP_URL || 'https://avtodrom.vercel.app/';
const INSTRUCTOR_MINI_APP_URL = process.env.INSTRUCTOR_MINI_APP_URL || 'https://avtodrom.vercel.app/instructor';
const ADMIN_MINI_APP_URL = process.env.ADMIN_MINI_APP_URL || 'https://avtodrom.vercel.app/admin';
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';

await app.register(cors, { origin: process.env.FRONTEND_ORIGIN ? [process.env.FRONTEND_ORIGIN] : true, credentials: true });
await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
app.get('/api/health', async () => ({ ok: true, service: 'avtodrom-api', bots: { customer: Boolean(CUSTOMER_BOT_TOKEN), instructor: Boolean(INSTRUCTOR_BOT_TOKEN), admin: Boolean(ADMIN_BOT_TOKEN) }, supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) }));

function authenticateWithToken(botToken: string) {
  return async (request: any): Promise<TelegramWebAppUser> => {
    let initData = String(request.headers['x-telegram-init-data'] || '').trim();
    if (!initData) { const auth = String(request.headers.authorization || '').trim(); if (auth.toLowerCase().startsWith('tma ')) initData = auth.slice(4).trim(); }
    if (!initData && request.query?.initData) initData = String(request.query.initData).trim();
    if (!initData) throw new Error('Telegram initData missing');
    return validateTelegramInitData(initData, botToken);
  };
}

app.post<{ Body: { initData?: string } }>('/api/telegram/auth', async (request, reply) => {
  try { return { ok: true, user: validateTelegramInitData(request.body?.initData || '', CUSTOMER_BOT_TOKEN) }; }
  catch (e: any) { return reply.code(401).send({ ok: false, error: e?.message || 'Telegram authentication failed' }); }
});

export const authenticateCustomer = authenticateWithToken(CUSTOMER_BOT_TOKEN);
export const authenticateInstructor = authenticateWithToken(INSTRUCTOR_BOT_TOKEN);
export const authenticateAdmin = authenticateWithToken(ADMIN_BOT_TOKEN);

/**
 * Uch botning istalgan biri imzolagan initData'ni qabul qiladi.
 * Kerak, chunki bron holatini instruktor ham, admin ham o'zgartiradi —
 * ular turli botlardan keladi, bitta token bilan tekshirib bo'lmaydi.
 */
export const authenticateAnyBot = async (request: any) => {
  const tokens = [CUSTOMER_BOT_TOKEN, INSTRUCTOR_BOT_TOKEN, ADMIN_BOT_TOKEN].filter(Boolean);
  let last: unknown = null;
  for (const token of tokens) {
    try { return await authenticateWithToken(token)(request); } catch (e) { last = e; }
  }
  throw last instanceof Error ? last : new Error('Telegram authentication failed');
};

await registerBookingRoutes(app, authenticateCustomer, authenticateAnyBot);
await registerInstructorRoutes(app, authenticateInstructor);
await registerInstructorRegistrationRoutes(app, authenticateInstructor);

// IMPORTANT: admin-password-routes.ts is the single owner of the canonical
// /api/admin/* endpoints. Do not register admin-routes.ts or
// admin-dashboard-routes.ts here: they contain overlapping routes and cause
// Fastify FST_ERR_DUPLICATED_ROUTE during Vercel cold starts.
await registerAdminPasswordRoutes(app);
await registerContentRoutes(app);

async function handleTelegramWebhook(request: any, reply: any, token: string, miniAppUrl: string, role: 'customer' | 'admin') {
  const secret = String(request.headers['x-telegram-bot-api-secret-token'] || '');
  if (TELEGRAM_WEBHOOK_SECRET && secret !== TELEGRAM_WEBHOOK_SECRET) return reply.code(401).send({ ok: false, error: 'Invalid webhook secret' });
  if (!token || !miniAppUrl) return reply.code(503).send({ ok: false, error: `${role} bot is not configured` });
  const message = (request.body as any)?.message;
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  const chatId = Number(message?.chat?.id);
  if (Number.isSafeInteger(chatId) && chatId > 0 && /^\/start(?:@\w+)?(?:\s.*)?$/i.test(text)) await sendMiniAppStart(token, chatId, miniAppUrl, role);
  return { ok: true };
}

async function webhookDiagnostic(token: string, role: string, expectedUrl: string) {
  if (!token) return { configured: false, role, expected_url: expectedUrl, reason: 'bot token missing' };
  try { const info = await telegramApi<any>(token, 'getWebhookInfo', {}); return { configured: true, role, expected_url: expectedUrl, telegram: { url: info.url || '', pending_update_count: info.pending_update_count || 0, last_error_date: info.last_error_date || null, last_error_message: info.last_error_message || null } }; }
  catch (error: any) { return { configured: true, role, expected_url: expectedUrl, error: String(error?.message || error) }; }
}

app.get('/api/telegram/instructor/webhook', async () => webhookDiagnostic(INSTRUCTOR_BOT_TOKEN, 'instructor', 'https://avtodrom.vercel.app/api/telegram/instructor/webhook'));
app.get('/api/telegram/customer/webhook', async () => webhookDiagnostic(CUSTOMER_BOT_TOKEN, 'customer', 'https://avtodrom.vercel.app/api/telegram/customer/webhook'));
app.get('/api/telegram/admin/webhook', async () => webhookDiagnostic(ADMIN_BOT_TOKEN, 'admin', 'https://avtodrom.vercel.app/api/telegram/admin/webhook'));

app.post('/api/telegram/customer/webhook', async (request, reply) => handleTelegramWebhook(request, reply, CUSTOMER_BOT_TOKEN, CUSTOMER_MINI_APP_URL, 'customer'));
app.post('/api/telegram/instructor/webhook', async (request, reply) => {
  const secret = String(request.headers['x-telegram-bot-api-secret-token'] || '');
  if (TELEGRAM_WEBHOOK_SECRET && secret !== TELEGRAM_WEBHOOK_SECRET) return reply.code(401).send({ ok: false, error: 'Invalid webhook secret' });
  const message = (request.body as any)?.message;
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  const chatId = Number(message?.chat?.id);
  if (!INSTRUCTOR_BOT_TOKEN) return reply.code(503).send({ ok: false, error: 'Instructor bot is not configured' });
  if (Number.isSafeInteger(chatId) && chatId > 0 && /^\/start(?:@\w+)?(?:\s.*)?$/i.test(text)) await handleInstructorStart(INSTRUCTOR_BOT_TOKEN, chatId, { id: chatId, first_name: message?.from?.first_name, last_name: message?.from?.last_name, username: message?.from?.username }, INSTRUCTOR_MINI_APP_URL);
  return { ok: true };
});
app.post('/api/telegram/admin/webhook', async (request, reply) => handleTelegramWebhook(request, reply, ADMIN_BOT_TOKEN, ADMIN_MINI_APP_URL, 'admin'));

app.post<{ Body: { chatId?: number } }>('/api/telegram/customer/start', async (request, reply) => {
  const chatId = Number(request.body?.chatId);
  if (!CUSTOMER_BOT_TOKEN || !CUSTOMER_MINI_APP_URL) return reply.code(503).send({ ok: false, error: 'Customer bot is not configured' });
  if (!Number.isSafeInteger(chatId)) return reply.code(400).send({ ok: false, error: 'Invalid chatId' });
  await sendCustomerStart(CUSTOMER_BOT_TOKEN, chatId, CUSTOMER_MINI_APP_URL);
  return { ok: true };
});
app.post<{ Body: { chatId?: number } }>('/api/telegram/instructor/start', async (request, reply) => {
  const chatId = Number(request.body?.chatId);
  if (!INSTRUCTOR_BOT_TOKEN) return reply.code(503).send({ ok: false, error: 'Instructor bot is not configured' });
  if (!Number.isSafeInteger(chatId)) return reply.code(400).send({ ok: false, error: 'Invalid chatId' });
  await handleInstructorStart(INSTRUCTOR_BOT_TOKEN, chatId, { id: chatId }, INSTRUCTOR_MINI_APP_URL);
  return { ok: true };
});
app.post<{ Body: { chatId?: number } }>('/api/telegram/admin/start', async (request, reply) => {
  const chatId = Number(request.body?.chatId);
  if (!ADMIN_BOT_TOKEN || !ADMIN_MINI_APP_URL) return reply.code(503).send({ ok: false, error: 'Admin bot is not configured' });
  if (!Number.isSafeInteger(chatId)) return reply.code(400).send({ ok: false, error: 'Invalid chatId' });
  await sendAdminStart(ADMIN_BOT_TOKEN, chatId, ADMIN_MINI_APP_URL);
  return { ok: true };
});

export default app;
export { app };
