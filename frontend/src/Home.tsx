import { useEffect, useRef, useState, type FormEvent } from "react";
import { Shell } from "./Shell";
import { api } from "./api";
import { ExerciseEditor } from "./ExerciseEditor";
import { readCodeFile, type CodeLine } from "./import-code";
import { GameRoom } from "./GameRoom";
type HistoryGame = {
  id: number;
  title: string;
  courseCode: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  joinPin?: string;
};
type Exercise = {
  id: number;
  title: string;
  topic: string;
  exerciseState: boolean;
  preview: string;
  lineCount: number;
  courseCode: string;
  usedCount: number;
  lastUsed: string | null;
};
export function Home({
  name,
  role,
  onSignOut,
  onAdmin,
  onCourses,
}: {
  name: string;
  role: string;
  onSignOut: () => void;
  onAdmin: () => void;
  onCourses: () => void;
}) {
  const student = role === "student";
  const libraryRequest = useRef(0);
  const [editorDirty, setEditorDirty] = useState(false),
    [leaveAction, setLeaveAction] = useState<(() => void) | null>(null);
  function navigate(action: () => void) {
    if (editorDirty) setLeaveAction(() => action);
    else action();
  }
  const [gameId, setGameId] = useState<number | null>(() => {
      const id = Number(new URLSearchParams(location.search).get("game"));
      return Number.isInteger(id) && id > 0 ? id : null;
    }),
    [history, setHistory] = useState<HistoryGame[] | null>(null);
  function openGame(id: number | null) {
    const url = new URL(location.href);
    if (id) url.searchParams.set("game", String(id));
    else url.searchParams.delete("game");
    url.searchParams.delete("pin");
    window.history.pushState({}, "", url);
    setGameId(id);
    setHistory(null);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
  useEffect(() => {
    const back = () => {
      const n = Number(new URLSearchParams(location.search).get("game"));
      setGameId(n > 0 ? n : null);
      setHistory(null);
    };
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);
  async function loadHistory() {
    setError("");
    try {
      const r = await api<{ games: HistoryGame[] }>("/api/games");
      setHistory(r.games);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function startGame(exerciseId: number) {
    setActing(true);
    setError("");
    try {
      const r = await api<{ id: number }>("/api/games", {
        method: "POST",
        body: JSON.stringify({ exerciseId }),
      });
      openGame(r.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActing(false);
    }
  }
  const [editor, setEditor] = useState<number | null | undefined>(undefined),
    [imported, setImported] = useState<CodeLine[] | undefined>(),
    [deleted, setDeleted] = useState<number | null>(null),
    [deleteItem, setDeleteItem] = useState<Exercise | null>(null),
    [acting, setActing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  async function reloadLibrary() {
    const request = ++libraryRequest.current;
    const data = await api<{ exercises: Exercise[] }>("/api/exercises");
    if (request === libraryRequest.current) {
      setItems(data.exercises);
      setError("");
    }
  }
  async function copy(id: number) {
    setActing(true);
    setError("");
    try {
      const r = await api<{ id: number }>(`/api/exercises/${id}/copy`, {
        method: "POST",
      });
      setImported(undefined);
      setEditor(r.id);
      await reloadLibrary();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActing(false);
    }
  }
  async function archive(id: number) {
    setActing(true);
    setError("");
    try {
      await api(`/api/exercises/${id}`, { method: "DELETE" });
      setDeleteItem(null);
      onArchived(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActing(false);
    }
  }
  function onArchived(id: number) {
    setDeleted(id);
    setEditorDirty(false);
    setEditor(undefined);
    void reloadLibrary().catch((e) => setError(e.message));
  }
  async function undo() {
    if (!deleted) return;
    setActing(true);
    try {
      await api(`/api/exercises/${deleted}/restore`, { method: "POST" });
      setDeleted(null);
      await reloadLibrary();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActing(false);
    }
  }
  const [items, setItems] = useState<Exercise[]>([]),
    [loading, setLoading] = useState(!student),
    [error, setError] = useState("");
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState("All"),
    [sort, setSort] = useState("lastUsed");
  const [pin, setPin] = useState(
      () =>
        new URLSearchParams(location.search)
          .get("pin")
          ?.replace(/\D/g, "")
          .slice(0, 6) ||
        sessionStorage.getItem("codeline:pin") ||
        "",
    ),
    [message, setMessage] = useState("");
  useEffect(() => {
    if (student) return;
    let active = true;
    api<{ exercises: Exercise[] }>("/api/exercises")
      .then((data) => {
        if (active) setItems(data.exercises);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [student]);
  async function join(e: FormEvent) {
    e.preventDefault();
    setActing(true);
    setMessage("");
    try {
      const r = await api<{ id: number }>("/api/games/join", {
        method: "POST",
        body: JSON.stringify({ pin }),
      });
      sessionStorage.removeItem("codeline:pin");
      openGame(r.id);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setActing(false);
    }
  }
  const topics = [...new Set(items.map((e) => e.topic))].filter(
    (t) => t !== "All" && t !== "Draft",
  );
  const filtered = items
    .filter(
      (e) =>
        (filter === "All" ||
          (filter === "Draft" ? !e.exerciseState : e.topic === filter)) &&
        `${e.title} ${e.topic}`.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "title"
        ? a.title.localeCompare(b.title)
        : new Date(b.lastUsed || 0).getTime() -
            new Date(a.lastUsed || 0).getTime() || b.id - a.id,
    );
  return (
    <Shell
      name={name}
      role={role}
      title={gameId ? "Game room" : student ? "Join" : "Exercise library"}
      onSignOut={() => navigate(onSignOut)}
      onAdmin={() => navigate(onAdmin)}
      onCourses={() => navigate(onCourses)}
    >
      {gameId ? (
        <GameRoom
          key={gameId}
          id={gameId}
          onClose={() => openGame(null)}
          onOpen={openGame}
        />
      ) : history ? (
        <main className="exercise-library">
          <div className="library-title">
            <h1 className="brand">GAME HISTORY</h1>
            <button
              className="secondary-button"
              onClick={() => setHistory(null)}
            >
              Back
            </button>
          </div>
          {!history.length && <p className="muted">No game sessions yet.</p>}
          <ul className="history-list">
            {history.map((g) => (
              <li className="panel" key={g.id}>
                <div>
                  <h2>{g.title}</h2>
                  <p className="muted">
                    {g.courseCode} · {new Date(g.createdAt).toLocaleString()} ·{" "}
                    {g.endedAt
                      ? "Finished"
                      : g.startedAt
                        ? "In progress"
                        : "Lobby"}
                  </p>
                </div>
                <button
                  className="secondary-button pixel-button"
                  onClick={() => openGame(g.id)}
                >
                  {g.endedAt ? "Results" : "Open room"}
                </button>
              </li>
            ))}
          </ul>
        </main>
      ) : editor !== undefined ? (
        <ExerciseEditor
          key={editor ?? "new"}
          id={editor}
          imported={imported}
          copyOptions={items}
          onClose={() => {
            setEditor(undefined);
            setEditorDirty(false);
            void reloadLibrary().catch((e) => setError(e.message));
          }}
          onCourses={() => navigate(onCourses)}
          onSaved={() => void reloadLibrary().catch((e) => setError(e.message))}
          onArchive={onArchived}
          onDirtyChange={setEditorDirty}
        />
      ) : student ? (
        <main className="join-main">
          <form className="join-card panel" onSubmit={join}>
            <h1 className="brand">JOIN A GAME</h1>
            <p className="join-identity">Signed in as {name} (SIT)</p>
            <label className="sr-only" htmlFor="game-pin">
              Session PIN
            </label>
            <input
              id="game-pin"
              aria-describedby="pin-help"
              className="pin-input brand"
              autoComplete="off"
              inputMode="numeric"
              pattern="[0-9]{3} ?[0-9]{3}"
              required
              placeholder="000 000"
              maxLength={7}
              value={
                pin.length > 3 ? `${pin.slice(0, 3)} ${pin.slice(3)}` : pin
              }
              onChange={(e) => {
                setPin(e.target.value.replace(/\D/g, "").slice(0, 6));
                setMessage("");
              }}
            />
            <button
              className="primary-button"
              disabled={acting || pin.length !== 6}
            >
              {acting ? "Joining…" : "Enter"}
            </button>
            <p id="pin-help" className="muted">
              The PIN is on the projector screen.
            </p>
            {message && (
              <p role="alert" className="join-message">
                {message}
              </p>
            )}
            <button
              className="nav-button mt-4 text-xs muted"
              type="button"
              onClick={() => void loadHistory()}
            >
              My game history
            </button>
          </form>
        </main>
      ) : (
        <main className="exercise-library">
          <div className="library-title">
            <h1 className="brand">MY EXERCISES</h1>
            <div className="flex gap-3">
              {role !== 'lecturer' && <button
                className="secondary-button pixel-button"
                onClick={() => void loadHistory()}
              >
                History
              </button>}
              <button
                className="secondary-button pixel-button"
                disabled={acting}
                onClick={() => fileInput.current?.click()}
              >
                Import
              </button>
              <button
                className="primary-button"
                disabled={acting}
                onClick={() => {
                  setImported(undefined);
                  setEditor(null);
                }}
              >
                + New exercise
              </button>
            </div>
          </div>
          <div className="library-toolbar">
            <label className="sr-only" htmlFor="exercise-search">
              Search exercises
            </label>
            <input
              id="exercise-search"
              className="form-input"
              placeholder="Search exercises..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="topic-filters" aria-label="Exercise filters">
              {["All", ...topics, "Draft"].map((f) => (
                <button
                  key={f}
                  aria-pressed={filter === f}
                  className={filter === f ? "active" : ""}
                  onClick={() => setFilter(f)}
                >
                  {f === "All" ? `ALL ${items.length}` : f}
                </button>
              ))}
            </div>
            <label className="library-sort">
              Sort:{" "}
              <select
                aria-label="Sort exercises"
                value={sort}
                onChange={(e) => setSort(e.target.value)}
              >
                <option value="lastUsed">Last used</option>
                <option value="title">Title</option>
              </select>
            </label>
          </div>
          {error && (
            <p role="alert" className="alert-error">
              {error}{" "}
              <button
                className="underline"
                onClick={() =>
                  void reloadLibrary().catch((e) => setError(e.message))
                }
              >
                Reload exercises
              </button>
            </p>
          )}
          {deleted && (
            <p role="status" className="alert-success mb-4">
              Exercise removed. Game history retained.{" "}
              <button
                className="underline"
                disabled={acting}
                onClick={() => void undo()}
              >
                Undo deletion
              </button>
            </p>
          )}
          {loading ? (
            <p role="status" className="muted">
              Loading exercises…
            </p>
          ) : (
            <ul className="exercise-grid">
              {filtered.map((e) => (
                <li className="exercise-card panel" key={e.id}>
                  <div className="exercise-tags">
                    <span>{e.topic}</span>
                    <span className={e.exerciseState ? "ready" : "draft"}>
                      {e.exerciseState ? "READY" : "DRAFT"}
                    </span>
                  </div>
                  <h2>{e.title}</h2>
                  <pre>{e.preview || "No code lines yet."}</pre>
                  <p className="exercise-meta">
                    {e.lineCount} lines · {e.courseCode}{" "}
                    <span>
                      {e.usedCount
                        ? `Used ${e.usedCount}× · last ${e.lastUsed ? new Date(e.lastUsed).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—"}`
                        : "Not used yet"}
                    </span>
                  </p>
                  <div className="exercise-card-actions">
                    <button
                      disabled={acting}
                      onClick={() => setEditor(e.id)}
                      className="secondary-button pixel-button"
                    >
                      Edit
                    </button>
                    <button
                      disabled={acting}
                      onClick={() => void copy(e.id)}
                      className="secondary-button pixel-button"
                    >
                      Copy
                    </button>
                    <button
                      disabled={acting}
                      onClick={() => setDeleteItem(e)}
                      className="danger-button pixel-button"
                    >
                      Delete
                    </button>
                    <button
                      disabled={acting || !e.exerciseState}
                      title={
                        !e.exerciseState
                          ? "Save this exercise as ready first"
                          : undefined
                      }
                      onClick={() => void startGame(e.id)}
                      className="primary-button"
                    >
                      Start
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {!loading && !error && !filtered.length && (
            <section className="library-empty panel">
              <h2>
                {items.length ? "No matching exercises" : "No exercises yet"}
              </h2>
              <p className="muted">
                {items.length
                  ? "Try another search or filter."
                  : "Create a new exercise or import a code file to get started."}
              </p>
            </section>
          )}
        </main>
      )}
      {leaveAction && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="leave-editor-title"
            className="panel confirm-dialog"
          >
            <h2 id="leave-editor-title">Leave without saving?</h2>
            <p>Your unsaved exercise changes will be discarded.</p>
            <footer>
              <button
                autoFocus
                className="secondary-button"
                onClick={() => setLeaveAction(null)}
              >
                Keep editing
              </button>
              <button
                className="danger-button"
                onClick={() => {
                  const action = leaveAction;
                  setLeaveAction(null);
                  setEditorDirty(false);
                  action();
                }}
              >
                Discard changes
              </button>
            </footer>
          </section>
        </div>
      )}
      <input
        ref={fileInput}
        className="sr-only"
        type="file"
        aria-label="Import code file"
        accept=".txt,.py,.js,.ts,.java,.c,.cpp,.cs,.sql"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          try {
            setImported(await readCodeFile(file));
            setEditor(null);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      />
      {deleteItem && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-exercise-title"
            className="panel confirm-dialog"
          >
            <h2 id="delete-exercise-title" className="brand">
              DELETE EXERCISE?
            </h2>
            <p>
              Remove “{deleteItem.title}” from your library? Game history is
              retained. You can undo deletion.
            </p>
            {error && (
              <p role="alert" className="alert-error">
                {error}
              </p>
            )}
            <footer>
              <button
                autoFocus
                className="secondary-button"
                disabled={acting}
                onClick={() => setDeleteItem(null)}
              >
                Cancel
              </button>
              <button
                className="danger-button"
                disabled={acting}
                onClick={() => void archive(deleteItem.id)}
              >
                Delete exercise
              </button>
            </footer>
          </section>
        </div>
      )}
    </Shell>
  );
}
