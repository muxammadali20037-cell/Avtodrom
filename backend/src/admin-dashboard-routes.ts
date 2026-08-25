import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { supabaseRest } from './supabase.js';

const COOKIE_NAME='avtodrom_admin_session';
const SESSION_TTL=60*60*12;
const SUPABASE_URL=String(process.env.SUPABASE_URL||'').trim();
const SERVICE_KEY=String(process.env.SUPABASE_SERVICE_ROLE_KEY||'').trim();
const BUCKET='customer-media';

function q(v:string){return encodeURIComponent(v)}
function getCookie(r:any){
  const raw=String(r.headers?.cookie??'');
  const item=raw.split(';').map((v:string)=>v.trim()).find((v:string)=>v.startsWith(`${COOKIE_NAME}=`));
  if(!item)return '';
  try{return decodeURIComponent(item.slice(COOKIE_NAME.length+1))}catch{return ''}
}
function validSession(token:string){
  try{
    const fallback=String(process.env.ADMIN_PASSWORD||'').trim();
    const secret=String(process.env.ADMIN_SESSION_SECRET||fallback).trim();
    const login=String(process.env.ADMIN_LOGIN||'').trim();
    if(!secret||!login||!token)return false;
    const decoded=Buffer.from(token,'base64url').toString('utf8');
    const a=decoded.indexOf(':'),b=decoded.indexOf(':',a+1);
    if(a<=0||b<=a)return false;
    const actual=decoded.slice(0,a),ts=Number(decoded.slice(a+1,b)),sig=decoded.slice(b+1);
    if(actual!==login||!Number.isFinite(ts)||!sig)return false;
    const age=Date.now()-ts;if(age<0||age>SESSION_TTL*1000)return false;
    const expected=createHmac('sha256',secret).update(`${login}:${ts}`).digest('hex');
    const x=Buffer.from(sig),y=Buffer.from(expected);
    return x.length===y.length&&timingSafeEqual(x,y);
  }catch{return false}
}
async function requireAdmin(r:any){if(!validSession(getCookie(r)))throw new Error('Unauthorized')}
async function safeRows<T=any>(table:string,query:string,options:any={}){try{return await supabaseRest<T[]>(table,{query,...options})}catch{return[] as T[]}}
function publicUrl(path:string){return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`}

async function getState(){
  const rows=await safeRows<any>('app_state','?id=eq.main&select=data,updated_at');
  return rows[0]||{data:{},updated_at:null};
}
async function saveState(data:any){
  const body=JSON.stringify({id:'main',data,updated_at:new Date().toISOString()});
  const rows=await supabaseRest<any[]>('app_state',{method:'PATCH',headers:{Prefer:'return=representation'},query:'?id=eq.main',body});
  if(rows[0])return rows[0];
  const created=await supabaseRest<any[]>('app_state',{method:'POST',headers:{Prefer:'return=representation'},body});
  return created[0];
}

export function registerAdminDashboardRoutes(app:FastifyInstance){
  app.get('/api/admin/dashboard',async(r,reply)=>{
    try{
      await requireAdmin(r);
      const [users,instructors,bookings,media]=await Promise.all([
        safeRows('tg_users','?select=tg_id,first_name,username,customer_id,created_at'),
        safeRows('panel_users','?role=eq.instructor&select=id,instructor_id,email,created_at'),
        safeRows('bookings','?select=id,instructor_id,customer_id,course_id,date,time,duration,status,price,deposit,payment_status,tg_user_id,created_at&order=created_at.desc'),
        safeRows('admin_media','?select=id,title,media_type,public_url,storage_path,is_active,created_at&order=created_at.desc')
      ]);
      const today=new Date().toISOString().slice(0,10);
      const pending=bookings.filter((x:any)=>String(x.status)==='pending').length;
      const todayBookings=bookings.filter((x:any)=>String(x.date||'')===today).length;
      const revenue=bookings.filter((x:any)=>['paid','completed'].includes(String(x.payment_status||'').toLowerCase())).reduce((s:number,x:any)=>s+Number(x.price||0),0);
      return {ok:true,dashboard:{users:users.length,activeInstructors:instructors.length,instructors:instructors.length,pendingBookings:pending,todayBookings,todayRevenue:revenue,revenue,media:media.length}};
    }catch(e:any){return reply.code(500).send({ok:false,error:e?.message||'Dashboard failed'})}
  });

  app.get('/api/admin/stats',async(r,reply)=>{
    try{
      await requireAdmin(r);
      const [users,instructors,bookings]=await Promise.all([
        safeRows('tg_users','?select=tg_id'),
        safeRows('panel_users','?role=eq.instructor&select=id'),
        safeRows('bookings','?select=id,date,status,price,payment_status')
      ]);
      const today=new Date().toISOString().slice(0,10);
      const todayRows=bookings.filter((x:any)=>String(x.date||'')===today);
      const ratings=0;
      const paid=todayRows.reduce((s:number,x:any)=>['paid','completed'].includes(String(x.payment_status||'').toLowerCase())?s+Number(x.price||0):s,0);
      return {ok:true,stats:{customers:users.length,users:users.length,instructors:instructors.length,activeInstructors:instructors.length,pendingBookings:bookings.filter((x:any)=>x.status==='pending').length,todayBookings:todayRows.length,completedBookings:bookings.filter((x:any)=>x.status==='completed').length,averageRating:ratings,todayRevenue:paid,revenue:paid}};
    }catch(e:any){return reply.code(500).send({ok:false,error:e?.message||'Stats failed'})}
  });

  app.get('/api/admin/bookings',async(r,reply)=>{
    try{await requireAdmin(r);const query=String((r.query as any)?.status||'');const rows=await safeRows<any>('bookings',`?select=*&order=created_at.desc${query?`&status=eq.${q(query)}`:''}`);return{ok:true,bookings:rows}}
    catch(e:any){return reply.code(500).send({ok:false,error:e?.message||'Bronlar yuklanmadi'})}
  });

  app.patch<{Params:{id:string};Body:{status:string;reason?:string}}>('/api/admin/bookings/:id/status',async(r,reply)=>{
    try{await requireAdmin(r);const allowed=['pending','confirmed','in_progress','completed','cancelled','no_show','rejected'];const status=String(r.body?.status||'');if(!allowed.includes(status))return reply.code(400).send({ok:false,error:'Noto‘g‘ri bron holati'});const rows=await supabaseRest<any[]>('bookings',{method:'PATCH',headers:{Prefer:'return=representation'},query:`?id=eq.${q(r.params.id)}`,body:JSON.stringify({status})});if(!rows[0])return reply.code(404).send({ok:false,error:'Bron topilmadi'});return{ok:true,booking:rows[0]}}
    catch(e:any){return reply.code(500).send({ok:false,error:e?.message||'Bron yangilanmadi'})}
  });

  app.get('/api/admin/customers',async(r,reply)=>{try{await requireAdmin(r);return{ok:true,customers:await safeRows('tg_users','?select=tg_id,first_name,username,customer_id,created_at&order=created_at.desc')}}catch(e:any){return reply.code(500).send({ok:false,error:e?.message||'Foydalanuvchilar yuklanmadi'})}});

  app.get('/api/admin/instructors',async(r,reply)=>{try{await requireAdmin(r);return{ok:true,instructors:await safeRows('panel_users','?role=eq.instructor&select=id,instructor_id,email,created_at&order=created_at.desc')}}catch(e:any){return reply.code(500).send({ok:false,error:e?.message||'Instruktorlar yuklanmadi'})}});

  app.get('/api/admin/applications',async(r,reply)=>{try{await requireAdmin(r);return{ok:true,applications:await safeRows('instructor_applications','?select=*&order=created_at.desc')}}catch{ return {ok:true,applications:[]} }});
  app.post('/api/admin/applications/:id/approve',async(r,reply)=>{try{await requireAdmin(r);return{ok:false,error:'Instructor ariza jadvali hozircha ulanmagan'}}catch(e:any){return reply.code(401).send({ok:false,error:e?.message||'Unauthorized'})}});
  app.post('/api/admin/applications/:id/reject',async(r,reply)=>{try{await requireAdmin(r);return{ok:false,error:'Instructor ariza jadvali hozircha ulanmagan'}}catch(e:any){return reply.code(401).send({ok:false,error:e?.message||'Unauthorized'})}});

  app.get('/api/admin/reviews',async(r,reply)=>{try{await requireAdmin(r);return{ok:true,reviews:[]}}catch(e:any){return reply.code(401).send({ok:false,error:e?.message||'Unauthorized'})}});

  app.get('/api/admin/results',async(r,reply)=>{
    try{await requireAdmin(r);const rows=await safeRows<any>('bookings','?select=*&order=created_at.desc');const revenue=rows.reduce((s:number,x:any)=>s+Number(x.price||0),0);return{ok:true,results:rows,summary:{total:rows.length,completed:rows.filter((x:any)=>x.status==='completed').length,revenue}}}
    catch(e:any){return reply.code(500).send({ok:false,error:e?.message||'Natijalar yuklanmadi'})}
  });

  app.get('/api/admin/prices',async(r,reply)=>{try{await requireAdmin(r);const state=await getState();const prices=Array.isArray(state.data?.prices)?state.data.prices:[];return{ok:true,prices}}catch(e:any){return reply.code(500).send({ok:false,error:e?.message||'Narxlar yuklanmadi'})}});
  app.get('/api/admin/tariffs',async(r,reply)=>{try{await requireAdmin(r);const state=await getState();return{ok:true,tariffs:Array.isArray(state.data?.prices)?state.data.prices:[]}}catch(e:any){return reply.code(500).send({ok:false,error:e?.message||'Tariflar yuklanmadi'})}});
  app.post('/api/admin/prices',async(r,reply)=>{try{await requireAdmin(r);const state=await getState();const prices=Array.isArray(state.data?.prices)?state.data.prices:[];const item={id:`price-${Date.now()}`,...(r.body as any),status:'active'};prices.push(item);await saveState({...state.data,prices});return{ok:true,price:item}}catch(e:any){return reply.code(500).send({ok:false,error:e?.message||'Narx saqlanmadi'})}});
  app.patch('/api/admin/prices/:id',async(r,reply)=>{try{await requireAdmin(r);const state=await getState();const prices=Array.isArray(state.data?.prices)?state.data.prices:[];const i=prices.findIndex((x:any)=>String(x.id)===String((r.params as any).id));if(i<0)return reply.code(404).send({ok:false,error:'Narx topilmadi'});prices[i]={...prices[i],...(r.body as any)};await saveState({...state.data,prices});return{ok:true,price:prices[i]}}catch(e:any){return reply.code(500).send({ok:false,error:e?.message||'Narx yangilanmadi'})}});

  app.get('/api/admin/settings',async(r,reply)=>{try{await requireAdmin(r);return{ok:true,settings:(await getState()).data?.settings||{}}}catch(e:any){return reply.code(500).send({ok:false,error:e?.message||'Sozlamalar yuklanmadi'})}});
  app.patch('/api/admin/settings',async(r,reply)=>{try{await requireAdmin(r);const state=await getState();const settings={...(state.data?.settings||{}),...(r.body as any)};await saveState({...state.data,settings});return{ok:true,settings}}catch(e:any){return reply.code(500).send({ok:false,error:e?.message||'Sozlamalar saqlanmadi'})}});

  app.get('/api/admin/media',async(r,reply)=>{try{await requireAdmin(r);const rows=await safeRows<any>('admin_media','?select=*&order=created_at.desc');return{ok:true,media:rows.map(x=>({...x,id:String(x.id),type:x.media_type,url:x.public_url||publicUrl(x.storage_path||''),active:x.is_active!==false}))}}catch(e:any){return reply.code(500).send({ok:false,error:e?.message||'Media yuklanmadi'})}});
  app.post('/api/admin/media',async(r,reply)=>{try{await requireAdmin(r);const b:any=r.body||{};const rows=await supabaseRest<any[]>('admin_media',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({key:`admin_${Date.now()}`,title:String(b.title||'Media'),media_type:String(b.type||b.media_type||'video'),storage_path:String(b.storage_path||''),public_url:String(b.url||b.public_url||''),is_active:true,sort_order:0})});return{ok:true,media:rows[0]}}catch(e:any){return reply.code(400).send({ok:false,error:e?.message||'Media saqlanmadi'})}});
  app.delete('/api/admin/media/:id',async(r,reply)=>{try{await requireAdmin(r);await supabaseRest<any[]>('admin_media',{method:'DELETE',headers:{Prefer:'return=representation'},query:`?id=eq.${q(String((r.params as any).id))}`});return{ok:true}}catch(e:any){return reply.code(400).send({ok:false,error:e?.message||'Media o‘chirilmadi'})}});
  app.post('/api/admin/media/sign',async(r,reply)=>{try{await requireAdmin(r);if(!SUPABASE_URL||!SERVICE_KEY)return reply.code(500).send({ok:false,error:'Supabase server credentials are missing'});const b:any=r.body||{};const name=String(b.file_name||b.filename||'video.mp4').replace(/[^a-zA-Z0-9._-]/g,'_');const type=String(b.content_type||b.contentType||'video/mp4').toLowerCase();if(!type.startsWith('video/'))return reply.code(400).send({ok:false,error:'Faqat video fayl yuklang'});const path=`customer/${Date.now()}-${Math.random().toString(36).slice(2,8)}-${name}`;const client=createClient(SUPABASE_URL,SERVICE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});const {data,error}=await client.storage.from(BUCKET).createSignedUploadUrl(path,{upsert:true});if(error||!data?.token)throw new Error(error?.message||'Signed upload URL yaratilmadi');return{ok:true,path,storage_path:path,token:data.token,upload_url:`${SUPABASE_URL}/storage/v1/object/upload/sign/${BUCKET}/${encodeURIComponent(path)}?token=${encodeURIComponent(data.token)}`,public_url:publicUrl(path)}}catch(e:any){return reply.code(400).send({ok:false,error:e?.message||'Upload tayyorlashda xato'})}});
  app.post('/api/admin/media/commit',async(r,reply)=>{try{await requireAdmin(r);const b:any=r.body||{};const rows=await supabaseRest<any[]>('admin_media',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({key:`admin_${Date.now()}`,title:String(b.title||'Video'),media_type:'video',storage_path:String(b.storage_path||b.path||''),public_url:String(b.public_url||''),is_active:true,sort_order:0})});return{ok:true,media:rows[0]}}catch(e:any){return reply.code(400).send({ok:false,error:e?.message||'Video ma’lumotini saqlashda xato'})}});
}
