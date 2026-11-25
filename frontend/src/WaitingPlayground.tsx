import { useEffect, useRef, useState, type CSSProperties } from "react";
export type PlaygroundPlayer = {
  key: string;
  name: string;
  x: number;
  y: number;
  color: number;
  emote: string;
  emoteUntil: number;
};
const colors = [
  "#ffd133",
  "#66aaff",
  "#5ce38c",
  "#ff8585",
  "#ffa24c",
  "#b58aff",
];
export function PixelPerson({ color = 0 }: { color?: number }) {
  return (
    <span
      className="pixel-person"
      style={{ "--shirt": colors[color] || colors[0] } as CSSProperties}
      aria-hidden="true"
    >
      <i className="pixel-hair" />
      <i className="pixel-face" />
      <i className="pixel-eyes" />
      <i className="pixel-shirt" />
      <i className="pixel-arms" />
      <i className="pixel-pants" />
      <i className="pixel-feet" />
    </span>
  );
}
export function WaitingPlayground({
  title,
  name,
  total,
  joined,
  lineCount,
  timeLimit,
  players,
  selfKey,
  send,
  onLeave,
  connected,
}: {
  title: string;
  name: string;
  total: number;
  joined: number;
  lineCount: number;
  timeLimit: number;
  players: PlaygroundPlayer[];
  selfKey: string | null;
  send: (p: { x: number; y: number; color: number; emote?: string }) => void;
  onLeave: () => void;
  connected: boolean;
}) {
  const [color, setColor] = useState(() =>
      Math.max(
        0,
        Math.min(5, Number(localStorage.getItem("codeline:avatar-color")) || 0),
      ),
    ),
    [local, setLocal] = useState<{ x: number; y: number } | null>(null),
    [tick, setTick] = useState(Date.now());
  const position = useRef({ x: 50, y: 60 }),
    keys = useRef(new Set<string>()),
    target = useRef<{ x: number; y: number } | null>(null),
    self = players.find((p) => p.key === selfKey),
    sendRef = useRef(send),
    colorRef = useRef(color),
    ready = useRef(false);
  sendRef.current = send;
  colorRef.current = color;
  useEffect(() => {
    ready.current = false;
    setLocal(null);
  }, [selfKey]);
  useEffect(() => {
    if (self && !ready.current) {
      position.current = { x: self.x, y: self.y };
      setLocal(position.current);
      ready.current = true;
      sendRef.current({ ...position.current, color: colorRef.current });
    }
  }, [self]);
  useEffect(() => {
    if (!selfKey || !connected) return;
    let frame = 0,
      last = performance.now(),
      lastSent = 0;
    const run = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      let dx =
          Number(keys.current.has("arrowright") || keys.current.has("d")) -
          Number(keys.current.has("arrowleft") || keys.current.has("a")),
        dy =
          Number(keys.current.has("arrowdown") || keys.current.has("s")) -
          Number(keys.current.has("arrowup") || keys.current.has("w"));
      if (dx || dy) target.current = null;
      else if (target.current) {
        const x = target.current.x - position.current.x,
          y = target.current.y - position.current.y,
          length = Math.hypot(x, y);
        if (length < 1) target.current = null;
        else {
          dx = x / length;
          dy = y / length;
        }
      }
      if (ready.current && (dx || dy)) {
        const length = Math.hypot(dx, dy) || 1;
        position.current = {
          x: Math.max(
            3,
            Math.min(97, position.current.x + (dx / length) * 24 * dt),
          ),
          y: Math.max(
            24,
            Math.min(88, position.current.y + (dy / length) * 24 * dt),
          ),
        };
        setLocal({ ...position.current });
        if (now - lastSent >= 110) {
          sendRef.current({ ...position.current, color: colorRef.current });
          lastSent = now;
        }
      }
      frame = requestAnimationFrame(run);
    };
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,select,textarea")) return;
      const key = e.key.toLowerCase();
      if (
        [
          "arrowup",
          "arrowdown",
          "arrowleft",
          "arrowright",
          "w",
          "a",
          "s",
          "d",
        ].includes(key)
      ) {
        e.preventDefault();
        keys.current.add(key);
      }
      if (["1", "2", "3", "4"].includes(key) && !e.repeat)
        sendRef.current({
          ...position.current,
          color: colorRef.current,
          emote: ["hi!", "GG", "?", "!!"][Number(key) - 1],
        });
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase()),
      blur = () => keys.current.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    frame = requestAnimationFrame(run);
    const timer = setInterval(() => setTick(Date.now()), 500);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(timer);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      keys.current.clear();
    };
  }, [selfKey, connected]);
  function chooseColor(n: number) {
    setColor(n);
    colorRef.current = n;
    localStorage.setItem("codeline:avatar-color", String(n));
    if (ready.current) send({ ...position.current, color: n });
  }
  function emote(value: string) {
    if (ready.current) send({ ...position.current, color, emote: value });
  }
  return (
    <>
      <div className="playground-heading">
        <h1 className="brand">WAITING ROOM</h1>
        <span>
          {joined} / {total} JOINED
        </span>
      </div>
      <div className="playground-layout">
        <div
          className="playground-floor"
          tabIndex={0}
          aria-label="Waiting room playground, use WASD or arrow keys to move"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            target.current = {
              x: Math.max(
                3,
                Math.min(97, ((e.clientX - r.left) / r.width) * 100),
              ),
              y: Math.max(
                24,
                Math.min(88, ((e.clientY - r.top) / r.height) * 100),
              ),
            };
            e.currentTarget.focus();
          }}
        >
          <div className="playground-wall">
            <div>
              <b>{title.toUpperCase()}</b>
              <p>Game starts soon...</p>
            </div>
            <span>
              {String(Math.floor(timeLimit / 60)).padStart(2, "0")}:
              {String(timeLimit % 60).padStart(2, "0")}
            </span>
          </div>
          <div className="pixel-plant left" />
          <div className="pixel-plant right" />
          <div className="floor-bench bench-one" />
          <div className="floor-bench bench-two" />
          <div className="floor-bench bench-three" />
          {players.map((p) => {
            const mine = p.key === selfKey,
              pos = mine && local ? local : p;
            return (
              <div
                key={p.key}
                className={`world-player ${mine ? "mine" : ""}`}
                style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
              >
                {p.emoteUntil > tick && (
                  <span className="emote-bubble">{p.emote}</span>
                )}
                <span className="player-name">
                  {mine ? "YOU · " : ""}
                  {p.name}
                </span>
                <PixelPerson color={mine ? color : p.color} />
              </div>
            );
          })}
          {!connected && (
            <p className="playground-offline">
              Reconnecting… Movement will resume when connected.
            </p>
          )}
        </div>
        <aside className="playground-sidebar">
          <section className="panel character-panel">
            <h2>YOUR CHARACTER</h2>
            <PixelPerson color={color} />
            <p>{name}</p>
            <div className="color-choices">
              {colors.map((c, i) => (
                <button
                  key={c}
                  style={{ background: c }}
                  aria-label={`Character color ${i + 1}`}
                  aria-pressed={color === i}
                  className={color === i ? "selected" : ""}
                  onClick={() => chooseColor(i)}
                />
              ))}
            </div>
          </section>
          <section className="panel">
            <h3>{title}</h3>
            <p>
              <span>{lineCount} LINES</span>{" "}
              <span className="mini-timer">
                TIME {String(Math.floor(timeLimit / 60)).padStart(2, "0")}:
                {String(timeLimit % 60).padStart(2, "0")}
              </span>
            </p>
            <p className="muted">Waiting for the lecturer to start...</p>
          </section>
          <section className="panel">
            <h2>EMOTES</h2>
            <div className="emote-buttons">
              {["hi!", "GG", "?", "!!"].map((v) => (
                <button
                  className="secondary-button pixel-button"
                  disabled={!connected || !self}
                  key={v}
                  onClick={() => emote(v)}
                >
                  {v}
                </button>
              ))}
            </div>
            <p className="muted">Move: W A S D or arrow keys</p>
            <p className="muted">Emote: keys 1–4 · click floor to walk</p>
            <div className="touch-controls" aria-label="Movement controls">
              {[
                ["↑", "arrowup"],
                ["←", "arrowleft"],
                ["↓", "arrowdown"],
                ["→", "arrowright"],
              ].map(([label, key]) => (
                <button
                  key={key}
                  className="secondary-button"
                  aria-label={`Move ${key.slice(5)}`}
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    keys.current.add(key);
                  }}
                  onPointerUp={() => keys.current.delete(key)}
                  onPointerCancel={() => keys.current.delete(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>
          <button
            className="secondary-button pixel-button w-full"
            onClick={onLeave}
          >
            Leave lobby
          </button>
        </aside>
      </div>
    </>
  );
}
