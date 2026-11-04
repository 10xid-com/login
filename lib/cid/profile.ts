/** Only explicitly public fields live here. Never project customer/member/work data. */
export const CID_COMPANIES = {
  rotary: {name:'Rotary',organizationSlug:'rotary-store'},
  brandingcentres: {name:'Branding Centres',organizationSlug:'branding-centres'},
  vinylwraptoronto: {name:'Vinyl Wrap Toronto',organizationSlug:'vinyl-wrap-toronto'},
  wrapauthority: {name:'Wrap Authority',organizationSlug:'wrap-authority'},
  workweartoronto: {name:'Workwear Toronto',organizationSlug:'workwear-toronto'},
} as const;
export type CidSlug = keyof typeof CID_COMPANIES;
export function isCidSlug(value:unknown):value is CidSlug {
  return typeof value==='string' && Object.hasOwn(CID_COMPANIES,value);
}
export function cidUrl(slug:CidSlug){return `https://cid-${slug}.10xid.com/`;}
export const PROFILE_LIMITS = {displayName:100,description:500,website:500,email:200,phone:60,address:500,
  instagram:500,facebook:500,linkedin:500,ownershipLabel:150,logoUrl:500,mapsUrl:500} as const;
export const CID_ACTIONS = [
  {id:'overview',label:'Overview',icon:'◫'}, {id:'profile',label:'Profile',icon:'▣'},
  {id:'links',label:'Web links',icon:'↗'}, {id:'website',label:'Website',icon:'◎'},
  {id:'email',label:'Email',icon:'✉'}, {id:'phone',label:'Call',icon:'☎'},
  {id:'instagram',label:'Instagram',icon:'▧'}, {id:'facebook',label:'Facebook',icon:'f'},
  {id:'linkedin',label:'LinkedIn',icon:'in'}, {id:'address',label:'Location',icon:'⌖'},
  {id:'manage',label:'Manage CiD',icon:'✎'},
] as const;
export const DEFAULT_CID_ACTIONS = ['overview','profile','links','website','email','phone'];
export function validateActions(input:unknown):string[]{
  if(input===undefined)return DEFAULT_CID_ACTIONS.slice();
  if(!Array.isArray(input)||input.length!==6||new Set(input).size!==6||
    !input.every(id=>typeof id==='string'&&CID_ACTIONS.some(action=>action.id===id)))
    throw Error('Choose six different Action buttons.');
  return input.slice();
}
export type CidProfile = Record<keyof typeof PROFILE_LIMITS,string> & {showOwnership:boolean;actions:string[]};
export function emptyProfile(slug:CidSlug):CidProfile {
  return {...Object.fromEntries(Object.keys(PROFILE_LIMITS).map(key=>[key,''])),displayName:CID_COMPANIES[slug].name,showOwnership:false,actions:DEFAULT_CID_ACTIONS.slice()} as CidProfile;
}
export function validateProfile(input:unknown):CidProfile {
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Enter a valid company profile.');
  const data=input as Record<string,unknown>,out={} as CidProfile;
  for(const [field,max] of Object.entries(PROFILE_LIMITS)){
    const value=data[field]??'';
    if(typeof value!=='string'||value.length>max)throw Error(`Check ${field} (maximum ${max} characters).`);
    out[field as keyof typeof PROFILE_LIMITS]=value.trim();
  }
  if(!out.displayName)throw Error('Enter a display name.');
  for(const field of ['website','instagram','facebook','linkedin','logoUrl','mapsUrl'] as const){
    if(!out[field])continue;
    try{const url=new URL(out[field]);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||
      (field==='logoUrl'&&url.protocol!=='https:'))throw Error();}
    catch{throw Error(`Enter a valid ${field} URL without credentials${field==='logoUrl'?' using HTTPS':''}.`);}
  }
  if(out.mapsUrl){
    const map=new URL(out.mapsUrl);
    if(map.protocol!=='https:'||!['www.google.com','google.com','maps.google.com','maps.app.goo.gl','g.page','www.google.ca'].includes(map.hostname))throw Error('Use a Google Maps location URL.');
  }
  if(out.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email))throw Error('Enter a valid contact email.');
  out.actions=validateActions(data.actions);
  out.showOwnership=data.showOwnership===true;
  // A hidden label is never sent to the public API, including to page source.
  if(!out.showOwnership)out.ownershipLabel='';
  return out;
}
export function mayEditCid(role:string,grants:{capability:string;deny:boolean}[]){
  const relevant=grants.filter(grant=>grant.capability==='cid.profile.write');
  if(relevant.some(grant=>grant.deny))return false;
  return ['owner','manager','editor','publisher'].includes(role)||relevant.some(grant=>!grant.deny);
}
