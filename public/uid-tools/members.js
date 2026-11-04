/* One Members feature for every UiD. Data and authority always come from the central business API. */
(function(root){
'use strict';
if(root.UIDMembers)return;
const $=id=>document.getElementById(id),escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const levels=['No access','View only','Edit','Edit and publish'];
let overview=null,business='',detail=null,opened=false,busy=false,request=0,clothingBusiness='',editing=null,fetchingOverview=null,heldChannels=null;
const directory=new Map(),loadedScripts=new Map();
const stage=document.createElement('section');stage.id='membersStage';stage.hidden=true;stage.setAttribute('aria-label','Members');
(document.querySelector('main')||document.body).append(stage);
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
  if(!value.businesses.some(b=>b.id===business))business=value.businesses[0]?.id||'';
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
function close(){opened=false;stage.hidden=true;document.body.classList.remove('members-open');editing=null;request++;
 if(heldChannels)for(const item of heldChannels){if(!item.node.isConnected)continue;item.node.classList.toggle('selected',item.selected);
  if(item.pressed===null)item.node.removeAttribute('aria-pressed');else item.node.setAttribute('aria-pressed',item.pressed);}
 heldChannels=null;
}
const home=root.showHome;
if(typeof home==='function')root.showHome=function(){close();return home.apply(this,arguments);};
function header(){
 return `<div class="um-top"><button type="button" data-um="home">← Control Room</button><button type="button" data-um="refresh">Refresh</button></div>
 <div class="um-title"><div><span class="um-kicker">BUSINESS ACCESS</span><h2>Members</h2></div>
 <label>Channel<select id="membersBusiness" ${busy?'disabled':''}><option value="">Choose a business</option>${(overview?.businesses||[]).map(b=>`<option value="${escape(b.id)}" ${b.id===business?'selected':''}>${escape(b.name)}</option>`).join('')}</select></label></div>
 <div id="membersNotice" class="um-notice" role="status" hidden></div>`;
}
function received(){
 if(!overview?.incoming.length)return '';
 return `<section class="um-panel"><h3>Invitations for you <span class="um-count">${overview.incoming.length}</span></h3><div class="um-list">${overview.incoming.map(invite=>`
 <div class="um-row"><div><strong>${escape(invite.business_name)}</strong><small>${escape(roleLabel(invite.role))} · Sent to ${escape(invite.email)}</small></div>
 <div class="um-actions"><button type="button" data-um="accept" data-id="${escape(invite.id)}" data-business="${escape(invite.business_id)}">Accept</button>
 <button type="button" class="um-quiet" data-um="decline" data-id="${escape(invite.id)}" data-business="${escape(invite.business_id)}">Decline</button></div></div>`).join('')}</div></section>`;
}
function roleLabel(role){return overview?.roles.find(option=>option.value===role)?.label||role;}
function tools(){
 const current=overview?.businesses.find(b=>b.id===business),tool=current?.tools.clothing;
 if(!tool?.available)return '';
 return `<section class="um-panel um-tool"><div><h3>Clothing Inventory</h3><p>${escape(levels[tool.level])}</p></div>${tool.level?'<button type="button" data-um="clothing">Open Clothing Inventory →</button>':'<span class="um-muted">Ask a business owner for access.</span>'}</section>`;
}
function render(){
 stage.innerHTML=header()+received()+tools();
 if(!business){stage.insertAdjacentHTML('beforeend','<section class="um-panel"><h3>Your business Channels</h3><p>No business memberships are available. Accepted invitations will appear here.</p></section>');return;}
 if(!detail){stage.insertAdjacentHTML('beforeend','<section class="um-panel"><p>Loading members…</p></section>');return;}
 stage.insertAdjacentHTML('beforeend',`<section class="um-panel"><div class="um-panel-head"><div><h3>${escape(detail.business.name)}</h3>
 <p>${detail.members.length} ${detail.directoryVisible?'member'+(detail.members.length===1?'':'s'):'membership'}${detail.pending.length?' · '+detail.pending.length+' pending':''}</p></div>
 ${detail.canManage?'<button type="button" data-um="invite">+ Invite member</button>':''}</div>
 ${!detail.directoryVisible?'<p class="um-muted">You can view your membership. An owner or manager can manage the full member list.</p>':''}
 <div class="um-list">${detail.members.map(member=>`<div class="um-row"><div class="um-person"><strong>${escape(member.name)}${member.id===overview.actor.id?' <span class="um-you">You</span>':''}</strong>
 <small>${escape(member.email)}</small><div class="um-tags"><span>${escape(roleLabel(member.role))}</span>${detail.clothingAvailable?`<span>Clothing · ${escape(levels[member.clothing])}</span>`:''}</div></div>
 ${member.canEdit?`<button type="button" class="um-quiet" data-um="edit" data-id="${escape(member.id)}">Edit access</button>`:''}</div>`).join('')||'<p>No members.</p>'}</div></section>
 ${detail.pending.length?`<section class="um-panel"><h3>Pending invitations</h3><div class="um-list">${detail.pending.map(invite=>`<div class="um-row"><div><strong>${escape(invite.email)}</strong>
 <small>${escape(roleLabel(invite.role))} · ${new Date(invite.expires_at).getTime()<Date.now()?'Expired':'Awaiting acceptance'}</small></div>
 ${detail.role==='owner'||invite.role!=='owner'?`<button type="button" class="um-quiet" data-um="revoke" data-id="${escape(invite.id)}">Withdraw</button>`:''}</div>`).join('')}</div></section>`:''}
 <div id="membersEditor"></div>`);
}
async function open(options={}){
 root.showHome?.();root.VendorUI?.close?.();root.InventoryUI?.leave?.();root.ClothingUI?.leave?.();root.WorkDeck?.close?.();root.TaskUI?.closeCard?.();
 opened=true;stage.hidden=false;document.body.classList.add('members-open');detail=null;render();
 try{await refreshOverview();business=options.business||selectedBusiness();await load();if(options.invite&&detail?.canManage)inviteForm();}
 catch(error){render();notice(error.message,true);}
}
async function load(){
 const ticket=++request;detail=null;render();markChannel();if(!business)return;
 try{const result=await api('members',{business});if(ticket!==request||!opened)return;detail=result;directory.set(business,result);render();reconcile();}
 catch(error){if(ticket===request){render();notice(error.message,true);}}
}
function roleOptions(value){return overview.roles.filter(r=>r.value!=='owner'||detail.role==='owner').map(r=>`<option value="${r.value}" ${r.value===value?'selected':''}>${escape(r.label)}</option>`).join('');}
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
 <form id="membersEditForm" class="um-form"><label>Business role<select name="role">${roleOptions(editing.role)}</select></label>
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
async function changed(message){await refreshOverview();await load();notice(message);}
stage.addEventListener('submit',event=>{
 event.preventDefault();const form=event.target;
 if(form.id==='membersInviteForm'){const input={email:form.elements.email.value,role:form.elements.role.value};return run(async()=>{
  const result=await api('invite',{business,invitation:input});await changed(result.delivered?'Invitation sent.':'Invitation saved. Email delivery failed; they can still accept it from Members in their UiD.');});}
 if(form.id==='membersEditForm'&&editing){const member={userId:editing.id,role:form.elements.role.value,clothing:form.elements.clothing?Number(form.elements.clothing.value):editing.clothing,version:editing.version};
  return run(async()=>{await api('change',{business,member});editing=null;await changed('Member access saved.');});}
});
stage.addEventListener('click',event=>{
 const button=event.target.closest('[data-um]');if(!button||busy)return;const action=button.dataset.um;
 if(action==='home')return root.showHome?.();if(action==='refresh')return run(async()=>{await refreshOverview();await load();});
 if(action==='invite')return inviteForm();if(action==='edit')return editForm(button.dataset.id);
 if(action==='cancel-edit'){editing=null;$('membersEditor').replaceChildren();return;}
 if(action==='clothing')return run(()=>openClothing(business));
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
root.UIDMembers={open,close,openClothing,toolUrl(path){const url=new URL(path,location.origin);if(clothingBusiness)url.searchParams.set('business',clothingBusiness);return url.pathname+url.search;}};
reconcile();refreshOverview().catch(()=>{});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshOverview().then(()=>{applyClothingAccess();if(opened)load();}).catch(()=>{});});
root.setInterval(()=>{if(!document.hidden)refreshOverview().then(applyClothingAccess).catch(()=>{});},30000);
})(window);
