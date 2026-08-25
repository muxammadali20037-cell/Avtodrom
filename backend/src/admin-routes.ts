import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { supabaseRest } from './supabase.js';
import type { TelegramWebAppUser } from './telegram.js';

const COOKIE_NAME = 'avtodrom_admin_session';
const SESSION_TTL = 60 * 60 * 12;
function q(value: string) { return encodeURIComponent(value); }
function getCookie(request: any): string {
  const raw = String(request.headers?.cookie ?? '');
  const item = raw.split(';').map((v: string) => v.trim()).find((v: string) => v.startsWith(`${COOKIE_NAME}=`));
  if (!item) return '';
  try { return decodeURIComponent(item.slice(COOKIE_NAME.length + 1)); } catch { return ''; }
}
function validAdminSession(token: string): boolean {
  try {
    const fallback = String(process.env.ADMIN_PASSWORD ?? '').trim();
    const secret = String(process.env.ADMIN_SESSION_SECRET ?? fallback).trim();
    const expectedLogin = String(process.env.ADMIN_LOGIN ?? '').trim();
    if (!secret || !token || !expectedLogin) return false;
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const first = decoded.indexOf(':'); const second = decoded.indexOf(':', first + 1);
    if (first <= 0 || second <= first) return false;
    const login = decoded.slice(0, first); const timestamp = Number(decoded.slice(first + 1, second));
    const signature = decoded.slice(second + 1);
    if (login !== expectedLogin || !Number.isFinite(timestamp) || !signature) return false;
    const age = Date.now() - timestamp;
    if (age < 0 || age > SESSION_TTL * 1000) return false;
    const expected = createHmac('sha256', secret).update(`${login}:${timestamp}`).digest('hex');
    const a = Buffer.from(signature); const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch { return false; }
}
async function requireAdminSession(request: any) { if (!validAdminSession(getCookie(request))) throw new Error('Unauthorized'); }
async function setting(key: string) {
  const rows = await supabaseRest<any[]>('admin_settings', { query: `?key=eq.${q(key)}&select=key,value,updated_at` });
  return rows[0] || null;
}
async function saveSetting(key: string, value: unknown) {
  const rows = await supabaseRest<any[]>('admin_settings', { method: 'PATCH', headers: { Prefer: 'return=representation' }, query: `?key=eq.${q(key)}`, body: JSON.stringify({ value, updated_at: new Date().toISOString() }) });
  if (rows[0]) return rows[0];
  const created = await supabaseRest<any[]>('admin_settings', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }) });
  return created[0];
}
async function adminDbUser() {
  const login = String(process.env.ADMIN_LOGIN || 'admin').trim();
  let rows = await supabaseRest<any[]>('users', { query: `?role=eq.admin&is_active=eq.true&is_blocked=eq.false&select=*&limit=1` });
  if (rows[0]) return rows[0];
  rows = await supabaseRest<any[]>('users', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ full_name: login, role: 'admin', is_active: true, is_blocked: false }) });
  return rows[0];
}

export async function registerAdminRoutes(app: FastifyInstance, _authenticate: (request: any) => Promise<TelegramWebAppUser>) {
  app.get('/api/admin/me', async (request, reply) => { try { await requireAdminSession(request); return { ok: true, login: String(process.env.ADMIN_LOGIN || '').trim() }; } catch (e) { return reply.code(401).send({ ok:false, error:e instanceof Error?e.message:'Unauthorized' }); } });
  app.post('/api/admin/logout', async (_request, reply) => { reply.header('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`); return { ok:true }; });

  app.get('/api/admin/stats', async (request, reply) => {
    try {
      await requireAdminSession(request);
      const [customers, instructors, bookings, reviews, payments] = await Promise.all([
        supabaseRest<any[]>('profiles', { query:'?role=eq.customer&select=id' }),
        supabaseRest<any[]>('instructor_profiles', { query:'?select=id,is_available,rating,total_reviews' }),
        supabaseRest<any[]>('bookings', { query:'?select=id,status,start_at,booking_date,price' }),
        supabaseRest<any[]>('reviews', { query:'?status=eq.approved&select=rating' }),
        supabaseRest<any[]>('payments', { query:'?status=eq.paid&select=amount,paid_at,created_at' })
      ]);
      const start = new Date(); start.setHours(0,0,0,0); const end = new Date(start); end.setDate(end.getDate()+1);
      const todayBookings = bookings.filter(b => { const d = new Date(b.start_at || b.booking_date || b.created_at); return d >= start && d < end; });
      const ratings = reviews.map(r=>Number(r.rating)).filter(Number.isFinite);
      const paidToday = payments.filter(p=>{const d=new Date(p.paid_at||p.created_at);return d>=start&&d<end;}).reduce((s,p)=>s+Number(p.amount||0),0);
      return { ok:true, stats:{ customers:customers.length, instructors:instructors.filter(i=>i.is_available).length, pendingBookings:bookings.filter(b=>b.status==='pending').length, todayBookings:todayBookings.length, completedBookings:bookings.filter(b=>b.status==='completed').length, averageRating:ratings.length?Number((ratings.reduce((a,b)=>a+b,0)/ratings.length).toFixed(2)):0, paidToday } };
    } catch(e) { console.error('Admin stats failed:',e); return reply.code(500).send({ok:false,error:e instanceof Error?e.message:'Stats failed'}); }
  });

  app.get('/api/admin/instructors', async (request, reply) => {
    try { await requireAdminSession(request); const rows=await supabaseRest<any[]>('instructor_profiles',{query:'?select=id,user_id,bio,experience_years,rating,total_reviews,is_verified,is_available,created_at,updated_at,profile:user_id(id,telegram_id,phone,full_name,role,is_active,is_blocked)&order=created_at.desc'}); return {ok:true,instructors:rows.map(x=>({...x,active:Boolean(x.is_available)}))}; }
    catch(e){console.error('Admin instructors failed:',e);return reply.code(500).send({ok:false,error:e instanceof Error?e.message:'Failed to load instructors'});}
  });
  app.patch<{Params:{id:string};Body:{active?:boolean;bio?:string;experience_years?:number;is_verified?:boolean}}>('/api/admin/instructors/:id',async(request,reply)=>{
    try { await requireAdminSession(request); const body=request.body||{}; const patch:any={updated_at:new Date().toISOString()}; if(body.active!==undefined)patch.is_available=Boolean(body.active); if(body.bio!==undefined)patch.bio=String(body.bio||'').trim()||null; if(body.experience_years!==undefined)patch.experience_years=Math.max(0,Number(body.experience_years||0)); if(body.is_verified!==undefined)patch.is_verified=Boolean(body.is_verified); const rows=await supabaseRest<any[]>('instructor_profiles',{method:'PATCH',headers:{Prefer:'return=representation'},query:`?id=eq.${q(request.params.id)}`,body:JSON.stringify(patch)}); if(!rows[0])return reply.code(404).send({ok:false,error:'Instruktor topilmadi'}); return {ok:true,instructor:{...rows[0],active:Boolean(rows[0].is_available)}}; }
    catch(e){return reply.code(500).send({ok:false,error:e instanceof Error?e.message:'Instructor update failed'});}
  });

  app.get('/api/admin/bookings',async(request,reply)=>{
    try { await requireAdminSession(request); const query=request.query as {status?:string}; const parts=['select=*','order=start_at.desc']; if(query.status)parts.push(`status=eq.${q(query.status)}`); const bookings=await supabaseRest<any[]>('bookings',{query:`?${parts.join('&')}`});
      const customerIds=[...new Set(bookings.map(b=>String(b.customer_id)).filter(Boolean))]; const instructorIds=[...new Set(bookings.map(b=>String(b.instructor_id)).filter(Boolean))];
      const customers=customerIds.length?await supabaseRest<any[]>('profiles',{query:`?id=in.(${customerIds.map(q).join(',')})&select=id,telegram_id,first_name,last_name,phone,username`}):[];
      const instructors=instructorIds.length?await supabaseRest<any[]>('instructors',{query:`?id=in.(${instructorIds.map(q).join(',')})&select=*`}):[];
      const customerMap=new Map(customers.map(x=>[String(x.id),x])); const instructorMap=new Map(instructors.map(x=>[String(x.id),x]));
      return {ok:true,bookings:bookings.map(b=>({...b,customer:customerMap.get(String(b.customer_id))||null,instructor:instructorMap.get(String(b.instructor_id))||null}))};
    } catch(e){console.error('Admin bookings failed:',e);return reply.code(500).send({ok:false,error:e instanceof Error?e.message:'Failed to load bookings'});}
  });
  app.patch<{Params:{id:string};Body:{status:string;reason?:string}}>('/api/admin/bookings/:id/status',async(request,reply)=>{
    try { await requireAdminSession(request); const status=String(request.body?.status||''); if(!['pending','confirmed','rejected','cancelled','completed','in_progress','no_show'].includes(status))return reply.code(400).send({ok:false,error:'Noto‘g‘ri bron holati'}); const patch:any={status,updated_at:new Date().toISOString()}; if(status==='confirmed')patch.confirmed_at=new Date().toISOString(); if(status==='cancelled'||status==='rejected'){patch.cancelled_at=new Date().toISOString();patch.cancelled_reason=String(request.body?.reason||'').trim()||null;} const rows=await supabaseRest<any[]>('bookings',{method:'PATCH',headers:{Prefer:'return=representation'},query:`?id=eq.${q(request.params.id)}`,body:JSON.stringify(patch)}); if(!rows[0])return reply.code(404).send({ok:false,error:'Bron topilmadi'}); return {ok:true,booking:rows[0]}; }
    catch(e){return reply.code(500).send({ok:false,error:e instanceof Error?e.message:'Booking update failed'});}
  });

  app.get('/api/admin/customers',async(request,reply)=>{try{await requireAdminSession(request);return {ok:true,customers:await supabaseRest<any[]>('profiles',{query:'?role=eq.customer&select=id,telegram_id,first_name,last_name,username,phone,role,created_at&order=created_at.desc'})};}catch(e){return reply.code(500).send({ok:false,error:e instanceof Error?e.message:'Failed to load customers'});}});

  app.get('/api/admin/reviews',async(request,reply)=>{try{await requireAdminSession(request);return {ok:true,reviews:await supabaseRest<any[]>('reviews',{query:'?select=*&order=created_at.desc'})};}catch(e){return reply.code(500).send({ok:false,error:e instanceof Error?e.message:'Failed to load reviews'});}});
  app.patch<{Params:{id:string};Body:{status:string}}>('/api/admin/reviews/:id',async(request,reply)=>{try{await requireAdminSession(request);const status=String(request.body?.status||'');if(!['pending','approved','rejected','visible','hidden'].includes(status))return reply.code(400).send({ok:false,error:'Noto‘g‘ri sharh holati'});const rows=await supabaseRest<any[]>('reviews',{method:'PATCH',headers:{Prefer:'return=representation'},query:`?id=eq.${q(request.params.id)}`,body:JSON.stringify({status,updated_at:new Date().toISOString()})});return {ok:true,review:rows[0]};}catch(e){return reply.code(500).send({ok:false,error:e instanceof Error?e.message:'Review update failed'});}});

  const applicationsHandler=async(request:any,reply:any)=>{try{await requireAdminSession(request);return {ok:true,applications:await supabaseRest<any[]>('instructor_applications',{query:'?select=*&order=created_at.desc'})};}catch(e){return reply.code(500).send({ok:false,error:e instanceof Error?e.message:'Failed to load applications'});}};
  app.get('/api/admin/applications',applicationsHandler);
  app.get('/api/admin/instructor-applications',applicationsHandler);
  const approve=async(request:any,reply:any)=>{try{await requireAdminSession(request);const admin=await adminDbUser();const id=String(request.params.id);const rows=await supabaseRest<any[]>('rpc/admin_approve_instructor',{method:'POST',body:JSON.stringify({p_application_id:id,p_admin_id:admin.id})});return {ok:true,application:Array.isArray(rows)?rows[0]:rows};}catch(e){console.error('Approve instructor failed:',e);return reply.code(400).send({ok:false,error:e instanceof Error?e.message:'Tasdiqlash amalga oshmadi'});}};
  const reject=async(request:any,reply:any)=>{try{await requireAdminSession(request);const admin=await adminDbUser();const id=String(request.params.id);const reason=String(request.body?.reason||'').trim()||null;const rows=await supabaseRest<any[]>('rpc/admin_reject_instructor',{method:'POST',body:JSON.stringify({p_application_id:id,p_admin_id:admin.id,p_reason:reason})});return {ok:true,application:Array.isArray(rows)?rows[0]:rows};}catch(e){return reply.code(400).send({ok:false,error:e instanceof Error?e.message:'Rad etish amalga oshmadi'});}};
  app.post('/api/admin/applications/:id/approve',approve); app.post('/api/admin/applications/:id/reject',reject);
  app.post('/api/admin/instructor-applications/:id/approve',approve); app.post('/api/admin/instructor-applications/:id/reject',reject);

  app.get('/api/admin/courses',async(request,reply)=>{try{await requireAdminSession(request);return {ok:true,courses:await supabaseRest<any[]>('courses',{query:'?select=*&order=created_at.desc'})};}catch(e){return reply.code(500).send({ok:false,error:e instanceof Error?e.message:'Failed to load courses'});}});
  app.post('/api/admin/courses',async(request,reply)=>{try{await requireAdminSession(request);const body=(request.body||{}) as Record<string,unknown>;const name=String(body.name||'').trim();const duration=Number(body.duration_minutes||60);const price=Number(body.price||0);if(!name)return reply.code(400).send({ok:false,error:'Mashg‘ulot nomi majburiy'});const rows=await supabaseRest<any[]>('courses',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({name,description:String(body.description||'').trim()||null,duration_minutes:duration,price,is_active:true})});return reply.code(201).send({ok:true,course:rows[0]});}catch(e){return reply.code(500).send({ok:false,error:e instanceof Error?e.message:'Course creation failed'});}});
  app.patch<{Params:{id:string};Body:{is_active?:boolean}}>('/api/admin/courses/:id',async(request,reply)=>{try{await requireAdminSession(request);const rows=await supabaseRest<any[]>('courses',{method:'PATCH',headers:{Prefer:'return=representation'},query:`?id=eq.${q(request.params.id)}`,body:JSON.stringify({is_active:Boolean(request.body?.is_active)})});return {ok:true,course:rows[0]};}catch(e){return reply.code(500).send({ok:false,error:e instanceof Error?e.message:'Course update failed'});}});
  app.get('/api/admin/payments',async(request,reply)=>{try{await requireAdminSession(request);return {ok:true,payments:await supabaseRest<any[]>('payments',{query:'?select=*&order=created_at.desc'})};}catch(e){return reply.code(500).send({ok:false,error:e instanceof Error?e.message:'Failed to load payments'});}});
  app.patch<{Params:{id:string};Body:{status:string}}>('/api/admin/payments/:id',async(request,reply)=>{try{await requireAdminSession(request);const status=String(request.body?.status||'');const rows=await supabaseRest<any[]>('payments',{method:'PATCH',headers:{Prefer:'return=representation'},query:`?id=eq.${q(request.params.id)}`,body:JSON.stringify({status,paid_at:status==='paid'?new Date().toISOString():null})});return {ok:true,payment:rows[0]};}catch(e){return reply.code(500).send({ok:false,error:e instanceof Error?e.message:'Payment update failed'});}});

  app.get('/api/admin/pricing',async(request,reply)=>{try{await requireAdminSession(request);const keys=await Promise.all(['lesson_price','lesson_duration','booking_enabled'].map(setting));return {ok:true,settings:Object.fromEntries(keys.filter(Boolean).map((x:any)=>[x.key,x.value]))};}catch(e){return reply.code(500).send({ok:false,error:e instanceof Error?e.message:'Failed to load pricing'});}});
  app.put('/api/admin/pricing',async(request,reply)=>{try{await requireAdminSession(request);const body=(request.body||{}) as Record<string,unknown>;await Promise.all([saveSetting('lesson_price',{amount:Math.max(0,Number(body.amount||0)),currency:'UZS'}),saveSetting('lesson_duration',{minutes:Math.max(15,Number(body.minutes||60))}),saveSetting('booking_enabled',{enabled:body.booking_enabled!==false})]);return {ok:true};}catch(e){return reply.code(500).send({ok:false,error:e instanceof Error?e.message:'Pricing update failed'});}});
  app.get('/api/admin/settings',async(request,reply)=>{try{await requireAdminSession(request);return {ok:true,settings:await supabaseRest<any[]>('admin_settings',{query:'?select=key,value,updated_at&order=key.asc'})};}catch(e){return reply.code(500).send({ok:false,error:e instanceof Error?e.message:'Failed to load settings'});}});
  app.get('/api/admin/audit-logs',async(request,reply)=>{try{await requireAdminSession(request);return {ok:true,logs:[]};}catch(e){return reply.code(500).send({ok:false,error:e instanceof Error?e.message:'Failed to load audit logs'});}});
}
