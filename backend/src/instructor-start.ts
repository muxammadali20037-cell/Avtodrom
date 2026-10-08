import { instructorRegistrationStatus } from './instructor-registration.js';
import { telegramApi, type TelegramWebAppUser } from './telegram.js';
import { MENU_KEYBOARD, ensureBotCommands } from './instructor-bot-menu.js';

function registrationUrl(miniAppUrl: string) {
  // The instructor Mini App already contains the registration screen.
  // Do not point Telegram to /register.html: that file does not exist in this repo.
  return miniAppUrl.replace(/\/$/, '') + '/';
}

export async function handleInstructorStart(token: string, chatId: number, user: TelegramWebAppUser, miniAppUrl: string) {
  const status = await instructorRegistrationStatus(user);
  if (status.status === 'APPROVED') {
    await ensureBotCommands(token);
    await telegramApi(token, 'sendMessage', {
      chat_id: chatId,
      text: '✅ Arizangiz tasdiqlangan. Instructor paneliga kirishingiz mumkin.\n\n📝 Bron yozish: mijoz raqami va vaqtni shu yerga yozing, masalan <code>901234567 14:00</code> yoki <code>ertaga 901234567 15-17</code>. Bekor qilish: <code>bekor 14:00</code>.',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '👨‍🏫 Instructor panelini ochish', web_app: { url: registrationUrl(miniAppUrl) } }]] }
    });
    /* Katalog — pastda doim turadigan tugmalar */
    return telegramApi(token, 'sendMessage', {
      chat_id: chatId,
      text: '📋 <b>Menyu</b> 👇\n\n📅 <b>Jadvalim</b> — kun rasmi va o‘quvchilar raqamlari\n📋 <b>Bronlarim</b> — soati bilan ro‘yxat, raqamni bosing — qo‘ng‘iroq qilasiz',
      parse_mode: 'HTML',
      reply_markup: MENU_KEYBOARD,
    });
  }
  if (status.status === 'PENDING') return telegramApi(token, 'sendMessage', {
    chat_id: chatId,
    text: '⏳ Arizangiz Admin tomonidan ko‘rib chiqilmoqda. Tasdiqlangandan keyin Instructor paneliga kirishingiz mumkin.'
  });
  if (status.status === 'REJECTED') return telegramApi(token, 'sendMessage', {
    chat_id: chatId,
    text: `❌ Arizangiz rad etilgan.${status.rejection_reason ? `\nSabab: ${status.rejection_reason}` : ''}\n\nQayta ariza yuborishingiz mumkin.`,
    reply_markup: { inline_keyboard: [[{ text: '📝 Qayta ariza yuborish', web_app: { url: registrationUrl(miniAppUrl) } }]] }
  });
  return telegramApi(token, 'sendMessage', {
    chat_id: chatId,
    text: '👋 Instructor bo‘lish uchun avval ro‘yxatdan o‘tish arizasini yuboring. Admin tasdiqlagandan keyin Instructor paneli ochiladi.',
    reply_markup: { inline_keyboard: [[{ text: '📝 Ro‘yxatdan o‘tish', web_app: { url: registrationUrl(miniAppUrl) } }]] }
  });
}
