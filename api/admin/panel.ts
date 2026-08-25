import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE='avtodrom_admin_session';
const TTL=60*60*12;
const BUCKET='customer-media';
const SUPA=()=>String(process.env.SUPABASE_URL||'').replace(/\/$/,'');
const KEY=()=>String(process.env.SUPABASE_SERVICE_ROLE_KEY||'');

function cookie(req:any){const raw=String(req.headers?.cookie||'');const item=raw.split(';').map((x:string)=>x.trim()).find((x:string)=>x.startsWith(`${COOKIE}=`));if(!item)return '';try{return decodeURIComponent(item.slice(COOKIE.length+1))}catch{return ''}}
function valid(token:string){try{const secret=String(process.env.ADMIN_SESSION_SECRET||process.env.ADMIN_PASSWORD||'').trim();const login=String(process.env.ADMIN_LOGIN||'').trim();if(!secret||!login||!token)return false;const d=Buffer.from(token,'base64url').toString('utf8');const a=d.indexOf(':'),b=d.indexOf(':',a+1);if(a<=0||b<=a)return false;const l=d.slice(0,a),ts=Number(d.slice(a+1,b)),sig=d.slice(b+1);if(l!==login||!Number.isFinite(ts)||!sig||Date.now()-ts<0||Date.now()-ts>TTL*1000)return false;const exp=createHmac('sha256',secret).update(`${login}:${ts}`).digest('hex');const x=Buffer.from(sig),y=Buffer.from(exp);return x.length===y.length&&timingSafeEqual(x,y)}catch{return false}}
function auth(req:any){let t=cookie(req);if(!t){const h=String(req.headers?.authorization||'');if(/^Bearer\s+/i.test(h))t=h.replace(/^Bearer\s+/i,'').trim()}if(!valid(t))throw new Error('Unauthorized')}
function json(res:any,status:number,data:any){res.statusCode=status;res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.end(JSON.stringify(data))}
async function rest(table:string,query:string,init:RequestInit={}){const url=SUPA(),key=KEY();if(!url||!key)throw new Error('Supabase server credentials are missing');const h=new Headers(init.headers);h.set('apikey',key);h.set('Authorization',`Bearer ${key}`);h.set('Content-Type','application/json');const r=await fetch(`${url}/rest/v1/${table}${query}`,{...init,headers:h});const text=await r.text();if(!r.ok)throw new Error(`Supabase ${r.status}`);return text?JSON.parse(text):[]}
async function safe(table:string,q:string){try{return await rest(table,q)}catch{return []}}
const publicUrl=(p:string)=>`${SUPA()}/storage/v1/object/public/${BUCKET}/${p}`;
function body(req:any){if(req.body&&typeof req.body==='object'&&!Buffer.isBuffer(req.body))return req.body;try{return JSON.parse(typeof req.body==='string'?req.body:'{}')}catch{return {}}}

export default async function handler(req:any,res:any){
  try{
    auth(req);
    const action=String(req.query?.action||'dashboard');
    if(req.method==='GET'&&action==='dashboard'){
      const [users,instructors,bookings,media]=await Promise.all([
        safe('tg_users','?select=tg_id'),safe('panel_users','?role=eq.instructor&select=id'),safe('bookings','?select=id,instructor_id,customer_id,date,time,duration,status,price,payment_status,tg_user_id,created_at&order=created_at.desc'),safe('admin_media','?select=*&order=created_at.desc')
      ]);const today=new Date().toISOString().slice(0,10);const todayRows=bookings.filter((x:any)=>String(x.date||'')===today);const revenue=todayRows.reduce((s:number,x:any)=>['paid','completed'].includes(String(x.payment_status||'').toLowerCase())?s+Number(x.price||0):s,0);return json(res,200,{ok:true,dashboard:{users:users.length,activeInstructors:instructors.length,pendingBookings:bookings.filter((x:any)=>x.status==='pending').length,todayBookings:todayRows.length,todayRevenue:revenue,media:media.length}})
    }
    if(req.method==='GET'&&action==='bookings')return json(res,200,{ok:true,bookings:await safe('bookings','?select=*&order=created_at.desc')});
    if(req.method==='GET'&&action==='users')return json(res,200,{ok:true,users:await safe('tg_users','?select=tg_id,first_name,username,customer_id,created_at&order=created_at.desc')});
    if(req.method==='GET'&&action==='instructors')return json(res,200,{ok:true,instructors:await safe('panel_users','?role=eq.instructor&select=id,instructor_id,email,created_at&order=created_at.desc')});
    if(req.method==='GET'&&action==='media'){const rows=await safe('admin_media','?select=*&order=created_at.desc');return json(res,200,{ok:true,media:rows.map((x:any)=>({...x,id:String(x.id),url:x.public_url||publicUrl(x.storage_path||'')}))})}
    if(req.method==='GET'&&action==='results'){const rows=await safe('bookings','?select=*&order=created_at.desc');return json(res,200,{ok:true,results:rows,summary:{total:rows.length,completed:rows.filter((x:any)=>x.status==='completed').length,revenue:rows.reduce((s:number,x:any)=>s+Number(x.price||0),0)}})}
    if(req.method==='GET'&&action==='prices'){const s=(await safe('app_state','?id=eq.main&select=data'))[0]?.data||{};return json(res,200,{ok:true,prices:Array.isArray(s.prices)?s.prices:[]})}
    if(req.method==='GET'&&action==='settings'){const s=(await safe('app_state','?id=eq.main&select=data'))[0]?.data||{};return json(res,200,{ok:true,settings:s.settings||{}})}
    if(req.method==='PATCH'&&action==='booking-status'){const b=body(req),id=encodeURIComponent(String(b.id||'')),status=String(b.status||'');if(!id||!['pending','confirmed','in_progress','completed','cancelled','no_show','rejected'].includes(status))return json(res,400,{ok:false,error:'Noto‘g‘ri bron holati'});const rows=await rest('bookings',`?id=eq.${id}`,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({status})});return json(res,200,{ok:true,booking:rows[0]})}
    if(req.method==='POST'&&action==='price'){const s=(await safe('app_state','?id=eq.main&select=data'))[0]||{data:{}};const prices=Array.isArray(s.data?.prices)?s.data.prices:[];const b=body(req);const item={id:`price-${Date.now()}`,name:String(b.name||'Xizmat'),duration_minutes:Number(b.duration_minutes||60),price:Number(b.price||0),status:'active'};prices.push(item);await rest('app_state','?id=eq.main',{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({data:{...(s.data||{}),prices},updated_at:new Date().toISOString()})});return json(res,200,{ok:true,price:item})}
    if(req.method==='PATCH'&&action==='settings'){const s=(await safe('app_state','?id=eq.main&select=data'))[0]||{data:{}};const settings={...(s.data?.settings||{}),...body(req)};await rest('app_state','?id=eq.main',{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({data:{...(s.data||{}),settings},updated_at:new Date().toISOString()})});return json(res,200,{ok:true,settings})}
    if(req.method==='POST'&&action==='sign'){const b=body(req),name=String(b.file_name||'video.mp4').replace(/[^a-zA-Z0-9._-]/g,'_'),type=String(b.content_type||'video/mp4').toLowerCase();if(!type.startsWith('video/'))return json(res,400,{ok:false,error:'Faqat video fayl yuklang'});const path=`customer/${Date.now()}-${Math.random().toString(36).slice(2,8)}-${name}`;const u=`${SUPA()}/storage/v1/object/upload/sign/${BUCKET}/${encodeURIComponent(path)}`;const r=await fetch(u,{method:'POST',headers:{apikey:KEY(),Authorization:`Bearer ${KEY()}`,'Content-Type':'application/json'},body:JSON.stringify({expiresIn:3600,upsert:true})});const d=await r.json().catch(()=>({}));if(!r.ok||!d.token)throw new Error(d.message||d.error||'Storage sign failed');return json(res,200,{ok:true,path,storage_path:path,token:d.token,upload_url:`${u}?token=${encodeURIComponent(d.token)}`,public_url:publicUrl(path)})}
    if(req.method==='POST'&&action==='commit'){const b=body(req);const rows=await rest('admin_media','',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({key:`admin_${Date.now()}`,title:String(b.title||'Video'),media_type:'video',storage_path:String(b.storage_path||''),public_url:String(b.public_url||''),is_active:true,sort_order:0,updated_at:new Date().toISOString()})});return json(res,200,{ok:true,media:rows[0]})}
    if(req.method==='DELETE'&&action==='media'){const id=encodeURIComponent(String(req.query?.id||''));if(!id)return json(res,400,{ok:false,error:'Media ID kerak'});await rest('admin_media',`?id=eq.${id}`,{method:'DELETE'});return json(res,200,{ok:true})}
    return json(res,404,{ok:false,error:'Admin action topilmadi'});
  }catch(e:any){const msg=e?.message||'Server xatosi';return json(res,msg==='Unauthorized'?401:500,{ok:false,error:msg})}
}
