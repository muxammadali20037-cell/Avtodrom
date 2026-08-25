import { randomUUID } from 'node:crypto';
import { requireAdmin, supabaseConfig, BUCKET } from './_auth.js';

const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function cleanName(name: string) {
  return String(name || 'media').normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'media';
}

function ext(name: string, type: string) {
  const found = String(name).toLowerCase().match(/\.[a-z0-9]{2,6}$/)?.[0];
  if (found) return found;
  return ({'video/mp4':'.mp4','video/webm':'.webm','video/quicktime':'.mov','image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/gif':'.gif'} as Record<string,string>)[type] || '';
}

export default async function handler(request: any, response: any) {
  try {
    requireAdmin(request);
    if (request.method !== 'POST') {
      response.statusCode = 405;
      response.setHeader('Allow', 'POST');
      response.end(JSON.stringify({ok:false,error:'Method not allowed'}));
      return;
    }
    const body = request.body || {};
    const title = String(body.title || '').trim();
    const mediaType = String(body.media_type || 'video').trim();
    const fileName = cleanName(body.file_name || body.filename || 'media');
    const contentType = String(body.content_type || body.contentType || '').toLowerCase();
    if (!title) throw new Error('Media nomi majburiy');
    if (!['video','image'].includes(mediaType)) throw new Error('Media turi noto‘g‘ri');
    const allowed = mediaType === 'video' ? VIDEO_TYPES : IMAGE_TYPES;
    if (!allowed.has(contentType)) throw new Error('Bu fayl turi qo‘llab-quvvatlanmaydi');

    const key = mediaType === 'video' ? 'guide_video' : 'home_image';
    const path = `${key}/${Date.now()}-${randomUUID()}-${fileName.replace(/\.[a-z0-9]{2,6}$/i,'')}${ext(fileName,contentType)}`;
    const {url,key:serviceKey} = supabaseConfig();
    const signUrl = `${url}/storage/v1/object/upload/sign/${BUCKET}/${path}`;
    const r = await fetch(signUrl, {method:'POST',headers:{apikey:serviceKey,Authorization:`Bearer ${serviceKey}`,'Content-Type':'application/json','x-upsert':'true'},body:JSON.stringify({expiresIn:3600,upsert:true,contentType})});
    const data:any = await r.json().catch(()=>({}));
    if (!r.ok) throw new Error(`Storage sign ${r.status}: ${JSON.stringify(data)}`);
    const absolute = String(data.url || '').startsWith('http') ? String(data.url) : `${url}${data.url || ''}`;
    const token = String(data.token || new URL(absolute).searchParams.get('token') || '');
    if (!token) throw new Error('Storage token qaytmadi');
    const publicUrl = `${url}/storage/v1/object/public/${BUCKET}/${path}`;
    response.statusCode = 200;
    response.setHeader('content-type','application/json; charset=utf-8');
    response.end(JSON.stringify({ok:true,bucket:BUCKET,path,storage_path:path,token,upload_url:`${absolute}${absolute.includes('?')?'&':'?'}token=${encodeURIComponent(token)}`,signed_url:absolute,public_url:publicUrl}));
  } catch (error) {
    const unauthorized = error instanceof Error && error.message === 'Unauthorized';
    response.statusCode = unauthorized ? 401 : 400;
    response.setHeader('content-type','application/json; charset=utf-8');
    response.end(JSON.stringify({ok:false,error:error instanceof Error ? error.message : 'Media sign failed'}));
  }
}
