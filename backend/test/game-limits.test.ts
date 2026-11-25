import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import session from "express-session";
import request from "supertest";
import type { Pool } from "pg";
import { createApp } from "../src/app.js";
test("more than sixty students sharing one IP can join; repeated requests are limited per account", async () => {
  const secret = "isolated-classroom-rate-limit-secret";
  process.env.SESSION_SECRET = secret;
  const store = new session.MemoryStore();
  const query = async (sql: string, values?: unknown[]) => {
    if (sql.startsWith('SELECT "id", "email", "role"'))
      return {
        rows: [
          {
            id: values?.[0],
            email: "fixture@example.invalid",
            role: "student",
          },
        ],
      };
    if (sql.startsWith('SELECT "id" FROM "gameSessions"'))
      return { rowCount: 1, rows: [{ id: 1 }] };
    if (sql.startsWith('SELECT * FROM "gameSessions"'))
      return {
        rowCount: 1,
        rows: [
          {
            id: 1,
            exerciseId: 1,
            hostUserId: randomUUID(),
            startedAt: null,
            endedAt: null,
            roomLocked: false,
            timeLimitSeconds: 300,
          },
        ],
      };
    if (sql.startsWith('SELECT * FROM "gameParticipants"'))
      return { rowCount: 1, rows: [{ attendance: "waiting", joinedAt: null }] };
    return { rowCount: 1, rows: [{}] };
  };
  const pool = {
    on() {},
    query,
    async connect() {
      return { query, release() {} };
    },
  } as unknown as Pool;
  const { app } = createApp({ pool, store });
  const headers: string[] = [];
  for (let n = 0; n < 61; n++) {
    const sid = randomUUID(),
      cookie = new session.Cookie();
    cookie.maxAge = 60000;
    await new Promise<void>((resolve, reject) =>
      store.set(
        sid,
        {
          cookie,
          identity: {
            oid: randomUUID(),
            email: "fixture@example.invalid",
            name: "Fixture",
          },
        },
        (e) => (e ? reject(e) : resolve()),
      ),
    );
    const sig = createHmac("sha256", secret)
      .update(sid)
      .digest("base64")
      .replace(/=+$/, "");
    headers.push(`codeline.sid=${encodeURIComponent(`s:${sid}.${sig}`)}`);
  }
  const join = (header: string) =>
    request(app)
      .post("/api/games/join")
      .set("Origin", "http://localhost:5173")
      .set("Cookie", header)
      .send({ pin: "123456" });
  for (const h of headers) assert.equal((await join(h)).status, 200);
  for (let n = 0; n < 29; n++)
    assert.equal((await join(headers[0])).status, 200);
  assert.equal((await join(headers[0])).status, 429);
  assert.equal((await join(headers[60])).status, 200);
});
