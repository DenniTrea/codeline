import { Router, type Request } from "express";
import type { Pool, PoolClient } from "pg";
import { config } from "./config.js";
import type { Role } from "./courses.js";
export type Actor = { id: string; email: string; role: Role };
export class ActionError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function positiveId(value: unknown) {
  if (!["string", "number"].includes(typeof value))
    throw new ActionError(400, "Invalid ID");
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 2147483647)
    throw new ActionError(400, "Invalid ID");
  return n;
}
export async function inTransaction<T>(
  pool: Pool,
  work: (db: PoolClient) => Promise<T>,
) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await work(db);
    await db.query("COMMIT");
    return result;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
export async function recheckStaff(db: PoolClient, actor: Actor) {
  const r = await db.query(
    'SELECT "role" FROM "users" WHERE "id"=$1 FOR UPDATE',
    [actor.id],
  );
  if (!["admin", "lecturer", "ta"].includes(r.rows[0]?.role))
    throw new ActionError(403, "Staff access required");
}
export async function ownedExercise(db: PoolClient, id: number, actor: Actor) {
  const r = await db.query(
    'SELECT * FROM "exercises" WHERE "id"=$1 FOR UPDATE',
    [id],
  );
  const e = r.rows[0];
  if (!e || e.deletedAt) throw new ActionError(404, "Exercise not found");
  if (e.ownerId !== actor.id && actor.role !== "admin")
    throw new ActionError(
      403,
      "Only the exercise owner can change this exercise",
    );
  return e;
}
export type ExerciseInput = {
  copiedFromId?: number;
  title: string;
  courseId: number;
  topicId: number;
  problemDescription: string;
  pseudocode: string;
  timeLimitSeconds: number;
  wrongAttemptPenalty: number;
  exerciseState: boolean;
  lines: { codeText: string; isGiven: boolean }[];
};
export function parseExercise(body: unknown): ExerciseInput {
  const b = body as ExerciseInput;
  if (
    !b ||
    typeof b.title !== "string" ||
    !b.title.trim() ||
    [...b.title.trim()].length > 50 ||
    typeof b.problemDescription !== "string" ||
    b.problemDescription.length > 20000 ||
    typeof b.pseudocode !== "string" ||
    b.pseudocode.length > 20000 ||
    !Number.isInteger(b.timeLimitSeconds) ||
    b.timeLimitSeconds < 1 ||
    b.timeLimitSeconds > 86400 ||
    !Number.isInteger(b.wrongAttemptPenalty) ||
    b.wrongAttemptPenalty < 0 ||
    b.wrongAttemptPenalty > 100 ||
    typeof b.exerciseState !== "boolean" ||
    !Array.isArray(b.lines) ||
    b.lines.length > 500 ||
    b.lines.some(
      (l) =>
        !l ||
        typeof l.codeText !== "string" ||
        l.codeText.length > 2000 ||
        /[\r\n]/.test(l.codeText) ||
        typeof l.isGiven !== "boolean",
    )
  )
    throw new ActionError(
      400,
      "Check the title, settings and code lines (maximum 500 lines).",
    );
  if (
    b.exerciseState &&
    (!b.problemDescription.trim() ||
      !b.lines.length ||
      !b.lines.some((l) => !l.isGiven && l.codeText.trim()))
  )
    throw new ActionError(
      400,
      "A ready exercise needs a problem description and at least one non-empty BLANK line.",
    );
  if (b.exerciseState && b.lines.some((l) => !l.isGiven && !l.codeText.trim()))
    throw new ActionError(
      400,
      "Remove empty code lines before marking this exercise ready.",
    );
  return {
    ...b,
    ...(b.copiedFromId ? { copiedFromId: positiveId(b.copiedFromId) } : {}),
    title: b.title.trim(),
    courseId: positiveId(b.courseId),
    topicId: positiveId(b.topicId),
  };
}
async function writeDetails(db: PoolClient, id: number, b: ExerciseInput) {
  await db.query(
    'INSERT INTO "exerciseDetails" ("exerciseId","timeLimitSeconds","wrongAttemptPenalty","pseudocode") VALUES ($1,$2,$3,$4) ON CONFLICT ("exerciseId") DO UPDATE SET "timeLimitSeconds"=$2,"wrongAttemptPenalty"=$3,"pseudocode"=$4',
    [id, b.timeLimitSeconds, b.wrongAttemptPenalty, b.pseudocode],
  );
  await db.query('DELETE FROM "exerciseLines" WHERE "exerciseId"=$1', [id]);
  if (b.lines.length)
    await db.query(
      'INSERT INTO "exerciseLines" ("exerciseId","lineNumber","codeText","isGiven") SELECT $1,x.ordinality::int,x.item->>\'codeText\',(x.item->>\'isGiven\')::boolean FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS x(item,ordinality)',
      [id, JSON.stringify(b.lines)],
    );
}
export function exercisesRouter(
  pool: Pool | null,
  currentUser: (req: Request) => Promise<Actor | null>,
) {
  const router = Router();
  router.use(async (req, res, next) => {
    try {
      const actor = await currentUser(req);
      if (!actor) return res.status(401).json({ error: "Sign in required" });
      if (!["lecturer", "admin", "ta"].includes(actor.role))
        return res.status(403).json({ error: "Staff access required" });
      if (
        req.method !== "GET" &&
        req.get("origin") !== new URL(config.origin).origin
      )
        return res.status(403).json({ error: "Invalid request origin" });
      if (!pool) return res.status(503).json({ error: "Database unavailable" });
      res.locals.actor = actor;
      next();
    } catch (e) {
      next(e);
    }
  });
  router.get("/topics", async (_req, res) => {
    res.json({
      topics: (
        await pool!.query('SELECT "id","name" FROM "topics" ORDER BY "name"')
      ).rows,
    });
  });
  router.post("/topics", async (req, res) => {
    const name = req.body?.name;
    if (typeof name !== "string" || !name.trim() || name.trim().length > 50)
      throw new ActionError(400, "Topic name must be 1–50 characters");
    const result = await inTransaction(pool!, async (db) => {
      await recheckStaff(db, res.locals.actor);
      return db.query(
        'INSERT INTO "topics" ("name") VALUES ($1) ON CONFLICT ("name") DO UPDATE SET "name"=excluded."name" RETURNING "id","name"',
        [name.trim()],
      );
    });
    res.status(201).json({ topic: result.rows[0] });
  });
  router.get("/:id", async (req, res) => {
    const id = positiveId(req.params.id);
    const result = await pool!.query(
      'SELECT e.*,coalesce(d."timeLimitSeconds",300) AS "timeLimitSeconds",coalesce(d."wrongAttemptPenalty",10) AS "wrongAttemptPenalty",coalesce(d."pseudocode",\'\') AS "pseudocode",EXISTS(SELECT 1 FROM "gameSessions" g WHERE g."exerciseId"=e."id") AS "used" FROM "exercises" e LEFT JOIN "exerciseDetails" d ON d."exerciseId"=e."id" WHERE e."id"=$1 AND e."deletedAt" IS NULL',
      [id],
    );
    const e = result.rows[0];
    if (!e) throw new ActionError(404, "Exercise not found");
    if (e.ownerId !== res.locals.actor.id && res.locals.actor.role !== "admin")
      throw new ActionError(403, "Exercise owner access required");
    const lines = await pool!.query(
      'SELECT "id","lineNumber","codeText","isGiven" FROM "exerciseLines" WHERE "exerciseId"=$1 ORDER BY "lineNumber"',
      [id],
    );
    res.json({
      exercise: {
        ...e,
        problemDescription: e.problemDescription || "",
        lines: lines.rows,
      },
    });
  });
  router.post("/", async (req, res) => {
    const b = parseExercise(req.body);
    const id = await inTransaction(pool!, async (db) => {
      await recheckStaff(db, res.locals.actor);
      if (b.copiedFromId)
        await ownedExercise(db, b.copiedFromId, res.locals.actor);
      const r = await db.query(
        'INSERT INTO "exercises" ("courseId","topicId","ownerId","title","problemDescription","exerciseState","copiedFromId") VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING "id"',
        [
          b.courseId,
          b.topicId,
          res.locals.actor.id,
          b.title,
          b.problemDescription,
          b.exerciseState,
          b.copiedFromId || null,
        ],
      );
      await writeDetails(db, r.rows[0].id, b);
      return r.rows[0].id;
    });
    res.status(201).json({ id });
  });
  router.put("/:id", async (req, res) => {
    const id = positiveId(req.params.id),
      b = parseExercise(req.body);
    await inTransaction(pool!, async (db) => {
      await recheckStaff(db, res.locals.actor);
      await ownedExercise(db, id, res.locals.actor);
      if (
        (
          await db.query(
            'SELECT 1 FROM "gameSessions" WHERE "exerciseId"=$1 LIMIT 1',
            [id],
          )
        ).rowCount
      )
        throw new ActionError(
          409,
          "This exercise has game history. Copy it to make an editable version.",
        );
      await db.query(
        'UPDATE "exercises" SET "title"=$2,"courseId"=$3,"topicId"=$4,"problemDescription"=$5,"exerciseState"=$6 WHERE "id"=$1',
        [
          id,
          b.title,
          b.courseId,
          b.topicId,
          b.problemDescription,
          b.exerciseState,
        ],
      );
      await writeDetails(db, id, b);
    });
    res.json({ id });
  });
  router.post("/:id/copy", async (req, res) => {
    const id = positiveId(req.params.id);
    const copiedId = await inTransaction(pool!, async (db) => {
      await recheckStaff(db, res.locals.actor);
      const e = await ownedExercise(db, id, res.locals.actor);
      const copy = await db.query(
        'INSERT INTO "exercises" ("courseId","topicId","ownerId","title","problemDescription","copiedFromId","exerciseState") VALUES ($1,$2,$3,$4,$5,$6,false) RETURNING "id"',
        [
          e.courseId,
          e.topicId,
          res.locals.actor.id,
          [...e.title].slice(0, 43).join("") + " (copy)",
          e.problemDescription,
          id,
        ],
      );
      const n = copy.rows[0].id;
      await db.query(
        'INSERT INTO "exerciseDetails" ("exerciseId","timeLimitSeconds","wrongAttemptPenalty","pseudocode") SELECT $2,"timeLimitSeconds","wrongAttemptPenalty","pseudocode" FROM "exerciseDetails" WHERE "exerciseId"=$1',
        [id, n],
      );
      await db.query(
        'INSERT INTO "exerciseLines" ("exerciseId","lineNumber","codeText","isGiven") SELECT $2,"lineNumber","codeText","isGiven" FROM "exerciseLines" WHERE "exerciseId"=$1',
        [id, n],
      );
      return n;
    });
    res.status(201).json({ id: copiedId });
  });
  router.delete("/:id", async (req, res) => {
    const id = positiveId(req.params.id);
    await inTransaction(pool!, async (db) => {
      await recheckStaff(db, res.locals.actor);
      await ownedExercise(db, id, res.locals.actor);
      await db.query('UPDATE "exercises" SET "deletedAt"=now() WHERE "id"=$1', [
        id,
      ]);
    });
    res.sendStatus(204);
  });
  router.post("/:id/restore", async (req, res) => {
    const id = positiveId(req.params.id);
    await inTransaction(pool!, async (db) => {
      await recheckStaff(db, res.locals.actor);
      const r = await db.query(
        'SELECT "ownerId" FROM "exercises" WHERE "id"=$1 FOR UPDATE',
        [id],
      );
      if (!r.rowCount) throw new ActionError(404, "Exercise not found");
      if (
        r.rows[0].ownerId !== res.locals.actor.id &&
        res.locals.actor.role !== "admin"
      )
        throw new ActionError(403, "Exercise owner access required");
      await db.query('UPDATE "exercises" SET "deletedAt"=NULL WHERE "id"=$1', [
        id,
      ]);
    });
    res.sendStatus(204);
  });
  router.use(
    (
      e: unknown,
      _req: Request,
      res: import("express").Response,
      _next: import("express").NextFunction,
    ) => {
      if (e instanceof ActionError)
        return res.status(e.status).json({ error: e.message });
      if ((e as { code?: string }).code === "23503")
        return res
          .status(409)
          .json({
            error:
              "A selected course or topic no longer exists. Refresh and try again.",
          });
      console.error("Exercise action failed", {
        code: (e as { code?: string }).code || (e as Error).name,
      });
      res
        .status(503)
        .json({ error: "Could not save this exercise. Please retry." });
    },
  );
  return router;
}
