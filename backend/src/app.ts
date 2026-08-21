import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { sendMiniAppStart, sendCustomerStart, sendInstructorStart, sendAdminStart, validateTelegramInitData, type TelegramWebAppUser } from './telegram.js';
import { registerBookingRoutes } from './booking-routes.js';
import { registerInstructorRoutes } from './instructor-routes.js';
import { registerInstructorRegistrationRoutes } from './instructor-registration-routes.js';
import { registerAdminInstructorRoutes } from './admin-instructor-routes.js';
import { handleInstructorStart } from './instructor-start.js';
import { registerAdminPasswordRoutes } from './admin-password-routes.js';

const app = Fastify({ logger: true });
const CUSTOMER_BOT_TOKEN = process.env.CUSTOMER_BOT_TOKEN || '';
const INSTRUCTOR_BOT_TOKEN = process.env.INSTRUCTOR_BOT_TOKEN || '';
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || '';
const CUSTOMER_MINI_APP_URL = process.env.CUSTOMER_MINI_APP_URL || process.env.MINI_APP_URL || '';
const INSTRUCTOR_MINI_APP_URL = process.env.INSTRUCTOR_MINI_APP_URL || '';
const ADMIN_MINI_APP_URL = process.env.ADMIN_MINI_APP_URL || '';
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';

await app.register(cors, { origin: process.env.FRONTEND_ORIGIN ? [process.env.FRONTEND_ORIGIN] : true, credentials: true });
await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
app.get('/api/health', async () => ({ ok:true, service:'avtodrom-api', bots:{customer:Boolean(CUSTOMER_BOT_TOKEN),instructor:Boolean(INSTRUCTOR_BOT_TOKEN),admin:Boolean(ADMIN_BOT_TOKEN)} }));

function authenticateWithToken(botToken:string){ return async(request:any):Promise<TelegramWebAppUser>=>{ const initData=String(request.headers['x-telegram-init-data']||'').trim(); if(!initData) throw new Error('Telegram initData missing'); return validateTelegramInitData(initData,botToken); }; }
app.post<{Body:{initData?:string}}>('/api/telegram/auth',async(request,reply)=>{try{return{ok:true,user:validateTelegramInitData(request.body?.initData||'',CUSTOMER_BOT_TOKEN)}}catch{return reply.code(401).send({ok:false,error:'Telegram authentication failed'})}});
export const authenticateCustomer=authenticateWithToken(CUSTOMER_BOT_TOKEN);
export const authenticateInstructor=authenticateWithToken(INSTRUCTOR_BOT_TOKEN);
export const authenticateAdmin=authenticateWithToken(ADMIN_BOT_TOKEN);

await registerBookingRoutes(app,authenticateCustomer);
await registerInstructorRoutes(app,authenticateInstructor);
await registerInstructorRegistrationRoutes(app,authenticateInstructor);
await registerAdminInstructorRoutes(app,authenticateAdmin);
await registerAdminPasswordRoutes(app);

async function handleTelegramWebhook(request:any,reply:any,token:string,miniAppUrl:string,role:'customer'|'admin'){
 const secret=String(request.headers['x-telegram-bot-api-secret-token']||'');
 if(TELEGRAM_WEBHOOK_SECRET&&secret!==TELEGRAM_WEBHOOK_SECRET)return reply.code(401).send({ok:false,error:'Invalid webhook secret'});
 if(!token||!miniAppUrl)return reply.code(503).send({ok:false,error:`${role} bot is not configured`});
 const message=(request.body as any)?.message; const text=typeof message?.text==='string'?message.text.trim():''; const chatId=Number(message?.chat?.id);
 if(Number.isSafeInteger(chatId)&&chatId>0&&/^\/start(?:@\w+)?(?:\s.*)?$/i.test(text)) await sendMiniAppStart(token,chatId,miniAppUrl,role);
 return {ok:true};
}
app.post('/api/telegram/customer/webhook',async(request,reply)=>handleTelegramWebhook(request,reply,CUSTOMER_BOT_TOKEN,CUSTOMER_MINI_APP_URL,'customer'));
app.post('/api/telegram/instructor/webhook',async(request,reply)=>{
 const secret=String(request.headers['x-telegram-bot-api-secret-token']||''); if(TELEGRAM_WEBHOOK_SECRET&&secret!==TELEGRAM_WEBHOOK_SECRET)return reply.code(401).send({ok:false,error:'Invalid webhook secret'});
 const message=(request.body as any)?.message; const text=typeof message?.text==='string'?message.text.trim():''; const chatId=Number(message?.chat?.id);
 if(!INSTRUCTOR_BOT_TOKEN||!INSTRUCTOR_MINI_APP_URL)return reply.code(503).send({ok:false,error:'Instructor bot is not configured'});
 if(Number.isSafeInteger(chatId)&&chatId>0&&/^\/start(?:@\w+)?(?:\s.*)?$/i.test(text)) await handleInstructorStart(INSTRUCTOR_BOT_TOKEN,chatId,{id:chatId,first_name:message?.from?.first_name,last_name:message?.from?.last_name,username:message?.from?.username},INSTRUCTOR_MINI_APP_URL);
 return {ok:true};
});
app.post('/api/telegram/admin/webhook',async(request,reply)=>handleTelegramWebhook(request,reply,ADMIN_BOT_TOKEN,ADMIN_MINI_APP_URL,'admin'));

app.post<{Body:{chatId?:number}}>('/api/telegram/customer/start',async(request,reply)=>{const chatId=Number(request.body?.chatId);if(!CUSTOMER_BOT_TOKEN||!CUSTOMER_MINI_APP_URL)return reply.code(503).send({ok:false,error:'Customer bot is not configured'});if(!Number.isSafeInteger(chatId))return reply.code(400).send({ok:false,error:'Invalid chatId'});await sendCustomerStart(CUSTOMER_BOT_TOKEN,chatId,CUSTOMER_MINI_APP_URL);return{ok:true}});
app.post<{Body:{chatId?:number}}>('/api/telegram/instructor/start',async(request,reply)=>{const chatId=Number(request.body?.chatId);if(!INSTRUCTOR_BOT_TOKEN||!INSTRUCTOR_MINI_APP_URL)return reply.code(503).send({ok:false,error:'Instructor bot is not configured'});if(!Number.isSafeInteger(chatId))return reply.code(400).send({ok:false,error:'Invalid chatId'});await handleInstructorStart(INSTRUCTOR_BOT_TOKEN,chatId,{id:chatId},INSTRUCTOR_MINI_APP_URL);return{ok:true}});
app.post<{Body:{chatId?:number}}>('/api/telegram/admin/start',async(request,reply)=>{const chatId=Number(request.body?.chatId);if(!ADMIN_BOT_TOKEN||!ADMIN_MINI_APP_URL)return reply.code(503).send({ok:false,error:'Admin bot is not configured'});if(!Number.isSafeInteger(chatId))return reply.code(400).send({ok:false,error:'Invalid chatId'});await sendAdminStart(ADMIN_BOT_TOKEN,chatId,ADMIN_MINI_APP_URL);return{ok:true}});

export default app;
export {app};
