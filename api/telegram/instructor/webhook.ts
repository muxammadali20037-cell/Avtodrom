import { handleInstructorStart } from '../../../backend/src/instructor-start.js';
import { telegramApi } from '../../../backend/src/telegram.js';

const BOT_TOKEN = process.env.INSTRUCTOR_BOT_TOKEN || '';
const MINI_APP_URL = process.env.INSTRUCTOR_MINI_APP_URL || 'https://avtodrom.vercel.app/instructor';
const WEBHOOK_URL = 'https://avtodrom.vercel.app/api/telegram/instructor/webhook';

function sendJson(response: any, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

export default async function handler(request: any, response: any) {
  try {
    if (request.method === 'GET') {
      if (!BOT_TOKEN) return sendJson(response, 503, { ok: false, role: 'instructor', error: 'INSTRUCTOR_BOT_TOKEN missing' });
      const info = await telegramApi<any>(BOT_TOKEN, 'getWebhookInfo', {});
      return sendJson(response, 200, {
        configured: true,
        role: 'instructor',
        expected_url: WEBHOOK_URL,
        telegram: {
          url: info?.url || '',
          pending_update_count: info?.pending_update_count || 0,
          last_error_date: info?.last_error_date || null,
          last_error_message: info?.last_error_message || null
        }
      });
    }

    if (request.method !== 'POST') {
      return sendJson(response, 405, { ok: false, error: 'Method not allowed' });
    }

    if (!BOT_TOKEN) {
      return sendJson(response, 503, { ok: false, error: 'INSTRUCTOR_BOT_TOKEN missing' });
    }

    let update = request.body;
    if (typeof update === 'string') {
      try { update = JSON.parse(update); } catch { return sendJson(response, 400, { ok: false, error: 'Invalid JSON body' }); }
    }

    const message = update?.message;
    const text = typeof message?.text === 'string' ? message.text.trim() : '';
    const chatId = Number(message?.chat?.id);

    if (Number.isSafeInteger(chatId) && chatId > 0 && /^\/start(?:@\w+)?(?:\s.*)?$/i.test(text)) {
      await handleInstructorStart(
        BOT_TOKEN,
        chatId,
        {
          id: chatId,
          first_name: message?.from?.first_name,
          last_name: message?.from?.last_name,
          username: message?.from?.username
        },
        MINI_APP_URL
      );
    }

    return sendJson(response, 200, { ok: true });
  } catch (error: any) {
    console.error('Instructor webhook failed:', error);
    return sendJson(response, 200, { ok: false, error: String(error?.message || error) });
  }
}
