import {companyBlogs} from '@/lib/cid/blogs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
async function handle(request:Request,{params}:{params:Promise<{slug:string;path:string[]}>}){
 const {slug,path}=await params;return companyBlogs(request,slug,path.join('/'));
}
export {handle as GET,handle as POST,handle as PUT,handle as DELETE,handle as OPTIONS};
