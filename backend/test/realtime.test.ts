import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import session from "express-session";
import { io, type Socket } from "socket.io-client";
import type { Pool } from "pg";
import { createApp } from "../src/app.js";
import { attachGameRealtime } from "../src/realtime.js";
function connect(socket: Socket) {
  return new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
    socket.connect();
  });
}
function nextEvent(socket: Socket, event: string) {
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("No room update received")),
      4000,
    );
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}
function watch(socket: Socket, id: number) {
  return new Promise<{ ok: boolean }>((resolve, reject) => {
    socket
      .timeout(3000)
      .emit("watch", id, (e: Error | null, result: { ok: boolean }) =>
        e ? reject(e) : resolve(result),
      );
  });
}
test("real WebSocket connections authenticate cookies, authorize rooms and send notifications without answers", async () => {
  const actor = randomUUID(),
    secret = "isolated-socket-session-secret",
    sid = randomUUID();
  process.env.SESSION_SECRET = secret;
  const store = new session.MemoryStore(),
    cookie = new session.Cookie();
  cookie.maxAge = 60000;
  await new Promise<void>((resolve, reject) =>
    store.set(
      sid,
      {
        cookie,
        identity: {
          oid: actor,
          email: "fixture@example.invalid",
          name: "Fixture",
        },
      },
      (e) => (e ? reject(e) : resolve()),
    ),
  );
  let role = "student";
  const query = async (sql: string, values?: unknown[]) => {
    if (sql.startsWith('SELECT "id", "email", "role"'))
      return { rows: [{ id: actor, email: "fixture@example.invalid", role }] };
    if (sql.startsWith('SELECT s.\"displayName\"'))
      return { rowCount: 1, rows: [{ displayName: "Fixture student" }] };
    if (sql.startsWith('SELECT * FROM "gameSessions"'))
      return {
        rowCount: values?.[0] === 1 ? 1 : 0,
        rows:
          values?.[0] === 1
            ? [{ id: 1, exerciseId: 1, hostUserId: randomUUID() }]
            : [],
      };
    if (sql.startsWith('SELECT 1 FROM "gameParticipants"'))
      return { rowCount: 1, rows: [{}] };
    return { rowCount: 0, rows: [] };
  };
  const pool = {
    on() {},
    query,
    async connect() {
      return { query, release() {} };
    },
  } as unknown as Pool;
  const { app, sessionMiddleware, currentUser, gameEvents } = createApp({
    pool,
    store,
  });
  const server = createServer(app),
    rt = attachGameRealtime(
      server,
      sessionMiddleware,
      currentUser,
      pool,
      gameEvents,
    );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const sig = createHmac("sha256", secret)
    .update(sid)
    .digest("base64")
    .replace(/=+$/, "");
  const header = `codeline.sid=${encodeURIComponent(`s:${sid}.${sig}`)}`;
  const make = (cookie?: string, origin = "http://localhost:5173") =>
    io(base, {
      autoConnect: false,
      reconnection: false,
      transports: ["websocket"],
      timeout: 3000,
      extraHeaders: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
    });
  const anonymous = make(),
    wrongOrigin = make(header, "https://foreign.example"),
    member = make(header);
  try {
    await assert.rejects(connect(anonymous));
    await assert.rejects(connect(wrongOrigin));
    await connect(member);
    const presence = nextEvent(member, "playground:state"),
      initial = nextEvent(member, "game:changed");
    assert.equal((await watch(member, 1)).ok, true);
    assert.deepEqual(await initial, { id: 1 });
    const state = (await presence) as {
      players: {
        key: string;
        name: string;
        x: number;
        y: number;
        color: number;
        emote: string;
        owner?: string;
      }[];
    };
    assert.equal(state.players.length, 1);
    assert.equal(state.players[0].name, "Fixture student");
    assert.notEqual(state.players[0].key, actor);
    assert.equal(state.players[0].owner, undefined);
    const moved = nextEvent(member, "playground:state");
    member.emit("playground:move", {
      x: 55,
      y: 70,
      color: 2,
      emote: "GG",
      name: "Spoofed name",
    });
    const movement = (await moved) as typeof state;
    assert.equal(movement.players[0].x, 55);
    assert.equal(movement.players[0].color, 2);
    assert.equal(movement.players[0].emote, "GG");
    assert.equal(movement.players[0].name, "Fixture student");
    const malformedAck = nextEvent(member, "game:changed");
    member.emit("watch", 1, { notAnAck: true });
    assert.deepEqual(await malformedAck, { id: 1 });
    const safeMove = nextEvent(member, "playground:state");
    member.emit("playground:move", {
      x: 60,
      y: 70,
      color: 4,
      emote: { toString: 0 },
    });
    member.emit("playground:move", { x: 60, y: 70, color: 4 });
    const safeState = (await safeMove) as typeof state;
    assert.equal(safeState.players[0].x, 60);
    assert.equal(safeState.players[0].color, 4);
    const update = nextEvent(member, "game:changed");
    gameEvents.emit("changed", 1);
    assert.deepEqual(await update, { id: 1 });
    assert.equal((await watch(member, 999)).ok, false);
    role = "lecturer";
    assert.equal((await watch(member, 1)).ok, false);
  } finally {
    anonymous.disconnect();
    wrongOrigin.disconnect();
    member.disconnect();
    rt.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
