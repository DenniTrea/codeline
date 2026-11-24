import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import session from 'express-session';
import { createApp } from '../src/app.js';
const { app } = createApp({ pool: null, store: new session.MemoryStore() });
test('anonymous visitors cannot read identity or create courses', async () => {
  assert.equal((await request(app).get('/api/me')).status, 401);
  assert.equal((await request(app).get('/api/exercises')).status,401);
  assert.equal((await request(app).post('/api/courses').send({ role: 'admin' })).status, 401);
});
test('invalid callback cannot create an authenticated session', async () => {
  const client = request.agent(app);
  assert.equal((await client.get('/auth/callback?code=fake&state=fake')).status, 400);
  assert.equal((await client.get('/api/me')).status, 401);
});
test('cross-origin logout is rejected', async () => {
  assert.equal((await request(app).post('/auth/logout').set('Origin', 'https://foreign.example')).status, 403);
});
test('liveness does not claim database readiness', async () => {
  assert.equal((await request(app).get('/health/live')).status, 200);
  assert.equal((await request(app).get('/health/ready')).status, 503);
});
