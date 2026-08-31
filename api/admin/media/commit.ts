import { requireAdmin, rest, supabaseConfig, BUCKET } from './_auth.js';

/**
 * DIQQAT: admin_media jadvalidagi ustun nomi `path`, `storage_path` EMAS
 * (bazadan tasdiqlangan, 2026-08-29 audit). Bu fayl avval `storage_path`
 * ga yozar/o'qirdi — har bir media yuklash "Media saqlanmadi" bilan
 * yiqilardi.
 */
export default async function handler(request:any,response:any){
  try{
    requireAdmin(request);
    if(request.method!=='POST'){
      response.statusCode=405;response.setHeader('Allow','POST');response.end(JSON.stringify({ok:false,error:'Method not allowed'}));return;
    }
    const body=request.body||{};
    const mediaType=String(body.media_type||'video').trim();
    const title=String(body.title||'').trim();
    let path=String(body.path||body.storage_path||'').trim();
    const publicUrl=String(body.public_url||'').trim();
    if(!title)throw new Error('Media nomi majburiy');
    if(!['video','image'].includes(mediaType))throw new Error('Media turi noto‘g‘ri');
    if(!path||!publicUrl)throw new Error('Media fayl ma’lumotlari to‘liq emas');
    if(path.startsWith(`${BUCKET}/`))path=path.slice(BUCKET.length+1);
    const slot=String(body.slot||'home').trim();
    const key=mediaType==='video'?'guide_video':(slot==='location'?'location_image':'home_image');
    if(!path.startsWith(`${key}/`))throw new Error('Media path noto‘g‘ri');
    const {url}=supabaseConfig();
    const prefix=`${url}/storage/v1/object/public/${BUCKET}/`;
    if(!publicUrl.startsWith(prefix))throw new Error('Media URL noto‘g‘ri');

    const old=await rest('admin_media',{query:`?key=eq.${encodeURIComponent(key)}&select=id,path`});
    const patch=await rest('admin_media',{method:'PATCH',headers:{Prefer:'return=representation'},query:`?key=eq.${encodeURIComponent(key)}`,body:JSON.stringify({title,media_type:mediaType,path,public_url:publicUrl,is_active:true,updated_at:new Date().toISOString()})});
    let media=Array.isArray(patch)?patch[0]:null;
    if(!media){
      const created=await rest('admin_media',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({key,title,media_type:mediaType,path,public_url:publicUrl,is_active:true,sort_order:0})});
      media=Array.isArray(created)?created[0]:null;
    }
    const previous=Array.isArray(old)?old[0]?.path:null;
    if(previous&&previous!==path){
      await fetch(`${url}/storage/v1/object/${BUCKET}/${previous}`,{method:'DELETE',headers:{apikey:String(process.env.SUPABASE_SERVICE_ROLE_KEY||''),Authorization:`Bearer ${String(process.env.SUPABASE_SERVICE_ROLE_KEY||'')}`}}).catch(()=>{});
    }
    response.statusCode=201;response.setHeader('content-type','application/json; charset=utf-8');response.end(JSON.stringify({ok:true,media}));
  }catch(error){
    const unauthorized=error instanceof Error&&error.message==='Unauthorized';
    response.statusCode=unauthorized?401:400;response.setHeader('content-type','application/json; charset=utf-8');response.end(JSON.stringify({ok:false,error:error instanceof Error?error.message:'Media commit failed'}));
  }
}
