import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { supabaseRest } from './supabase.js';

function q(value: string) { return encodeURIComponent(value); }
const COOKIE_NAME = 'avtodrom_admin_session';
const SESSION_TTL = 60 * 60 * 12;

function getCookie(request: any) {
  const raw = String(request.headers?.cookie || '');
  const item = raw.split(';').map((v: string) => v.trim()).find((v: string) => v.startsWith(COOKIE_NAME + '='));
  return item ? decodeURIComponent(item.slice(COOKIE_NAME.length + 1)) : '';
}
function makeToken(login: string) {
  const secret = String(process.env.ADMIN_SESSION_SECRET || '').trim();
  if (!secret) throw new Error('ADMIN_SESSION_SECRET sozlanmagan');
  const payload = `${login}:${Date.now()}`;
  const signature = createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(`${payload}:${signature}`).toString('base64url');
}
function validToken(token: string) {
  try {
    const secret = String(process.env.ADMIN_SESSION_SECRET || '').trim();
    if (!secret || !token) return false;
    const parts = Buffer.from(token, 'base64url').toString('utf8').split(':');
    if (parts.length < 3) return false;
    const login = parts[0]; const timestamp = Number(parts[1]); const signature = parts.slice(2).join(':');
    if (!login || !Number.isFinite(timestamp) || Date.now() - timestamp > SESSION_TTL * 1000) return false;
    const expected = createHmac('sha256', secret).update(`${login}:${timestamp}`).digest('hex');
    const a = Buffer.from(signature); const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch { return false; }
}
function setCookie(reply: any, token: string) { reply.header('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`); }
function clearCookie(reply: any) { reply.header('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`); }
async function guard(request: any) {
  if (!validToken(getCookie(request))) throw new Error('Admin login talab qilinadi');
}

export async function registerAdminPasswordRoutes(app: FastifyInstance) {
  app.post('/api/admin/login', async (request, reply) => {
    const body = (request.body || {}) as { login?: string; password?: string };
    const login = String(body.login || '').trim();
    const password = String(body.password || '');
    const expectedLogin = String(process.env.ADMIN_LOGIN || '').trim();
    const expectedPassword = String(process.env.ADMIN_PASSWORD || '');
    if (!expectedLogin || !expectedPassword || !process.env.ADMIN_SESSION_SECRET) return reply.code(500).send({ ok:false, error:'Admin auth environment sozlanmagan' });
    if (login !== expectedLogin || password !== expectedPassword) return reply.code(401).send({ ok:false, error:'Login yoki parol noto‘g‘ri' });
    setCookie(reply, makeToken(login));
    return { ok:true, login };
  });
  app.post('/api/admin/logout', async (_request, reply) => { clearCookie(reply); return { ok:true }; });
  app.get('/api/admin/me', async (request, reply) => { try { await guard(request); return {ok:true,login:process.env.ADMIN_LOGIN||'admin'}; } catch(e) { return reply.code(401).send({ok:false,error:e instanceof Error?e.message:'Unauthorized'}); } });

  app.get('/api/admin/stats', async (request, reply) => {
    try {
      await guard(request);
      const [profiles,instructors,bookings,reviews] = await Promise.all([
        supabaseRest<any[]>('profiles',{query:'?select=id,role,active'}),
        supabaseRest<any[]>('instructors',{query:'?select=id,active'}),
        supabaseRest<any[]>('bookings',{query:'?select=id,status,start_at'}),
        supabaseRest<any[]>('instructor_reviews',{query:'?select=id,status,rating'}),
      ]);
      const today=new Date(); const start=new Date(today); start.setHours(0,0,0,0); const end=new Date(today); end.setHours(24,0,0,0);
      const visible=reviews.filter(r=>r.status==='visible');
      const avg=visible.length?visible.reduce((s,r)=>s+Number(r.rating||0),0)/visible.length:0;
      return {ok:true,stats:{customers:profiles.filter(p=>p.role==='customer').length,activeCustomers:profiles.filter(p=>p.role==='customer'&&p.active!==false).length,instructors:instructors.filter(i=>i.active).length,pendingBookings:bookings.filter(b=>b.status==='pending').length,todayBookings:bookings.filter(b=>new Date(b.start_at)>=start&&new Date(b.start_at)<end).length,completedBookings:bookings.filter(b=>b.status==='completed').length,reviews:visible.length,averageRating:Number(avg.toFixed(2))}};
    } catch(e) { return reply.code(500).send({ok:false,error:e instanceof Error?e.message:'Stats failed'}); }
  });

  app.get('/api/admin/instructors',async(request,reply)=>{
    try{
      await guard(request);
      const instructors=await supabaseRest<any[]>('instructors',{query:'?select=id,active,created_at,profile:profile_id(id,telegram_id,first_name,last_name,username,phone,role,active)&order=created_at.desc'});
      const reviews=await supabaseRest<any[]>('instructor_reviews',{query:'?status=eq.visible&select=instructor_id,rating'});
      return {ok:true,instructors:instructors.map(i=>{const rs=reviews.filter(r=>r.instructor_id===i.id);return {...i,rating:rs.length?Number((rs.reduce((s,r)=>s+Number(r.rating),0)/rs.length).toFixed(2)):0,reviewCount:rs.length};})};
    }catch(e){return reply.code(500).send({ok:false,error:e instanceof Error?e.message:'Failed to load instructors'});}
  });

  app.post('/api/admin/instructors',async(request,reply)=>{
    try{
      await guard(request);
      const body=(request.body||{}) as {telegram_id?:number|string;first_name?:string;last_name?:string;phone?:string;username?:string};
      const telegramId=Number(body.telegram_id); const firstName=String(body.first_name||'').trim();
      if(!Number.isSafeInteger(telegramId)||telegramId===0)return reply.code(400).send({ok:false,error:'Telegram ID majburiy'});
      if(firstName.length<2)return reply.code(400).send({ok:false,error:'Ism majburiy'});
      const existing=await supabaseRest<any[]>('profiles',{query:`?telegram_id=eq.${q(String(telegramId))}&select=*`});
      let profile=existing[0];
      if(profile){
        const rows=await supabaseRest<any[]>('profiles',{method:'PATCH',headers:{Prefer:'return=representation'},query:`?id=eq.${q(profile.id)}`,body:JSON.stringify({first_name:firstName,last_name:String(body.last_name||'').trim()||null,phone:String(body.phone||'').trim()||null,username:String(body.username||'').trim()||null,role:'instructor',active:true,updated_at:new Date().toISOString()})});
        profile=rows[0]||profile;
      }else{
        const rows=await supabaseRest<any[]>('profiles',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({telegram_id:telegramId,first_name:firstName,last_name:String(body.last_name||'').trim()||null,phone:String(body.phone||'').trim()||null,username:String(body.username||'').trim()||null,role:'instructor',active:true})});
        profile=rows[0];
      }
      const old=await supabaseRest<any[]>('instructors',{query:`?profile_id=eq.${q(profile.id)}&select=*`});
      const instructor=old[0]|| (await supabaseRest<any[]>('instructors',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({profile_id:profile.id,active:true})}))[0];
      return reply.code(201).send({ok:true,profile,instructor});
    }catch(e){return reply.code(400).send({ok:false,error:e instanceof Error?e.message:'Instructor creation failed'});}
  });

  app.patch<{Params:{id:string};Body:{active?:boolean}}>('/api/admin/instructors/:id',async(request,reply)=>{try{await guard(request);const active=Boolean(request.body?.active);const rows=await supabaseRest<any[]>('instructors',{method:'PATCH',headers:{Prefer:'return=representation'},query:`?id=eq.${q(request.params.id)}`,body:JSON.stringify({active})});if(!rows[0])return reply.code(404).send({ok:false,error:'Instructor topilmadi'});const ins=rows[0];await supabaseRest('profiles',{method:'PATCH',query:`?id=eq.${q(ins.profile_id)}`,body:JSON.stringify({active,updated_at:new Date().toISOString()})});return{ok:true,instructor:ins};}catch(e){return reply.code(400).send({ok:false,error:e instanceof Error?e.message:'Instructor update failed'});}});

  app.get('/api/admin/bookings',async(request,reply)=>{try{await guard(request);const query=request.query as {status?:string};const parts=['select=*,customer:customer_id(id,first_name,last_name,username,phone,active),instructor:instructor_id(id,profile:profile_id(first_name,last_name,username,phone)),car:car_id(id,plate_number,model)','order=start_at.desc'];if(query.status)parts.push(`status=eq.${q(query.status)}`);return{ok:true,bookings:await supabaseRest<any[]>('bookings',{query:`?${parts.join('&')}`})};}catch(e){return reply.code(500).send({ok:false,error:e instanceof Error?e.message:'Failed to load bookings'});}});

  app.patch<{Params:{id:string};Body:{status:string;reason?:string}}>('/api/admin/bookings/:id/status',async(request,reply)=>{try{await guard(request);const allowed=['pending','confirmed','cancelled','in_progress','completed','no_show'];const body=request.body||{};if(!allowed.includes(body.status))return reply.code(400).send({ok:false,error:'Bron holati noto‘g‘ri'});const rows=await supabaseRest<any[]>('bookings',{method:'PATCH',headers:{Prefer:'return=representation'},query:`?id=eq.${q(request.params.id)}`,body:JSON.stringify({status:body.status,cancelled_reason:String(body.reason||'').trim()||null,updated_at:new Date().toISOString()})});if(!rows[0])return reply.code(404).send({ok:false,error:'Bron topilmadi'});return{ok:true,booking:rows[0]};}catch(e){return reply.code(400).send({ok:false,error:e instanceof Error?e.message:'Booking update failed'});}});

  app.get('/api/admin/customers',async(request,reply)=>{try{await guard(request);return{ok:true,customers:await supabaseRest<any[]>('profiles',{query:'?role=eq.customer&select=id,telegram_id,first_name,last_name,username,phone,active,created_at,updated_at&order=created_at.desc'})};}catch(e){return reply.code(500).send({ok:false,error:e instanceof Error?e.message:'Failed to load customers'});}});
  app.patch<{Params:{id:string};Body:{active?:boolean}}>('/api/admin/customers/:id',async(request,reply)=>{try{await guard(request);const rows=await supabaseRest<any[]>('profiles',{method:'PATCH',headers:{Prefer:'return=representation'},query:`?id=eq.${q(request.params.id)}&role=eq.customer`,body:JSON.stringify({active:Boolean(request.body?.active),updated_at:new Date().toISOString()})});if(!rows[0])return reply.code(404).send({ok:false,error:'Foydalanuvchi topilmadi'});return{ok:true,customer:rows[0]};}catch(e){return reply.code(400).send({ok:false,error:e instanceof Error?e.message:'Customer update failed'});}});

  app.get('/api/admin/reviews',async(request,reply)=>{try{await guard(request);const rows=await supabaseRest<any[]>('instructor_reviews',{query:'?select=*,customer:customer_id(first_name,last_name,username),instructor:instructor_id(id,profile:profile_id(first_name,last_name,username))&order=created_at.desc'});return{ok:true,reviews:rows};}catch(e){return reply.code(500).send({ok:false,error:e instanceof Error?e.message:'Failed to load reviews'});}});
  app.patch<{Params:{id:string};Body:{status?:string}}>('/api/admin/reviews/:id',async(request,reply)=>{try{await guard(request);const status=String(request.body?.status||'visible');if(!['visible','hidden','deleted'].includes(status))return reply.code(400).send({ok:false,error:'Sharh holati noto‘g‘ri'});const rows=await supabaseRest<any[]>('instructor_reviews',{method:'PATCH',headers:{Prefer:'return=representation'},query:`?id=eq.${q(request.params.id)}`,body:JSON.stringify({status,updated_at:new Date().toISOString()})});if(!rows[0])return reply.code(404).send({ok:false,error:'Sharh topilmadi'});return{ok:true,review:rows[0]};}catch(e){return reply.code(400).send({ok:false,error:e instanceof Error?e.message:'Review update failed'});}});

  app.get('/api/admin/pricing',async(request,reply)=>{try{await guard(request);const rows=await supabaseRest<any[]>('admin_settings',{query:'?key=in.(lesson_price,lesson_duration,booking_enabled,system_name)&select=key,value,updated_at'});const out:any={};for(const r of rows)out[r.key]=r.value;return{ok:true,settings:out};}catch(e){return reply.code(500).send({ok:false,error:e instanceof Error?e.message:'Pricing load failed'});}});
  app.put('/api/admin/pricing',async(request,reply)=>{try{await guard(request);const body=(request.body||{}) as {amount?:number;minutes?:number;booking_enabled?:boolean};const amount=Number(body.amount);const minutes=Number(body.minutes);if(!Number.isFinite(amount)||amount<0)return reply.code(400).send({ok:false,error:'Narx noto‘g‘ri'});if(!Number.isInteger(minutes)||minutes<15||minutes>240)return reply.code(400).send({ok:false,error:'Davomiylik 15-240 daqiqa oralig‘ida bo‘lsin'});const now=new Date().toISOString();const values=[{key:'lesson_price',value:{amount,currency:'UZS'},updated_at:now},{key:'lesson_duration',value:{minutes},updated_at:now},{key:'booking_enabled',value:{enabled:body.booking_enabled!==false},updated_at:now}];for(const item of values)await supabaseRest('admin_settings',{method:'POST',headers:{Prefer:'resolution=merge-duplicates'},body:JSON.stringify(item)});return{ok:true};}catch(e){return reply.code(400).send({ok:false,error:e instanceof Error?e.message:'Pricing update failed'});}});

  app.get('/api/admin/settings',async(request,reply)=>{try{await guard(request);const rows=await supabaseRest<any[]>('admin_settings',{query:'?select=key,value,updated_at&order=key.asc'});return{ok:true,settings:rows};}catch(e){return reply.code(500).send({ok:false,error:e instanceof Error?e.message:'Settings load failed'});}});
  app.put('/api/admin/settings/:key',async(request,reply)=>{try{await guard(request);const key=String((request.params as any).key||'').trim();if(!/^[a-z0-9_]+$/.test(key))return reply.code(400).send({ok:false,error:'Settings key noto‘g‘ri'});await supabaseRest('admin_settings',{method:'POST',headers:{Prefer:'resolution=merge-duplicates'},body:JSON.stringify({key,value:(request.body||{}),updated_at:new Date().toISOString()})});return{ok:true};}catch(e){return reply.code(400).send({ok:false,error:e instanceof Error?e.message:'Settings update failed'});}});
}
