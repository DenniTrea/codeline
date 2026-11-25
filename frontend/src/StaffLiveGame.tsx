import { useEffect, useRef, useState } from "react";

type Line = {
  position: number;
  isGiven: boolean;
  solved: boolean;
  answerShown: boolean;
  visible: boolean;
  codeText: string | null;
  studentName?: string | null;
  retrying?: boolean;
};
const states = ["correct", "empty", "retrying", "absent"] as const;
type State = typeof states[number];
function state(line: Line): State {
  if (line.isGiven || line.solved) return "correct";
  if (line.answerShown) return "absent";
  return line.retrying ? "retrying" : "empty";
}
const labels: Record<State, string> = {
  correct: "Correct", empty: "Not placed yet", retrying: "Wrong – retrying", absent: "Answer shown (absent)",
};
function clock(seconds: number) {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
export function StaffLiveGame({ lines, description, pseudocode, remaining, busy, onEnd }: {
  lines: Line[]; description: string; pseudocode: string; remaining: number; busy: boolean; onEnd: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [range, setRange] = useState({ start: 0, end: 9 });
  const [selected, setSelected] = useState<number | null>(null);
  const rows = useRef(new Map<number, HTMLDivElement>());
  const viewport = useRef<HTMLDivElement>(null);
  const counts = Object.fromEntries(states.map((s) => [s, lines.filter((l) => state(l) === s).length])) as Record<State, number>;
  function updateRange() {
    const view = viewport.current;
    if (!view) return;
    const bounds = view.getBoundingClientRect();
    const visible = lines.map((line, index) => ({ index, rect: rows.current.get(line.position)?.getBoundingClientRect() }))
      .filter(({ rect }) => rect && rect.bottom > bounds.top && rect.top < bounds.bottom);
    if (visible.length) setRange({ start: visible[0].index, end: visible[visible.length - 1].index });
  }
  useEffect(() => {
    updateRange();
    const observer = new ResizeObserver(updateRange);
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [showAll, lines.length]);
  function jump(position: number) {
    setSelected(position);
    const view = viewport.current, row = rows.current.get(position);
    if (view && row) {
      view.scrollTop += row.getBoundingClientRect().top - view.getBoundingClientRect().top - 5;
      row.scrollIntoView({ block: "nearest", inline: "nearest" });
      updateRange();
    }
  }
  return <section className="staff-live" aria-label="Lecturer live game dashboard">
    <div className="panel staff-control-bar">
      <span className="timer">TIME <b className="brand">{clock(remaining)}</b></span>
      <div className="staff-progress">
        <span>{counts.correct} / {lines.length} lines correct</span>
        <progress aria-label="Correct code lines" value={counts.correct} max={Math.max(1, lines.length)} />
      </div>
      <button className="danger-button pixel-button" disabled={busy} onClick={onEnd}>End game</button>
    </div>
    <div className="staff-status-counts" aria-label="Line status counts">
      {states.map((s) => <span key={s} className={`line-status-${s}`}>{counts[s]} {s === "empty" ? "NOT PLACED" : s === "retrying" ? "WRONG – RETRYING" : s === "absent" ? "ANSWER SHOWN (ABSENT)" : "CORRECT"}</span>)}
    </div>
    <div className="staff-live-columns">
      <aside className="panel staff-problem">
        <h2>PROBLEM</h2><p>{description}</p>
        <h3>PSEUDOCODE</h3>
        <pre className="code-sample">{pseudocode || "No pseudocode provided."}</pre>
      </aside>
      <section className="panel staff-code-panel">
        <header><h2>CODE <span>{showAll ? `All ${lines.length} lines` : `Lines ${range.start + 1}–${Math.min(range.end + 1, lines.length)} of ${lines.length}`}</span></h2>
          <button className="secondary-button pixel-button" onClick={() => { setShowAll(!showAll); }}>{showAll ? "Compact view" : "Show all"}</button></header>
        <div className="staff-code-with-rail">
          <div ref={viewport} className={`staff-code-scroll ${showAll ? "show-all" : ""}`} onScroll={updateRange}>
            {lines.map((line) => <div key={line.position} ref={(el) => { if (el) rows.current.set(line.position, el); else rows.current.delete(line.position); }}
              className={`staff-code-row line-status-${state(line)} ${selected === line.position ? "selected" : ""}`}>
              <span className="staff-line-number">{line.position}</span>
              <code>{line.visible ? line.codeText : "________________________"}</code>
              <small>{line.isGiven ? "Given" : line.answerShown ? `${line.studentName || "Absent"} · answer shown` : line.solved ? line.studentName || "Correct" : line.retrying ? `${line.studentName || "Student"} · wrong – retrying` : "Empty"}</small>
            </div>)}
          </div>
          <nav className="staff-code-rail" aria-label="Code minimap">{lines.map((line) => <button key={line.position} className={`line-status-${state(line)}`} aria-label={`Jump to line ${line.position}: ${labels[state(line)]}`} onClick={() => jump(line.position)} />)}</nav>
        </div>
      </section>
      <aside className="panel staff-all-lines">
        <h2>ALL LINES</h2>
        <nav className="staff-line-grid" aria-label="All code lines">{lines.map((line) => <button key={line.position} aria-label={`Line ${line.position}: ${labels[state(line)]}`} aria-pressed={selected === line.position} className={`line-status-${state(line)}`} onClick={() => jump(line.position)}>{line.position}</button>)}</nav>
        <ul className="staff-line-legend">{states.map((s) => <li key={s}><i className={`line-status-${s}`} />{labels[s]}</li>)}</ul>
        <p className="staff-status-note">Recent retry activity is temporary; scores are saved.</p>
      </aside>
    </div>
  </section>;
}
