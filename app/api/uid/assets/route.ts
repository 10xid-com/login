import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isUidSiteCaller, uidSiteSecret, uidSites } from '@/lib/auth/uid-sites';

export const runtime='nodejs';
const FILES=new Set(['members.js','members.css','clothing.js','clothing.css','clothing-csv.js','clothing-save.js',
  'clothing-store-filters.js','clothing-store-products.js','clothing-photo-fill.js','qrcode.js']);
/** Members is shared application code; existing inventory bundles stay in their original private service. */
export async function GET(request:Request){
  const file=new URL(request.url).searchParams.get('file')||'';
  if(!FILES.has(file))return new Response('Not found',{status:404});
  if(!file.startsWith('members.')){
    const caller=new URL(request.url).searchParams.get('host')||'';
    if(!isUidSiteCaller(caller,request.headers.get('authorization')))return new Response('Not authorized',{status:401});
    const host=process.env.CLOTHING_UI_HOST||'uid-bypaolo.10xid.com';
    const secret=uidSiteSecret(host);
    if(!uidSites().has(host)||!secret)return new Response('Tool interface is unavailable',{status:503});
    try{
      const upstream=await fetch(`https://${host}/internal/uid-tool-assets/${file}`,{
        headers:{authorization:`Bearer ${secret}`},redirect:'error',signal:AbortSignal.timeout(10_000),cache:'no-store',
      });
      const type=file.endsWith('.css')?'text/css':'text/javascript';
      if(!upstream.ok||!upstream.headers.get('content-type')?.startsWith(type))return new Response('Tool interface is unavailable',{status:503});
      return new Response(upstream.body,{headers:{'content-type':type+'; charset=utf-8','cache-control':'private, max-age=60','x-content-type-options':'nosniff'}});
    }catch{return new Response('Tool interface is unavailable',{status:503});}
  }
  try{return new Response(await readFile(join(process.cwd(),'public','uid-tools',file)),{
    headers:{'content-type':file.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8',
      'cache-control':'public, max-age=60','x-content-type-options':'nosniff'},
  });}catch{return new Response('Not found',{status:404});}
}
