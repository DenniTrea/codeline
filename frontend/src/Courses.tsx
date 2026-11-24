import { Shell } from './Shell';
import { useEffect, useState, type FormEvent } from 'react';
type Course = { id: number; code: string; studentCount: number };
export function Courses({ name, role, onSignOut, onAdmin, onHome }: { name: string; role: string; onSignOut: () => void; onAdmin?: () => void; onHome?:()=>void }) {
  const [courses, setCourses] = useState<Course[]>([]);
  const [code, setCode] = useState('');
  const [count, setCount] = useState('0');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canCreate = role === 'lecturer' || role === 'admin';
  async function load() {
    setLoading(true); setError('');
    try {
      const r = await fetch('/api/courses');
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Could not load courses');
      setCourses(data.courses);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load courses'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  async function save(e: FormEvent) {
    e.preventDefault(); setSaving(true); setError(''); setNotice('');
    try {
      const r = await fetch('/api/courses', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, studentCount: Number(count) }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Could not save course');
      setCourses(previous => [...previous, data.course].sort((a, b) => a.code.localeCompare(b.code)));
      setCode(''); setCount('0'); setNotice('Course saved.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save course'); }
    finally { setSaving(false); }
  }
  return <Shell name={name} role={role} onSignOut={onSignOut} onAdmin={onAdmin} onHome={onHome}>
    <main className="max-w-5xl mx-auto px-5 py-10">
      <h1 className="brand text-[#ffd133] text-xl mb-8">COURSES</h1>
      {canCreate && <form onSubmit={save} className="rounded-lg border border-[#333654] bg-[#1c1f36] p-6 mb-8 grid sm:grid-cols-[1fr_180px_160px] gap-5 items-end">
        <label className="text-sm text-[#a6abcc]">Course code<input required maxLength={30} value={code} onChange={e => setCode(e.target.value)} placeholder="CSC101" className="form-input" /></label>
        <label className="text-sm text-[#a6abcc]">Planned students<input required type="number" min={0} max={32767} step={1} value={count} onChange={e => setCount(e.target.value)} className="form-input" /></label>
        <button disabled={saving || !code.trim()} className="primary-button">{saving ? 'Saving…' : 'Create course'}</button>
      </form>}
      {notice && <p role="status" className="mb-5 text-[#5ce38c]">{notice}</p>}
      {error && <div role="alert" className="mb-5 text-[#ff8585]">{error} <button className="underline cursor-pointer" onClick={load}>Reload courses</button></div>}
      {loading ? <p role="status">Loading courses…</p> : <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {courses.map(course => <li key={course.id} className="rounded-lg border border-[#333654] bg-[#1c1f36] p-6">
          <h2 className="text-xl text-[#ffd133] mb-3">{course.code}</h2><p className="text-sm text-[#a6abcc]">{course.studentCount} planned students</p>
        </li>)}
      </ul>}
      {!loading && !error && !courses.length && <p className="text-[#a6abcc]">{canCreate ? 'Create your first course above.' : 'No courses yet. Ask your lecturer to enroll you.'}</p>}
    </main>
  </Shell>;
}
