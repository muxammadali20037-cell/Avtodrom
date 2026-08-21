import { telegramApi, type TelegramWebAppUser } from './telegram.js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const INSTRUCTOR_BOT_TOKEN = process.env.INSTRUCTOR_BOT_TOKEN || process.env.TELEGRAM_INSTRUCTOR_BOT_TOKEN || '';
const INSTRUCTOR_MINI_APP_URL = process.env.INSTRUCTOR_MINI_APP_URL || 'https://avtodrom.vercel.app/instructor';

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase server credentials are missing');
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.message || data?.hint || data?.error || 'Supabase RPC error');
  return data as T;
}

export async function instructorRegistrationStatus(user: TelegramWebAppUser) {
  const rows = await rpc<Array<{status:string;first_name:string;last_name:string;rejection_reason:string|null}>>(
    'get_instructor_registration_status', { p_telegram_user_id: user.id }
  );
  return rows[0] || { status: 'NOT_REGISTERED', first_name: user.first_name || '', last_name: user.last_name || '', rejection_reason: null };
}

export async function submitInstructorRegistration(user: TelegramWebAppUser, body: { firstName:string; lastName:string; phone:string; experienceYears?:number; message?:string }) {
  return rpc('submit_instructor_application', {
    p_telegram_user_id: user.id,
    p_first_name: body.firstName,
    p_last_name: body.lastName,
    p_phone: body.phone,
    p_experience_years: body.experienceYears ?? null,
    p_message: body.message ?? null,
  });
}

export async function sendInstructorStatusMessage(chatId: number, status: 'APPROVED'|'REJECTED', reason?: string) {
  if (!INSTRUCTOR_BOT_TOKEN) return;
  const text = status === 'APPROVED'
    ? '✅ Arizangiz Admin tomonidan tasdiqlandi! Endi Instructor Mini Appni ochib ishlatishingiz mumkin.'
    : `❌ Arizangiz hozircha tasdiqlanmadi.${reason ? `\n\nSabab: ${reason}` : ''}\n\nMa’lumotlaringizni to‘g‘rilab qayta ariza yuborishingiz mumkin.`;
  await telegramApi(INSTRUCTOR_BOT_TOKEN, 'sendMessage', {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: [[{ text: '👨‍🏫 Instructor Mini App', web_app: { url: INSTRUCTOR_MINI_APP_URL } }]] },
  });
}
