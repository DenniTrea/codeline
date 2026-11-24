import { useEffect, useState, type FormEvent } from 'react';
import { Shell } from './Shell';
import { api } from './api';
type Exercise={id:number;title:string;topic:string;exerciseState:boolean;preview:string;lineCount:number;courseCode:string;usedCount:number;lastUsed:string|null};
export function Home({name,role,onSignOut,onAdmin,onCourses}:{name:string;role:string;onSignOut:()=>void;onAdmin:()=>void;onCourses:()=>void}){
  const student=role==='student';
  const [items,setItems]=useState<Exercise[]>([]),[loading,setLoading]=useState(!student),[error,setError]=useState('');
  const [search,setSearch]=useState(''),[filter,setFilter]=useState('All'),[sort,setSort]=useState('lastUsed');
  const [pin,setPin]=useState(''),[message,setMessage]=useState('');
  useEffect(()=>{if(student)return;let active=true;api<{exercises:Exercise[]}>('/api/exercises').then(data=>{if(active)setItems(data.exercises);}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[student]);
  function join(e:FormEvent){e.preventDefault();setMessage('Live game joining is not available yet. Your sign-in is ready; the game flow still needs to be implemented.');}
  const topics=[...new Set(items.map(e=>e.topic))];
  const filtered=items.filter(e=>(filter==='All'||(filter==='Draft'?!e.exerciseState:e.topic===filter))&&`${e.title} ${e.topic}`.toLowerCase().includes(search.toLowerCase())).sort((a,b)=>sort==='title'?a.title.localeCompare(b.title):(new Date(b.lastUsed||0).getTime()-new Date(a.lastUsed||0).getTime())||b.id-a.id);
  return <Shell name={name} role={role} title={student?'Join':'Exercise library'} onSignOut={onSignOut} onAdmin={onAdmin} onCourses={onCourses}>
    {student?<main className="join-main"><form className="join-card panel" onSubmit={join}>
      <h1 className="brand">JOIN A GAME</h1><p className="join-identity">Signed in as {name} (SIT)</p>
      <label className="sr-only" htmlFor="game-pin">Session PIN</label><input id="game-pin" aria-describedby="pin-help" className="pin-input brand" autoComplete="off" inputMode="numeric" pattern="[0-9]{3} ?[0-9]{3}" required placeholder="000 000" maxLength={7} value={pin.length>3?`${pin.slice(0,3)} ${pin.slice(3)}`:pin} onChange={e=>{setPin(e.target.value.replace(/\D/g,'').slice(0,6));setMessage('');}}/>
      <button className="primary-button" disabled={pin.length!==6}>Enter</button><p id="pin-help" className="muted">The PIN is on the projector screen.</p>{message&&<p role="status" className="join-message">{message}</p>}
    </form></main>:<main className="exercise-library">
      <div className="library-title"><h1 className="brand">MY EXERCISES</h1><div className="flex gap-3"><button className="secondary-button pixel-button" disabled title="File import is not implemented yet">Import</button><button className="primary-button" disabled title="The exercise editor is not implemented yet">+ New exercise</button></div></div>
      <div className="library-toolbar"><label className="sr-only" htmlFor="exercise-search">Search exercises</label><input id="exercise-search" className="form-input" placeholder="Search exercises..." value={search} onChange={e=>setSearch(e.target.value)}/><div className="topic-filters" aria-label="Exercise filters">{['All',...topics,'Draft'].map(f=><button key={f} aria-pressed={filter===f} className={filter===f?'active':''} onClick={()=>setFilter(f)}>{f==='All'?`ALL ${items.length}`:f}</button>)}</div><label className="library-sort">Sort: <select aria-label="Sort exercises" value={sort} onChange={e=>setSort(e.target.value)}><option value="lastUsed">Last used</option><option value="title">Title</option></select></label></div>
      {error&&<p role="alert" className="alert-error">{error}</p>}
      {loading?<p role="status" className="muted">Loading exercises…</p>:<ul className="exercise-grid">{filtered.map(e=><li className="exercise-card panel" key={e.id}>
        <div className="exercise-tags"><span>{e.topic}</span><span className={e.exerciseState?'ready':'draft'}>{e.exerciseState?'READY':'DRAFT'}</span></div><h2>{e.title}</h2><pre>{e.preview||'No code lines yet.'}</pre><p className="exercise-meta">{e.lineCount} lines · {e.courseCode} <span>{e.usedCount?`Used ${e.usedCount}× · last ${e.lastUsed?new Date(e.lastUsed).toLocaleDateString('en-GB',{day:'numeric',month:'short'}):'—'}`:'Not used yet'}</span></p><div className="exercise-card-actions"><button disabled title="Exercise editor is not implemented yet" className="secondary-button pixel-button">Edit</button><button disabled title="Copy is not implemented yet" className="secondary-button pixel-button">Copy</button><button disabled title="Exercise deletion is not implemented yet" className="danger-button pixel-button">Delete</button><button disabled title="Live games are not implemented yet" className="primary-button">Start</button></div>
      </li>)}</ul>}
      {!loading&&!error&&!filtered.length&&<section className="library-empty panel"><h2>{items.length?'No matching exercises':'No exercises yet'}</h2><p className="muted">{items.length?'Try another search or filter.':'Your saved exercises will appear here. Exercise creation is the next implementation step.'}</p></section>}
    </main>}
  </Shell>;
}
