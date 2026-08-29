import { createHmac, timingSafeEqual } from 'node:crypto';
import { supabaseRest } from '../../../backend/src/supabase.js';

const COOKIE='avtodrom_admin_session', TTL=60*60*12;
function cookie(req:any){const raw=String(req.headers?.cookie||'');const x=raw.split(';').map((v:string)=>v.trim()).find((v:string)=>v.startsWith(COOKIE+'='));if(!x)return '';try{return decodeURIComponent(x.slice(COOKIE.length+1))}catch{return ''}}
function valid(t:string){try{const secret=String(process.env.ADMIN_SESSION_SECRET||process.env.ADMIN_PASSWORD||'').trim(),expected=String(process.env.ADMIN_LOGIN||'').trim();const d=Buffer.from(t||'','base64url').toString('utf8'),a=d.indexOf(':'),b=d.indexOf(':',a+1);if(!secret||!expected||a<=0||b<=a)return false;const login=d.slice(0,a),ts=Number(d.slice(a+1,b)),sig=d.slice(b+1);if(login!==expected||!Number.isFinite(ts)||Date.now()-ts<0||Date.now()-ts>TTL*1000)return false;const e=createHmac('sha256',secret).update(`${login}:${ts}`).digest('hex');const x=Buffer.from(sig),y=Buffer.from(e);return x.length===y.length&&timingSafeEqual(x,y)}catch{return false}}

export default async function handler(req:any,res:any){
  try{
    if(!valid(cookie(req))){res.statusCode=401;res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:false,error:'Admin login talab qilinadi'}));return}
    const admins=await supabaseRest<any[]>('users',{query:'?role=eq.admin&is_active=eq.true&is_blocked=eq.false&select=id&limit=1'});const admin=admins[0];
    if(!admin){res.statusCode=403;res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:false,error:'Admin topilmadi'}));return}
    if(req.method==='GET'){
      const rows=await supabaseRest<any[]>('community_messages',{query:'?select=id,sender_user_id,sender_role,message,created_at&order=created_at.asc&limit=500'});
      res.statusCode=200;res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,messages:rows}));return;
    }
    if(req.method==='POST'){
      const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});const text=String(body.message||body.text||'').trim();
      if(!text||text.length>4000){res.statusCode=400;res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:false,error:'Xabar 1-4000 belgi bo‘lishi kerak'}));return}
      const rows=await supabaseRest<any[]>('community_messages',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({sender_user_id:admin.id,sender_role:'admin',message:text})});
      res.statusCode=201;res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,message:rows[0]||null}));return;
    }
    res.statusCode=405;res.setHeader('allow','GET, POST');res.end(JSON.stringify({ok:false,error:'Method not allowed'}));
  }catch(e){res.statusCode=500;res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:false,error:e instanceof Error?e.message:'Chat server xatosi'}))}
}
