import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { WaitingPlayground, type PlaygroundPlayer } from "./WaitingPlayground";
import QRCode from "qrcode";
import { StudentLiveGame } from "./StudentLiveGame";
import { StaffLiveGame } from "./StaffLiveGame";
import { api } from "./api";
import { encodeCsv } from "./csv";
type Participant = {
  studentId: string;
  name: string;
  studentNumber: string | null;
  attendance: "joined" | "absent" | "waiting";
  joinedAt: string | null;
  solvedAt: string | null;
  score: number;
};
type Slot = {
  position: number;
  isGiven: boolean;
  visible: boolean;
  codeText: string | null;
  solved: boolean;
  answerShown: boolean;
  placedBy?: string | null;
  studentName?: string | null;
  retrying?: boolean;
};
type Game = {
  exerciseId?: number;
  courseLeaderboard: { name: string; score: number; gamesPlayed: number }[];
  activity?: {
    at: string;
    actor: string;
    line: number | null;
    result: string;
    points: number | null;
  }[];
  activityTemporary?: boolean;
  id: number;
  title: string;
  problemDescription: string;
  courseCode: string;
  pseudocode: string;
  wrongAttemptPenalty: number;
  joinPin?: string;
  roomLocked: boolean;
  timeLimitSeconds: number;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  serverTime: string;
  canControl: boolean;
  board: Slot[];
  participants?: Participant[];
  players: { name: string }[];
  my: {
    name: string;
    attendance: string;
    codeText: string | null;
    score: number;
    solvedAt: string | null;
    joinedAt: string | null;
  } | null;
  counts: {
    joined: number;
    absent: number;
    waiting: number;
    solved: number;
    total: number;
  };
  leaderboard: {
    name: string;
    isYou: boolean;
    score: number;
    solvedAt: string | null;
    attendance: string;
  }[];
};
function clock(seconds: number) {
  return `${String(Math.floor(Math.max(0, seconds) / 60)).padStart(2, "0")}:${String(Math.max(0, seconds) % 60).padStart(2, "0")}`;
}
export function GameRoom({
  id,
  onClose,
  onOpen,
}: {
  id: number;
  onClose: () => void;
  onOpen: (id: number) => void;
}) {
  const [game, setGame] = useState<Game | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [now, setNow] = useState(Date.now()),
    [offset, setOffset] = useState(0),
    [connected, setConnected] = useState(false),
    [qr, setQr] = useState<string | null>(null),
    [showQr, setShowQr] = useState(false),
    [showEnd, setShowEnd] = useState(false),
    [showClose, setShowClose] = useState(false),
    [showAnswers, setShowAnswers] = useState(false),
    [courseTotal, setCourseTotal] = useState(false);
  const [playground, setPlayground] = useState<PlaygroundPlayer[]>([]),
    [selfKey, setSelfKey] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const fetching = useRef(false),
    active = useRef(true),
    retry = useRef<{ position: number; requestId: string } | null>(null);
  const load = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    try {
      const data = await api<{ game: Game }>(`/api/games/${id}`);
      if (active.current) {
        setGame(data.game);
        setOffset(new Date(data.game.serverTime).getTime() - Date.now());
        setError("");
      }
    } catch (e) {
      if (active.current) setError((e as Error).message);
    } finally {
      fetching.current = false;
    }
  }, [id]);
  useEffect(() => {
    active.current = true;
    void load();
    const socket = io({ withCredentials: true });
    socketRef.current = socket;
    socket.on("playground:identity", (r: { key: string }) => setSelfKey(r.key));
    socket.on("playground:state", (r: { players: PlaygroundPlayer[] }) =>
      setPlayground(r.players),
    );
    let refresh: ReturnType<typeof setTimeout> | undefined;
    const watch = () => {
      setConnected(true);
      socket.emit("watch", id, (r: { ok: boolean }) => {
        if (!r.ok) setConnected(false);
      });
      void load();
    };
    socket.on("connect", watch);
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", () => setConnected(false));
    socket.on("game:changed", () => {
      clearTimeout(refresh);
      refresh = setTimeout(() => void load(), 80);
    });
    const fallback = setInterval(() => void load(), 5000),
      tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      active.current = false;
      socket.disconnect();
      clearInterval(fallback);
      clearInterval(tick);
      clearTimeout(refresh);
    };
  }, [id, load]);
  async function action(path: string, body?: unknown, method = "POST") {
    setBusy(true);
    setError("");
    try {
      await api(`/api/games/${id}/${path}`, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      setShowEnd(false);
      if (method === "DELETE") {
        onClose();
        return;
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function submit(position: number) {
    if (
      busy ||
      !game?.startedAt ||
      game.endedAt ||
      game.my?.solvedAt ||
      game.my?.attendance !== "joined"
    )
      return;
    setBusy(true);
    setError("");
    setMessage("");
    const request =
      retry.current?.position === position
        ? retry.current
        : { position, requestId: crypto.randomUUID() };
    retry.current = request;
    try {
      const r = await api<{ correct: boolean; score: number; points?: number }>(
        `/api/games/${id}/submit`,
        { method: "POST", body: JSON.stringify(request) },
      );
      retry.current = null;
      setMessage(
        r.correct
          ? `Correct! ${r.score} points.`
          : `Wrong position · −${game.wrongAttemptPenalty} points. ${r.score} points remaining.`,
      );
      await load();
      return r;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function downloadCsv(activity = false) {
    if (!game) return;
    const rows: unknown[][] = activity
      ? [
          ["Time", "Student / actor", "Line", "Result", "Point change"],
          ...(game.activity || []).map((a) => [
            a.at,
            a.actor,
            a.line,
            a.result,
            a.points,
          ]),
        ]
      : courseTotal
        ? [
            ["Rank", "Student", "Total score", "Games played"],
            ...game.courseLeaderboard.map((p, i) => [
              i + 1,
              p.name,
              p.score,
              p.gamesPlayed,
            ]),
          ]
        : [
            ["Rank", "Student", "Score", "Attendance", "Solved at"],
            ...game.leaderboard.map((p, i) => [
              i + 1,
              p.name,
              p.score,
              p.attendance,
              p.solvedAt,
            ]),
          ];
    const blob = new Blob([encodeCsv(rows)], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = `codeline-${id}-${activity ? "activity" : courseTotal ? "course-total" : "results"}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function playAgain() {
    if (!game?.exerciseId) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<{ id: number }>("/api/games", {
        method: "POST",
        body: JSON.stringify({ exerciseId: game.exerciseId }),
      });
      onOpen(r.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function leaveLobby() {
    setBusy(true);
    setError("");
    try {
      await api(`/api/games/${id}/leave`, { method: "POST" });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      await load();
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let cancelled = false;
    setQr(null);
    setShowQr(false);
    if (game?.joinPin) {
      void QRCode.toDataURL(`${location.origin}/?pin=${game.joinPin}`, {
        width: 320,
        margin: 4,
      }).then(
        (data) => { if (!cancelled) setQr(data); },
        () => { if (!cancelled) setError("Could not generate the QR code. Share the PIN instead."); },
      );
    }
    return () => { cancelled = true; };
  }, [game?.joinPin]);
  if (!game)
    return (
      <main className="game-main">
        <button className="nav-button" onClick={onClose}>
          ← Back
        </button>
        <p role={error ? "alert" : "status"}>{error || "Loading room…"}</p>
      </main>
    );
  const remaining = game.startedAt
    ? Math.max(
        0,
        Math.ceil(
          (new Date(game.startedAt).getTime() +
            game.timeLimitSeconds * 1000 -
            (now + offset)) /
            1000,
        ),
      )
    : game.timeLimitSeconds;
  const lobby = !game.startedAt,
    ended = Boolean(game.endedAt),
    my = game.my;
  const board = (
    <div className="game-board">
      {game.board.map((line) => (
        <button
          key={line.position}
          className={`board-slot ${line.isGiven ? "given" : ""} ${line.solved ? "solved" : ""} ${line.answerShown ? "answer" : ""}`}
          disabled={
            busy ||
            lobby ||
            ended ||
            game.canControl ||
            line.visible ||
            Boolean(my?.solvedAt) ||
            my?.attendance !== "joined" ||
            remaining === 0
          }
          onClick={() => void submit(line.position)}
          onDragOver={(e) => {
            if (!line.visible) e.preventDefault();
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.getData("text/plain") === "codeline-my-line")
              void submit(line.position);
          }}
        >
          <span>{line.position}</span>
          <code>
            {line.visible ? line.codeText : "________________________"}
          </code>
          <small>
            {line.isGiven
              ? "GIVEN"
              : line.answerShown
                ? "ANSWER · 0 pts"
                : line.solved
                  ? "CORRECT"
                  : "BLANK"}
          </small>
        </button>
      ))}
    </div>
  );
  return (
    <main className={`game-main ${!lobby && !ended ? game.canControl ? "staff-live-main" : "student-live-main" : ""}`}>
      {!(game.startedAt && !game.endedAt && !game.canControl) && <div className="game-breadcrumb">
        <button className="nav-button" onClick={onClose}>
          ← {ended ? "Back to home" : "Leave view"}
        </button>
        <span>
          {game.courseCode} · {game.title}
        </span>
        <span className={connected ? "online-label" : "muted"}>
          {connected ? "Live updates" : "Reconnecting · refreshing every 5s"}
        </span>
      </div>}
      {error && (
        <p role="alert" className="alert-error mb-4">
          {error}
        </p>
      )}
      {lobby ? (
        game.canControl ? (
          <>
            <section className="lobby-pin">
              <div>
                <span>Join at</span>
                <strong>{location.host}</strong>
              </div>
              <div>
                <span>Session PIN</span>
                <p className="brand">
                  {game.joinPin?.slice(0, 3)} {game.joinPin?.slice(3)}
                </p>
              </div>
              <button
                className="qr-button"
                aria-label="Enlarge join room QR code"
                disabled={!qr}
                onClick={() => setShowQr(true)}
              >
                {qr ? <img src={qr} alt="Scan to join this game" /> : "…"}
              </button>
            </section>
            <div className="lobby-toolbar">
              <div className="attendance-counts">
                <span className="joined">{game.counts.joined} JOINED</span>
                <span className="absent">{game.counts.absent} ABSENT</span>
                <span>{game.counts.waiting} WAITING</span>
              </div>
              <h1>
                {game.title} · {game.board.length} lines
              </h1>
              <span className="timer">
                TIME <b className="brand">{clock(remaining)}</b>
              </span>
              <button
                className="secondary-button pixel-button"
                disabled={busy}
                onClick={() =>
                  void action("lock", { locked: !game.roomLocked })
                }
              >
                {game.roomLocked ? "Unlock room" : "Lock room"}
              </button>
              <button
                className="primary-button"
                disabled={busy || !game.counts.joined}
                onClick={() => void action("start")}
              >
                Start game
              </button>
              <button
                className="nav-button muted"
                disabled={busy}
                onClick={() => setShowClose(true)}
              >
                Close room
              </button>
            </div>
            <div className="lobby-columns">
              <section className="panel joined-panel">
                <h2>JOINED</h2>
                <div className="joined-names">
                  {game.players.map((p, i) => (
                    <span key={i}>{p.name}</span>
                  ))}
                </div>
                {!game.players.length && (
                  <p className="muted mt-5">
                    Waiting for enrolled students to enter the PIN.
                  </p>
                )}
              </section>
              <section className="panel class-list">
                <div className="flex justify-between gap-3">
                  <h2>CLASS LIST</h2>
                  <span className="muted">
                    Waiting students are marked absent at Start.
                  </span>
                </div>
                {game.participants?.map((p) => (
                  <div
                    key={p.studentId}
                    className={`class-row ${p.attendance}`}
                  >
                    <label>
                      <input
                        type="checkbox"
                        aria-label={`Mark ${p.name} absent`}
                        checked={p.attendance === "absent"}
                        disabled={busy}
                        onChange={(e) =>
                          void action(
                            "attendance",
                            {
                              studentId: p.studentId,
                              attendance: e.target.checked
                                ? "absent"
                                : "waiting",
                            },
                            "PATCH",
                          )
                        }
                      />
                      <span>
                        {p.studentNumber || ""} {p.name}
                      </span>
                    </label>
                    <b>{p.attendance.toUpperCase()}</b>
                  </div>
                ))}
                <p className="class-note">
                  Absent → their line shows the ANSWER (0 pts). Students who
                  disconnect can rejoin.
                </p>
              </section>
            </div>
          </>
        ) : my?.attendance === "joined" ? (
          <WaitingPlayground
            title={game.title}
            name={my.name}
            total={game.counts.total}
            joined={game.counts.joined}
            lineCount={game.board.length}
            timeLimit={game.timeLimitSeconds}
            players={playground}
            selfKey={selfKey}
            connected={connected}
            send={(value) => socketRef.current?.emit("playground:move", value)}
            onLeave={() => {
              if (!busy) void leaveLobby();
            }}
          />
        ) : (
          <section className="waiting-room panel">
            <h1 className="brand">
              {my?.attendance === "absent" ? "MARKED ABSENT" : "JOIN THE ROOM"}
            </h1>
            <p>{game.title}</p>
            <p className="muted">
              {my?.attendance === "absent"
                ? "Ask your lecturer to correct attendance before the game starts."
                : "Enter the session PIN on the home page to join this room."}
            </p>
            <button className="primary-button !w-auto" onClick={onClose}>
              Back to home
            </button>
          </section>
        )
      ) : ended && game.canControl ? (
        <>
          <div className="result-heading">
            <h1 className="brand">GAME OVER</h1>
            <p className="muted">
              {game.counts.solved} solved ·{" "}
              {game.counts.total - game.counts.solved} answers shown
            </p>
            <div className="result-actions">
              <button
                className="secondary-button pixel-button"
                onClick={() => downloadCsv()}
              >
                Export CSV
              </button>
              <button
                className="primary-button !w-auto"
                disabled={busy}
                onClick={() => void playAgain()}
              >
                Play again
              </button>
            </div>
          </div>
          <div className="staff-results-columns">
            <section className="panel leaderboard">
              <h2>LEADERBOARD</h2>
              <div className="topic-filters mb-3">
                <button
                  className={!courseTotal ? "active" : ""}
                  onClick={() => setCourseTotal(false)}
                >
                  THIS GAME
                </button>
                <button
                  className={courseTotal ? "active" : ""}
                  onClick={() => setCourseTotal(true)}
                >
                  COURSE TOTAL
                </button>
              </div>
              <ol>
                {(courseTotal ? game.courseLeaderboard : game.leaderboard).map(
                  (p, i) => (
                    <li key={i}>
                      <span>
                        #{i + 1} {p.name}
                      </span>
                      <strong>{p.score} pts</strong>
                    </li>
                  ),
                )}
              </ol>
              {courseTotal && (
                <p className="muted mt-3">
                  Totals across finished games for {game.courseCode}.
                </p>
              )}
            </section>
            <section className="panel activity-panel">
              <div className="flex flex-wrap gap-3 justify-between">
                <h2>HISTORY LOG</h2>
                <button
                  className="nav-button muted"
                  disabled={!game.activity?.length}
                  onClick={() => downloadCsv(true)}
                >
                  Export activity
                </button>
              </div>
              <p className="muted mb-4">
                Activity is temporary for this server session. Export it to keep
                a copy. Final scores remain saved.
              </p>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Student / actor</th>
                      <th>Line</th>
                      <th>Result</th>
                      <th>Pts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {game.activity?.map((a, i) => (
                      <tr key={i}>
                        <td>{new Date(a.at).toLocaleTimeString()}</td>
                        <td>{a.actor}</td>
                        <td>{a.line ? `#${a.line}` : "—"}</td>
                        <td
                          className={
                            a.result === "Correct"
                              ? "correct-result"
                              : a.result === "Wrong"
                                ? "wrong-result"
                                : ""
                          }
                        >
                          {a.result}
                        </td>
                        <td>
                          {a.points === null
                            ? "—"
                            : a.points > 0
                              ? `+${a.points}`
                              : a.points}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!game.activity?.length && (
                  <p className="muted p-5">
                    Detailed activity is no longer available. Saved results are
                    shown in the leaderboard.
                  </p>
                )}
              </div>
              <button
                className="secondary-button pixel-button mt-5"
                onClick={() => setShowAnswers((v) => !v)}
              >
                {showAnswers ? "Hide code" : "View full code"}
              </button>
            </section>
          </div>
          {showAnswers && <section className="panel mt-6 p-5">{board}</section>}
        </>
      ) : ended ? (
        <>
          <div className="result-heading">
            <h1 className="brand">GAME OVER</h1>
            <p className="muted">
              {game.title} · {game.counts.solved} / {game.counts.total} students
              solved
            </p>
          </div>
          <div className="results-columns">
            <section className="panel result-card">
              <h2>{game.canControl ? "CLASS RESULT" : "YOUR RESULT"}</h2>
              {my ? (
                <>
                  <p className="result-rank brand">
                    #
                    {Math.max(
                      1,
                      game.leaderboard.findIndex((p) => p.isYou) + 1,
                    )}
                  </p>
                  <div className="result-metrics">
                    <div>
                      <b>{my.score}</b>
                      <span>points</span>
                    </div>
                    <div>
                      <b>{my.solvedAt ? "Solved" : "Unsolved"}</b>
                      <span>
                        {my.attendance === "absent"
                          ? "Absent · 0 pts"
                          : `−${game.wrongAttemptPenalty} per wrong try`}
                      </span>
                    </div>
                    <div>
                      <b>
                        {my.solvedAt
                          ? clock(
                              Math.floor(
                                (new Date(my.solvedAt).getTime() -
                                  new Date(game.startedAt!).getTime()) /
                                  1000,
                              ),
                            )
                          : "—"}
                      </b>
                      <span>time to answer</span>
                    </div>
                  </div>
                  <h2>YOUR LINE</h2>
                  <pre className="my-line code-sample">
                    {my.codeText || "No assigned line"}
                  </pre>
                </>
              ) : (
                <div className="result-metrics">
                  <div>
                    <b>{game.counts.solved}</b>
                    <span>solved</span>
                  </div>
                  <div>
                    <b>{game.counts.absent}</b>
                    <span>absent</span>
                  </div>
                  <div>
                    <b>{game.counts.total}</b>
                    <span>students</span>
                  </div>
                </div>
              )}
              <div className="flex gap-3 mt-5">
                <button
                  className="secondary-button pixel-button"
                  onClick={() => setShowAnswers((v) => !v)}
                >
                  {showAnswers ? "Hide code" : "View full code"}
                </button>
                <button className="primary-button !w-auto" onClick={onClose}>
                  Back to home
                </button>
              </div>
            </section>
            <section className="panel leaderboard">
              <h2>LEADERBOARD · THIS GAME</h2>
              <ol>
                {game.leaderboard.map((p, i) => (
                  <li key={i} className={p.isYou ? "you" : ""}>
                    <span>
                      #{i + 1} {p.name}
                      {p.isYou ? " (you)" : ""}
                    </span>
                    <strong>{p.score}</strong>
                  </li>
                ))}
              </ol>
            </section>
          </div>
          {showAnswers && <section className="panel mt-6 p-5">{board}</section>}
        </>
      ) : game.canControl ? (
        <StaffLiveGame
          lines={game.board}
          description={game.problemDescription}
          pseudocode={game.pseudocode}
          remaining={remaining}
          busy={busy}
          onEnd={() => setShowEnd(true)}
        />
      ) : (
        <StudentLiveGame title={game.title} description={game.problemDescription}
          pseudocode={game.pseudocode} lines={game.board} my={my}
          remaining={remaining} busy={busy} penalty={game.wrongAttemptPenalty}
          onSubmit={submit} onClose={onClose} />
      )}
      {showQr && qr && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Join room QR code"
            className="panel confirm-dialog"
          >
            <img
              src={qr}
              width={240}
              height={240}
              alt="Scan to open the game join page"
            />
            <p className="brand text-center mt-4">{game.joinPin}</p>
            <footer>
              <button
                autoFocus
                className="secondary-button"
                onClick={() => setShowQr(false)}
              >
                Close
              </button>
            </footer>
          </section>
        </div>
      )}
      {showClose && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="close-room-title"
            className="panel confirm-dialog"
          >
            <h2 id="close-room-title" className="brand">
              CLOSE THIS ROOM?
            </h2>
            <p>
              This permanently removes the unstarted lobby and its PIN. No
              played game history is removed.
            </p>
            <footer>
              <button
                autoFocus
                disabled={busy}
                className="secondary-button"
                onClick={() => setShowClose(false)}
              >
                Keep room
              </button>
              <button
                disabled={busy}
                className="danger-button"
                onClick={() => void action("", undefined, "DELETE")}
              >
                Close room permanently
              </button>
            </footer>
          </section>
        </div>
      )}
      {showEnd && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="end-game-title"
            className="panel confirm-dialog"
          >
            <h2 id="end-game-title" className="brand">
              END GAME?
            </h2>
            <p>
              Unsolved and absent students finish with 0. All answers will be
              revealed.
            </p>
            <footer>
              <button
                autoFocus
                disabled={busy}
                className="secondary-button"
                onClick={() => setShowEnd(false)}
              >
                Keep playing
              </button>
              <button
                disabled={busy}
                className="danger-button"
                onClick={() => void action("end")}
              >
                End game
              </button>
            </footer>
          </section>
        </div>
      )}
    </main>
  );
}
