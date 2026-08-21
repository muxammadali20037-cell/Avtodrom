import { instructorRegistrationStatus } from './instructor-registration.js';
import { telegramApi, type TelegramWebAppUser } from './telegram.js';

export async function handleInstructorStart(token: string, chatId: number, user: TelegramWebAppUser, miniAppUrl: string) {
  const status = await instructorRegistrationStatus(user);
  if (status.status === 'APPROVED') return telegramApi(token, 'sendMessage', { chat_id: chatId, text: '✅ Arizangiz tasdiqlangan. Instructor paneliga kirishingiz mumkin.', reply_markup: { inline_keyboard: [[{ text: '👨‍🏫 Instructor panelini ochish', web_app: { url: miniAppUrl } }]] } });
  if (status.status === 'PENDING') return telegramApi(token, 'sendMessage', { chat_id: chatId, text: '⏳ Arizangiz Admin tomonidan ko‘rib chiqilmoqda. Tasdiqlangandan keyin Instructor paneliga kirishingiz mumkin.' });
  if (status.status === 'REJECTED') return telegramApi(token, 'sendMessage', { chat_id: chatId, text: `❌ Arizangiz rad etilgan.${status.rejection_reason ? `\nSabab: ${status.rejection_reason}` : ''}\n\nQayta ariza yuborishingiz mumkin.`, reply_markup: { inline_keyboard: [[{ text: '📝 Qayta ariza yuborish', web_app: { url: `${miniAppUrl}?register=1` } }]] } });
  return telegramApi(token, 'sendMessage', { chat_id: chatId, text: '👋 Instructor bo‘lish uchun avval ro‘yxatdan o‘tish arizasini yuboring. Admin tasdiqlagandan keyin panel ochiladi.', reply_markup: { inline_keyboard: [[{ text: '📝 Ro‘yxatdan o‘tish', web_app: { url: `${miniAppUrl}?register=1` } }]] } });
}
