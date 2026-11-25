import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import session from "express-session";
import request from "supertest";
import type { Pool } from "pg";
import { createApp } from "../src/app.js";
import { createPool } from "../src/db.js";
import { parseExercise } from "../src/exercises.js";
const origin = "http://localhost:5173";
async function login(pool: Pool, id: string) {
  const secret = "isolated-complete-flow-session-secret";
  process.env.SESSION_SECRET = secret;
  const sid = randomUUID(),
    store = new session.MemoryStore(),
    cookie = new session.Cookie();
  cookie.maxAge = 60000;
  await new Promise<void>((resolve, reject) =>
    store.set(
      sid,
      {
        cookie,
        identity: {
          oid: id,
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
  const { app } = createApp({ pool, store });
  return {
    client: request(app),
    header: `codeline.sid=${encodeURIComponent(`s:${sid}.${sig}`)}`,
  };
}
const draft = {
  title: "Fixture grade exercise",
  courseId: 1,
  topicId: 1,
  problemDescription: "Print a result",
  pseudocode: "PRINT a\nPRINT b",
  timeLimitSeconds: 300,
  wrongAttemptPenalty: 10,
  exerciseState: false,
  lines: [
    { codeText: "a = 1", isGiven: false },
    { codeText: "b = 2", isGiven: false },
    { codeText: "print(a + b)", isGiven: true },
  ],
};
test("exercise validation rejects invalid scoring, missing ready code and multiline rows", () => {
  for (const b of [
    { ...draft, wrongAttemptPenalty: -1 },
    { ...draft, wrongAttemptPenalty: 101 },
    { ...draft, timeLimitSeconds: 0 },
    { ...draft, title: "" },
    { ...draft, exerciseState: true, lines: [] },
    { ...draft, lines: [{ codeText: "one\ntwo", isGiven: false }] },
    { ...draft, lines: [{ codeText: "okay", isGiven: "false" }] },
  ])
    assert.throws(() => parseExercise(b));
  assert.equal(parseExercise(draft).lines.length, 3);
});
test(
  "full exercise and live-game API flow is authorized, private, atomic and rolled back",
  { skip: process.env.TEST_DATABASE !== "1" },
  async () => {
    const pool = createPool();
    assert.ok(pool);
    const db = await pool.connect();
    const host = randomUUID(),
      student = randomUUID(),
      second = randomUUID(),
      outsider = randomUUID(),
      otherHost = randomUUID();
    let gameId = 0;
    try {
      await db.query("BEGIN");
      for (const [id, role] of [
        [host, "lecturer"],
        [student, "student"],
        [second, "student"],
        [outsider, "student"],
        [otherHost, "lecturer"],
      ])
        await db.query(
          'INSERT INTO "users" ("id","email","role") VALUES ($1,$2,$3)',
          [id, `${id}@fixture.invalid`, role],
        );
      for (const id of [student, second, outsider])
        await db.query(
          'INSERT INTO "students" ("userId","displayName") VALUES ($1,$2)',
          [id, `Fixture ${id.slice(0, 4)}`],
        );
      const course = (
        await db.query(
          'INSERT INTO "courses" ("code","studentCount") VALUES ($1,2) RETURNING "id"',
          [`flow-${randomUUID().slice(0, 10)}`],
        )
      ).rows[0].id;
      const topic = (
        await db.query(
          'INSERT INTO "topics" ("name") VALUES ($1) RETURNING "id"',
          [`topic-${randomUUID()}`],
        )
      ).rows[0].id;
      await db.query(
        'INSERT INTO "courseStudents" ("courseId","studentId") VALUES ($1,$2),($1,$3)',
        [course, student, second],
      );
      const nested = {
        async query(sql: string, values?: unknown[]) {
          if (sql === "BEGIN") return db.query("SAVEPOINT action");
          if (sql === "COMMIT") return db.query("RELEASE SAVEPOINT action");
          if (sql === "ROLLBACK")
            return db.query("ROLLBACK TO SAVEPOINT action");
          return db.query(sql, values);
        },
        release() {},
      };
      const adapter = {
        on() {},
        query: db.query.bind(db),
        async connect() {
          return nested;
        },
      } as unknown as Pool;
      const h = await login(adapter, host),
        s = await login(adapter, student),
        s2 = await login(adapter, second),
        o = await login(adapter, outsider),
        h2 = await login(adapter, otherHost);
      const post = (actor: typeof h, path: string, body?: object) =>
        actor.client
          .post(path)
          .set("Cookie", actor.header)
          .set("Origin", origin)
          .send(body);
      const get = (actor: typeof h, path: string) =>
        actor.client.get(path).set("Cookie", actor.header);
      const body = { ...draft, courseId: course, topicId: topic };
      let r = await post(s, "/api/exercises", body);
      assert.equal(r.status, 403);
      r = await h.client
        .post("/api/exercises")
        .set("Cookie", h.header)
        .set("Origin", "https://foreign.example")
        .send(body);
      assert.equal(r.status, 403);
      r = await post(h, "/api/exercises", body);
      assert.equal(r.status, 201, r.text);
      const exerciseId = r.body.id;
      r = await get(h, `/api/exercises/${exerciseId}`);
      assert.equal(r.status, 200);
      assert.equal(r.body.exercise.lines.length, 3);
      assert.equal(r.body.exercise.lines[2].isGiven, true);
      r = await get(s, `/api/exercises/${exerciseId}`);
      assert.equal(r.status, 403);
      r = await get(h2, `/api/exercises/${exerciseId}`);
      assert.equal(r.status, 403);
      r = await post(h, "/api/games", { exerciseId });
      assert.equal(r.status, 409);
      r = await h.client
        .put(`/api/exercises/${exerciseId}`)
        .set("Cookie", h.header)
        .set("Origin", origin)
        .send({ ...body, exerciseState: true });
      assert.equal(r.status, 200, r.text);
      r = await post(h, "/api/games", { exerciseId });
      assert.equal(r.status, 201, r.text);
      gameId = r.body.id;
      const pin = (await get(h, `/api/games/${gameId}`)).body.game.joinPin;
      assert.match(pin, /^\d{6}$/);
      assert.equal(
        (
          await db.query(
            'SELECT 1 FROM "gameParticipants" WHERE "sessionId"=$1',
            [gameId],
          )
        ).rowCount,
        2,
      );
      r = await post(o, "/api/games/join", { pin });
      assert.equal(r.status, 403);
      r = await post(h2, `/api/games/${gameId}/start`);
      assert.equal(r.status, 403);
      r = await post(h, `/api/games/${gameId}/lock`, { locked: true });
      assert.equal(r.status, 204);
      r = await post(s, "/api/games/join", { pin });
      assert.equal(r.status, 409);
      r = await post(h, `/api/games/${gameId}/lock`, { locked: false });
      assert.equal(r.status, 204);
      r = await post(s, "/api/games/join", { pin });
      assert.equal(r.status, 200, r.text);
      r = await post(s, `/api/games/${gameId}/leave`);
      assert.equal(r.status, 204);
      assert.equal(
        (await get(h, `/api/games/${gameId}`)).body.game.counts.waiting,
        2,
      );
      r = await post(s, "/api/games/join", { pin });
      assert.equal(r.status, 200);
      r = await post(s2, "/api/games/join", { pin });
      assert.equal(r.status, 200);
      r = await post(h, `/api/games/${gameId}/lock`, { locked: true });
      assert.equal(r.status, 204);
      r = await post(s, "/api/games/join", { pin });
      assert.equal(r.status, 200);
      r = await post(h, `/api/games/${gameId}/start`);
      assert.equal(r.status, 204, r.text);
      r = await get(s, `/api/games/${gameId}`);
      assert.equal(r.status, 200, r.text);
      const view = r.body.game;
      assert.equal(view.my.score, 100);
      assert.ok(view.my.codeText);
      assert.equal(view.participants, undefined);
      assert.equal(view.joinPin, undefined);
      assert.equal(view.my.lineNumber, undefined);
      assert.ok(
        view.board
          .filter((l: { isGiven: boolean }) => !l.isGiven)
          .every(
            (l: { codeText: null; answer?: string }) =>
              l.codeText === null && l.answer === undefined,
          ),
      );
      assert.equal(view.board[2].codeText, "print(a + b)");
      const before = (
        await db.query(
          'SELECT "exerciseLineId" FROM "gameParticipants" WHERE "sessionId"=$1 AND "studentId"=$2',
          [gameId, student],
        )
      ).rows[0].exerciseLineId;
      r = await post(s, "/api/games/join", { pin });
      assert.equal(r.status, 200);
      assert.equal(
        (
          await db.query(
            'SELECT "exerciseLineId" FROM "gameParticipants" WHERE "sessionId"=$1 AND "studentId"=$2',
            [gameId, student],
          )
        ).rows[0].exerciseLineId,
        before,
      );
      const assigned = (
        await db.query(
          'SELECT l."lineNumber" FROM "gameParticipants" p JOIN "exerciseLines" l ON l."id"=p."exerciseLineId" WHERE p."sessionId"=$1 AND p."studentId"=$2',
          [gameId, student],
        )
      ).rows[0].lineNumber;
      const wrong = assigned === 1 ? 2 : 1,
        requestId = randomUUID();
      r = await post(s, `/api/games/${gameId}/submit`, {
        position: wrong,
        requestId,
      });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.score, 90);
      assert.equal(r.body.correct, false);
      const staffBoard = (await get(h, `/api/games/${gameId}`)).body.game.board;
      assert.equal(staffBoard.find((line: { position: number }) => line.position === assigned).retrying, true);
      assert.ok(staffBoard.find((line: { position: number }) => line.position === assigned).studentName);
      const privateBoard = (await get(s, `/api/games/${gameId}`)).body.game.board;
      assert.ok(privateBoard.every((line: { studentName?: string; retrying?: boolean }) => line.studentName === undefined && line.retrying === undefined));
      r = await post(s, `/api/games/${gameId}/submit`, {
        position: wrong,
        requestId,
      });
      assert.equal(r.body.score, 90);
      r = await post(s, `/api/games/${gameId}/submit`, {
        position: 3,
        requestId: randomUUID(),
      });
      assert.equal(r.status, 400);
      for (let n = 0; n < 12; n++)
        await post(s, `/api/games/${gameId}/submit`, {
          position: wrong,
          requestId: randomUUID(),
        });
      r = await get(s, `/api/games/${gameId}`);
      assert.equal(r.body.game.my.score, 0);
      r = await post(s, `/api/games/${gameId}/submit`, {
        position: assigned,
        requestId: randomUUID(),
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.correct, true);
      assert.equal(r.body.score, 0);
      const solvedLine = (await get(h, `/api/games/${gameId}`)).body.game.board.find((line: { position: number }) => line.position === assigned);
      assert.equal(solvedLine.solved, true);
      assert.equal(solvedLine.retrying, false);
      const studentBoard = (await get(s, `/api/games/${gameId}`)).body.game.board;
      assert.equal(studentBoard.find((line: { position: number }) => line.position === assigned).placedBy, solvedLine.studentName);
      assert.ok(studentBoard.filter((line: { visible: boolean }) => !line.visible).every((line: { placedBy: string | null }) => line.placedBy === null));
      r = await h.client
        .put(`/api/exercises/${exerciseId}`)
        .set("Cookie", h.header)
        .set("Origin", origin)
        .send(body);
      assert.equal(r.status, 409);
      r = await post(h2, "/api/exercises", {
        ...body,
        copiedFromId: exerciseId,
      });
      assert.equal(r.status, 403);
      r = await post(h, "/api/exercises", {
        ...body,
        copiedFromId: exerciseId,
      });
      assert.equal(r.status, 201, r.text);
      assert.equal(
        (await get(h, `/api/exercises/${r.body.id}`)).body.exercise
          .copiedFromId,
        exerciseId,
      );
      r = await post(h, `/api/exercises/${exerciseId}/copy`);
      assert.equal(r.status, 201);
      const copied = r.body.id;
      const copy = (await get(h, `/api/exercises/${copied}`)).body.exercise;
      assert.equal(copy.copiedFromId, exerciseId);
      assert.equal(copy.exerciseState, false);
      assert.equal(copy.lines.length, 3);
      assert.notEqual(copy.lines[0].id, before);
      r = await h.client
        .delete(`/api/exercises/${exerciseId}`)
        .set("Cookie", h.header)
        .set("Origin", origin);
      assert.equal(r.status, 204);
      r = await get(s, `/api/games/${gameId}`);
      assert.equal(r.status, 200);
      assert.equal(r.body.game.title, body.title);
      r = await post(h, `/api/exercises/${exerciseId}/restore`);
      assert.equal(r.status, 204);
      r = await post(h, `/api/games/${gameId}/end`);
      assert.equal(r.status, 204);
      r = await get(h, `/api/games/${gameId}`);
      assert.equal(r.status, 200, r.text);
      assert.ok(r.body.game.activity.length);
      assert.ok(r.body.game.courseLeaderboard.length);
      r = await get(s2, `/api/games/${gameId}`);
      assert.equal(r.body.game.activity, undefined);
      assert.equal(r.body.game.exerciseId, undefined);
      assert.ok(r.body.game.endedAt);
      assert.equal(r.body.game.my.score, 0);
      assert.ok(
        r.body.game.board.every((l: { visible: boolean }) => l.visible),
      );
      assert.equal(r.body.game.leaderboard.length, 2);
      r = await post(s2, `/api/games/${gameId}/submit`, {
        position: 1,
        requestId: randomUUID(),
      });
      assert.equal(r.status, 409);
      // Second game verifies waiting->absent, answer reveal and expiry, including server restart reads.
      r = await post(h, "/api/games", { exerciseId });
      assert.equal(r.status, 201);
      const next = r.body.id;
      const nextPin = (await get(h, `/api/games/${next}`)).body.game.joinPin;
      await post(s, "/api/games/join", { pin: nextPin });
      r = await post(h, `/api/games/${next}/start`);
      assert.equal(r.status, 204);
      const p2 = (
        await db.query(
          'SELECT "attendance","score","exerciseLineId" FROM "gameParticipants" WHERE "sessionId"=$1 AND "studentId"=$2',
          [next, second],
        )
      ).rows[0];
      assert.equal(p2.attendance, "absent");
      assert.equal(p2.score, 0);
      assert.ok(p2.exerciseLineId);
      r = await post(s2, "/api/games/join", { pin: nextPin });
      assert.equal(r.status, 409);
      r = await get(s, `/api/games/${next}`);
      assert.ok(
        r.body.game.board.some((l: { answerShown: boolean }) => l.answerShown),
      );
      await db.query(
        'UPDATE "gameSessions" SET "startedAt"=now()-interval \'301 seconds\' WHERE "id"=$1',
        [next],
      );
      r = await get(s, `/api/games/${next}`);
      assert.ok(r.body.game.endedAt);
      assert.equal(r.body.game.my.score, 0);
      r = await h.client
        .delete(`/api/games/${next}`)
        .set("Cookie", h.header)
        .set("Origin", origin);
      assert.equal(r.status, 409);
      r = await post(h, "/api/games", { exerciseId });
      const unused = r.body.id;
      assert.equal(r.status, 201);
      r = await h2.client
        .delete(`/api/games/${unused}`)
        .set("Cookie", h2.header)
        .set("Origin", origin);
      assert.equal(r.status, 403);
      r = await h.client
        .delete(`/api/games/${unused}`)
        .set("Cookie", h.header)
        .set("Origin", origin);
      assert.equal(r.status, 204);
      assert.equal((await get(h, `/api/games/${unused}`)).status, 404);
      r = await get(s, "/api/games");
      assert.equal(r.status, 200);
      assert.ok(r.body.games.some((g: { id: number }) => g.id === next));
      assert.ok(!("joinPin" in r.body.games[0]));
    } finally {
      await db.query("ROLLBACK");
      db.release();
      await pool.end();
    }
    const verify = createPool();
    assert.ok(verify);
    try {
      assert.equal(
        (await verify.query('SELECT 1 FROM "users" WHERE "id"=$1', [host]))
          .rowCount,
        0,
      );
    } finally {
      await verify.end();
    }
  },
);
