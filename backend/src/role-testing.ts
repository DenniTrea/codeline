import { Router, type Request } from 'express';
import type { Pool } from 'pg';
import { AdminError, removeEnrollment } from './admin.js';
import type { Role } from './courses.js';

type User = { id: string; email: string; role: Role };
export function roleTestingEnabled(environment: string | undefined, flag: string | undefined, origin: string) {
  return environment === 'development' && flag === 'true' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
}
export function localRequest(req: Request) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '') &&
    ['localhost', '127.0.0.1', '[::1]'].includes(req.hostname);
}
export function roleTestingRouter(pool: Pool | null, storedUser: (req: Request) => Promise<User | null>, enabled: boolean, origin: string) {
  const router = Router();
  router.use(async (req, res, next) => {
    try {
      if (!enabled || !localRequest(req)) return res.status(404).json({ error: 'Not found' });
      const user = await storedUser(req);
      if (!user) return res.status(401).json({ error: 'Sign in required' });
      if (user.role !== 'admin') return res.status(403).json({ error: 'Saved admin role required' });
      if (req.method !== 'GET' && req.get('origin') !== new URL(origin).origin) return res.status(403).json({ error: 'Invalid request origin' });
      if (!pool) return res.status(503).json({ error: 'Database unavailable' });
      res.locals.actor = user;
      next();
    } catch (error) { next(error); }
  });
  router.post('/role', (req, res, next) => {
    const role = req.body?.role;
    if (!['admin', 'lecturer', 'student'].includes(role)) return res.status(400).json({ error: 'Choose admin, lecturer or student' });
    if (role === 'admin') delete req.session.testRole;
    else req.session.testRole = role;
    req.session.save(error => error ? next(error) : res.sendStatus(204));
  });
  router.get('/courses', async (_req, res) => {
    const r = await pool!.query('SELECT c."id",c."code", EXISTS (SELECT 1 FROM "courseStudents" cs WHERE cs."courseId"=c."id" AND cs."studentId"=$1) AS "enrolled" FROM "courses" c ORDER BY c."code"', [res.locals.actor.id]);
    res.json({ courses: r.rows });
  });
  router.put('/enrollment', async (req, res) => {
    const id = req.body?.courseId;
    if (!Number.isInteger(id) || id < 1 || id > 2147483647) return res.status(400).json({ error: 'Choose a course' });
    const actor: User = res.locals.actor;
    const db = await pool!.connect();
    try {
      await db.query('BEGIN');
      const user = await db.query('SELECT "role" FROM "users" WHERE "id"=$1 FOR UPDATE', [actor.id]);
      if (user.rows[0]?.role !== 'admin') throw new AdminError(403, 'Saved admin role required');
      const course = await db.query('SELECT "id" FROM "courses" WHERE "id"=$1 FOR UPDATE', [id]);
      if (!course.rowCount) throw new AdminError(404, 'Course not found');
      await db.query('INSERT INTO "students" ("userId","displayName") VALUES ($1,$2) ON CONFLICT ("userId") DO NOTHING', [actor.id, req.session.identity?.name || actor.email]);
      await db.query('INSERT INTO "courseStudents" ("courseId","studentId") VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, actor.id]);
      await db.query('COMMIT');
      res.sendStatus(204);
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  });
  router.delete('/enrollment', async (req, res) => {
    const id = req.body?.courseId;
    if (!Number.isInteger(id) || id < 1 || id > 2147483647) return res.status(400).json({ error: 'Choose a course' });
    await removeEnrollment(pool!, res.locals.actor.id, id, res.locals.actor.id);
    res.sendStatus(204);
  });
  router.use((error: unknown, _req: Request, res: import('express').Response, _next: import('express').NextFunction) => {
    if (error instanceof AdminError) return res.status(error.status).json({ error: error.message });
    console.error('Role testing request failed', { code: (error as {code?:string}).code || (error as Error).name });
    res.status(503).json({ error: 'Could not complete role testing. Please retry.' });
  });
  return router;
}
