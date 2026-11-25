import { useEffect, useState } from 'react';
import { Courses } from './Courses';
import { AdminPanel } from './AdminPanel';
import { RoleTesting } from './RoleTesting';
import { Home } from './Home';
type Identity = { oid: string; email: string | null; name: string | null };
export function App() {
  const [showAdmin, setShowAdmin] = useState(false);
  const [role, setRole] = useState('student');
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [roleTesting,setRoleTesting] = useState(false);
  const [viewVersion,setViewVersion] = useState(0);
  const [showCourses,setShowCourses]=useState(false);
  async function reloadIdentity(){
    const r=await fetch('/api/me');
    if(!r.ok)throw new Error('Could not refresh your test session. Reload the page.');
    const data=await r.json();setIdentity(data.identity);setRole(data.user.role);setRoleTesting(data.roleTesting===true);setShowAdmin(data.user.role==='admin');setShowCourses(false);setViewVersion(v=>v+1);
  }
  useEffect(() => {
    const pin=new URLSearchParams(location.search).get('pin');if(pin&&/^\d{6}$/.test(pin))sessionStorage.setItem('codeline:pin',pin);
    if (new URLSearchParams(location.search).has('authError')) setError('Microsoft sign-in failed. Please try again.');
    const controller = new AbortController();
    fetch('/api/me', { signal: controller.signal }).then(async r => {
      if (r.ok) { const data = await r.json(); setIdentity(data.identity); setRole(data.user.role); setRoleTesting(data.roleTesting===true); setShowAdmin(data.user.role === 'admin'); }
      else if (r.status !== 401) setError('Could not reach CodeLine. Please try again.');
    }).catch(e => { if (e.name !== 'AbortError') setError('Could not reach CodeLine. Please try again.'); });
    return () => controller.abort();
  }, []);
  function home(){const url=new URL(location.href);url.searchParams.delete('game');url.searchParams.delete('pin');window.history.pushState({},'',url);setShowCourses(false);setShowAdmin(false);}
  async function signIn() {
    setBusy(true); setError('');
    try {
      const r = await fetch('/api/config');
      if (!r.ok) throw new Error('Could not reach CodeLine. Please try again.');
      if (!(await r.json()).microsoftConfigured) throw new Error('SIT sign-in is not available yet. Please contact the lecturer.');
      location.assign('/auth/start');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not sign in.'); setBusy(false); }
  }
  async function signOut() {
    setBusy(true);
    try {
      const r = await fetch('/auth/logout', { method: 'POST' });
      if (!r.ok) throw new Error('Could not sign out. Please try again.');
      setIdentity(null); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not sign out.'); }
    finally { setBusy(false); }
  }
  if (identity) return <>
    {roleTesting&&<RoleTesting role={role} changed={reloadIdentity}/>}
    {error && <p role="alert" className="alert-error">{error}</p>}
    {role==='admin' && showAdmin ? <AdminPanel key={viewVersion} name={identity.name || identity.email || 'SIT user'} selfId={identity.oid} onSignOut={signOut} onCourses={()=>{setShowAdmin(false);setShowCourses(true);}}/> : showCourses?
    <Courses key={viewVersion} name={identity.name || identity.email || 'SIT user'} role={role} onSignOut={signOut} onAdmin={()=>setShowAdmin(true)} onHome={home}/>:
    <Home key={viewVersion} name={identity.name || identity.email || 'SIT user'} role={role} onSignOut={signOut} onAdmin={()=>setShowAdmin(true)} onCourses={()=>setShowCourses(true)}/>}
  </>;
  return <main className="min-h-dvh grid place-items-center p-5">
    <section aria-labelledby="brand" className="login-card w-full max-w-[480px] rounded-lg border border-[#333654] bg-[#1c1f36] p-6 sm:p-10 flex flex-col items-center gap-[18px]">
      <h1 id="brand" className="brand text-[24px] sm:text-[28px] text-[#ffd133]">CODELINE</h1>
      <p className="text-center text-base text-[#a6abcc]">Arrange the code. One line each.</p>
      <div className="code-sample w-full rounded-md bg-[#0a0a17] px-[14px] py-3 text-[13px] leading-[1.6] overflow-x-auto" aria-label="Example code">
        <div className="whitespace-pre">for i in range(1, n+1):</div>
        <div className="whitespace-pre text-[#5ce38c]">{'    total += i   Ploy'}</div>
        <div className="whitespace-pre text-[#ffd133]">{'    ____________  ← you?'}</div>
      </div>
      <button className="primary-button" disabled={busy} onClick={signIn}>{busy ? 'Connecting…' : 'Sign in with SIT account'}</button>
      {error && <p role="alert" className="text-sm text-center text-[#ff8585]">{error}</p>}
    </section>
  </main>;
}
