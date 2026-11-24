import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import session from 'express-session';
import request from 'supertest';
import type { Pool } from 'pg';
import { createApp } from '../src/app.js';
import { createCourse, listCourses, parseCourse } from '../src/courses.js';
import { createPool } from '../src/db.js';

test('course input rejects fractional, negative and out-of-range counts and overlong codes', () => {
  for (const studentCount of [-1, .5, 32768, '12', null]) assert.equal(parseCourse({code:'CSC101', studentCount}), null);
  assert.equal(parseCourse({ code:'a'.repeat(31), studentCount:0 }), null);
  assert.equal(parseCourse({ code:' ', studentCount:0 }), null);
  assert.deepEqual(parseCourse({ code:' CSC101 ', studentCount:58 }), {code:'CSC101', studentCount:58});
});
async function authenticatedRequest(role: string) {
  process.env.SESSION_SECRET = 'test-only-session-secret-not-for-deployment';
  const store = new session.MemoryStore();
  const sid = randomUUID();
  const sessionCookie = new session.Cookie();
  sessionCookie.maxAge = 60000;
  await new Promise<void>((resolve, reject) => store.set(sid, {
    cookie: sessionCookie,
    identity: { oid:'00000000-0000-4000-8000-000000000001', email:'test@example.invalid', name:'Test' },
  }, error => error ? reject(error) : resolve()));
  const signature = createHmac('sha256', process.env.SESSION_SECRET).update(sid).digest('base64').replace(/=+$/, '');
  const db = { on() {}, async query(sql: string) {
    if (sql.startsWith('SELECT "id", "email", "role"')) return { rows:[{id:'00000000-0000-4000-8000-000000000001', email:'test@example.invalid', role}] };
    throw new Error('Unexpected query');
  } } as unknown as Pool;
  const { app } = createApp({ pool: db, store });
  return { app, cookie:`codeline.sid=${encodeURIComponent(`s:${sid}.${signature}`)}` };
}
test('student cannot gain staff privileges through a request body', async () => {
  const {app, cookie} = await authenticatedRequest('student');
  const r = await request(app).post('/api/courses').set('Cookie',cookie).set('Origin','http://localhost:5173')
    .send({code:'CSC101', studentCount:58, role:'admin'});
  assert.equal(r.status,403);
});
test('lecturer cannot create courses from a foreign origin', async () => {
  const {app, cookie} = await authenticatedRequest('lecturer');
  const r = await request(app).post('/api/courses').set('Cookie',cookie).set('Origin','https://foreign.example').send({code:'CSC101', studentCount:58});
  assert.equal(r.status,403);
});
test('real PostgreSQL create and read works inside a rolled-back transaction', {skip:process.env.TEST_DATABASE !== '1'}, async () => {
  const pool = createPool();
  assert.ok(pool);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const course = await createCourse(db, {code:`test-${randomUUID().slice(0,12)}`, studentCount:58});
    const rows = await listCourses(db, '00000000-0000-4000-8000-000000000001', 'admin');
    assert.ok(rows.some(row => row.id === course.id && row.studentCount === 58));
  } finally { await db.query('ROLLBACK'); db.release(); await pool.end(); }
});
