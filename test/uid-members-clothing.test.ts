import {beforeEach,describe,it,expect,vi} from 'vitest';
const f=vi.hoisted(()=>({access:vi.fn()}));
vi.mock('@/lib/db/uid-members',()=>({uidClothingAccess:f.access}));
import {clothingProxy} from '@/lib/uid/clothing-proxy';
const actor={userId:'person',email:'member@example.com',name:'Member',addresses:['member@example.com']};
beforeEach(()=>{process.env.CLOTHING_API_URL='https://clothing.example.com';process.env.CLOTHING_API_KEY='k'.repeat(40);f.access.mockResolvedValue({id:'business',level:1});});
describe('server-side Clothing Inventory enforcement',()=>{
 it('allows reads and blocks writes for a viewer before contacting inventory',async()=>{
  const upstream=vi.fn().mockResolvedValue(Response.json({items:[]}));
  await clothingProxy(actor,{path:'/api/clothing',method:'GET'},upstream);
  expect(upstream).toHaveBeenCalledTimes(1);
  await expect(clothingProxy(actor,{path:'/api/clothing/C001',method:'PUT',body:'{}'},upstream)).rejects.toThrow('does not allow');
  expect(upstream).toHaveBeenCalledTimes(1);
 });
 it('requires publishing access separately from editing',async()=>{
  f.access.mockResolvedValue({id:'business',level:2});const upstream=vi.fn();
  await expect(clothingProxy(actor,{path:'/api/clothing/C001/publish',method:'POST',body:'{}'},upstream)).rejects.toThrow('does not allow');
  expect(upstream).not.toHaveBeenCalled();
 });
 it('refuses internal paths, encoded traversal and untrusted origins',async()=>{
  const upstream=vi.fn();
  for(const path of ['/internal/migrate','/api/clothing/../internal/migrate','/api/clothing/%2e%2e/internal','//elsewhere.example/api/clothing'])
   await expect(clothingProxy(actor,{path,method:'GET'},upstream)).rejects.toThrow('Invalid inventory');
  expect(upstream).not.toHaveBeenCalled();
 });
 it('binds the inventory actor to the authenticated account',async()=>{
  f.access.mockResolvedValue({id:'business',level:3});const upstream=vi.fn().mockResolvedValue(Response.json({saved:true}));
  await clothingProxy(actor,{path:'/api/clothing/C001?business=other',method:'PUT',business:'business',body:'{}'},upstream);
  expect(String(upstream.mock.calls[0][0])).toBe('https://clothing.example.com/api/clothing/C001');
  expect(upstream.mock.calls[0][1].headers['x-clothing-actor']).toBe(actor.email);
 });
});
describe('photo reading for the other UiDs',()=>{
 const host='uid-bypaolo.10xid.com';
 beforeEach(()=>{process.env.UID_SITE_KEY='u'.repeat(40);process.env.UID_SITES=`${host}=paolo@example.com`;delete process.env.CLOTHING_UI_HOST;});
 it('is passed to the clothing tools\' UiD, signed with its secret and naming the person',async()=>{
  f.access.mockResolvedValue({id:'business',level:2});
  const upstream=vi.fn().mockResolvedValue(Response.json({suggestions:[{field:'brand'}]}));
  const r=await clothingProxy(actor,{path:'/api/clothing/photo-reader?business=other',method:'POST',body:'{"photos":[]}'},upstream);
  expect(r.status).toBe(200);expect(await r.json()).toEqual({suggestions:[{field:'brand'}]});
  const [url,init]=upstream.mock.calls[0];
  expect(String(url)).toBe(`https://${host}/internal/uid-photo-reader`);
  expect(init.method).toBe('POST');expect(init.body).toBe('{"photos":[]}');
  expect(init.headers['x-uid-actor']).toBe(actor.email);
  const {uidSiteSecret}=await import('@/lib/auth/uid-sites');
  expect(init.headers.authorization).toBe('Bearer '+uidSiteSecret(host));
 });
 it('needs editing rights to read, and only looking to ask whether it is available',async()=>{
  const upstream=vi.fn().mockResolvedValue(Response.json({available:true}));
  await expect(clothingProxy(actor,{path:'/api/clothing/photo-reader',method:'POST',body:'{}'},upstream)).rejects.toThrow('does not allow');
  expect(upstream).not.toHaveBeenCalled();
  expect(await (await clothingProxy(actor,{path:'/api/clothing/photo-reader',method:'GET'},upstream)).json()).toEqual({available:true});
 });
 it('says it is unavailable, never fails, when the clothing tools\' UiD cannot be reached',async()=>{
  for(const upstream of [vi.fn().mockRejectedValue(Error('offline')),vi.fn().mockResolvedValue(new Response('Not found',{status:404,headers:{'content-type':'text/plain'}}))]){
   const r=await clothingProxy(actor,{path:'/api/clothing/photo-reader',method:'GET'},upstream);
   expect(await r.json()).toMatchObject({available:false});
  }
  f.access.mockResolvedValue({id:'business',level:2});
  await expect(clothingProxy(actor,{path:'/api/clothing/photo-reader',method:'POST',body:'{}'},vi.fn().mockRejectedValue(Error('offline')))).rejects.toThrow('could not finish');
  process.env.UID_SITES='other.10xid.com=x@example.com';
  const never=vi.fn();
  expect(await (await clothingProxy(actor,{path:'/api/clothing/photo-reader',method:'GET'},never)).json()).toMatchObject({available:false});
  expect(never).not.toHaveBeenCalled();
 });
});
