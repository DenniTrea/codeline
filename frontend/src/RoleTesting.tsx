import { useEffect, useState } from 'react';
import { api } from './api';
type TestCourse = { id:number; code:string; enrolled:boolean };
export function RoleTesting({role,changed}:{role:string;changed:()=>Promise<void>}) {
  const [courses,setCourses]=useState<TestCourse[]>([]);
  const [courseId,setCourseId]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  async function loadCourses(){const data=await api<{courses:TestCourse[]}>('/api/dev/role-testing/courses');setCourses(data.courses);}
  useEffect(()=>{let active=true;api<{courses:TestCourse[]}>('/api/dev/role-testing/courses').then(data=>{if(active)setCourses(data.courses);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[role]);
  async function switchRole(next:string){
    setBusy(true);setError('');setNotice('');
    try{await api('/api/dev/role-testing/role',{method:'POST',body:JSON.stringify({role:next})});await changed();}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const course=courses.find(c=>String(c.id)===courseId);
  async function enrollment(){
    if(!course)return;
    setBusy(true);setError('');setNotice('');
    try{
      await api('/api/dev/role-testing/enrollment',{method:course.enrolled?'DELETE':'PUT',body:JSON.stringify({courseId:course.id})});
      setNotice(course.enrolled?'Your enrollment was removed.':'Your account is enrolled.');
      await loadCourses();await changed();
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <details className="role-testing-tools"><summary>Test roles · {role}</summary><aside aria-label="Local role testing" className="text-sm">
    <div className="max-w-7xl mx-auto space-y-3">
      <div className="flex flex-wrap gap-4 items-end">
        <div><p className="text-[#ffd133] font-medium">LOCAL ROLE TESTING</p><p className="muted mt-1">Your saved role stays admin. This session uses {role} permissions. Changes save to the real development database.</p></div>
        <label className="field-label">Test as<select className="form-input" disabled={busy} value={role} onChange={e=>void switchRole(e.target.value)}><option value="admin">Admin (normal)</option><option value="lecturer">Lecturer</option><option value="student">Student</option></select></label>
        {role!=='admin'&&<button className="secondary-button" disabled={busy} onClick={()=>void switchRole('admin')}>Return to admin</button>}
      </div>
      <details><summary className="muted cursor-pointer">Test my student enrollment</summary>
        <p className="muted my-3">This adds or removes your own account in the selected course roster. It never creates a Microsoft account or changes your saved role.</p>
        <div className="flex flex-wrap gap-3 items-end"><label className="field-label">Test course<select className="form-input" disabled={busy} value={courseId} onChange={e=>setCourseId(e.target.value)}><option value="">Choose a course</option>{courses.map(c=><option key={c.id} value={c.id}>{c.code}{c.enrolled?' · enrolled':''}</option>)}</select></label><button className="secondary-button" disabled={busy||!course} onClick={()=>void enrollment()}>{course?.enrolled?'Remove my enrollment':'Enroll my account'}</button><button className="nav-button" disabled={busy} onClick={()=>void loadCourses().catch(e=>setError(e.message))}>Refresh test courses</button></div>
      </details>
      {busy&&<p role="status" className="muted">Updating test session…</p>}
      {notice&&<p role="status" className="text-[#5ce38c]">{notice}</p>}
      {error&&<p role="alert" className="text-[#ff8585]">{error}</p>}
    </div>
  </aside></details>;
}
