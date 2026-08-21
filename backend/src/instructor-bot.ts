import { telegramApi } from './telegram.js';
import { instructorRegistrationStatus, sendInstructorStatusMessage, submitInstructorRegistration } from './instructor-registration.js';

export async function handleInstructorUpdate(token:string, update:any, miniAppUrl:string) {
  const message=update?.message;
  const chatId=Number(message?.chat?.id);
  const text=typeof message?.text==='string'?message.text.trim():'';
  if(!Number.isSafeInteger(chatId) || chatId<=0) return;

  if(/^\/start(?:@\w+)?(?:\s.*)?$/i.test(text)) {
    const status=await instructorRegistrationStatus({id:chatId,first_name:message.from?.first_name,last_name:message.from?.last_name,username:message.from?.username});
    if(status.status==='APPROVED') {
      await telegramApi(token,'sendMessage',{chat_id:chatId,text:'✅ Sizning Instructor profilingiz tasdiqlangan. Mini Appni oching.',reply_markup:{inline_keyboard:[[ {text:'👨‍🏫 Instructor Mini Appni ochish',web_app:{url:miniAppUrl}} ]]}});
    } else if(status.status==='PENDING') {
      await telegramApi(token,'sendMessage',{chat_id:chatId,text:'⏳ Arizangiz Admin tomonidan ko‘rib chiqilmoqda. Tasdiqlangandan keyin Mini Appga kirishingiz mumkin.'});
    } else if(status.status==='REJECTED') {
      await telegramApi(token,'sendMessage',{chat_id:chatId,text:`❌ Arizangiz tasdiqlanmadi.${status.rejection_reason?`\nSabab: ${status.rejection_reason}`:''}\n\nQuyidagi tugma orqali qayta ariza yuboring.`,reply_markup:{inline_keyboard:[[ {text:'📝 Qayta ariza yuborish',web_app:{url:`${miniAppUrl}?register=1`}} ]]}});
    } else {
      await telegramApi(token,'sendMessage',{chat_id:chatId,text:'👋 Instructor bo‘lish uchun avval ariza yuboring. Mini App ichida ism, familiya va telefon raqamingizni kiriting.',reply_markup:{inline_keyboard:[[ {text:'📝 Instructor bo‘lish uchun ariza',web_app:{url:`${miniAppUrl}?register=1`}} ]]}});
    }
  }
}

export async function notifyInstructorApproval(application:any) {
  if(application?.telegram_user_id) await sendInstructorStatusMessage(Number(application.telegram_user_id),'APPROVED');
}
