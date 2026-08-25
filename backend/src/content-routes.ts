import type { FastifyInstance } from 'fastify';
import { supabaseRest, requireSupabase } from './supabase.js';
import { createHmac, timingSafeEqual } from 'node:crypto';

const ADMIN_COOKIE='avtodrom_admin_session';
const SESSION_TTL=60*60*12;
const BUCKET='customer-media';

function adminCookie(request:any){
  const raw=String(request.headers?.cookie||'');
  const item=raw.split(';').map((x:string)=>x.trim()).find((x:string)=>x.startsWith(`${ADMIN_COOKIE}=`));
  if(!item)return '';
  try{return decodeURIComponent(item.slice(ADMIN_COOKIE.length+1))}catch{return ''}
}
function validAdminSession(token:string){
  try{
    const fallback=String(process.env.ADMIN_PASSWORD||'').trim();
    const secret=String(process.env.ADMIN_SESSION_SECRET||fallback).trim();
    const loginExpected=String(process.env.ADMIN_LOGIN||'').trim();
    if(!secret||!token||!loginExpected)return false;
    const decoded=Buffer.from(token,'base64url').toString('utf8');
    const a=decoded.indexOf(':'),b=decoded.indexOf(':',a+1);
    if(a<=0||b<=a)return false;
    const login=decoded.slice(0,a),ts=Number(decoded.slice(a+1,b)),sig=decoded.slice(b+1);
    if(login!==loginExpected||!Number.isFinite(ts)||!sig)return false;
    const age=Date.now()-ts;
    if(age<0||age>SESSION_TTL*1000)return false;
    const expected=createHmac('sha256',secret).update(`${login}:${ts}`).digest('hex');
    const x=Buffer.from(sig),y=Buffer.from(expected);
    return x.length===y.length&&timingSafeEqual(x,y);
  }catch{return false}
}
function requireAdmin(request:any){if(!validAdminSession(adminCookie(request)))throw new Error('Unauthorized')}
function publicUrl(path:string){const url=String(process.env.SUPABASE_URL||'').trim();return `${url}/storage/v1/object/public/${BUCKET}/${path}`}

async function getMedia(){
  try{
    const rows=await supabaseRest<any[]>('admin_media',{query:'?select=*&order=created_at.desc'});
    return rows.map(x=>({...x,id:String(x.id),active:x.is_active!==false,public_url:x.public_url||publicUrl(x.storage_path||'')}));
  }catch{return[]}
}

export async function registerContentRoutes(app:FastifyInstance){
  app.get('/api/content',async()=>({ok:true,media:await getMedia()}));

  app.get('/api/results',async()=>{
    const safeCount=async(table:string,query:string)=>{try{return(await supabaseRest<any[]>(table,{query})).length}catch{return 0}};
    const [customers,instructors,completedBookings]=await Promise.all([
      safeCount('tg_users','?select=tg_id'),
      safeCount('panel_users','?role=eq.instructor&select=id'),
      safeCount('bookings','?status=eq.completed&select=id')
    ]);
    return{ok:true,stats:{customers,instructors,completedBookings,averageRating:0}};
  });

  app.post('/api/admin/content/storage/init',async(request,reply)=>{
    try{
      requireAdmin(request);requireSupabase();
      const url=String(process.env.SUPABASE_URL||''),key=String(process.env.SUPABASE_SERVICE_ROLE_KEY||'');
      const r=await fetch(`${url}/storage/v1/bucket`,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({id:BUCKET,name:BUCKET,public:true,file_size_limit:157286400,allowed_mime_types:['video/mp4','video/webm','video/quicktime','image/jpeg','image/png','image/webp']})});
      if(!r.ok&&r.status!==409){const d=await r.text();return reply.code(r.status).send({ok:false,error:d})}
      return{ok:true,bucket:BUCKET};
    }catch(e:any){return reply.code(401).send({ok:false,error:e?.message||'Unauthorized'})}
  });

  app.post('/api/admin/content/sign',async(request,reply)=>{
    try{
      requireAdmin(request);requireSupabase();
      const body=(request.body||{}) as any;
      const filename=String(body.filename||'').trim();
      const contentType=String(body.contentType||'video/mp4').trim().toLowerCase();
      if(!filename)return reply.code(400).send({ok:false,error:'filename required'});
      if(!/^video\/(mp4|webm|quicktime)$/.test(contentType))return reply.code(400).send({ok:false,error:'Faqat MP4, WebM yoki MOV video yuklash mumkin'});
      const safe=filename.replace(/[^a-zA-Z0-9._-]/g,'_');
      const path=`customer/${Date.now()}-${Math.random().toString(36).slice(2,8)}-${safe}`;
      const url=String(process.env.SUPABASE_URL||'');
      const key=String(process.env.SUPABASE_SERVICE_ROLE_KEY||'');
      const signUrl=`${url}/storage/v1/object/upload/sign/${BUCKET}/${encodeURIComponent(path)}`;
      const r=await fetch(signUrl,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({expiresIn:3600,upsert:true,contentType})});
      const data=await r.json().catch(()=>({}));
      if(!r.ok)return reply.code(r.status).send({ok:false,error:data?.message||data?.error||'Storage sign failed'});
      return{ok:true,path,token:data.token,upload_url:`${signUrl}?token=${encodeURIComponent(String(data.token||''))}`,public_url:publicUrl(path)};
    }catch(e:any){return reply.code(401).send({ok:false,error:e?.message||'Unauthorized'})}
  });

  app.post('/api/admin/content',async(request,reply)=>{
    try{
      requireAdmin(request);
      const body=(request.body||{}) as any;
      const public_url=String(body.public_url||'').trim();
      if(!public_url)return reply.code(400).send({ok:false,error:'public_url required'});
      const title=String(body.title||'Video qo‘llanma').trim();
      const description=String(body.description||'').trim();
      const mediaType=String(body.media_type||'video')==='image'?'image':'video';
      const storagePath=String(body.storage_path||'').trim()||public_url.split(`/storage/v1/object/public/${BUCKET}/`)[1]||'';
      const rows=await supabaseRest<any[]>('admin_media',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({key:`guide_video_${Date.now()}`,title,media_type:mediaType,storage_path:storagePath,public_url,is_active:body.active!==false,sort_order:0,updated_at:new Date().toISOString()})});
      return{ok:true,media:rows[0]};
    }catch(e:any){return reply.code(400).send({ok:false,error:e?.message||'Media saqlanmadi'})}
  });

  app.delete('/api/admin/content/:id',async(request,reply)=>{
    try{
      requireAdmin(request);
      const id=String((request.params as any).id||'');
      if(!id)return reply.code(400).send({ok:false,error:'Media ID kerak'});
      const rows=await supabaseRest<any[]>('admin_media',{method:'DELETE',headers:{Prefer:'return=representation'},query:`?id=eq.${encodeURIComponent(id)}&select=*`});
      if(!rows[0])return reply.code(404).send({ok:false,error:'Media topilmadi'});
      return{ok:true};
    }catch(e:any){return reply.code(400).send({ok:false,error:e?.message||'Media o‘chirilmadi'})}
  });
}
