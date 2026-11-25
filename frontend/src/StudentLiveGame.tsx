import { useState } from "react";
type Line = { position: number; isGiven: boolean; solved: boolean; answerShown: boolean; visible: boolean; codeText: string | null; placedBy?: string | null };
type Result = { correct: boolean; score: number; points?: number };
export function StudentLiveGame({title,description,pseudocode,lines,my,remaining,busy,penalty,onSubmit,onClose}: {
  title:string; description:string; pseudocode:string; lines:Line[];
  my:{codeText:string|null;score:number;solvedAt:string|null;attendance:string}|null;
  remaining:number; busy:boolean; penalty:number;
  onSubmit:(position:number)=>Promise<Result|undefined>; onClose:()=>void;
}) {
  const [selected,setSelected]=useState<number|null>(null);
  const [attempts,setAttempts]=useState<Record<number,number>>({});
  const [feedback,setFeedback]=useState("");
  const canPlace=Boolean(my && !my.solvedAt && my.attendance==='joined' && remaining>0 && !busy);
  async function place(position:number) {
    const result=await onSubmit(position);
    if(!result)return;
    if(result.correct) { setFeedback(`Correct! ${result.score} points.`); return; }
    const lost=Math.abs(result.points ?? (result.score-(my?.score ?? result.score)));
    setAttempts((old)=>({...old,[position]:(old[position]||0)+lost}));
    setFeedback(`Wrong place on line ${position} — −${lost} pts. Unlimited tries.`);
  }
  function select(position:number) { if(canPlace)setSelected(position); }
  const time=`${String(Math.floor(remaining/60)).padStart(2,'0')}:${String(remaining%60).padStart(2,'0')}`;
  return <>
    <div className="student-line-toolbar">
      <h1 className="brand">YOUR LINE</h1>
      <div className="student-assigned-line" draggable={canPlace} onDragStart={(e)=>e.dataTransfer.setData('text/plain','codeline-my-line')}>
        <code>{my?.codeText || 'No assigned line'}</code><span>YOUR LINE</span>
      </div>
      <strong className="student-live-score">Score {my?.score ?? 0}</strong>
      <span className="timer">TIME <b className="brand">{time}</b></span>
    </div>
    <div className="student-live-columns">
      <aside className="panel student-problem"><h2>PROBLEM</h2><p>{description}</p>
        <h3>PSEUDOCODE</h3><pre className="code-sample">{pseudocode || 'No pseudocode provided.'}</pre>
      </aside>
      <section className="panel student-code-panel"><h2>CODE</h2>
        <p className="sr-only">Select an empty line, then choose Place here. Wrong tries lose up to {penalty} points.</p>
        {my?.solvedAt && <p className="student-game-notice" role="status">Your line is correct. Watch your classmates finish.</p>}
        {my?.attendance==='absent' && <p className="student-game-notice" role="status">Marked absent · your answer is shown for 0 points.</p>}
        <div className="student-code-board">{lines.map((line)=>{
          const isSelected=selected===line.position && !line.visible;
          const tried=Object.hasOwn(attempts,line.position);
          return <div key={line.position} className={`student-code-row ${line.visible?'filled':'empty'} ${line.answerShown?'answer':''} ${isSelected?'selected':''}`}
            onDragOver={(e)=>{if(canPlace&&!line.visible)e.preventDefault();}}
            onDrop={(e)=>{e.preventDefault();if(canPlace&&!line.visible&&e.dataTransfer.getData('text/plain')==='codeline-my-line')select(line.position);}}>
            <div className="student-row-content">
              {line.visible ? <div className="student-line-content"><span>{line.position}</span><code>{line.codeText}</code></div>
                : <button className="student-line-content" aria-label={`Select line ${line.position}`} aria-pressed={isSelected} disabled={!canPlace} onClick={()=>select(line.position)}>
                  <span>{line.position}</span><code>{isSelected?my?.codeText:'____________________'}</code>
                </button>}
              <div className="student-line-status">{line.visible ? line.placedBy || (line.answerShown?'Answer shown · 0 pts':line.solved?'Correct':'Given') : isSelected ? <><span>Selected</span><button className="student-place-button pixel-button" disabled={!canPlace} onClick={()=>void place(line.position)}>Place here</button></> : tried?`You tried here · −${attempts[line.position]}`:'Empty'}</div>
            </div>
            {isSelected&&feedback&&<p className="student-placement-feedback" role="status">{feedback}</p>}
          </div>;
        })}</div>
      </section>
    </div>
    <footer className="student-game-footer"><button className="brand" aria-label="Leave game view" onClick={onClose}>CODELINE</button><span>{title}</span><span className="role-badge">STUDENT</span></footer>
  </>;
}
