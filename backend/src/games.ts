import { Router, type Request } from "express";
import type { Pool, PoolClient } from "pg";
import { randomInt } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import {
  ActionError,
  inTransaction,
  ownedExercise,
  positiveId,
  recheckStaff,
  type Actor,
} from "./exercises.js";
import { config } from "./config.js";
type Game = {
  id: number;
  exerciseId: number;
  hostUserId: string;
  joinPin: string;
  roomLocked: boolean;
  timeLimitSeconds: number;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
};
const staff = (a: Actor) => ["lecturer", "ta", "admin"].includes(a.role);
const controls = (a: Actor, g: Game) =>
  staff(a) && (a.role === "admin" || a.role === "ta" || a.id === g.hostUserId);
async function lockGame(db: PoolClient, id: number) {
  const r = await db.query<Game>(
    'SELECT * FROM "gameSessions" WHERE "id"=$1 FOR UPDATE',
    [id],
  );
  if (!r.rowCount) throw new ActionError(404, "Game not found");
  return r.rows[0];
}
async function finish(db: PoolClient, g: Game, at: Date) {
  await db.query(
    'UPDATE "gameSessions" SET "endedAt"=$2 WHERE "id"=$1 AND "endedAt" IS NULL',
    [g.id, at],
  );
  await db.query(
    'UPDATE "gameParticipants" SET "score"=0 WHERE "sessionId"=$1 AND ("solvedAt" IS NULL OR "attendance"<>\'joined\')',
    [g.id],
  );
  g.endedAt = at;
}
async function expire(db: PoolClient, g: Game) {
  if (g.startedAt && !g.endedAt) {
    const deadline = new Date(
      new Date(g.startedAt).getTime() + g.timeLimitSeconds * 1000,
    );
    if (deadline.getTime() <= Date.now()) await finish(db, g, deadline);
  }
}
async function eligible(db: PoolClient, g: Game, a: Actor) {
  if (controls(a, g)) return;
  const p = await db.query(
    'SELECT 1 FROM "gameParticipants" p JOIN "exercises" e ON e."id"=$1 JOIN "courseStudents" cs ON cs."courseId"=e."courseId" AND cs."studentId"=p."studentId" WHERE p."sessionId"=$2 AND p."studentId"=$3',
    [g.exerciseId, g.id, a.id],
  );
  if (a.role !== "student" || !p.rowCount)
    throw new ActionError(403, "You do not have access to this game");
}
export async function canWatchGame(pool: Pool, id: number, a: Actor) {
  return inTransaction(pool, async (db) => {
    const g = await lockGame(db, id);
    await eligible(db, g, a);
    return true;
  });
}
export async function expireGames(pool: Pool, changed: (id: number) => void) {
  const r = await pool.query(
    'SELECT "id" FROM "gameSessions" WHERE "endedAt" IS NULL AND "startedAt"+"timeLimitSeconds"*interval \'1 second\'<=now()',
  );
  for (const row of r.rows) {
    await inTransaction(pool, async (db) => {
      const g = await lockGame(db, row.id);
      await expire(db, g);
    });
    changed(row.id);
  }
}
export function gamesRouter(
  pool: Pool | null,
  currentUser: (req: Request) => Promise<Actor | null>,
  changed: (id: number) => void,
) {
  const router = Router();
  const activities = new Map<
    number,
    {
      touched: number;
      rows: {
        at: string;
        actor: string;
        line: number | null;
        result: string;
        points: number | null;
        studentId?: string;
      }[];
    }
  >();
  const record = (
    id: number,
    actor: string,
    result: string,
    line: number | null = null,
    points: number | null = null,
    studentId?: string,
  ) => {
    for (const [key, value] of activities)
      if (Date.now() - value.touched > 8 * 3600000 || activities.size > 100)
        activities.delete(key);
    const log = activities.get(id) || { touched: Date.now(), rows: [] };
    log.touched = Date.now();
    log.rows.push({
      at: new Date().toISOString(),
      actor,
      line,
      result,
      points,
      studentId,
    });
    if (log.rows.length > 2000) log.rows.shift();
    activities.set(id, log);
  };

  router.use(async (req, res, next) => {
    try {
      const a = await currentUser(req);
      if (!a) return res.status(401).json({ error: "Sign in required" });
      if (!pool) return res.status(503).json({ error: "Database unavailable" });
      if (
        req.method !== "GET" &&
        req.get("origin") !== new URL(config.origin).origin
      )
        return res.status(403).json({ error: "Invalid request origin" });
      res.locals.actor = a;
      next();
    } catch (e) {
      next(e);
    }
  });
  router.get("/", async (_req, res) => {
    const a: Actor = res.locals.actor;
    const r = await pool!.query(
      'SELECT g.*,e."title",c."code" AS "courseCode" FROM "gameSessions" g JOIN "exercises" e ON e."id"=g."exerciseId" JOIN "courses" c ON c."id"=e."courseId" WHERE ($2=\'student\' AND EXISTS(SELECT 1 FROM "gameParticipants" p WHERE p."sessionId"=g."id" AND p."studentId"=$1)) OR ($2<>\'student\' AND (g."hostUserId"=$1 OR $2 IN (\'admin\',\'ta\'))) ORDER BY g."createdAt" DESC LIMIT 100',
      [a.id, a.role],
    );
    res.json({
      games: r.rows.map((g) => ({
        id: g.id,
        title: g.title,
        courseCode: g.courseCode,
        createdAt: g.createdAt,
        startedAt: g.startedAt,
        endedAt: g.endedAt,
        ...(staff(a) ? { joinPin: g.joinPin } : {}),
      })),
    });
  });
  router.post("/", async (req, res) => {
    const a: Actor = res.locals.actor;
    if (!staff(a)) throw new ActionError(403, "Staff access required");
    const exerciseId = positiveId(req.body?.exerciseId);
    const id = await inTransaction(pool!, async (db) => {
      await recheckStaff(db, a);
      const e = await ownedExercise(db, exerciseId, a);
      if (!e.exerciseState)
        throw new ActionError(
          409,
          "Save this exercise as ready before starting a lobby",
        );
      await db.query(
        'SELECT \"id\" FROM \"courses\" WHERE \"id\"=$1 FOR UPDATE',
        [e.courseId],
      );
      const blank = await db.query(
        'SELECT count(*)::int AS count FROM "exerciseLines" WHERE "exerciseId"=$1 AND NOT "isGiven"',
        [exerciseId],
      );
      const roster = await db.query(
        'SELECT "studentId" FROM "courseStudents" WHERE "courseId"=$1 ORDER BY "studentId"',
        [e.courseId],
      );
      if (!roster.rowCount || blank.rows[0].count !== roster.rowCount)
        throw new ActionError(
          409,
          `The course has ${roster.rowCount} enrolled students. Create exactly that many BLANK lines before starting.`,
        );
      await db.query("SELECT pg_advisory_xact_lock(213,6002)");
      let pin = "";
      for (let n = 0; n < 20; n++) {
        pin = String(randomInt(100000, 1000000));
        if (
          !(
            await db.query('SELECT 1 FROM "gameSessions" WHERE "joinPin"=$1', [
              pin,
            ])
          ).rowCount
        )
          break;
        pin = "";
      }
      if (!pin)
        throw new ActionError(503, "Could not reserve a PIN. Please retry.");
      const r = await db.query(
        'INSERT INTO "gameSessions" ("exerciseId","hostUserId","joinPin","timeLimitSeconds") SELECT $1,$2,$3,coalesce((SELECT "timeLimitSeconds" FROM "exerciseDetails" WHERE "exerciseId"=$1),300) RETURNING "id"',
        [exerciseId, a.id, pin],
      );
      const id = r.rows[0].id;
      await db.query(
        'INSERT INTO "gameParticipants" ("sessionId","studentId") SELECT $1,unnest($2::uuid[])',
        [id, roster.rows.map((p) => p.studentId)],
      );
      return id;
    });
    record(id, a.email, "Room created");
    res.status(201).json({ id });
    changed(id);
  });
  router.post(
    "/join",
    rateLimit({
      windowMs: 60000,
      limit: 30,
      keyGenerator: (_req, res) => String(res.locals.actor.id),
    }),
    async (req, res) => {
      const a: Actor = res.locals.actor;
      if (a.role !== "student")
        throw new ActionError(403, "Switch to a student account to join");
      const pin = req.body?.pin;
      if (typeof pin !== "string" || !/^\d{6}$/.test(pin))
        throw new ActionError(400, "Enter a six-digit PIN");
      const id = await inTransaction(pool!, async (db) => {
        const r = await db.query(
          'SELECT "id" FROM "gameSessions" WHERE "joinPin"=$1',
          [pin],
        );
        if (!r.rowCount)
          throw new ActionError(404, "No room found for that PIN");
        const g = await lockGame(db, r.rows[0].id);
        await eligible(db, g, a);
        await expire(db, g);
        if (g.endedAt)
          throw new ActionError(
            409,
            "This game has ended. Open it from game history.",
          );
        const p = (
          await db.query(
            'SELECT * FROM "gameParticipants" WHERE "sessionId"=$1 AND "studentId"=$2',
            [g.id, a.id],
          )
        ).rows[0];
        if (g.roomLocked && !p.joinedAt)
          throw new ActionError(409, "The lecturer has locked this room");
        if (p.attendance === "absent")
          throw new ActionError(
            409,
            "You are marked absent. Ask the lecturer to correct attendance before the game starts.",
          );
        if (g.startedAt && !p.joinedAt)
          throw new ActionError(409, "This game has already started");
        await db.query(
          'UPDATE "gameParticipants" SET "attendance"=\'joined\',"joinedAt"=coalesce("joinedAt",now()) WHERE "sessionId"=$1 AND "studentId"=$2',
          [g.id, a.id],
        );
        return g.id;
      });
      record(id, req.session.identity?.name || a.email, "Joined");
      res.json({ id });
      changed(id);
    },
  );
  router.post("/:id/leave", async (req, res) => {
    const a: Actor = res.locals.actor,
      id = positiveId(req.params.id);
    if (a.role !== "student")
      throw new ActionError(403, "Student access required");
    await inTransaction(pool!, async (db) => {
      const g = await lockGame(db, id);
      await eligible(db, g, a);
      if (g.startedAt)
        throw new ActionError(
          409,
          "The game has started; you can leave the view and rejoin without losing your line",
        );
      await db.query(
        'UPDATE "gameParticipants" SET "attendance"=\'waiting\' WHERE "sessionId"=$1 AND "studentId"=$2 AND "attendance"=\'joined\'',
        [id, a.id],
      );
    });
    record(id, req.session.identity?.name || a.email, "Left lobby");
    res.sendStatus(204);
    changed(id);
  });
  router.get("/:id", async (req, res) => {
    const a: Actor = res.locals.actor,
      id = positiveId(req.params.id);
    const view = await inTransaction(pool!, async (db) => {
      const g = await lockGame(db, id);
      await eligible(db, g, a);
      await expire(db, g);
      const e = (
        await db.query(
          'SELECT e."title",e."courseId",e."problemDescription",c."code" AS "courseCode",coalesce(d."pseudocode",\'\') AS "pseudocode",coalesce(d."wrongAttemptPenalty",10) AS "wrongAttemptPenalty" FROM "exercises" e JOIN "courses" c ON c."id"=e."courseId" LEFT JOIN "exerciseDetails" d ON d."exerciseId"=e."id" WHERE e."id"=$1',
          [g.exerciseId],
        )
      ).rows[0];
      const ps = (
        await db.query(
          'SELECT p.*,s."displayName",trim(s."studentNumber") AS "studentNumber",l."codeText",l."lineNumber" FROM "gameParticipants" p JOIN "students" s ON s."userId"=p."studentId" LEFT JOIN "exerciseLines" l ON l."id"=p."exerciseLineId" WHERE p."sessionId"=$1 ORDER BY s."displayName",p."studentId"',
          [id],
        )
      ).rows;
      const lines = (
        await db.query(
          'SELECT "id","lineNumber","codeText","isGiven" FROM "exerciseLines" WHERE "exerciseId"=$1 ORDER BY "lineNumber"',
          [g.exerciseId],
        )
      ).rows;
      const teacher = controls(a, g),
        me =
          a.role === "student"
            ? ps.find((p) => p.studentId === a.id)
            : undefined;
      const board = lines.map((l) => {
        const p = ps.find((p) => p.exerciseLineId === l.id);
        const revealed = Boolean(
          g.endedAt ||
          l.isGiven ||
          (g.startedAt && (p?.solvedAt || p?.attendance === "absent")),
        );
        return {
          position: l.lineNumber,
          isGiven: l.isGiven,
          visible: revealed,
          codeText: revealed ? l.codeText : null,
          solved: Boolean(p?.solvedAt),
          placedBy: revealed && p?.solvedAt ? p.displayName : null,
          answerShown: Boolean(
            !l.isGiven &&
            (g.endedAt || (g.startedAt && p?.attendance === "absent")) &&
            !p?.solvedAt,
          ),
          ...(teacher ? {
            answer: l.codeText,
            studentName: p?.displayName ?? null,
            retrying: Boolean(p && !p.solvedAt && p.attendance === "joined" &&
              (p.score < 100 || activities.get(id)?.rows.some((row) => row.studentId === p.studentId && row.result === "Wrong"))),
          } : {}),
        };
      });
      const courseLeaderboard =
        teacher && g.endedAt
          ? (
              await db.query(
                'SELECT s."displayName" AS "name",sum(p."score")::int AS "score",count(*)::int AS "gamesPlayed" FROM "gameParticipants" p JOIN "students" s ON s."userId"=p."studentId" JOIN "gameSessions" g2 ON g2."id"=p."sessionId" JOIN "exercises" e2 ON e2."id"=g2."exerciseId" WHERE e2."courseId"=$1 AND g2."endedAt" IS NOT NULL GROUP BY s."userId" ORDER BY sum(p."score") DESC,s."displayName"',
                [e.courseId],
              )
            ).rows
          : [];
      return {
        id: g.id,
        ...e,
        exerciseId: teacher ? g.exerciseId : undefined,
        courseLeaderboard,
        activity: teacher ? activities.get(id)?.rows || [] : undefined,
        activityTemporary: teacher,
        joinPin: teacher ? g.joinPin : undefined,
        roomLocked: g.roomLocked,
        timeLimitSeconds: g.timeLimitSeconds,
        createdAt: g.createdAt,
        startedAt: g.startedAt,
        endedAt: g.endedAt,
        serverTime: new Date(),
        canControl: teacher,
        board,
        participants: teacher
          ? ps.map((p) => ({
              studentId: p.studentId,
              name: p.displayName,
              studentNumber: p.studentNumber,
              attendance: p.attendance,
              joinedAt: p.joinedAt,
              solvedAt: p.solvedAt,
              score: p.score,
            }))
          : undefined,
        my: me
          ? {
              name: me.displayName,
              attendance: me.attendance,
              codeText: me.codeText || null,
              score: me.score,
              solvedAt: me.solvedAt,
              joinedAt: me.joinedAt,
            }
          : null,
        counts: {
          joined: ps.filter((p) => p.attendance === "joined").length,
          waiting: ps.filter((p) => p.attendance === "waiting").length,
          absent: ps.filter((p) => p.attendance === "absent").length,
          solved: ps.filter((p) => p.solvedAt).length,
          total: ps.length,
        },
        players: ps
          .filter((p) => p.attendance === "joined")
          .map((p) => ({ name: p.displayName })),
        leaderboard: g.endedAt
          ? ps
              .map((p) => ({
                name: p.displayName,
                isYou: a.role === "student" && p.studentId === a.id,
                score: p.score,
                solvedAt: p.solvedAt,
                attendance: p.attendance,
              }))
              .sort(
                (x, y) =>
                  y.score - x.score ||
                  (x.solvedAt ? new Date(x.solvedAt).getTime() : Infinity) -
                    (y.solvedAt ? new Date(y.solvedAt).getTime() : Infinity),
              )
          : [],
      };
    });
    res.json({ game: view });
  });
  router.post("/:id/lock", async (req, res) => {
    const a: Actor = res.locals.actor,
      id = positiveId(req.params.id);
    if (typeof req.body?.locked !== "boolean")
      throw new ActionError(400, "Specify room lock");
    await inTransaction(pool!, async (db) => {
      await recheckStaff(db, a);
      const g = await lockGame(db, id);
      if (!controls(a, g)) throw new ActionError(403, "Host access required");
      if (g.startedAt)
        throw new ActionError(409, "The game has already started");
      await db.query(
        'UPDATE "gameSessions" SET "roomLocked"=$2 WHERE "id"=$1',
        [id, req.body.locked],
      );
    });
    record(
      id,
      req.session.identity?.name || a.email,
      req.body.locked ? "Room locked" : "Room unlocked",
    );
    res.sendStatus(204);
    changed(id);
  });
  router.patch("/:id/attendance", async (req, res) => {
    const a: Actor = res.locals.actor,
      id = positiveId(req.params.id);
    const { studentId, attendance } = req.body || {};
    if (
      typeof studentId !== "string" ||
      !["waiting", "absent"].includes(attendance)
    )
      throw new ActionError(400, "Choose waiting or absent");
    await inTransaction(pool!, async (db) => {
      await recheckStaff(db, a);
      const g = await lockGame(db, id);
      if (!controls(a, g)) throw new ActionError(403, "Host access required");
      if (g.startedAt)
        throw new ActionError(
          409,
          "Attendance changes are limited to the lobby",
        );
      const r = await db.query(
        'UPDATE "gameParticipants" SET "attendance"=$3 WHERE "sessionId"=$1 AND "studentId"::text=$2 RETURNING "studentId"',
        [id, studentId, attendance],
      );
      if (!r.rowCount) throw new ActionError(404, "Participant not found");
    });
    record(id, req.session.identity?.name || a.email, "Attendance corrected");
    res.sendStatus(204);
    changed(id);
  });
  router.post("/:id/start", async (req, res) => {
    const a: Actor = res.locals.actor,
      id = positiveId(req.params.id);
    await inTransaction(pool!, async (db) => {
      await recheckStaff(db, a);
      const g = await lockGame(db, id);
      if (!controls(a, g)) throw new ActionError(403, "Host access required");
      if (g.startedAt) throw new ActionError(409, "Game already started");
      const ps = (
        await db.query(
          'SELECT "studentId","attendance" FROM "gameParticipants" WHERE "sessionId"=$1 ORDER BY "studentId"',
          [id],
        )
      ).rows;
      if (!ps.some((p) => p.attendance === "joined"))
        throw new ActionError(409, "Wait for at least one student to join");
      const lines = (
        await db.query(
          'SELECT "id" FROM "exerciseLines" WHERE "exerciseId"=$1 AND NOT "isGiven" ORDER BY "lineNumber"',
          [g.exerciseId],
        )
      ).rows;
      if (lines.length !== ps.length)
        throw new ActionError(409, "Roster and BLANK line counts do not match");
      for (let i = lines.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [lines[i], lines[j]] = [lines[j], lines[i]];
      }
      await db.query(
        'UPDATE "gameParticipants" p SET "exerciseLineId"=x.line,"attendance"=CASE WHEN p."attendance"=\'waiting\' THEN \'absent\'::"attendanceState" ELSE p."attendance" END,"score"=CASE WHEN p."attendance"=\'joined\' THEN 100 ELSE 0 END FROM unnest($2::uuid[],$3::int[]) x(student,line) WHERE p."sessionId"=$1 AND p."studentId"=x.student',
        [id, ps.map((p) => p.studentId), lines.map((l) => l.id)],
      );
      await db.query(
        'UPDATE "gameSessions" SET "startedAt"=now(),"roomLocked"=true WHERE "id"=$1',
        [id],
      );
    });
    record(
      id,
      req.session.identity?.name || a.email,
      "Game started; waiting students marked absent",
    );
    res.sendStatus(204);
    changed(id);
  });
  router.delete("/:id", async (req, res) => {
    const a: Actor = res.locals.actor,
      id = positiveId(req.params.id);
    await inTransaction(pool!, async (db) => {
      await recheckStaff(db, a);
      const g = await lockGame(db, id);
      if (!controls(a, g)) throw new ActionError(403, "Host access required");
      if (g.startedAt)
        throw new ActionError(409, "Started games are retained in history");
      await db.query('DELETE FROM "gameParticipants" WHERE "sessionId"=$1', [
        id,
      ]);
      await db.query('DELETE FROM "gameSessions" WHERE "id"=$1', [id]);
    });
    res.sendStatus(204);
    changed(id);
  });
  router.post("/:id/end", async (req, res) => {
    const a: Actor = res.locals.actor,
      id = positiveId(req.params.id);
    await inTransaction(pool!, async (db) => {
      await recheckStaff(db, a);
      const g = await lockGame(db, id);
      if (!controls(a, g)) throw new ActionError(403, "Host access required");
      if (!g.startedAt) throw new ActionError(409, "The game has not started");
      if (!g.endedAt) await finish(db, g, new Date());
    });
    record(id, req.session.identity?.name || a.email, "Game ended");
    res.sendStatus(204);
    changed(id);
  });
  const attempts = new Map<string, { expires: number; result: unknown }>();
  router.post(
    "/:id/submit",
    rateLimit({
      windowMs: 10000,
      limit: 50,
      keyGenerator: (_req, res) => String(res.locals.actor.id),
    }),
    async (req, res) => {
      const a: Actor = res.locals.actor,
        id = positiveId(req.params.id);
      if (a.role !== "student")
        throw new ActionError(403, "Student access required");
      const position = positiveId(req.body?.position),
        requestId = req.body?.requestId;
      if (
        typeof requestId !== "string" ||
        !/^[-a-zA-Z0-9]{16,64}$/.test(requestId)
      )
        throw new ActionError(400, "A submission request ID is required");
      const key = `${id}:${a.id}:${requestId}`;
      const result = await inTransaction(pool!, async (db) => {
        const g = await lockGame(db, id);
        await eligible(db, g, a);
        await expire(db, g);
        if (!g.startedAt || g.endedAt)
          throw new ActionError(409, "The game is not accepting attempts");
        const previous = attempts.get(key);
        if (previous && previous.expires > Date.now()) return previous.result;
        const p = (
          await db.query(
            'SELECT p.*,l."lineNumber",l."codeText" FROM "gameParticipants" p JOIN "exerciseLines" l ON l."id"=p."exerciseLineId" AND l."exerciseId"=$3 WHERE p."sessionId"=$1 AND p."studentId"=$2',
            [id, a.id, g.exerciseId],
          )
        ).rows[0];
        if (!p || p.attendance !== "joined")
          throw new ActionError(403, "You do not have an active assigned line");
        if (p.solvedAt)
          return { correct: true, score: p.score, alreadySolved: true };
        if (
          !(
            await db.query(
              'SELECT 1 FROM "exerciseLines" WHERE "exerciseId"=$1 AND "lineNumber"=$2 AND NOT "isGiven"',
              [g.exerciseId, position],
            )
          ).rowCount
        )
          throw new ActionError(400, "Choose a BLANK position");
        const correct = p.lineNumber === position;
        const penalty =
          (
            await db.query(
              'SELECT "wrongAttemptPenalty" FROM "exerciseDetails" WHERE "exerciseId"=$1',
              [g.exerciseId],
            )
          ).rows[0]?.wrongAttemptPenalty ?? 10;
        const score = correct ? p.score : Math.max(0, p.score - penalty);
        await db.query(
          'UPDATE "gameParticipants" SET "score"=$3,"solvedAt"=CASE WHEN $4 THEN now() ELSE NULL END WHERE "sessionId"=$1 AND "studentId"=$2',
          [id, a.id, score, correct],
        );
        if (
          correct &&
          !(
            await db.query(
              'SELECT 1 FROM "gameParticipants" WHERE "sessionId"=$1 AND "attendance"=\'joined\' AND "solvedAt" IS NULL LIMIT 1',
              [id],
            )
          ).rowCount
        )
          await finish(db, g, new Date());
        const result = { correct, score, points: score - p.score };
        if (attempts.size > 10000)
          for (const [k, v] of attempts) {
            if (v.expires < Date.now() || attempts.size > 10000)
              attempts.delete(k);
          }
        return result;
      });
      if (!attempts.has(key)) {
        const outcome = result as {
          correct: boolean;
          alreadySolved?: boolean;
          points?: number;
        };
        if (!outcome.alreadySolved)
          record(
            id,
            req.session.identity?.name || a.email,
            outcome.correct ? "Correct" : "Wrong",
            position,
            outcome.points ?? 0,
            a.id,
          );
      }
      attempts.set(key, { expires: Date.now() + 600000, result });
      res.json(result);
      changed(id);
    },
  );
  router.use(
    (
      e: unknown,
      _req: Request,
      res: import("express").Response,
      _next: import("express").NextFunction,
    ) => {
      if (e instanceof ActionError)
        return res.status(e.status).json({ error: e.message });
      console.error("Game action failed", {
        code: (e as { code?: string }).code || (e as Error).name,
      });
      res
        .status(503)
        .json({ error: "Could not complete this game action. Please retry." });
    },
  );
  return router;
}
