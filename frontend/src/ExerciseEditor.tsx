import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { readCodeFile, type CodeLine } from "./import-code";
type Course = { id: number; code: string; studentCount: number };
type Topic = { id: number; name: string };
type Data = {
  title: string;
  courseId: number;
  topicId: number;
  problemDescription: string;
  pseudocode: string;
  timeLimitSeconds: number;
  wrongAttemptPenalty: number;
  exerciseState: boolean;
  lines: CodeLine[];
  used?: boolean;
};
const empty: Data = {
  title: "",
  courseId: 0,
  topicId: 0,
  problemDescription: "",
  pseudocode: "",
  timeLimitSeconds: 300,
  wrongAttemptPenalty: 10,
  exerciseState: false,
  lines: [],
};
export function ExerciseEditor({
  id: initialId,
  imported,
  copyOptions,
  onClose,
  onCourses,
  onSaved,
  onArchive,
  onDirtyChange,
}: {
  id: number | null;
  imported?: CodeLine[];
  copyOptions: { id: number; title: string }[];
  onClose: () => void;
  onCourses: () => void;
  onSaved: () => void;
  onArchive: (id: number) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [loaded, setLoaded] = useState(false),
    [loadAttempt, setLoadAttempt] = useState(0);
  const [startMode, setStartMode] = useState(
      imported?.length ? "import" : "blank",
    ),
    [copiedFromId, setCopiedFromId] = useState<number | undefined>();
  const [id, setId] = useState(initialId),
    [data, setData] = useState<Data>({ ...empty, lines: imported || [] });
  const [courses, setCourses] = useState<Course[]>([]),
    [topics, setTopics] = useState<Topic[]>([]),
    [newTopic, setNewTopic] = useState("");
  const [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [dirty, setDirty] = useState(false),
    [discard, setDiscard] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (!id && loaded)
      modalRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [loaded, id]);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const modalRef = useRef<HTMLElement>(null),
    fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    setBusy(true);
    setLoaded(false);
    setError("");
    Promise.all([
      api<{ courses: Course[] }>("/api/courses"),
      api<{ topics: Topic[] }>("/api/exercises/topics"),
      initialId ? api<{ exercise: Data }>(`/api/exercises/${initialId}`) : null,
    ])
      .then(([c, t, e]) => {
        if (!active) return;
        setCourses(c.courses);
        setTopics(t.topics);
        setLoaded(true);
        if (e) setData(e.exercise);
        else
          setData((d) => ({
            ...d,
            courseId: c.courses[0]?.id || 0,
            topicId: t.topics[0]?.id || 0,
          }));
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [initialId, loadAttempt]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    if (id) return;
    const previous = document.activeElement as HTMLElement;
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        if (dirty) setDiscard(true);
        else onClose();
      }
      if (e.key === "Tab") {
        const list = modalRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)",
        );
        if (!list?.length) return;
        const first = list[0],
          last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handle);
    return () => {
      document.removeEventListener("keydown", handle);
      previous?.focus();
    };
  }, [id, busy, dirty, onClose]);
  function update<K extends keyof Data>(key: K, value: Data[K]) {
    setData((d) => ({ ...d, [key]: value }));
    setDirty(true);
    setNotice("");
  }
  async function addTopic() {
    setError("");
    setBusy(true);
    try {
      const r = await api<{ topic: Topic }>("/api/exercises/topics", {
        method: "POST",
        body: JSON.stringify({ name: newTopic }),
      });
      setTopics((prev) =>
        prev.some((t) => t.id === r.topic.id) ? prev : [...prev, r.topic],
      );
      update("topicId", r.topic.id);
      setNewTopic("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(ready: boolean) {
    setError("");
    setBusy(true);
    try {
      const r = await api<{ id: number }>(
        `/api/exercises${id ? `/${id}` : ""}`,
        {
          method: id ? "PUT" : "POST",
          body: JSON.stringify({
            ...data,
            exerciseState: ready,
            ...(copiedFromId ? { copiedFromId } : {}),
          }),
        },
      );
      setId(r.id);
      setData((d) => ({ ...d, exerciseState: ready }));
      setDirty(false);
      setNotice(ready ? "Exercise saved and ready." : "Draft saved.");
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function archive() {
    if (!id) return;
    setBusy(true);
    try {
      await api(`/api/exercises/${id}`, { method: "DELETE" });
      setDirty(false);
      onArchive(id);
    } catch (e) {
      setError((e as Error).message);
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  }
  async function importFile(file?: File) {
    if (!file) return;
    try {
      update("lines", await readCodeFile(file));
      setStartMode("import");
      setCopiedFromId(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function chooseCopy(value: number) {
    setBusy(true);
    setError("");
    try {
      const { exercise: s } = await api<{ exercise: Data }>(
        `/api/exercises/${value}`,
      );
      setCopiedFromId(value);
      setData((d) => ({
        ...d,
        title: d.title || s.title,
        problemDescription: d.problemDescription || s.problemDescription,
        pseudocode: s.pseudocode,
        lines: s.lines.map((l) => ({
          codeText: l.codeText,
          isGiven: l.isGiven,
        })),
      }));
      setDirty(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const course = courses.find((c) => c.id === data.courseId),
    blank = data.lines.filter((l) => !l.isGiven).length;
  const titleField = (
    <label className="field-label">
      {id ? "Title" : "Exercise title"}
      <input
        autoFocus={!id}
        required
        maxLength={50}
        className="form-input"
        value={data.title}
        onChange={(e) => update("title", e.target.value)}
      />
    </label>
  );
  const metadata = (
    <>
      <div className="editor-pair">
        <label className="field-label">
          Course
          <select
            className="form-input"
            value={data.courseId || ""}
            onChange={(e) => update("courseId", Number(e.target.value))}
          >
            <option value="" disabled>
              Choose course
            </option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          Topic
          <select
            className="form-input"
            value={data.topicId || ""}
            onChange={(e) => update("topicId", Number(e.target.value))}
          >
            <option value="" disabled>
              Choose topic
            </option>
            {topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!courses.length && loaded && !busy && (
        <p className="muted">
          Create a course first.{" "}
          <button type="button" className="underline" onClick={onCourses}>
            Manage courses
          </button>
        </p>
      )}
      <details>
        <summary className="muted cursor-pointer">Add a topic</summary>
        <div className="flex gap-3 mt-3">
          <input
            aria-label="New topic name"
            className="form-input !mt-0"
            maxLength={50}
            value={newTopic}
            onChange={(e) => setNewTopic(e.target.value)}
          />
          <button
            type="button"
            className="secondary-button"
            disabled={busy || !newTopic.trim()}
            onClick={() => void addTopic()}
          >
            Add
          </button>
        </div>
      </details>
    </>
  );
  const settings = (
    <div className="editor-pair">
      <label className="field-label">
        Time limit (game)
        <select
          className="form-input code-sample"
          value={data.timeLimitSeconds}
          onChange={(e) => update("timeLimitSeconds", Number(e.target.value))}
        >
          {[...new Set([60, 120, 180, 300, 600, 900, data.timeLimitSeconds])]
            .sort((a, b) => a - b)
            .map((s) => (
              <option key={s} value={s}>
                {String(Math.floor(s / 60)).padStart(2, "0")}:
                {String(s % 60).padStart(2, "0")}
              </option>
            ))}
        </select>
      </label>
      <label className="field-label">
        Penalty per wrong try
        <select
          className="form-input"
          value={data.wrongAttemptPenalty}
          onChange={(e) =>
            update("wrongAttemptPenalty", Number(e.target.value))
          }
        >
          {[...new Set([0, 5, 10, 20, 25, 50, 100, data.wrongAttemptPenalty])]
            .sort((a, b) => a - b)
            .map((n) => (
              <option key={n} value={n}>
                −{n} pts
              </option>
            ))}
        </select>
      </label>
    </div>
  );
  const problem = (
    <label className="field-label">
      Problem description {id ? "" : "(shown to students)"}
      <textarea
        className="form-input"
        rows={5}
        maxLength={20000}
        placeholder="e.g. Read every student’s score, give a grade A–F, then print the class average."
        value={data.problemDescription}
        onChange={(e) => update("problemDescription", e.target.value)}
      />
    </label>
  );
  const alerts = (
    <>
      {error && (
        <p role="alert" className="alert-error">
          {error}
        </p>
      )}
      {!loaded && !busy && (
        <button
          className="secondary-button my-3"
          onClick={() => setLoadAttempt((n) => n + 1)}
        >
          Retry loading
        </button>
      )}
      {notice && (
        <p role="status" className="alert-success">
          {notice}
        </p>
      )}
    </>
  );
  return (
    <>
      {!id ? (
        <div className="modal-backdrop">
          <section
            ref={modalRef}
            className="new-exercise panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-title"
          >
            <div className="flex justify-between items-center">
              <h1 id="new-title" className="brand">
                NEW EXERCISE
              </h1>
              <button
                aria-label="Close new exercise"
                className="close-button"
                disabled={busy}
                onClick={() => (dirty ? setDiscard(true) : onClose())}
              >
                ×
              </button>
            </div>
            {alerts}
            <fieldset disabled={busy || !loaded} className="editor-fields">
              {titleField}
              {metadata}
              <p className="roster-hint">
                {course?.studentCount || 0} students → write{" "}
                {course?.studentCount || 0} BLANK lines
              </p>
              {settings}
              {problem}
              <label className="field-label">Start from</label>
              <div className="start-options">
                <button
                  className={startMode === "blank" ? "active" : ""}
                  onClick={() => {
                    setStartMode("blank");
                    setCopiedFromId(undefined);
                    update("lines", []);
                  }}
                >
                  Blank
                </button>
                <button
                  className={startMode === "copy" ? "active" : ""}
                  onClick={() => setStartMode("copy")}
                >
                  Copy an exercise
                </button>
                <button
                  className={startMode === "import" ? "active" : ""}
                  onClick={() => fileInput.current?.click()}
                >
                  Import file
                </button>
              </div>
              {startMode === "copy" && (
                <label className="field-label">
                  Copy from
                  <select
                    className="form-input"
                    value={copiedFromId || ""}
                    onChange={(e) => void chooseCopy(Number(e.target.value))}
                  >
                    <option value="" disabled>
                      Choose an exercise
                    </option>
                    {copyOptions.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.title}
                      </option>
                    ))}
                  </select>
                  {!copyOptions.length && (
                    <span className="muted">
                      No saved exercises to copy yet.
                    </span>
                  )}
                </label>
              )}
              {data.lines.length > 0 && (
                <p className="muted">
                  {data.lines.length} starting lines. GIVEN/BLANK can be changed
                  in the editor.
                </p>
              )}
            </fieldset>

            <footer>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => (dirty ? setDiscard(true) : onClose())}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={
                  busy ||
                  !loaded ||
                  !data.title.trim() ||
                  !data.courseId ||
                  !data.topicId
                }
                onClick={() => void save(false)}
              >
                Create exercise
              </button>
            </footer>
          </section>
        </div>
      ) : (
        <main className="editor-main">
          <div className="editor-top">
            <button
              className="nav-button"
              onClick={() => (dirty ? setDiscard(true) : onClose())}
            >
              ← Exercise library
            </button>
            {dirty && <span className="muted">Unsaved changes</span>}
          </div>
          {alerts}
          {data.used && (
            <p className="alert-error mb-5">
              This exercise has game history. Its code and settings are
              protected. Make a copy from the library to edit it.
            </p>
          )}
          <div className="editor-columns">
            <section className="panel editor-problem">
              <h2>PROBLEM</h2>
              <fieldset
                disabled={busy || !loaded || data.used}
                className="editor-fields"
              >
                <label className="field-label">
                  Title
                  <input
                    className="form-input"
                    required
                    maxLength={50}
                    value={data.title}
                    onChange={(e) => update("title", e.target.value)}
                  />
                </label>
                <details>
                  <summary className="muted cursor-pointer">
                    Course & topic
                  </summary>
                  <div className="editor-fields mt-4">{metadata}</div>
                </details>
                {problem}
                <label className="field-label">
                  Pseudocode (shown on the left side)
                  <textarea
                    className="form-input code-sample"
                    rows={6}
                    maxLength={20000}
                    value={data.pseudocode}
                    onChange={(e) => update("pseudocode", e.target.value)}
                  />
                </label>
                {settings}
              </fieldset>
            </section>
            <section className="panel editor-code">
              <h2>CODE LINES</h2>
              <div className="line-summary">
                <span className="role-badge">{course?.code || "Course"}</span>
                <span>
                  Lines {data.lines.length} / {course?.studentCount || 0}{" "}
                  students
                </span>
                {course && blank < course.studentCount && (
                  <button
                    disabled={
                      busy ||
                      !loaded ||
                      data.used ||
                      data.lines.length + course.studentCount - blank > 500
                    }
                    onClick={() =>
                      update("lines", [
                        ...data.lines,
                        ...Array.from(
                          { length: course.studentCount - blank },
                          () => ({ codeText: "", isGiven: false }),
                        ),
                      ])
                    }
                  >
                    ADD {course.studentCount - blank} MORE LINES
                  </button>
                )}
              </div>
              <p className="muted mb-3">
                {blank} BLANK · {data.lines.length - blank} GIVEN. Toggle each
                line to choose what students fill in.
              </p>
              <div className="code-lines">
                {data.lines.map((line, i) => (
                  <div
                    key={i}
                    className={`code-line ${line.isGiven ? "given" : "blank"}`}
                  >
                    <span className="line-number">{i + 1}</span>
                    <input
                      aria-label={`Code line ${i + 1}`}
                      className="code-sample"
                      disabled={busy || !loaded || data.used}
                      value={line.codeText}
                      onChange={(e) =>
                        update(
                          "lines",
                          data.lines.map((l, n) =>
                            n === i ? { ...l, codeText: e.target.value } : l,
                          ),
                        )
                      }
                    />
                    <button
                      className="line-kind"
                      disabled={busy || !loaded || data.used}
                      aria-label={`Line ${i + 1} is ${line.isGiven ? "GIVEN" : "BLANK"}, toggle`}
                      onClick={() =>
                        update(
                          "lines",
                          data.lines.map((l, n) =>
                            n === i ? { ...l, isGiven: !l.isGiven } : l,
                          ),
                        )
                      }
                    >
                      {line.isGiven ? "GIVEN" : "BLANK"}
                    </button>
                    <div className="line-tools">
                      <button
                        aria-label={`Move line ${i + 1} up`}
                        disabled={busy || !loaded || data.used || i === 0}
                        onClick={() => {
                          const lines = [...data.lines];
                          [lines[i - 1], lines[i]] = [lines[i], lines[i - 1]];
                          update("lines", lines);
                        }}
                      >
                        ↑
                      </button>
                      <button
                        aria-label={`Remove line ${i + 1}`}
                        disabled={busy || !loaded || data.used}
                        onClick={() =>
                          update(
                            "lines",
                            data.lines.filter((_, n) => n !== i),
                          )
                        }
                      >
                        ×
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex gap-3 mt-3">
                <button
                  className="secondary-button pixel-button"
                  disabled={
                    busy || !loaded || data.used || data.lines.length >= 500
                  }
                  onClick={() =>
                    update("lines", [
                      ...data.lines,
                      { codeText: "", isGiven: false },
                    ])
                  }
                >
                  + Add line
                </button>
                <button
                  className="nav-button"
                  disabled={busy || !loaded || data.used}
                  onClick={() => fileInput.current?.click()}
                >
                  Import code
                </button>
              </div>
              <footer className="editor-footer">
                <button
                  className="danger-button pixel-button"
                  disabled={busy || !loaded}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete
                </button>
                <div>
                  <button
                    className="secondary-button pixel-button"
                    disabled={busy || !loaded || data.used}
                    onClick={() => void save(false)}
                  >
                    Save draft
                  </button>
                  <button
                    className="primary-button"
                    disabled={busy || !loaded || data.used}
                    onClick={() => void save(true)}
                  >
                    Save
                  </button>
                </div>
              </footer>
            </section>
          </div>
        </main>
      )}
      <input
        ref={fileInput}
        type="file"
        className="sr-only"
        aria-label="Import exercise file"
        accept=".txt,.py,.js,.ts,.java,.c,.cpp,.cs,.sql"
        onChange={(e) => {
          void importFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {discard && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="discard-title"
            className="panel confirm-dialog"
          >
            <h2 id="discard-title">Discard unsaved changes?</h2>
            <p>Your last saved exercise will remain.</p>
            <footer>
              <button
                autoFocus
                className="secondary-button"
                onClick={() => setDiscard(false)}
              >
                Keep editing
              </button>
              <button className="danger-button" onClick={onClose}>
                Discard changes
              </button>
            </footer>
          </section>
        </div>
      )}
      {confirmDelete && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="archive-title"
            className="panel confirm-dialog"
          >
            <h2 id="archive-title" className="brand">
              DELETE EXERCISE?
            </h2>
            <p>
              Remove “{data.title}” from your library? Game history is retained.
              You can undo this after deletion.
            </p>
            <footer>
              <button
                autoFocus
                className="secondary-button"
                disabled={busy}
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </button>
              <button
                className="danger-button"
                disabled={busy}
                onClick={() => void archive()}
              >
                Delete exercise
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
