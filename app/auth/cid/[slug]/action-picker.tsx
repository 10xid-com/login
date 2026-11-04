'use client';
import {useState} from 'react';
import {CID_ACTIONS,DEFAULT_CID_ACTIONS} from '@/lib/cid/profile';
import {inputClass,labelClass} from '../../auth-card';
/** Same six-slot swap behaviour as PiD Actions; publishing uses the protected form. */
export function ActionPicker({initial}:{initial:string[]}){
 const [slots,setSlots]=useState(initial);
 function place(index:number,id:string){
  setSlots(current=>{const next=current.slice(),other=next.indexOf(id);
   if(other!==-1)next[other]=next[index];next[index]=id;return next;});
 }
 return <section id="actions" className="space-y-3 rounded-xl border border-slate-300 p-3">
  <h2 className="font-semibold">Action buttons</h2>
  <p>Choose and reorder the six public buttons. Choosing a button already in the row swaps the two. Publish to save this company’s layout on every device.</p>
  {slots.map((id,index)=><label key={index} className={labelClass}>Button {index+1}
   <select name="actions" value={id} onChange={event=>place(index,event.target.value)} className={inputClass}>
    {CID_ACTIONS.map(action=><option key={action.id} value={action.id}>{action.icon} {action.label}</option>)}
   </select>
  </label>)}
  <button type="button" onClick={()=>setSlots(DEFAULT_CID_ACTIONS.slice())} className="underline">Reset buttons</button>
 </section>;
}
