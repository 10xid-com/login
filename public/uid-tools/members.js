/* One Members feature for every UiD. Data and authority always come from the central business API. */
(function(root){
'use strict';
if(root.UIDMembers)return;
const $=id=>document.getElementById(id),escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const levels=['No access','View only','Edit','Edit and publish'];
const ALL_CIDS='all-cids';
const memberDate=new Intl.DateTimeFormat(undefined,{dateStyle:'medium'});
let overview=null,business='',detail=null,roster=null,opened=false,busy=false,request=0,clothingBusiness='',editing=null,fetchingOverview=null,heldChannels=null;
const directory=new Map(),loadedScripts=new Map();
let contactProfiles=null,profileRequest=0;
const stage=document.createElement('section');stage.id='membersStage';stage.hidden=true;stage.setAttribute('aria-label','Members');
(document.querySelector('main')||document.body).append(stage);
const inventories=document.createElement('section');inventories.id='inventoriesStage';inventories.hidden=true;inventories.setAttribute('aria-label','Inventories');
(document.querySelector('main')||document.body).append(inventories);
let inventoryRequest=0,inventoryEntries=[],inventoryLoading=false;
function selectedBusiness(){
 const current=overview?.businesses.find(b=>b.name.toLowerCase()===($('business')?.textContent||'').trim().toLowerCase());
 return current?.id||business||overview?.businesses[0]?.id||'';
}
async function api(action,data={}){
 const url=action==='overview'?'/api/business-members':action==='members'?'/api/business-members?business='+encodeURIComponent(data.business):'/api/business-members';
 const response=await fetch(url,{method:action==='overview'||action==='members'?'GET':'POST',credentials:'same-origin',cache:'no-store',
  ...(action==='overview'||action==='members'?{}:{headers:{'content-type':'application/json'},body:JSON.stringify({action,...data})})});
 const body=await response.json();if(!response.ok)throw Error(body.error||'Members could not be loaded.');return body;
}
async function refreshOverview(){
 if(fetchingOverview)return fetchingOverview;
 fetchingOverview=api('overview').then(value=>{const previous=overview?.businesses.find(b=>b.id===business);overview=value;
  if(business!==ALL_CIDS&&!value.businesses.some(b=>b.id===business))business=value.businesses[0]?.id||'';
  if(!clothingBusiness)clothingBusiness=value.businesses.find(b=>b.tools.clothing.available)?.id||'';
  const current=value.businesses.find(b=>b.id===business);
  if(opened&&detail&&(detail.business.id!==business||previous?.role!==current?.role)){
   detail=null;editing=null;queueMicrotask(()=>load());
  }
  reconcile();return value;})
  .finally(()=>{fetchingOverview=null;});return fetchingOverview;
}
function notice(text,bad=false){const node=$('membersNotice');if(node){node.hidden=false;node.textContent=text;node.className=bad?'um-notice um-error':'um-notice';}}
function markChannel(){
 const tabs=$('stageTabs');if(!tabs||!opened)return;
 const buttons=[...tabs.querySelectorAll('button')];
 if(!heldChannels||!heldChannels.some(item=>item.node.isConnected))heldChannels=buttons.map(node=>({node,pressed:node.getAttribute('aria-pressed'),selected:node.classList.contains('selected')}));
 for(const node of buttons)if(!heldChannels.some(item=>item.node===node))heldChannels.push({node,pressed:node.getAttribute('aria-pressed'),selected:node.classList.contains('selected')});
 for(const node of buttons){const selected=node.dataset.umBusiness===business;node.classList.toggle('selected',selected);node.setAttribute('aria-pressed',String(selected));}
}
function close(){opened=false;stage.hidden=true;document.body.classList.remove('members-open');editing=null;request++;profileRequest++;contactProfiles=null;
 if(heldChannels)for(const item of heldChannels){if(!item.node.isConnected)continue;item.node.classList.toggle('selected',item.selected);
  if(item.pressed===null)item.node.removeAttribute('aria-pressed');else item.node.setAttribute('aria-pressed',item.pressed);}
 heldChannels=null;
}
const home=root.showHome;
if(typeof home==='function')root.showHome=function(){close();closeInventories();return home.apply(this,arguments);};
function closeInventories(){inventoryRequest++;inventories.hidden=true;document.body.classList.remove('inventory-directory-open');}
function inventoryCard(entry){
 return `<button type="button" class="ui-inventory-card" data-inventory-open="${escape(entry.key)}"><span class="ui-inventory-kind">${entry.kind==='clothing'?'Clothing Inventory':'Inventory'}</span>
 <strong>${escape(entry.name)}</strong><span class="ui-inventory-access">${escape(levels[entry.level])}<span aria-hidden="true"> →</span></span></button>`;
}
function renderInventories(error=''){
 const group=(personal)=>{
  const entries=inventoryEntries.filter(entry=>entry.personal===personal);
  const title=personal?'Personal inventories':'Shared inventories',id=personal?'personalInventoriesTitle':'sharedInventoriesTitle';
  const description=personal?'Inventories you own, including those you share.':'Inventories other people have shared with you.';
  const empty=error?'Your inventories could not be fully loaded.':personal?'You do not own any connected inventories yet.':'No inventories have been shared with you.';
  return `<section class="um-panel" aria-labelledby="${id}"><div class="um-panel-head"><h3 id="${id}">${title}</h3>${inventoryLoading?'':`<span class="um-count">${entries.length}</span>`}</div>
   <p class="um-muted">${description}</p>${inventoryLoading?'<p role="status">Loading your inventories…</p>':entries.length?`<div class="ui-inventory-grid">${entries.map(inventoryCard).join('')}</div>`:`<p class="um-muted">${empty}</p>`}</section>`;
 };
 inventories.innerHTML=`<div class="um-top"><button type="button" data-inventories="home">← Control Room</button><button type="button" data-inventories="refresh">Refresh</button></div>
 <div class="um-title"><div><h2>Inventory</h2><p>Choose an inventory to open.</p></div></div>
 ${error?`<div class="um-notice um-error" role="alert">${escape(error)} <button type="button" data-inventories="refresh">Try again</button></div>`:''}
 ${group(true)}${group(false)}`;
}
async function generalInventories(){
 if(!root.InventoryUI?.openForBusiness)return [];
 const response=await fetch('/api/inventory',{credentials:'same-origin',cache:'no-store'});
 const body=await response.json();
 if(response.status===404&&body.setup)return [];
 if(!response.ok)throw Error(body.error||'Some inventories could not be loaded.');
 return (body.businesses||[]).map(item=>({key:'inventory:'+item.id,id:item.id,name:item.name,kind:'inventory',level:2}));
}
async function openInventories(){
 root.showHome?.();root.VendorUI?.leave?.();root.InventoryUI?.leave?.();root.ClothingUI?.leave?.();root.WorkDeck?.close?.();root.TaskUI?.closeCard?.();
 const ticket=++inventoryRequest;inventories.hidden=false;document.body.classList.add('inventory-directory-open');inventoryEntries=[];inventoryLoading=true;renderInventories();
 $('stage')?.scrollTo({top:0});
 const results=await Promise.allSettled([refreshOverview(),generalInventories()]);
 if(ticket!==inventoryRequest||inventories.hidden)return;
 const [membersResult,generalResult]=results,errors=[];
 if(membersResult.status==='fulfilled')inventoryEntries=membersResult.value.businesses
  .filter(item=>item.tools?.clothing?.available&&item.tools.clothing.level>0)
  .map(item=>({key:'clothing:'+item.id,id:item.id,name:item.name,kind:'clothing',level:item.tools.clothing.level}));
 else errors.push('Inventory ownership and access could not be loaded.');
 if(generalResult.status==='fulfilled'){if(membersResult.status==='fulfilled')inventoryEntries.push(...generalResult.value);}
 else errors.push(generalResult.reason.message||'Some inventories could not be loaded.');
 if(membersResult.status==='fulfilled')inventoryEntries=inventoryEntries.map(entry=>({...entry,
  personal:membersResult.value.businesses.find(item=>item.id===entry.id)?.inventoryOwnership?.[entry.kind]===true}));
 inventoryEntries.sort((a,b)=>a.name.localeCompare(b.name)||a.kind.localeCompare(b.kind));inventoryLoading=false;renderInventories(errors.join(' '));
}
inventories.addEventListener('click',async event=>{
 const button=event.target.closest('button');if(!button)return;
 if(button.dataset.inventories==='home')return root.showHome?.();
 if(button.dataset.inventories==='refresh')return openInventories();
 const entry=inventoryEntries.find(item=>item.key===button.dataset.inventoryOpen);if(!entry)return;
 inventories.querySelectorAll('button').forEach(node=>node.disabled=true);
 try{
  if(entry.kind==='clothing')await openClothing(entry.id);
  else{root.showHome?.();root.InventoryUI.openForBusiness(entry.id);}
 }catch(error){if(!inventories.hidden)renderInventories(error.message);}
 finally{inventories.querySelectorAll('button').forEach(node=>node.disabled=false);}
});
// Paolo's existing menu opens independently of showHome; close the chooser before that menu renders.
$('tenxButton')?.addEventListener('click',()=>{if(!inventories.hidden)root.showHome?.();},true);
function header(){
 return `<div class="um-top"><button type="button" data-um="home">← Control Room</button><button type="button" data-um="refresh">Refresh</button></div>
 <div class="um-title"><div><span class="um-kicker">BUSINESS ACCESS</span><h2>Members</h2></div>
 <label>CiD<select id="membersBusiness" ${busy?'disabled':''}><option value="">Choose a CiD</option>${overview?.businesses.length?`<option value="${ALL_CIDS}" ${business===ALL_CIDS?'selected':''}>All CiDs</option>`:''}${(overview?.businesses||[]).map(b=>`<option value="${escape(b.id)}" ${b.id===business?'selected':''}>${escape(b.name)}</option>`).join('')}</select></label></div>
 <div id="membersNotice" class="um-notice" role="status" hidden></div>`;
}
function received(){
 if(!overview?.incoming.length)return '';
 return `<section class="um-panel"><h3>Invitations for you <span class="um-count">${overview.incoming.length}</span></h3><div class="um-list">${overview.incoming.map(invite=>`
 <div class="um-row"><div><strong>${escape(invite.business_name)}</strong><small>${escape(roleLabel(invite.role))} · Sent to ${escape(invite.email)}</small></div>
 <div class="um-actions"><button type="button" data-um="accept" data-id="${escape(invite.id)}" data-business="${escape(invite.business_id)}">Accept</button>
 <button type="button" class="um-quiet" data-um="decline" data-id="${escape(invite.id)}" data-business="${escape(invite.business_id)}">Decline</button></div></div>`).join('')}</div></section>`;
}
function roleLabel(role){return overview?.roles.find(option=>option.value===role)?.label||({staff:'Staff (legacy)',member:'Member (legacy)'}[role])||role;}
function emailLink(value){
 const address=String(value??'').trim();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))return escape(value);
 return `<a href="mailto:${escape(encodeURIComponent(address).replace('%40','@'))}" style="color:inherit">${escape(value)}</a>`;
}
function phoneLink(value,label=value,extension=''){
 const number=String(value??'').trim().replace(/[\s().-]/g,'');
 if(!/^\+?\d{3,15}$/.test(number))return escape(label);
 const ext=/^\d+$/.test(extension)?';ext='+extension:'';
 return `<a href="tel:${number}${ext}" style="color:inherit">${escape(label)}</a>`;
}
function profileContent(id,name,email){
 const profile=contactProfiles?.get(id);
 const displayName=profile?.name||name||email;
 const displayEmail=profile?.email||email;
 const heading=`<strong>${displayName===displayEmail?emailLink(displayEmail):escape(displayName)}${id===overview?.actor.id?' <span class="um-you">You</span>':''}</strong>
 ${displayEmail!==displayName?`<small>${emailLink(displayEmail)}</small>`:''}`;
 if(!profile)return heading;
 const memberships=profile.memberships.map(m=>escape(m.ciD.name+' · '+m.role)+(m.signIn?' ('+emailLink(m.signIn)+')':'')).sort().join(', ');
 const employeeCiDs=[...new Set(profile.memberships.map(m=>m.ciD.name).filter(Boolean))].sort().join(', ');
 const deckCiDs=[...new Set(profile.sources.map(s=>s.ciD.name).filter(Boolean))].sort().join(', ');
 return heading+`${profile.phone?`<small>Phone · ${phoneLink(profile.phone)}</small>`:''}<small><strong>CiD memberships</strong> · ${memberships}</small>
 ${employeeCiDs?`<small><strong>Employee</strong> · ${escape(employeeCiDs)}</small>`:''}
 ${deckCiDs?`<small><strong>Listed as a contact for</strong> · ${escape(deckCiDs)}</small>`:''}
 ${profile.sources.length?`<details><summary>Work Deck contact details</summary>${profile.sources.map(({contact:c,ciD,deck:d})=>`<div>
  <a href="#work-deck-${escape(d.id)}" data-um="open-work-deck" data-id="${escape(d.id)}">${escape(d.title||'Open Work Deck')}</a>
  <small>${escape([ciD.name,c.role||(c.vendor?'Vendor contact':'Client contact'),c.vendor?d.vendor:''].filter(Boolean).join(' · '))}</small>
  ${c.email?`<small>Email · ${emailLink(c.email)}</small>`:''}
  ${c.phone?`<small>Phone · ${phoneLink(c.phone,c.phone,c.extension)}${c.extension?' · Ext. '+escape(c.extension):''}</small>`:''}
  ${c.mobile?`<small>Mobile · ${phoneLink(c.mobile)}</small>`:''}
  ${c.vendor&&d.vendorAddress?`<small>${escape(d.vendorAddress)}</small>`:''}
 </div>`).join('')}</details>`:''}`;
}
async function memberOnlyProfiles(){
 const current=await refreshOverview();
 const results=await Promise.allSettled(current.businesses.map(b=>api('members',{business:b.id})));
 const people=new Map(),profiles=new Map();
 for(const result of results){
  if(result.status!=='fulfilled')continue;
  const {business,members}=result.value;
  for(const member of members){
   const group=member.contactGroup;
   const key=group?'group:'+group.key:member.id;
   if(!people.has(key))people.set(key,{name:group?.name||member.name,email:member.email,memberships:[],sources:[]});
   const record=people.get(key);
   if(group?.primary)record.email=member.email;
   if(member.contactPhone&&(group?.primary||!record.phone))record.phone=member.contactPhone;
   record.memberships.push({ciD:business,role:roleLabel(member.role),signIn:group?member.email:''});
   profiles.set(member.id,record);
  }
 }
 return profiles;
}
function refreshContactProfiles(){
 const loadProfiles=root.WorkDeck?.contactProfiles||memberOnlyProfiles;
 const ticket=++profileRequest;
 contactProfiles=null;
 loadProfiles().then(profiles=>{
  if(!opened||ticket!==profileRequest)return;
  contactProfiles=profiles;
  for(const node of stage.querySelectorAll('[data-member-profile]')){
   const id=node.dataset.memberProfile;
   if(profiles.has(id))node.innerHTML=profileContent(id);
  }
 }).catch(()=>{});
}
function memberRow(member,company,editable){
 const dates=[['Assigned',member.assignedAt],['Updated',member.updatedAt]]
  .filter(([,value])=>value&&Number.isFinite(Date.parse(value)))
  .map(([label,value])=>label+' '+memberDate.format(new Date(value))).join(' · ');
 return `<div class="um-row"><div class="um-person"><div data-member-profile="${escape(member.id)}">${profileContent(member.id,member.name,member.email)}</div>
 <div class="um-tags"><span>CiD · ${escape(company.business.name)}</span><span>${escape(roleLabel(member.role))}</span>${company.clothingAvailable?`<span>Clothing · ${escape(levels[member.clothing])}</span>`:''}</div>
 ${dates?`<small>${escape(dates)}</small>`:''}</div>
 ${editable&&member.canEdit?`<button type="button" class="um-quiet" data-um="edit" data-id="${escape(member.id)}">Edit access</button>`:''}</div>`;
}
function renderRoster(){
 if(!roster)return '<section class="um-panel"><p role="status">Loading members…</p></section>';
 return roster.map(({name,company})=>{
  if(!company)return `<section class="um-panel"><h3>${escape(name)}</h3><p>Members could not be loaded for this CiD.</p></section>`;
  return `<section class="um-panel"><div class="um-panel-head"><h3>${escape(company.business.name)}</h3>
   <button type="button" class="um-quiet" data-um="open-cid" data-business="${escape(company.business.id)}">Open CiD roster</button></div>
   ${company.directoryVisible?'':'<p class="um-muted">Only your membership is visible for this CiD.</p>'}
   <div class="um-list">${company.members.map(member=>memberRow(member,company,false)).join('')||'<p>No members.</p>'}</div></section>`;
 }).join('')||'<section class="um-panel"><p>No CiDs are available.</p></section>';
}
function render(){
 stage.innerHTML=header()+received();
 if(business===ALL_CIDS){stage.insertAdjacentHTML('beforeend',renderRoster());return;}
 if(!business){stage.insertAdjacentHTML('beforeend','<section class="um-panel"><h3>Your business Channels</h3><p>No business memberships are available. Accepted invitations will appear here.</p></section>');return;}
 if(!detail){stage.insertAdjacentHTML('beforeend','<section class="um-panel"><p>Loading members…</p></section>');return;}
 stage.insertAdjacentHTML('beforeend',`<section class="um-panel"><div class="um-panel-head"><div><h3>${escape(detail.business.name)}</h3>
 <p>${detail.members.length} ${detail.directoryVisible?'member'+(detail.members.length===1?'':'s'):'membership'}${detail.pending.length?' · '+detail.pending.length+' pending':''}</p></div>
 ${detail.canManage?'<button type="button" data-um="invite">+ Invite member</button>':''}</div>
 ${!detail.directoryVisible?'<p class="um-muted">You can view your membership. An owner or manager can manage the full member list.</p>':''}
 <div class="um-list">${detail.members.map(member=>memberRow(member,detail,true)).join('')||'<p>No members.</p>'}</div></section>
 ${detail.pending.length?`<section class="um-panel"><h3>Pending invitations</h3><div class="um-list">${detail.pending.map(invite=>`<div class="um-row"><div><strong>${escape(invite.email)}</strong>
 <small>${escape(roleLabel(invite.role))} · ${new Date(invite.expires_at).getTime()<Date.now()?'Expired':'Awaiting acceptance'}</small></div>
 ${detail.role==='owner'||invite.role!=='owner'?`<button type="button" class="um-quiet" data-um="revoke" data-id="${escape(invite.id)}">Withdraw</button>`:''}</div>`).join('')}</div></section>`:''}
 <div id="membersEditor"></div>`);
}
async function open(options={}){
 root.showHome?.();root.VendorUI?.close?.();root.InventoryUI?.leave?.();root.ClothingUI?.leave?.();root.WorkDeck?.close?.();root.TaskUI?.closeCard?.();
 opened=true;stage.hidden=false;document.body.classList.add('members-open');detail=null;roster=null;render();refreshContactProfiles();
 try{await refreshOverview();business=options.business||selectedBusiness();await load();if(options.invite&&detail?.canManage)inviteForm();}
 catch(error){render();notice(error.message,true);}
}
async function load(){
 const ticket=++request;detail=null;roster=null;editing=null;render();markChannel();if(!business)return;
 if(business===ALL_CIDS){
  const companies=overview?.businesses||[];
  const results=await Promise.allSettled(companies.map(company=>api('members',{business:company.id})));
  if(ticket!==request||!opened)return;
  roster=results.map((result,index)=>({name:companies[index].name,company:result.status==='fulfilled'?result.value:null}));
  render();return;
 }
 try{const result=await api('members',{business});if(ticket!==request||!opened)return;detail=result;directory.set(business,result);render();reconcile();}
 catch(error){if(ticket===request){render();notice(error.message,true);}}
}
function roleOptions(value){
 const options=overview.roles.filter(r=>r.value!=='owner'||detail.role==='owner');
 const placeholder=options.some(r=>r.value===value)?'':'<option value="" disabled selected>Choose a business role</option>';
 return placeholder+options.map(r=>`<option value="${r.value}" ${r.value===value?'selected':''}>${escape(r.label)}</option>`).join('');
}
function inviteForm(){
 editing=null;$('membersEditor').innerHTML=`<section class="um-panel"><h3>Invite into ${escape(detail.business.name)}</h3><form id="membersInviteForm" class="um-form">
 <label>Email<input name="email" type="email" autocomplete="email" required maxlength="320" placeholder="name@example.com"></label>
 <label>Business role<select name="role">${roleOptions('viewer')}</select></label><p class="um-muted">They accept the invitation with this verified account. Tool access can be assigned after acceptance.</p>
 <div class="um-actions"><button type="submit">Send invitation</button><button type="button" class="um-quiet" data-um="cancel-edit">Cancel</button></div></form></section>`;
 $('membersEditor').scrollIntoView({block:'nearest',behavior:'smooth'});$('membersInviteForm').elements.email.focus();
}
function editForm(id){
 editing=detail.members.find(member=>member.id===id);if(!editing?.canEdit)return;
 const accessOptions=levels.map((label,value)=>({label,value})).filter(option=>detail.role==='owner'||option.value<=detail.maxClothing||option.value===editing.clothing);
 $('membersEditor').innerHTML=`<section class="um-panel"><h3>Edit access · ${escape(editing.name)}</h3><p class="um-muted">${escape(detail.business.name)}</p>
 <form id="membersEditForm" class="um-form"><label>Business role<select name="role" required>${roleOptions(editing.role)}</select></label>
 ${detail.clothingAvailable?`<label>Clothing Inventory<select name="clothing">${accessOptions.map(option=>`<option value="${option.value}" ${option.value===editing.clothing?'selected':''}>${option.label}</option>`).join('')}</select></label>`:''}
 <p class="um-muted">Saved changes apply across this person's UiDs. Removing access takes effect on their next request.</p>
 <div class="um-actions"><button type="submit">Save access</button><button type="button" class="um-quiet" data-um="cancel-edit">Cancel</button>
 <button type="button" class="um-danger" data-um="confirm-remove">Remove member</button></div></form></section>`;
 const form=$('membersEditForm');function ownerAccess(){if(form.elements.clothing){const owner=form.elements.role.value==='owner';if(owner)form.elements.clothing.value='3';form.elements.clothing.disabled=owner;}}
 form.elements.role.addEventListener('change',ownerAccess);ownerAccess();$('membersEditor').scrollIntoView({block:'nearest',behavior:'smooth'});
}
async function run(operation){
 if(busy)return;busy=true;stage.setAttribute('aria-busy','true');stage.querySelectorAll('button,input,select').forEach(node=>node.disabled=true);
 try{await operation();}catch(error){notice(error.message,true);}finally{busy=false;stage.removeAttribute('aria-busy');
  stage.querySelectorAll('button,input,select').forEach(node=>node.disabled=false);
  const form=$('membersEditForm');if(form?.elements.clothing&&form.elements.role.value==='owner')form.elements.clothing.disabled=true;}
}
async function changed(message){refreshContactProfiles();await refreshOverview();await load();notice(message);}
stage.addEventListener('submit',event=>{
 event.preventDefault();const form=event.target;
 if(form.id==='membersInviteForm'){const input={email:form.elements.email.value,role:form.elements.role.value};return run(async()=>{
  const result=await api('invite',{business,invitation:input});await changed(result.delivered?'Invitation sent.':'Invitation saved. Email delivery failed; they can still accept it from Members in their UiD.');});}
 if(form.id==='membersEditForm'&&editing){const member={userId:editing.id,role:form.elements.role.value,clothing:form.elements.clothing?Number(form.elements.clothing.value):editing.clothing,version:editing.version};
  return run(async()=>{await api('change',{business,member});editing=null;await changed('Member access saved.');});}
});
stage.addEventListener('click',event=>{
 const button=event.target.closest('[data-um]');if(!button||busy)return;const action=button.dataset.um;
 if(action==='home')return root.showHome?.();if(action==='refresh')return run(async()=>{refreshContactProfiles();await refreshOverview();await load();});
 if(action==='open-work-deck'){event.preventDefault();close();return root.WorkDeck?.open({deckId:button.dataset.id});}
 if(action==='open-cid'){business=button.dataset.business;return load();}
 if(action==='invite')return inviteForm();if(action==='edit')return editForm(button.dataset.id);
 if(action==='cancel-edit'){editing=null;$('membersEditor').replaceChildren();return;}
 if(action==='accept'||action==='decline')return run(async()=>{await api(action,{business:button.dataset.business,invitationId:button.dataset.id});
  business=action==='accept'?button.dataset.business:business;await changed(action==='accept'?'Invitation accepted. The business Channel is now available.':'Invitation declined.');});
 if(action==='revoke')return run(async()=>{await api('revoke',{business,invitationId:button.dataset.id});await changed('Invitation withdrawn.');});
 if(action==='confirm-remove'&&editing){$('membersEditor').innerHTML=`<section class="um-panel"><h3>Remove ${escape(editing.name)}?</h3><p>This removes their membership and Clothing Inventory access for ${escape(detail.business.name)}.</p>
 <div class="um-actions"><button type="button" class="um-danger" data-um="remove">Remove member</button><button type="button" data-um="edit" data-id="${escape(editing.id)}">Keep member</button></div></section>`;return;}
 if(action==='remove'&&editing){const member={userId:editing.id,role:editing.role,clothing:editing.clothing,version:editing.version};return run(async()=>{
  await api('remove',{business,member});editing=null;await changed('Membership removed.');});}
});
stage.addEventListener('change',event=>{if(event.target.id==='membersBusiness'){business=event.target.value;load();}});
function reconcile(){
 const tabs=$('stageTabs');
 if(tabs&&overview){
  tabs.querySelectorAll('[data-um="business"]').forEach(node=>{if(!overview.businesses.some(item=>item.id===node.dataset.umBusiness))node.remove();});
  for(const item of overview.businesses){
   let button=[...tabs.querySelectorAll('button')].find(node=>(node.querySelector('strong')?.textContent||'').trim().toLowerCase()===item.name.toLowerCase()||node.dataset.umBusiness===item.id);
   if(!button){button=document.createElement('button');button.className='tab';button.type='button';button.dataset.um='business';button.innerHTML=`<strong>${escape(item.name)}</strong><small>${escape(item.roleLabel)}</small>`;tabs.append(button);}
   button.dataset.umBusiness=item.id;
   const caption=button.querySelector('small');if(caption&&caption.firstChild?.nodeType===Node.TEXT_NODE&&caption.firstChild.nodeValue.trim()!==item.roleLabel)
    caption.firstChild.nodeValue=item.roleLabel+' ';
  }
  markChannel();
 }
 document.querySelectorAll('[data-tile="people"],.nav button[onclick]').forEach(button=>{
  if(button.dataset.tile==='people'||button.getAttribute('onclick')?.includes("focusCard('people'")){
   button.dataset.um='open';if(/People/.test(button.textContent))button.innerHTML=button.innerHTML.replace(/People/g,'Members');
  }
 });
 let card=$('people');if(!card){const grid=document.querySelector('main>.grid');if(grid){card=document.createElement('section');card.className='card';card.id='people';grid.append(card);}}
 if(card){
  if(!card.querySelector('#peopleRows'))card.innerHTML='<div class="card-head"><h3>Members</h3></div><div id="peopleRows"></div>';
  const rows=$('peopleRows'),id=selectedBusiness(),current=overview?.businesses.find(item=>item.id===id),cached=directory.get(id);
  const label=card.querySelector('h3');if(label&&label.textContent!=='Members')label.textContent='Members';
  const message=overview?(current?`Manage members and access for ${current.name}.`:'View your business memberships and invitations.'):'Members are managed across your business Channels.';
  const signature=JSON.stringify([id,cached?.members.length,overview?.incoming.length,message]);
  if(rows.dataset.membersSignature!==signature||!rows.querySelector('[data-um="open"]')){
   rows.dataset.membersSignature=signature;rows.innerHTML=`<p class="muted">${escape(message)}</p>${overview?.incoming.length?`<p class="count">${overview.incoming.length} invitation${overview.incoming.length===1?'':'s'} for you</p>`:''}<button type="button" class="mini" data-um="open">Open Members →</button>`;
  }
  const count=$('memberCount');if(count){const value=cached?`${cached.members.length} member${cached.members.length===1?'':'s'}${cached.pending.length?' · '+cached.pending.length+' pending':''}`:'';if(count.textContent!==value)count.textContent=value;}
  const channel=$('membersChannel');if(channel){const value=current?current.name+' · Business members':'Your business memberships and invitations';if(channel.textContent!==value)channel.textContent=value;}
 }
}
let queued=false;const observer=new MutationObserver(()=>{if(queued)return;queued=true;queueMicrotask(()=>{queued=false;reconcile();});});
if($('stageTabs'))observer.observe($('stageTabs'),{childList:true});
if($('actionTiles'))observer.observe($('actionTiles'),{childList:true});
const people=$('people');if(people)observer.observe(people,{childList:true,subtree:true});
document.addEventListener('click',event=>{
 const button=event.target.closest('[data-um="open"],[data-um="business"]');if(!button)return;
 event.preventDefault();event.stopPropagation();open({business:button.dataset.umBusiness||selectedBusiness()});
},true);
root.openInvite=()=>open({business:selectedBusiness(),invite:true});
function loadScript(file){if(loadedScripts.has(file))return loadedScripts.get(file);const promise=new Promise((resolve,reject)=>{
 const script=document.createElement('script');script.src='/shared/uid-members/'+file;script.onload=resolve;script.onerror=()=>reject(Error('Clothing Inventory could not be opened. Please retry.'));document.head.append(script);});loadedScripts.set(file,promise);promise.catch(()=>loadedScripts.delete(file));return promise;}
async function openClothing(id){
 await refreshOverview();const item=overview.businesses.find(entry=>entry.id===id);
 if(!item?.tools.clothing.available||!item.tools.clothing.level)throw Error('You do not have Clothing Inventory access in this business.');
 clothingBusiness=id;
 if(!root.ClothingUI){
  if(!$('inventoryStage')){const anchor=document.createElement('section');anchor.id='inventoryStage';anchor.hidden=true;stage.before(anchor);}
  const css=document.createElement('link');css.rel='stylesheet';css.href='/shared/uid-members/clothing.css';document.head.append(css);
  for(const file of ['clothing-csv.js','clothing-save.js','qrcode.js','clothing-store-filters.js','clothing-store-products.js','clothing-photo-fill.js','clothing.js'])await loadScript(file);
 }
 close();await root.ClothingUI.open();applyClothingAccess();
}
function applyClothingAccess(){
 const clothing=$('clothingStage');if(!clothing||clothing.hidden||!overview)return;
 const access=overview.businesses.find(entry=>entry.id===clothingBusiness)?.tools.clothing.level||0;
 if(!access){root.ClothingUI?.leave();return;}
 const restrict=(node,property,denied)=>{const key=property==='hidden'?'umHidden':'umDisabled';
  if(denied){if(!(key in node.dataset))node.dataset[key]=String(node[property]);node[property]=true;}
  else if(key in node.dataset){node[property]=node.dataset[key]==='true';delete node.dataset[key];}
 };
 clothing.querySelectorAll('[data-cl="new"],[data-cl="import-confirm"],[data-cl="read-photos"],[data-cl="apply-photo-fields"],#clImport').forEach(node=>restrict(node,'hidden',access<2));
 clothing.querySelectorAll('#clForm input,#clForm textarea,#clForm select,#clForm button,#clMove input,#clMove select,#clMove button').forEach(node=>restrict(node,'disabled',access<2));
 clothing.querySelectorAll('button[value="publish"]').forEach(node=>restrict(node,'hidden',access<3));
}
const clothesObserver=new MutationObserver(applyClothingAccess);clothesObserver.observe(document.querySelector('main')||document.body,{childList:true,subtree:true});
root.UIDMembers={open,close,openClothing,openInventories,toolUrl(path){const url=new URL(path,location.origin);if(clothingBusiness)url.searchParams.set('business',clothingBusiness);return url.pathname+url.search;}};
reconcile();refreshOverview().catch(()=>{});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshOverview().then(()=>{applyClothingAccess();if(opened){refreshContactProfiles();load();}}).catch(()=>{});});
root.setInterval(()=>{if(!document.hidden)refreshOverview().then(applyClothingAccess).catch(()=>{});},30000);
})(window);
