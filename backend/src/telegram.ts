import crypto from 'node:crypto';

const BOT_API = 'https://api.telegram.org';

function botUrl(token: string, method: string) {
  return `${BOT_API}/bot${token}/${method}`;
}

export type TelegramWebAppUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string;
};

export function validateTelegramInitData(initData: string, botToken: string, maxAgeSeconds = 3600): TelegramWebAppUser {
  if (!initData || !botToken) throw new Error('Telegram authentication data is missing');
  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!receivedHash || !Number.isFinite(authDate)) throw new Error('Invalid Telegram initData');
  const age = Math.floor(Date.now() / 1000) - authDate;
  if (age < -60 || age > maxAgeSeconds) throw new Error('Telegram initData expired');
  params.delete('hash');
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const a = Buffer.from(receivedHash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Telegram initData signature is invalid');
  const rawUser = params.get('user');
  if (!rawUser) throw new Error('Telegram user is missing');
  const user = JSON.parse(rawUser) as TelegramWebAppUser;
  if (!user.id) throw new Error('Telegram user id is missing');
  return user;
}

export async function telegramApi<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(botUrl(token, method), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json() as { ok: boolean; result?: T; description?: string };
  if (!data.ok) throw new Error(data.description || `Telegram API error: ${method}`);
  return data.result as T;
}

export async function sendMiniAppStart(token: string, chatId: number, miniAppUrl: string, role: 'customer' | 'instructor' | 'admin') {
  const config = {
    customer: {
      text: '🚗 AVTODROM\n\nBron qilish, instruktor tanlash va darslaringizni boshqarish uchun Mini Appni oching.',
      button: '🚗 Avtodromni ochish',
    },
    instructor: {
      text: '👨‍🏫 AVTODROM INSTRUKTOR\n\nBronlar, mijozlar va dars jarayonini boshqarish uchun Mini Appni oching.',
      button: '👨‍🏫 Instruktor panelini ochish',
    },
    admin: {
      text: '🛡️ AVTODROM ADMIN\n\nBronlar, instruktorlar, foydalanuvchilar, sharhlar va tizimni boshqaring.',
      button: '🛡️ Admin panelini ochish',
    },
  }[role];
  return telegramApi(token, 'sendMessage', {
    chat_id: chatId,
    text: config.text,
    reply_markup: { inline_keyboard: [[{ text: config.button, web_app: { url: miniAppUrl } }]] },
  });
}

export const sendCustomerStart = (token: string, chatId: number, miniAppUrl: string) => sendMiniAppStart(token, chatId, miniAppUrl, 'customer');
export const sendInstructorStart = (token: string, chatId: number, miniAppUrl: string) => sendMiniAppStart(token, chatId, miniAppUrl, 'instructor');
export const sendAdminStart = (token: string, chatId: number, miniAppUrl: string) => sendMiniAppStart(token, chatId, miniAppUrl, 'admin');

export async function sendBookingNotification(token: string, chatId: number, text: string, miniAppUrl?: string, buttonText = 'Mini Appni ochish') {
  return telegramApi(token, 'sendMessage', {
    chat_id: chatId,
    text,
    ...(miniAppUrl ? { reply_markup: { inline_keyboard: [[{ text: buttonText, web_app: { url: miniAppUrl } }]] } } : {}),
  });
}

type Update = { update_id: number; message?: { chat: { id: number }; text?: string } };

export async function startTelegramPolling(token: string, miniAppUrl: string, role: 'customer' | 'instructor' | 'admin') {
  if (!token || !miniAppUrl) throw new Error(`${role} Telegram bot is not configured`);
  let offset = 0;
  console.log(`Telegram ${role} bot polling started`);
  while (true) {
    try {
      const updates = await telegramApi<Update[]>(token, 'getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
      for (const update of updates || []) {
        offset = update.update_id + 1;
        const message = update.message;
        if (!message?.text) continue;
        if (/^\/start(?:@\w+)?(?:\s.*)?$/i.test(message.text.trim())) {
          await sendMiniAppStart(token, message.chat.id, miniAppUrl, role);
        }
      }
    } catch (error) {
      console.error(`Telegram ${role} polling error:`, error);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}
