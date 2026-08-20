import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { sendCustomerStart, sendTelegramMessage, sendEventNotification, telegramApi, answerTelegramCallback, editTelegramMessage, validateTelegramInitData, type TelegramWebAppUser } from './telegram.js';
import { registerBookingRoutes } from './booking-routes.js';
import { registerInstructorRoutes } from './instructor-routes.js';
import { registerAdminPasswordRoutes } from './admin-password-routes.js';
import { supabaseRest } from './supabase.js';

const app = Fastify({ logger: true });
const CUSTOMER_BOT_TOKEN = process.env.CUSTOMER_BOT_TOKEN || '';
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || '';
const MINI_APP_URL = process.env.MINI_APP_URL || '';
const ADMIN_TELEGRAM_CHAT_IDS = String(process.env.ADMIN_TELEGRAM_CHAT_IDS || '').split(',').map(v => Number(v.trim())).filter(v => Number.isSafeInteger(v) && v > 0);
const TELEGRAM_WEBHOOK_SECRET = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();

await app.register(cors, { origin: process.env.FRONTEND_ORIGIN ? [process.env.FRONTEND_ORIGIN] : true, credentials: true });
await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
app.get('/api/health', async () => ({ ok: true, service: 'avtodrom-api' }));

app.post<{ Body: { initData?: string } }>('/api/telegram/auth', async (request, reply) => { try { return { ok:true, user:validateTelegramInitData(request.body?.initData||'',CUSTOMER_BOT_TOKEN) }; } catch { return reply.code(401).send({ok:false,error:'Telegram authentication failed'}); } });
export async function authenticate(request:any):Promise<TelegramWebAppUser>{const initData=String(request.headers['x-telegram-init-data']||'').trim();if(!initData)throw new Error('Telegram initData missing');return validateTelegramInitData(initData,CUSTOMER_BOT_TOKEN);}

function webhookAuthorized(request:any){ return !TELEGRAM_WEBHOOK_SECRET || String(request.headers['x-telegram-bot-api-secret-token']||'')===TELEGRAM_WEBHOOK_SECRET; }
function adminAuthorized(chatId:number){ return ADMIN_TELEGRAM_CHAT_IDS.includes(chatId); }
async function notifyInstructor(userId:string,title:string,body:string){
  if(!CUSTOMER_BOT_TOKEN)return;
  const users=await supabaseRest<any[]>('users',{query:`?id=eq.${encodeURIComponent(userId)}&select=telegram_id`});
  const chatId=Number(users[0]?.telegram_id); if(Number.isSafeInteger(chatId)&&chatId>0) await sendEventNotification(CUSTOMER_BOT_TOKEN,chatId,title,body,MINI_APP_URL);
}

app.post('/api/telegram/admin/webhook', async (request:any, reply:any) => {
  if (!webhookAuthorized(request)) return reply.code(401).send({ok:false,error:'Invalid Telegram webhook secret'});
  if (!ADMIN_BOT_TOKEN) return reply.code(503).send({ok:false,error:'ADMIN_BOT_TOKEN is not configured'});
  try {
    const update=request.body||{};
    if(update.message?.chat?.id){
      const chatId=Number(update.message.chat.id);
      if(!adminAuthorized(chatId)) return {ok:true};
      const text=String(update.message.text||'').trim();
      if(/^\/start(?:@\w+)?$/i.test(text)){
        await sendTelegramMessage(ADMIN_BOT_TOKEN,chatId,'🛡️ Avtodrom Admin Bot\n\nAdmin xabarnomalari shu yerga keladi. Instruktor arizalari va bronlarni shu bot orqali tasdiqlashingiz mumkin.',MINI_APP_URL);
      }
      return {ok:true};
    }
    const callback=update.callback_query;
    if(!callback?.message?.chat?.id||!callback?.data) return {ok:true};
    const chatId=Number(callback.message.chat.id);
    if(!adminAuthorized(chatId)){await answerTelegramCallback(ADMIN_BOT_TOKEN,String(callback.id),'Ruxsat yo‘q',true);return {ok:true};}
    const data=String(callback.data);
    const match=data.match(/^(approve_instructor|reject_instructor):([0-9a-fA-F-]+)$/);
    if(!match){await answerTelegramCallback(ADMIN_BOT_TOKEN,String(callback.id),'Noma’lum amal',true);return {ok:true};}
    const action=match[1], instructorId=match[2];
    const profiles=await supabaseRest<any[]>('instructor_profiles',{query:`?id=eq.${encodeURIComponent(instructorId)}&select=*`});
    const profile=profiles[0];
    if(!profile){await answerTelegramCallback(ADMIN_BOT_TOKEN,String(callback.id),'Instruktor topilmadi',true);return {ok:true};}
    const users=await supabaseRest<any[]>('users',{query:`?id=eq.${encodeURIComponent(profile.user_id)}&select=*`});
    const user=users[0]; if(!user){await answerTelegramCallback(ADMIN_BOT_TOKEN,String(callback.id),'Foydalanuvchi topilmadi',true);return {ok:true};}
    const approved=action==='approve_instructor';
    await supabaseRest('instructor_profiles',{method:'PATCH',headers:{Prefer:'return=minimal'},query:`?id=eq.${encodeURIComponent(instructorId)}`,body:JSON.stringify({is_verified:approved,is_available:approved,updated_at:new Date().toISOString()})});
    await supabaseRest('users',{method:'PATCH',headers:{Prefer:'return=minimal'},query:`?id=eq.${encodeURIComponent(profile.user_id)}`,body:JSON.stringify({is_active:approved,is_blocked:!approved,role:'instructor',updated_at:new Date().toISOString()})});
    await supabaseRest('notifications',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({user_id:user.id,type:approved?'INSTRUCTOR_APPROVED':'INSTRUCTOR_REJECTED',title:approved?'Instruktor arizasi tasdiqlandi':'Instruktor arizasi rad etildi',message:approved?'Sizning instruktorlik arizangiz tasdiqlandi.':'Sizning instruktorlik arizangiz rad etildi.',telegram_sent:false,is_read:false})});
    await notifyInstructor(user.id,approved?'🎉 Instruktorlik arizangiz tasdiqlandi':'❌ Instruktorlik arizangiz rad etildi',approved?'Tabriklaymiz! Admin sizni tasdiqladi. Endi Instructor Panelga kirishingiz mumkin.':'Afsuski, admin arizangizni tasdiqlamadi. Batafsil ma’lumot uchun admin bilan bog‘laning.');
    await answerTelegramCallback(ADMIN_BOT_TOKEN,String(callback.id),approved?'Instruktor tasdiqlandi ✅':'Instruktor rad etildi ❌',false);
    const oldText=String(callback.message.text||'');
    await editTelegramMessage(ADMIN_BOT_TOKEN,chatId,Number(callback.message.message_id),`${oldText}\n\n${approved?'✅ TASDIQLANDI':'❌ RAD ETILDI'}`);
    return {ok:true};
  } catch(e){ request.log.error(e); return reply.code(200).send({ok:true}); }
});

await registerBookingRoutes(app, authenticate);
await registerInstructorRoutes(app, authenticate);
await registerAdminPasswordRoutes(app);
app.post<{Body:{chatId?:number}}>('/api/telegram/customer/start',async(request,reply)=>{if(!CUSTOMER_BOT_TOKEN||!MINI_APP_URL)return reply.code(503).send({ok:false,error:'Telegram bot is not configured'});const chatId=Number(request.body?.chatId);if(!Number.isSafeInteger(chatId))return reply.code(400).send({ok:false,error:'Invalid chatId'});await sendCustomerStart(CUSTOMER_BOT_TOKEN,chatId,MINI_APP_URL);return{ok:true};});
export default app;
export { app };
