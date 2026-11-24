import { useCallback, useEffect, useState, useRef, type FormEvent } from 'react';
import { api } from './api';
import { Shell } from './Shell';
type User = {id:string; email:string; role:string; displayName:string|null; studentNumber:string|null; enrolledCount?:number};
type Course = {id:number; code:string; studentCount:number; enrolledCount:number};
type Summary = {accounts:number; students:number; courses:number; enrollments:number; openSessions:number; database:string};
const roles = ['student','ta','lecturer','admin'];
function AccountRow({ user, selfId, changed, fail }: {user:User; selfId:string; changed:()=>Promise<void>; fail:(message:string)=>void}) {
  const [role,setRole]=useState(user.role);
  const [name,setName]=useState(user.displayName || '');
  const [number,setNumber]=useState(user.studentNumber || '');
  const [busy,setBusy]=useState(false);
  async function save(kind:'role'|'student') {
    setBusy(true);
    try {
      await api(`/api/admin/users/${user.id}/${kind}`, {method:'PATCH',body:JSON.stringify(kind==='role'?{role}:{displayName:name,studentNumber:number.trim()||null})});
      await changed();
    } catch(e) {fail((e as Error).message);}
    finally {setBusy(false);}
  }
  return <article className="admin-row">
    <div className="min-w-0"><h3 className="font-medium break-all">{user.email} {user.id===selfId && <span className="text-[#ffd133]">(you)</span>}</h3><p className="muted mt-1">{user.displayName || 'No student profile'} · {user.enrolledCount || 0} course enrollments</p></div>
    <form className="flex flex-wrap items-end gap-3" onSubmit={e=>{e.preventDefault();void save('role');}}>
      <label className="field-label">Role<select aria-label={`Role for ${user.email}`} className="form-input" value={role} disabled={busy||user.id===selfId} onChange={e=>setRole(e.target.value)}>{roles.map(r=><option key={r}>{r}</option>)}</select></label>
      <button className="secondary-button" disabled={busy||role===user.role||user.id===selfId}>Save role</button>
    </form>
    {user.role==='student' && <details className="lg:col-span-2"><summary className="text-sm text-[#a6abcc] cursor-pointer">Edit student profile</summary>
      <form className="grid sm:grid-cols-[1fr_1fr_auto] gap-3 items-end mt-3" onSubmit={e=>{e.preventDefault();void save('student');}}>
        <label className="field-label">Display name<input className="form-input" required maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></label>
        <label className="field-label">Student number (optional)<input className="form-input" inputMode="numeric" pattern="[0-9]{11}" maxLength={11} value={number} onChange={e=>setNumber(e.target.value)}/></label>
        <button disabled={busy} className="secondary-button">Save profile</button>
      </form>
    </details>}
  </article>;
}
export function AdminPanel({name,selfId,onSignOut,onCourses}:{name:string;selfId:string;onSignOut:()=>void;onCourses:()=>void}) {
  const [tab,setTab]=useState<'overview'|'accounts'|'courses'>('overview');
  const [summary,setSummary]=useState<Summary|null>(null);
  const [users,setUsers]=useState<User[]>([]);
  const [courses,setCourses]=useState<Course[]>([]);
  const [members,setMembers]=useState<User[]>([]);
  const [candidates,setCandidates]=useState<User[]>([]);
  const [q,setQ]=useState(''); const [role,setRole]=useState(''); const [offset,setOffset]=useState(0); const [more,setMore]=useState(false);
  const [candidateInput,setCandidateInput]=useState('');
  const usersRequest = useRef(0); const rosterRequest = useRef(0);
  const [studentQ,setStudentQ]=useState(''); const [candidateQ,setCandidateQ]=useState('');const [candidatePage,setCandidatePage]=useState(0);const [candidateMore,setCandidateMore]=useState(false);
  const [selectedCourse,setSelectedCourse]=useState(''); const [selected,setSelected]=useState<string[]>([]);
  const [editId,setEditId]=useState<number|null>(null);const [code,setCode]=useState('');const [count,setCount]=useState('0');
  const [busy,setBusy]=useState(false);const [loading,setLoading]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');
  const [remove,setRemove]=useState<{user:User;courseId:string;courseCode:string}|null>(null);
  const [courseToDelete,setCourseToDelete]=useState<Course|null>(null);
  const [confirmCode,setConfirmCode]=useState('');
  const dialogRef=useRef<HTMLElement>(null);
  useEffect(()=>{
    if(!remove&&!courseToDelete)return;
    const previous=document.activeElement as HTMLElement|null;
    const handle=(event:KeyboardEvent)=>{
      if(event.key==='Escape'&&!busy){event.preventDefault();setRemove(null);setCourseToDelete(null);}
      if(event.key==='Tab'){
        const buttons=dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)');
        if(!buttons?.length){event.preventDefault();return;}
        const first=buttons[0],last=buttons[buttons.length-1];
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
      }
    };
    document.addEventListener('keydown',handle);
    return()=>{document.removeEventListener('keydown',handle);previous?.focus();};
  },[remove,courseToDelete,busy]);
  const fail=(message:string)=>{setError(message);setNotice('');};
  const loadBase=useCallback(async()=>{
    const [s,c]=await Promise.all([api<Summary>('/api/admin/summary'),api<{courses:Course[]}>('/api/admin/courses')]);
    setSummary(s);setCourses(c.courses);
  },[]);
  const loadUsers=useCallback(async()=>{
    const requestId=++usersRequest.current;
    const data=await api<{users:User[];hasMore:boolean}>(`/api/admin/users?${new URLSearchParams({q,role,offset:String(offset)})}`);
    if(requestId===usersRequest.current){setUsers(data.users);setMore(data.hasMore);}
  },[q,role,offset]);
  const loadRoster=useCallback(async()=>{
    const requestId=++rosterRequest.current;
    if(!selectedCourse){setMembers([]);setCandidates([]);return;}
    const [roster,available]=await Promise.all([
      api<{students:User[]}>(`/api/admin/courses/${selectedCourse}/students`),
      api<{users:User[];hasMore:boolean}>(`/api/admin/users?${new URLSearchParams({q:candidateQ,role:'student',offset:String(candidatePage)})}`),
    ]);
    if(requestId===rosterRequest.current){setMembers(roster.students);setCandidates(available.users);setCandidateMore(available.hasMore);}
  },[selectedCourse,candidateQ,candidatePage]);
  useEffect(()=>{let active=true;setLoading(true);loadBase().catch(e=>{if(active)fail(e.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[loadBase]);
  useEffect(()=>{if(tab!=='accounts')return;let active=true;setLoading(true);loadUsers().catch(e=>{if(active)fail(e.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[tab,loadUsers]);
  useEffect(()=>{if(tab!=='courses')return;let active=true;setLoading(true);loadRoster().catch(e=>{if(active)fail(e.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[tab,loadRoster]);
  async function refresh(){setError('');setLoading(true);try{await loadBase();if(tab==='accounts')await loadUsers();if(tab==='courses')await loadRoster();}catch(e){fail((e as Error).message);}finally{setLoading(false);}}
  async function saveCourse(e:FormEvent){
    e.preventDefault();setBusy(true);setError('');setNotice('');
    try{
      const data=await api<{course:Course}>(`/api/admin/courses${editId?`/${editId}`:''}`,{method:editId?'PATCH':'POST',body:JSON.stringify({code,studentCount:Number(count)})});
      setSelectedCourse(String(data.course.id));setSelected([]);setNotice(editId?'Course updated.':'Course created.');setCode('');setCount('0');setEditId(null);await loadBase();
    }catch(e){fail((e as Error).message);}finally{setBusy(false);}
  }
  async function enroll(){setBusy(true);setError('');setNotice('');try{
    const r=await api<{added:number;alreadyEnrolled:number}>(`/api/admin/courses/${selectedCourse}/students`,{method:'POST',body:JSON.stringify({studentIds:selected})});
    setSelected([]);setNotice(`${r.added} student(s) enrolled. ${r.alreadyEnrolled} already enrolled.`);await Promise.all([loadBase(),loadRoster()]);
  }catch(e){fail((e as Error).message);}finally{setBusy(false);}}
  async function removeMember(){if(!remove)return;setBusy(true);setError('');try{
    await api(`/api/admin/courses/${remove.courseId}/students/${remove.user.id}`,{method:'DELETE'});setRemove(null);setNotice('Enrollment removed. Account and game history retained.');await Promise.all([loadBase(),loadRoster()]);
  }catch(e){fail((e as Error).message);}finally{setBusy(false);}}
  async function deleteSelectedCourse(){
    if(!courseToDelete)return;
    setBusy(true);setError('');setNotice('');
    try{
      await api(`/api/admin/courses/${courseToDelete.id}`,{method:'DELETE',body:JSON.stringify({confirmCode,expectedEnrolledCount:courseToDelete.enrolledCount})});
      ++rosterRequest.current;setCourseToDelete(null);setSelectedCourse('');setSelected([]);setMembers([]);setCandidates([]);
      if(editId===courseToDelete.id){setEditId(null);setCode('');setCount('0');}
      setNotice('Course deleted. Student accounts retained.');await loadBase();
    }catch(e){fail((e as Error).message);}finally{setBusy(false);}
  }
  const course=courses.find(c=>String(c.id)===selectedCourse);
  const enrolled=new Set(members.map(m=>m.id));
  return <Shell name={name} role="admin" title="Admin panel" onSignOut={onSignOut} onCourses={onCourses}>
    <main className="max-w-7xl mx-auto px-5 py-9">
      <div className="flex justify-between items-center gap-4 mb-3"><h1 className="brand text-lg sm:text-xl text-[#ffd133]">ADMIN PANEL</h1><button className="secondary-button" disabled={loading||busy} onClick={refresh}>Refresh</button></div>
      <p className="muted mb-7">Manage CodeLine accounts, course details and student access.</p>
      <nav aria-label="Admin sections" className="flex flex-wrap gap-2 border-b border-[#333654] pb-4 mb-6">{(['overview','accounts','courses'] as const).map(t=><button key={t} aria-current={tab===t?'page':undefined} className={`admin-tab ${tab===t?'active':''}`} onClick={()=>{setTab(t);setError('');setNotice('');}}>{t==='courses'?'Courses & enrollment':t==='accounts'?'Accounts':'Overview'}</button>)}</nav>
      {error&&!courseToDelete&&<p role="alert" className="alert-error mb-5">{error}</p>}{notice&&<p role="status" className="alert-success mb-5">{notice}</p>}
      {loading&&<p className="muted mb-4" role="status">Loading…</p>}
      {tab==='overview'&&summary&&<>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">{[['Accounts',summary.accounts],['Students',summary.students],['Courses',summary.courses],['Enrollments',summary.enrollments],['Open rooms',summary.openSessions]].map(([label,value])=><div key={label} className="panel p-5"><div className="text-3xl text-[#ffd133] mb-2">{value}</div><div className="muted">{label}</div></div>)}</div>
        <section className="panel p-6 mt-6"><h2 className="text-lg mb-4">System status</h2><p className="text-[#5ce38c]">PostgreSQL connected · Microsoft sign-in configured</p><p className="muted mt-4">Accounts are created by university Microsoft sign-in. Add registered students to courses under Courses & enrollment.</p></section>
      </>}
      {tab==='accounts'&&<>
        <div className="grid sm:grid-cols-[1fr_180px] gap-4 mb-4"><label className="field-label">Search accounts<input className="form-input" placeholder="Email, name or student number" value={q} maxLength={100} onChange={e=>{setQ(e.target.value);setOffset(0);}}/></label><label className="field-label">Filter role<select className="form-input" value={role} onChange={e=>{setRole(e.target.value);setOffset(0);}}><option value="">All roles</option>{roles.map(r=><option key={r}>{r}</option>)}</select></label></div>
        <p className="muted mb-5">Users must sign in once before appearing here. Your own admin role is protected.</p>
        <div className="space-y-3">{users.map(u=><AccountRow key={`${u.id}-${u.role}-${u.displayName}-${u.studentNumber}`} user={u} selfId={selfId} fail={fail} changed={async()=>{setError('');setNotice('Account updated.');await Promise.all([loadBase(),loadUsers()]);}}/>)}</div>
        {!loading&&!users.length&&<p className="muted">No matching accounts.</p>}
        <div className="flex items-center gap-4 mt-5"><button className="secondary-button" disabled={!offset||loading} onClick={()=>setOffset(offset-50)}>Previous accounts</button><span className="muted">Page {offset/50+1}</span><button className="secondary-button" disabled={!more||loading} onClick={()=>setOffset(offset+50)}>Next accounts</button></div>
      </>}
      {tab==='courses'&&<div className="grid lg:grid-cols-[320px_1fr] gap-6 items-start">
        <aside className="space-y-5">
          <form onSubmit={saveCourse} className="panel p-5 space-y-4"><h2 className="text-[#ffd133]">{editId?'Edit course':'Create course'}</h2><label className="field-label block">Course code<input required maxLength={30} className="form-input" value={code} onChange={e=>setCode(e.target.value)} placeholder="CSC213"/></label><label className="field-label block">Planned students<input required type="number" min={0} max={32767} step={1} className="form-input" value={count} onChange={e=>setCount(e.target.value)}/></label><button className="primary-button" disabled={busy||!code.trim()}>{busy?'Saving…':editId?'Save course':'Create course'}</button>{editId&&<button type="button" className="secondary-button w-full" onClick={()=>{setEditId(null);setCode('');setCount('0');}}>Cancel edit</button>}</form>
          <section className="panel p-5"><label className="field-label">Course roster<select className="form-input" disabled={busy} value={selectedCourse} onChange={e=>{++rosterRequest.current;setMembers([]);setCandidates([]);setSelectedCourse(e.target.value);setSelected([]);setStudentQ('');setCandidateInput('');setCandidateQ('');setCandidatePage(0);setError('');}}><option value="">Choose a course</option>{courses.map(c=><option key={c.id} value={c.id}>{c.code}</option>)}</select></label>{course&&<><p className="muted mt-4">{course.enrolledCount} enrolled · {course.studentCount} planned</p><button className="secondary-button mt-4" onClick={()=>{setEditId(course.id);setCode(course.code);setCount(String(course.studentCount));}}>Edit selected course</button><button className="danger-button mt-3" disabled={busy||loading} onClick={()=>{setCourseToDelete(course);setConfirmCode('');setError('');setNotice('');}}>Delete course</button></>}</section>
        </aside>
        <div className="space-y-6">{!course?<section className="panel p-8"><h2 className="text-lg mb-3">Choose or create a course</h2><p className="muted">Then select registered students and add them to its roster.</p></section>:<>
          <section className="panel p-5"><h2 className="text-lg text-[#ffd133] mb-2">{course.code} roster</h2><p className="muted mb-4">Planned count is entered manually. Enrollment is counted from the roster. Changes apply to future game lobbies.</p><label className="field-label">Find enrolled student<input className="form-input" value={studentQ} onChange={e=>setStudentQ(e.target.value)} placeholder="Email, name or student number"/></label>
            <ul className="divide-y divide-[#333654] mt-4">{members.filter(u=>`${u.email} ${u.displayName} ${u.studentNumber}`.toLowerCase().includes(studentQ.toLowerCase())).map(u=><li key={u.id} className="flex flex-wrap justify-between items-center gap-3 py-4"><div className="min-w-0"><p className="break-all">{u.displayName||u.email}</p><p className="muted break-all">{u.studentNumber||'No student number'} · {u.email}</p>{u.role!=='student'&&<p className="muted">Current role: {u.role}</p>}</div><button className="danger-button" disabled={busy} aria-label={`Remove ${u.email} from course`} onClick={()=>setRemove({user:u,courseId:selectedCourse,courseCode:course.code})}>Remove</button></li>)}</ul>{!members.length&&<p className="muted mt-5">No students enrolled.</p>}
          </section>
          <section className="panel p-5"><h2 className="text-lg text-[#ffd133] mb-2">Add students</h2><p className="muted mb-4">Select up to 50 accounts. Students who have not signed in yet will not appear.</p>
            <form onSubmit={e=>{e.preventDefault();setCandidatePage(0);setCandidateQ(candidateInput.trim());}} className="flex flex-wrap gap-3 items-end"><label className="field-label flex-1">Search registered students<input className="form-input" value={candidateInput} maxLength={100} onChange={e=>setCandidateInput(e.target.value)} placeholder="Email, name or student number"/></label><button className="secondary-button">Search students</button></form>
            <ul className="divide-y divide-[#333654] mt-4">{candidates.map(u=><li key={u.id}><label className="flex items-center gap-3 py-3 cursor-pointer"><input type="checkbox" aria-label={`Enroll ${u.email}`} checked={enrolled.has(u.id)||selected.includes(u.id)} disabled={busy||enrolled.has(u.id)||(!selected.includes(u.id)&&selected.length>=50)} onChange={e=>setSelected(prev=>e.target.checked?[...prev,u.id]:prev.filter(id=>id!==u.id))}/><span className="min-w-0"><span className="block break-all">{u.displayName||u.email}</span><span className="muted break-all">{u.email} {enrolled.has(u.id)?'· Already enrolled':''}</span></span></label></li>)}</ul>{!loading&&!candidates.length&&<p className="muted my-5">No registered students found.</p>}
            <div className="flex flex-wrap gap-3 items-center mt-4"><button className="secondary-button" disabled={!candidatePage||loading} onClick={()=>setCandidatePage(candidatePage-50)}>Previous students</button><button className="secondary-button" disabled={!candidateMore||loading} onClick={()=>setCandidatePage(candidatePage+50)}>Next students</button><button className="primary-button sm:!w-auto sm:ml-auto" disabled={busy||!selected.length} onClick={enroll}>Add {selected.length||''} selected</button></div>
          </section>
        </>}</div>
      </div>}
      {courseToDelete&&<div className="fixed inset-0 bg-black/70 grid place-items-center p-5 z-50"><section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="delete-course-title" className="panel p-6 max-w-md w-full">
        <h2 id="delete-course-title" className="text-lg text-[#ffd133] mb-4">Delete course?</h2>
        <p>This permanently deletes <strong>{courseToDelete.code}</strong> and {courseToDelete.enrolledCount} enrollment(s). Student accounts remain.</p>
        <p className="muted mt-3">Courses with exercises or game history cannot be deleted.</p>
        <label className="field-label block mt-5">Type {courseToDelete.code} to confirm<input autoFocus disabled={busy} className="form-input" value={confirmCode} onChange={e=>setConfirmCode(e.target.value)}/></label>
        {error&&<p role="alert" className="alert-error mt-4">{error}</p>}
        <div className="flex gap-3 justify-end mt-6"><button className="secondary-button" disabled={busy} onClick={()=>setCourseToDelete(null)}>Cancel</button><button className="danger-button" disabled={busy||confirmCode!==courseToDelete.code} onClick={deleteSelectedCourse}>{busy?'Deleting…':'Delete permanently'}</button></div>
      </section></div>}
      {remove&&<div className="fixed inset-0 bg-black/70 grid place-items-center p-5 z-50"><section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="remove-title" className="panel p-6 max-w-md w-full"><h2 id="remove-title" className="text-lg text-[#ffd133] mb-4">Remove enrollment?</h2><p className="break-all">Remove {remove.user.email} from {remove.courseCode}?</p><p className="muted mt-3">Their account and saved game history remain.</p><div className="flex gap-3 justify-end mt-6"><button autoFocus className="secondary-button" disabled={busy} onClick={()=>setRemove(null)}>Cancel</button><button className="danger-button" disabled={busy} onClick={removeMember}>Remove enrollment</button></div></section></div>}
    </main>
  </Shell>;
}
