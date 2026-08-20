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
  if (!token) throw new Error('Telegram bot token is missing');
  const response = await fetch(botUrl(token, method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json() as { ok: boolean; result?: T; description?: string };
  if (!data.ok) throw new Error(data.description || `Telegram API error: ${method}`);
  return data.result as T;
}

export async function sendTelegramMessage(token: string, chatId: number, text: string, miniAppUrl?: string) {
  const reply_markup = miniAppUrl
    ? { inline_keyboard: [[{ text: '🚗 Avtodrom Mini App', web_app: { url: miniAppUrl } }]] }
    : undefined;
  return telegramApi(token, 'sendMessage', { chat_id: chatId, text, reply_markup });
}

export async function sendCustomerStart(token: string, chatId: number, miniAppUrl: string) {
  return sendTelegramMessage(token, chatId, '🚗 Avtodrom\n\nBron qilish, instruktor tanlash va darslaringizni boshqarish uchun Mini Appni oching.', miniAppUrl);
}

export async function sendEventNotification(token: string, chatId: number | string | null | undefined, title: string, body: string, miniAppUrl?: string) {
  const id = Number(chatId);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  try {
    await sendTelegramMessage(token, id, `${title}\n\n${body}`, miniAppUrl);
    return true;
  } catch (error) {
    console.error('Telegram notification failed:', error);
    return false;
  }
}

type Update = { update_id: number; message?: { chat: { id: number }; text?: string } };

export async function startCustomerPolling(token: string, miniAppUrl: string) {
  let offset = 0;
  console.log('Telegram customer bot polling started');
  while (true) {
    try {
      const updates = await telegramApi<Update[]>(token, 'getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
      for (const update of updates || []) {
        offset = update.update_id + 1;
        const message = update.message;
        if (!message?.text) continue;
        if (/^\/start(?:@\w+)?(?:\s.*)?$/i.test(message.text.trim())) await sendCustomerStart(token, message.chat.id, miniAppUrl);
      }
    } catch (error) {
      console.error('Telegram polling error:', error);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}
