import React from 'react';
import {beforeEach,test,expect,vi} from 'vitest';
const f=vi.hoisted(()=>({session:vi.fn(),account:vi.fn(),editable:vi.fn()}));
vi.mock('@/lib/auth/login',()=>({getLoginSession:f.session}));
vi.mock('@/lib/db/accounts',()=>({userByAuthUserId:f.account}));
vi.mock('@/lib/db/cid-profiles',()=>({editableCid:f.editable}));
vi.mock('@/app/auth/cid/[slug]/actions',()=>({publishCid:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:(url:string)=>{throw Error('REDIRECT '+url);},notFound:()=>{throw Error('NOT_FOUND');}}));
import CidEditor from '@/app/auth/cid/[slug]/page';
import {MemberError} from '@/lib/uid/member-policy';
import {CID_COMPANIES,emptyProfile,type CidSlug} from '@/lib/cid/profile';
const page=(slug='workweartoronto')=>CidEditor({params:Promise.resolve({slug}),searchParams:Promise.resolve({})});
beforeEach(()=>{
 vi.resetAllMocks();vi.stubGlobal('React',React);
 f.session.mockResolvedValue({mfaVerifiedAt:new Date(),user:{id:'auth-person',email:'person@example.com'}});
 f.account.mockResolvedValue({id:'bound-account'});
 f.editable.mockResolvedValue({profile:emptyProfile('workweartoronto'),version:1});
});
test.each(Object.keys(CID_COMPANIES) as CidSlug[])('non-members go directly to their public %s CiD',async slug=>{
 f.editable.mockRejectedValue(new MemberError('You are not an assigned member of this company.'));
 await expect(page(slug)).rejects.toThrow(`REDIRECT https://cid-${slug}.10xid.com/`);
});
test('view-only roles and explicit editing denials also get the public view',async()=>{
 f.editable.mockRejectedValue(new MemberError('Your company role does not allow profile editing.'));
 await expect(page()).rejects.toThrow('REDIRECT https://cid-workweartoronto.10xid.com/');
});
test('an unbound signed-in account goes to the public view without attempting editing',async()=>{
 f.account.mockResolvedValue(null);
 await expect(page()).rejects.toThrow('REDIRECT https://cid-workweartoronto.10xid.com/');
 expect(f.editable).not.toHaveBeenCalled();
});
test('authorized editors retain the editing form',async()=>{
 expect((await page()).props.intro).toBe('Edit public company identity');
 expect(f.editable).toHaveBeenCalledWith('workweartoronto','bound-account');
});
test('database failures remain visible rather than masquerading as denied membership',async()=>{
 f.editable.mockRejectedValue(Error('Database unavailable'));
 expect((await page()).props.intro).toBe('Company profile');
});
