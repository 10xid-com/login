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
