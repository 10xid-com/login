import {describe,it,expect} from 'vitest';
import {clothingLevel,mayChange,requiredClothingLevel} from '@/lib/uid/member-policy';
describe('UiD business roles and clothing capabilities',()=>{
 it('keeps owner management with owners',()=>{
  expect(mayChange('owner','owner','viewer')).toBe(true);
  expect(mayChange('manager','owner','viewer')).toBe(false);
  expect(mayChange('manager','viewer','owner')).toBe(false);
  expect(mayChange('viewer','viewer','manager')).toBe(false);
  expect(mayChange('staff','viewer','manager')).toBe(false);
  expect(mayChange('manager','editor','publisher')).toBe(true);
 });
 it('requires cumulative explicit tool access and gives denies priority',()=>{
  expect(clothingLevel('owner',[])).toBe(3);
  expect(clothingLevel('viewer',[])).toBe(0);
  expect(clothingLevel('editor',[{capability:'clothing.write',deny:false}])).toBe(0);
  expect(clothingLevel('viewer',[{capability:'clothing.read',deny:false}])).toBe(1);
  expect(clothingLevel('owner',[{capability:'clothing.read',deny:true}])).toBe(0);
  expect(clothingLevel('owner',[{capability:'clothing.write',deny:true}])).toBe(1);
 });
 it('separates viewing, editing and publishing requests',()=>{
  expect(requiredClothingLevel('GET','/api/clothing')).toBe(1);
  expect(requiredClothingLevel('PUT','/api/clothing/C001')).toBe(2);
  expect(requiredClothingLevel('POST','/api/clothing/C001/photos')).toBe(2);
  expect(requiredClothingLevel('POST','/api/clothing/C001/publish')).toBe(3);
 });
});
