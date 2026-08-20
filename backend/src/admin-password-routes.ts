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
      const [profiles,instructors,bookings,cars] = await Promise.all([
        supabaseRest<any[]>('profiles',{query:'?select=id,role'}),
        supabaseRest<any[]>('instructors',{query:'?select=id,active'}),
        supabaseRest<any[]>('bookings',{query:'?select=id,status,start_at'}),
        supabaseRest<any[]>('cars',{query:'?select=id,active'})
      ]);
      const today=new Date(); const start=new Date(today); start.setHours(0,0,0,0); const end=new Date(today); end.setHours(24,0,0,0);
      return {ok:true,stats:{customers:profiles.filter(p=>p.role==='customer').length,instructors:instructors.filter(i=>i.active).length,pendingBookings:bookings.filter(b=>b.status==='pending').length,todayBookings:bookings.filter(b=>new Date(b.start_at)>=start&&new Date(b.start_at)<end).length,completedBookings:bookings.filter(b=>b.status==='completed').length,activeCars:cars.filter(c=>c.active).length}};
    } catch(e) { return reply.code(401).send({ok:false,error:e instanceof Error?e.message:'Stats failed'}); }
  });
  app.get('/api/admin/instructors',async(request,reply)=>{try{await guard(request);return{ok:true,instructors:await supabaseRest<any[]>('instructors',{query:'?select=id,active,created_at,profile:profile_id(id,telegram_id,first_name,last_name,username,phone,role)&order=created_at.desc'})};}catch(e){return reply.code(401).send({ok:false,error:e instanceof Error?e.message:'Failed to load instructors'});}});
  app.patch<{Params:{id:string};Body:{active?:boolean}}>('/api/admin/instructors/:id',async(request,reply)=>{try{await guard(request);const rows=await supabaseRest<any[]>('instructors',{method:'PATCH',headers:{Prefer:'return=representation'},query:`?id=eq.${q(request.params.id)}`,body:JSON.stringify({active:Boolean(request.body?.active)})});if(!rows[0])return reply.code(404).send({ok:false,error:'Instructor topilmadi'});return{ok:true,instructor:rows[0]};}catch(e){return reply.code(401).send({ok:false,error:e instanceof Error?e.message:'Instructor update failed'});}});
  app.get('/api/admin/bookings',async(request,reply)=>{try{await guard(request);const query=request.query as {status?:string};const parts=['select=*,customer:customer_id(id,first_name,last_name,username,phone),instructor:instructor_id(id,profile:profile_id(first_name,last_name,username)),car:car_id(id,plate_number,model)','order=start_at.desc'];if(query.status)parts.push(`status=eq.${q(query.status)}`);return{ok:true,bookings:await supabaseRest<any[]>('bookings',{query:`?${parts.join('&')}`})};}catch(e){return reply.code(401).send({ok:false,error:e instanceof Error?e.message:'Failed to load bookings'});}});
  app.get('/api/admin/customers',async(request,reply)=>{try{await guard(request);return{ok:true,customers:await supabaseRest<any[]>('profiles',{query:'?role=eq.customer&select=id,telegram_id,first_name,last_name,username,phone,created_at&order=created_at.desc'})};}catch(e){return reply.code(401).send({ok:false,error:e instanceof Error?e.message:'Failed to load customers'});}});
  app.get('/api/admin/cars',async(request,reply)=>{try{await guard(request);return{ok:true,cars:await supabaseRest<any[]>('cars',{query:'?select=*&order=created_at.desc'})};}catch(e){return reply.code(401).send({ok:false,error:e instanceof Error?e.message:'Failed to load cars'});}});
  app.post('/api/admin/cars',async(request,reply)=>{try{await guard(request);const body=(request.body||{}) as {plate_number?:string;model?:string};const plate=String(body.plate_number||'').trim().toUpperCase();const model=String(body.model||'').trim();if(!plate||!model)return reply.code(400).send({ok:false,error:'Raqam va rusum majburiy'});const rows=await supabaseRest<any[]>('cars',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({plate_number:plate,model,active:true})});return reply.code(201).send({ok:true,car:rows[0]});}catch(e){return reply.code(401).send({ok:false,error:e instanceof Error?e.message:'Car creation failed'});}});
}
