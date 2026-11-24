import type { ReactNode } from 'react';
export function Shell({ name, role, onSignOut, onAdmin, onCourses, title='Courses', onHome, children }: {
  name:string; role:string; onSignOut:()=>void; onAdmin?:()=>void; onCourses?:()=>void; title?:string; onHome?:()=>void; children:ReactNode;
}) {
  return <div className="min-h-dvh">
    <header className="app-header">
      <div className="header-brand"><button className="brand" onClick={onHome}>CODELINE</button><span>{title}</span></div>
      <div className="header-actions">
        {onCourses && <button className="nav-button" onClick={onCourses}>Courses</button>}
        {role==='admin' && onAdmin && <button className="nav-button" onClick={onAdmin}>Admin panel</button>}
        <span className="role-badge">{role.toUpperCase()}</span>
        <details className="account-menu"><summary aria-label="Account menu">⋮</summary><div><p>{name}</p>{onHome&&<button className="nav-button" onClick={onHome}>Home</button>}<button className="nav-button" onClick={onSignOut}>Sign out</button></div></details>
      </div>
    </header>
    {children}
  </div>;
}
