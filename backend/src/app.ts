import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomBytes } from 'node:crypto';
import { ConfidentialClientApplication, CryptoProvider } from '@azure/msal-node';
import { config, authConfigured } from './config.js';
import { createPool } from './db.js';
import { adminRouter } from './admin.js';
import FileStoreFactory from 'session-file-store';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { createCourse, listCourses, parseCourse, type Role } from './courses.js';
import { roleTestingEnabled, localRequest, roleTestingRouter } from './role-testing.js';

type Identity = { oid: string; email: string | null; name: string | null };
declare module 'express-session' {
  interface SessionData {
    identity?: Identity;
    testRole?: 'student' | 'lecturer';
    flow?: { state: string; nonce: string; verifier: string; createdAt: number };
  }
}

export function createApp(options: { pool?: Pool | null; store?: session.Store } = {}) {
  const app = express();
  const testingEnabled = roleTestingEnabled(process.env.NODE_ENV, process.env.DEV_ROLE_TESTING, config.origin);
  const pool = options.pool !== undefined ? options.pool : createPool();
  pool?.on('error', () => console.error('Database pool error'));
  const secret = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
  if (config.production && (!process.env.SESSION_SECRET || secret.length < 32)) throw new Error('Set a strong SESSION_SECRET before deployment');
  if (config.production && !config.origin.startsWith('https://')) throw new Error('Production requires HTTPS');
  const sessionPath = process.env.SESSION_DIR || resolve('.local/sessions');
  if (!options.store) mkdirSync(sessionPath, { recursive: true, mode: 0o700 });
  const FileStore = FileStoreFactory(session);
  const store = options.store || new FileStore({ path: sessionPath, secret, ttl: 8 * 60 * 60, logFn: () => {} });
  if (config.production) app.set('trust proxy', 1);
  const sessionMiddleware = session({ store, name: 'codeline.sid', secret, resave: false,
    saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: config.production, maxAge: 8 * 60 * 60 * 1000 } });
  async function storedUser(req: express.Request) {
    if (!req.session.identity) return null;
    if (!pool) throw new Error('Database unavailable');
    const r = await pool.query<{ id: string; email: string; role: Role }>('SELECT "id", "email", "role" FROM "users" WHERE "id"=$1', [req.session.identity.oid]);
    return r.rows[0] || null;
  }
  async function currentUser(req: express.Request) {
    const user = await storedUser(req);
    if (user?.role === 'admin' && testingEnabled && localRequest(req) && ['student', 'lecturer'].includes(req.session.testRole || '')) return { ...user, role: req.session.testRole! };
    return user;
  }
  const msal = authConfigured ? new ConfidentialClientApplication({ auth: {
    clientId: config.clientId, authority: `https://login.microsoftonline.com/${config.tenantId}`,
    clientSecret: config.clientSecret,
  } }) : null;
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '16kb' }));
  app.use(sessionMiddleware);
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.get('/api/config', (_req, res) => res.json({ microsoftConfigured: authConfigured }));
  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', async (_req, res) => {
    if (!pool) return res.status(503).json({ status: 'database_not_configured' });
    try { await pool.query('SELECT 1'); return res.json({ status: 'ok' }); }
    catch { return res.status(503).json({ status: 'database_unavailable' }); }
  });
  app.get('/api/me', async (req, res) => {
    try {
      const user = await currentUser(req);
      if (!user) return res.status(401).json({ error: 'Sign in required' });
      const saved = await storedUser(req);
      const roleTesting = testingEnabled && localRequest(req) && saved?.role === 'admin';
      return res.json({ identity: req.session.identity, user, courseAccessReady: true, roleTesting });
    } catch { return res.status(503).json({ error: 'Database unavailable' }); }
  });
  app.get('/auth/start', rateLimit({ windowMs: 60_000, limit: 15 }), async (req, res, next) => {
    if (!msal) return res.status(503).json({ error: 'Microsoft app registration is not configured' });
    try {
      const pkce = await new CryptoProvider().generatePkceCodes();
      const state = randomBytes(32).toString('hex');
      const nonce = randomBytes(32).toString('hex');
      req.session.flow = { state, nonce, verifier: pkce.verifier, createdAt: Date.now() };
      const url = await msal.getAuthCodeUrl({ scopes: ['openid', 'profile', 'email'],
        redirectUri: config.redirectUri, state, nonce, codeChallenge: pkce.challenge,
        codeChallengeMethod: 'S256', responseMode: 'query' });
      req.session.save(error => error ? next(error) : res.redirect(url));
    } catch (error) { next(error); }
  });
  app.get('/auth/callback', async (req, res) => {
    const flow = req.session.flow;
    delete req.session.flow;
    if (!msal || !flow || typeof req.query.code !== 'string' || req.query.state !== flow.state ||
      Date.now() - flow.createdAt > 10 * 60_000) return res.status(400).send('Sign-in expired or invalid. Start again.');
    let stage = 'token_exchange';
    try {
      const result = await msal.acquireTokenByCode({ code: req.query.code, scopes: ['openid', 'profile', 'email'],
        redirectUri: config.redirectUri, codeVerifier: flow.verifier, nonce: flow.nonce });
      const c = result.idTokenClaims as Record<string, unknown>;
      if (c.tid !== config.tenantId || c.aud !== config.clientId || c.nonce !== flow.nonce ||
        typeof c.oid !== 'string' || !/^[0-9a-f-]{36}$/i.test(c.oid) || typeof c.exp !== 'number' || c.exp * 1000 <= Date.now()) {
        return res.status(403).send('University identity could not be verified.');
      }
      const identity: Identity = { oid: c.oid, email: typeof c.preferred_username === 'string' ? c.preferred_username : null,
        name: typeof c.name === 'string' ? c.name : null };
      if (!pool || !identity.email) return res.status(503).send('Database or university email unavailable.');
      stage = 'database_provisioning';
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO "users" ("id", "email", "role") VALUES ($1, $2, $3) ON CONFLICT ("id") DO NOTHING', [identity.oid, identity.email, 'student']);
        const user = await client.query<{ role: Role }>('SELECT "role" FROM "users" WHERE "id"=$1', [identity.oid]);
        if (user.rows[0].role === 'student') await client.query('INSERT INTO "students" ("userId", "displayName") VALUES ($1, $2) ON CONFLICT ("userId") DO NOTHING', [identity.oid, identity.name || identity.email]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
      req.session.regenerate(error => {
        if (error) return res.status(500).send('Could not establish sign-in session.');
        req.session.identity = identity;
        req.session.save(error => error ? res.status(500).send('Could not save sign-in session.') : res.redirect(config.origin));
      });
    } catch (error) {
      const details = error as { errorCode?: string; code?: string; name?: string };
      console.error('Sign-in callback failed', { stage, code: details.errorCode || details.code || details.name || 'unknown' });
      return res.redirect(`${config.origin}/?authError=sign_in_failed`);
    }
  });
  app.post('/auth/logout', (req, res) => {
    if (req.get('origin') !== new URL(config.origin).origin) return res.sendStatus(403);
    req.session.destroy(error => {
      if (error) return res.sendStatus(500);
      res.clearCookie('codeline.sid', { path: '/' });
      return res.sendStatus(204);
    });
  });
  app.get('/api/courses', async (req, res) => {
    try {
      const user = await currentUser(req);
      if (!user) return res.status(401).json({ error: 'Sign in required' });
      return res.json({ courses: await listCourses(pool!, user.id, user.role) });
    } catch { return res.status(503).json({ error: 'Database unavailable' }); }
  });
  app.post('/api/courses', async (req, res) => {
    try {
      const user = await currentUser(req);
      if (!user) return res.status(401).json({ error: 'Sign in required' });
      if (!['lecturer', 'admin'].includes(user.role)) return res.status(403).json({ error: 'Lecturer or admin access required' });
      if (req.get('origin') !== new URL(config.origin).origin) return res.status(403).json({ error: 'Invalid request origin' });
      const course = parseCourse(req.body);
      if (!course) return res.status(400).json({ error: 'Use a course code of 1–30 characters and a whole student count from 0 to 32767' });
      return res.status(201).json({ course: await createCourse(pool!, course) });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') return res.status(409).json({ error: 'This course code already exists' });
      return res.status(503).json({ error: 'Could not save course. Please try again.' });
    }
  });
  app.use('/api/admin', adminRouter(pool, currentUser));
  app.get('/api/exercises', async (req,res) => {
    try {
      const user=await currentUser(req);
      if(!user)return res.status(401).json({error:'Sign in required'});
      if(!['admin','lecturer','ta'].includes(user.role))return res.status(403).json({error:'Staff access required'});
      const r=await pool!.query(`SELECT e."id",e."title",e."exerciseState",t."name" AS "topic",c."code" AS "courseCode",
        (SELECT count(*)::int FROM "exerciseLines" l WHERE l."exerciseId"=e."id") AS "lineCount",
        coalesce((SELECT string_agg(p."codeText",E'\\n' ORDER BY p."lineNumber") FROM
          (SELECT l."codeText",l."lineNumber" FROM "exerciseLines" l WHERE l."exerciseId"=e."id" ORDER BY l."lineNumber" LIMIT 3) p),'') AS "preview",
        (SELECT count(*)::int FROM "gameSessions" g WHERE g."exerciseId"=e."id") AS "usedCount",
        (SELECT max(g."createdAt") FROM "gameSessions" g WHERE g."exerciseId"=e."id") AS "lastUsed"
        FROM "exercises" e JOIN "topics" t ON t."id"=e."topicId" JOIN "courses" c ON c."id"=e."courseId"
        WHERE e."deletedAt" IS NULL AND (e."ownerId"=$1 OR $2='admin') ORDER BY e."createdAt" DESC`,[user.id,user.role]);
      res.json({exercises:r.rows});
    }catch{return res.status(503).json({error:'Could not load exercises. Please try again.'});}
  });
  app.use('/api/dev/role-testing', roleTestingRouter(pool, storedUser, testingEnabled, config.origin));
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Request failed', error instanceof Error ? error.name : 'UnknownError');
    res.status(500).json({ error: 'Request failed' });
  });
  return { app, pool, sessionMiddleware };
}
