import { randomUUID } from 'node:crypto';
import { requireAdmin, rest, supabaseConfig, BUCKET } from './_auth.js';

const ALLOWED_KEYS = new Set(['home_image', 'guide_video']);
const IMAGE_TYPES = new Set(['image/jpeg','image/png','image/webp','image/gif']);
const VIDEO_TYPES = new Set(['video/mp4','video/webm','video/quicktime']);

function cleanName(name: string) {
  const base = String(name || 'media').normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
  return base || 'media';
}
function extension(name: string, type: string) {
  const found = String(name).toLowerCase().match(/\.[a-z0-9]{2,6}$/)?.[0];
  if (found) return found;
  const map: Record<string,string> = {'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/gif':'.gif','video/mp4':'.mp4','video/webm':'.webm','video/quicktime':'.mov'};
  return map[type] || '';
}

async function signUpload(body: any) {
  const { url, key } = supabaseConfig();
  const mediaKey = String(body.key || '').trim();
  const title = String(body.title || '').trim();
  const mediaType = String(body.media_type || '').trim();
  const fileName = cleanName(String(body.file_name || 'media'));
  const contentType = String(body.content_type || '').trim().toLowerCase();
  if (!ALLOWED_KEYS.has(mediaKey)) throw new Error('Noto‘g‘ri media kaliti');
  if (!title) throw new Error('Media nomi majburiy');
  if (mediaType !== 'image' && mediaType !== 'video') throw new Error('Media turi noto‘g‘ri');
  const allowed = mediaType === 'image' ? IMAGE_TYPES : VIDEO_TYPES;
  if (!allowed.has(contentType)) throw new Error('Bu fayl turi qo‘llab-quvvatlanmaydi');

  const path = `${mediaKey}/${Date.now()}-${randomUUID()}-${fileName.replace(/\.[a-z0-9]{2,6}$/i, '')}${extension(fileName, contentType)}`;
  const signUrl = `${url}/storage/v1/object/upload/sign/${BUCKET}/${path}`;
  const signResponse = await fetch(signUrl, {method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json','x-upsert':'true'},body:JSON.stringify({})});
  const data:any = await signResponse.json().catch(()=>({}));
  if (!signResponse.ok) throw new Error(`Storage sign ${signResponse.status}: ${JSON.stringify(data)}`);
  const signedUrl = String(data.url || '');
  if (!signedUrl) throw new Error('Storage signed URL qaytmadi');
  const absolute = signedUrl.startsWith('http') ? signedUrl : `${url}${signedUrl}`;
  const token = new URL(absolute).searchParams.get('token') || '';
  if (!token) throw new Error('Storage token qaytmadi');

  // Existing admin UI builds the upload endpoint from public_url + storage_path,
  // therefore storage_path intentionally includes the bucket prefix here.
  const uploadPath = `${BUCKET}/${path}`;
  return {ok:true,bucket:BUCKET,storage_path:uploadPath,token,signed_url:absolute,public_url:`${url}/storage/v1/object/public/${BUCKET}/${path}`};
}

async function commit(body:any) {
  const { url } = supabaseConfig();
  const mediaKey=String(body.key||'').trim();
  const title=String(body.title||'').trim();
  const mediaType=String(body.media_type||'').trim();
  let path=String(body.path||'').trim();
  const publicUrl=String(body.public_url||'').trim();
  if(!ALLOWED_KEYS.has(mediaKey)||!title||!['image','video'].includes(mediaType)||!path||!publicUrl) throw new Error('Media ma’lumotlari to‘liq emas');
  if(path.startsWith(`${BUCKET}/`)) path=path.slice(BUCKET.length+1);
  if(!path.startsWith(`${mediaKey}/`)) throw new Error('Media path noto‘g‘ri');
  const expectedPrefix=`${url}/storage/v1/object/public/${BUCKET}/`;
  if(!publicUrl.startsWith(expectedPrefix)) throw new Error('Media URL noto‘g‘ri');

  const old=await rest('admin_media',{query:`?key=eq.${encodeURIComponent(mediaKey)}&select=id,storage_path`});
  const patched=await rest('admin_media',{method:'PATCH',headers:{Prefer:'return=representation'},query:`?key=eq.${encodeURIComponent(mediaKey)}`,body:JSON.stringify({title,media_type:mediaType,storage_path:path,public_url:publicUrl,is_active:true,updated_at:new Date().toISOString()})});
  let media=Array.isArray(patched) ? patched[0] : null;
  if(!media){
    const created=await rest('admin_media',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({key:mediaKey,title,media_type:mediaType,storage_path:path,public_url:publicUrl,is_active:true})});
    media=Array.isArray(created) ? created[0] : null;
  }
  const previous=Array.isArray(old) ? old[0]?.storage_path : null;
  if(previous && previous!==path) await deleteObject(previous).catch(()=>{});
  return {ok:true,media};
}

async function deleteObject(path:string){
  const {url,key}=supabaseConfig();
  const res=await fetch(`${url}/storage/v1/object/${BUCKET}/${path}`,{method:'DELETE',headers:{apikey:key,Authorization:`Bearer ${key}`}});
  if(!res.ok) throw new Error(`Storage delete ${res.status}`);
}

export default async function handler(request:any,response:any){
  try{
    requireAdmin(request);
    const action=String((request.query as any)?.action || '').trim();
    if(request.method!=='POST'){
      response.statusCode=405;response.setHeader('Allow','POST');response.end(JSON.stringify({ok:false,error:'Method not allowed'}));return;
    }
    const result=action==='sign' ? await signUpload(request.body||{}) : action==='commit' ? await commit(request.body||{}) : null;
    if(!result){response.statusCode=404;response.end(JSON.stringify({ok:false,error:'Unknown media action'}));return;}
    response.statusCode=action==='commit'?201:200;response.setHeader('content-type','application/json; charset=utf-8');response.end(JSON.stringify(result));
  }catch(error){
    const status=error instanceof Error && (error.message==='Unauthorized'||error.message==='Session expired') ? 401 : 500;
    response.statusCode=status;response.setHeader('content-type','application/json; charset=utf-8');response.end(JSON.stringify({ok:false,error:error instanceof Error?error.message:'Media operation failed'}));
  }
}
