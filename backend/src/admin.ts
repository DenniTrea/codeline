import { Router, type Request } from 'express';
import type { Pool, PoolClient } from 'pg';
import { config, authConfigured } from './config.js';
import { createCourse, parseCourse, type Role } from './courses.js';

type User = { id: string; email: string; role: Role };
export class AdminError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const roles: Role[] = ['admin', 'lecturer', 'ta', 'student'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function courseId(value: unknown) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || Number(value) > 2147483647) throw new AdminError(400, 'Invalid course ID');
  return Number(value);
}
function userId(value: unknown) {
  if (typeof value !== 'string' || !uuid.test(value)) throw new AdminError(400, 'Invalid account ID');
  return value;
}
async function transaction<T>(pool: Pool, work: (db: PoolClient) => Promise<T>) {
  const db = await pool.connect();
  try { await db.query('BEGIN'); const result = await work(db); await db.query('COMMIT'); return result; }
  catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
async function assertAdmin(db: PoolClient, actor: string) {
  const r = await db.query('SELECT "role" FROM "users" WHERE "id"=$1 FOR UPDATE', [actor]);
  if (r.rows[0]?.role !== 'admin') throw new AdminError(403, 'Admin access required');
}
export async function changeRole(pool: Pool, actor: string, target: string, role: Role) {
  return transaction(pool, async db => {
    // Serialize role changes, then recheck the actor under the lock. Concurrent
    // admins cannot demote each other and accidentally leave no active admin.
    await db.query('SELECT pg_advisory_xact_lock(213, 6001)');
    await assertAdmin(db, actor);
    if (actor === target && role !== 'admin') throw new AdminError(409, 'You cannot remove your own admin access');
    const targetRow = await db.query('SELECT "email", "role" FROM "users" WHERE "id"=$1 FOR UPDATE', [target]);
    if (!targetRow.rowCount) throw new AdminError(404, 'Account not found');
    if (role !== 'student' && targetRow.rows[0].role === 'student') {
      const active = await db.query('SELECT 1 FROM "gameParticipants" p JOIN "gameSessions" g ON g."id"=p."sessionId" WHERE p."studentId"=$1 AND g."endedAt" IS NULL LIMIT 1', [target]);
      if (active.rowCount) throw new AdminError(409, 'End this student’s open game sessions before changing their role');
    }
    if (role === 'student') await db.query('INSERT INTO "students" ("userId", "displayName") VALUES ($1,$2) ON CONFLICT ("userId") DO NOTHING', [target, targetRow.rows[0].email]);
    await db.query('UPDATE "users" SET "role"=$1 WHERE "id"=$2', [role, target]);
    return { id: target, role };
  });
}
export async function enrollStudents(pool: Pool, actor: string, course: number, ids: string[]) {
  return transaction(pool, async db => {
    await assertAdmin(db, actor);
    const c = await db.query('SELECT "id" FROM "courses" WHERE "id"=$1 FOR UPDATE', [course]);
    if (!c.rowCount) throw new AdminError(404, 'Course not found');
    const students = await db.query('SELECT u."id" FROM "users" u JOIN "students" s ON s."userId"=u."id" WHERE u."id"=ANY($1::uuid[]) AND u."role"=$2 FOR UPDATE OF u', [ids, 'student']);
    if (students.rowCount !== ids.length) throw new AdminError(400, 'Every selected account must be a registered student');
    const result = await db.query('INSERT INTO "courseStudents" ("courseId", "studentId") SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING RETURNING "studentId"', [course, ids]);
    return { added: result.rowCount, alreadyEnrolled: ids.length - (result.rowCount || 0) };
  });
}
export async function removeEnrollment(pool: Pool, actor: string, course: number, student: string) {
  return transaction(pool, async db => {
    await assertAdmin(db, actor);
    const c = await db.query('SELECT "id" FROM "courses" WHERE "id"=$1 FOR UPDATE', [course]);
    if (!c.rowCount) throw new AdminError(404, 'Course not found');
    const active = await db.query('SELECT 1 FROM "gameParticipants" p JOIN "gameSessions" g ON g."id"=p."sessionId" JOIN "exercises" e ON e."id"=g."exerciseId" WHERE p."studentId"=$1 AND e."courseId"=$2 AND g."endedAt" IS NULL LIMIT 1', [student, course]);
    if (active.rowCount) throw new AdminError(409, 'End open game sessions for this student before removing enrollment');
    const r = await db.query('DELETE FROM "courseStudents" WHERE "courseId"=$1 AND "studentId"=$2 RETURNING "studentId"', [course, student]);
    if (!r.rowCount) throw new AdminError(404, 'Enrollment not found');
  });
}
export async function deleteCourse(pool: Pool, actor: string, id: number, confirmCode: string, expectedEnrolledCount: number) {
  return transaction(pool, async db => {
    await assertAdmin(db, actor);
    const course = await db.query('SELECT "code" FROM "courses" WHERE "id"=$1 FOR UPDATE', [id]);
    if (!course.rowCount) throw new AdminError(404, 'Course not found');
    if (course.rows[0].code !== confirmCode) throw new AdminError(409, 'Course code changed or confirmation does not match. Refresh and try again.');
    const linked = await db.query('SELECT 1 FROM "exercises" WHERE "courseId"=$1 LIMIT 1', [id]);
    if (linked.rowCount) throw new AdminError(409, 'This course has exercises or game history attached and cannot be deleted.');
    const enrolled = await db.query('SELECT count(*)::int AS count FROM "courseStudents" WHERE "courseId"=$1', [id]);
    if (enrolled.rows[0].count !== expectedEnrolledCount) throw new AdminError(409, 'Enrollment changed. Cancel, refresh, and review the course before deleting.');
    await db.query('DELETE FROM "courseStudents" WHERE "courseId"=$1', [id]);
    await db.query('DELETE FROM "courses" WHERE "id"=$1', [id]);
  });
}
export function adminRouter(pool: Pool | null, currentUser: (req: Request) => Promise<User | null>) {
  const router = Router();
  router.use(async (req, res, next) => {
    try {
      const user = await currentUser(req);
      if (!user) return res.status(401).json({ error: 'Sign in required' });
      if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
      if (!['GET','HEAD'].includes(req.method) && req.get('origin') !== new URL(config.origin).origin) return res.status(403).json({ error: 'Invalid request origin' });
      if (!pool) return res.status(503).json({ error: 'Database unavailable' });
      res.locals.actor = user.id;
      if (!['GET','HEAD'].includes(req.method)) res.on('finish', () => {
        if (res.statusCode<400) console.info(JSON.stringify({ event:'admin_action',actor:user.id,method:req.method,path:req.path,status:res.statusCode }));
      });
      next();
    } catch (error) { next(error); }
  });
  router.get('/summary', async (_req, res) => {
    const r = await pool!.query(`SELECT
      (SELECT count(*)::int FROM "users") AS "accounts",
      (SELECT count(*)::int FROM "users" WHERE "role"='student') AS "students",
      (SELECT count(*)::int FROM "courses") AS "courses",
      (SELECT count(*)::int FROM "courseStudents") AS "enrollments",
      (SELECT count(*)::int FROM "gameSessions" WHERE "endedAt" IS NULL) AS "openSessions"`);
    res.json({ ...r.rows[0], database: 'connected', microsoftConfigured: authConfigured });
  });
  router.get('/users', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length > 100) throw new AdminError(400, 'Search is too long');
    const role = typeof req.query.role === 'string' ? req.query.role : '';
    if (role && !roles.includes(role as Role)) throw new AdminError(400, 'Invalid role');
    const offset = Number(req.query.offset || 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > 1000000) throw new AdminError(400, 'Invalid page');
    const r = await pool!.query(`SELECT u."id",u."email",u."role",s."displayName",trim(s."studentNumber") AS "studentNumber", count(cs."courseId")::int AS "enrolledCount"
      FROM "users" u LEFT JOIN "students" s ON s."userId"=u."id" LEFT JOIN "courseStudents" cs ON cs."studentId"=u."id"
      WHERE ($1='' OR strpos(lower(u."email"),lower($1))>0 OR strpos(lower(coalesce(s."displayName",'')),lower($1))>0 OR strpos(coalesce(s."studentNumber",''),$1)>0)
      AND ($2='' OR u."role"::text=$2)
      GROUP BY u."id",s."userId" ORDER BY u."email" LIMIT 51 OFFSET $3`, [q, role, offset]);
    res.json({ users: r.rows.slice(0,50), hasMore: r.rows.length>50 });
  });
  router.patch('/users/:id/role', async (req, res) => {
    const target = userId(req.params.id);
    if (!roles.includes(req.body?.role)) throw new AdminError(400, 'Invalid role');
    res.json({ user: await changeRole(pool!, res.locals.actor, target, req.body.role) });
  });
  router.patch('/users/:id/student', async (req, res) => {
    const id = userId(req.params.id);
    const { displayName, studentNumber } = req.body || {};
    if (typeof displayName !== 'string' || !displayName.trim() || [...displayName.trim()].length>100 ||
      !(studentNumber === null || (typeof studentNumber==='string' && /^\d{11}$/.test(studentNumber)))) throw new AdminError(400, 'Use a display name and an optional 11-digit student number');
    const r = await pool!.query('UPDATE "students" SET "displayName"=$1,"studentNumber"=$2 WHERE "userId"=$3 RETURNING "userId"', [displayName.trim(), studentNumber, id]);
    if (!r.rowCount) throw new AdminError(404, 'Student profile not found');
    res.json({ updated: true });
  });
  router.get('/courses', async (_req, res) => {
    const r = await pool!.query('SELECT c."id",c."code",c."studentCount",count(cs."studentId")::int AS "enrolledCount" FROM "courses" c LEFT JOIN "courseStudents" cs ON cs."courseId"=c."id" GROUP BY c."id" ORDER BY c."code"');
    res.json({ courses: r.rows });
  });
  router.post('/courses', async (req, res) => {
    const course = parseCourse(req.body);
    if (!course) throw new AdminError(400, 'Use a code of 1–30 characters and a planned count from 0 to 32767');
    res.status(201).json({ course: await createCourse(pool!, course) });
  });
  router.patch('/courses/:id', async (req, res) => {
    const id = courseId(req.params.id); const course = parseCourse(req.body);
    if (!course) throw new AdminError(400, 'Invalid course details');
    const r = await pool!.query('UPDATE "courses" SET "code"=$1,"studentCount"=$2 WHERE "id"=$3 RETURNING "id","code","studentCount"', [course.code, course.studentCount, id]);
    if (!r.rowCount) throw new AdminError(404, 'Course not found');
    res.json({ course: r.rows[0] });
  });
  router.delete('/courses/:id', async (req, res) => {
    const id = courseId(req.params.id);
    const { confirmCode, expectedEnrolledCount } = req.body || {};
    if (typeof confirmCode !== 'string' || !confirmCode || confirmCode.length>30 || !Number.isInteger(expectedEnrolledCount) || expectedEnrolledCount<0) throw new AdminError(400, 'Confirm the course code and current enrollment count');
    await deleteCourse(pool!, res.locals.actor, id, confirmCode, expectedEnrolledCount);
    res.sendStatus(204);
  });
  router.get('/courses/:id/students', async (req, res) => {
    const id = courseId(req.params.id);
    const exists = await pool!.query('SELECT "id" FROM "courses" WHERE "id"=$1', [id]);
    if (!exists.rowCount) throw new AdminError(404, 'Course not found');
    const r = await pool!.query('SELECT u."id",u."email",u."role",s."displayName",trim(s."studentNumber") AS "studentNumber" FROM "courseStudents" cs JOIN "students" s ON s."userId"=cs."studentId" JOIN "users" u ON u."id"=s."userId" WHERE cs."courseId"=$1 ORDER BY coalesce(s."studentNumber",u."email")', [id]);
    res.json({ students: r.rows });
  });
  router.post('/courses/:id/students', async (req, res) => {
    const id = courseId(req.params.id); const values = req.body?.studentIds;
    if (!Array.isArray(values) || !values.length || values.length>50) throw new AdminError(400, 'Select 1–50 registered students');
    const ids = [...new Set(values.map(userId))];
    res.json(await enrollStudents(pool!, res.locals.actor, id, ids));
  });
  router.delete('/courses/:id/students/:studentId', async (req, res) => {
    await removeEnrollment(pool!, res.locals.actor, courseId(req.params.id), userId(req.params.studentId));
    res.sendStatus(204);
  });
  router.use((error: unknown, _req: Request, res: import('express').Response, _next: import('express').NextFunction) => {
    if (error instanceof AdminError) return res.status(error.status).json({ error: error.message });
    if ((error as {code?:string}).code==='23505') return res.status(409).json({error:'That course code or student number is already in use'});
    console.error('Admin request failed', {code:(error as {code?:string;name?:string}).code || (error as Error).name});
    return res.status(503).json({error:'Could not complete this action. Please retry.'});
  });
  return router;
}
