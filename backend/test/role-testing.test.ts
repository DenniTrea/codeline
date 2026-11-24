import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import session from 'express-session';
import type { Pool } from 'pg';
import { createApp } from '../src/app.js';
import { roleTestingEnabled } from '../src/role-testing.js';

const origin='http://localhost:5173';
async function fixture(savedRole='admin', enabled=true, forgedRole?:'student'|'lecturer', environment='development', oid=randomUUID()) {
  const sid=randomUUID(); const secret='isolated-role-testing-session-secret';
  let role=savedRole;
  const queries:{sql:string;values:unknown[]|undefined}[]=[];
  const pool={on(){},async query(sql:string,values?:unknown[]){
    queries.push({sql,values});
    if(sql.startsWith('SELECT "id", "email", "role"'))return{rows:[{id:oid,email:'fixture@example.invalid',role}]};
    if(sql.startsWith('INSERT INTO "courses"'))return{rows:[{id:1,code:'TEST',studentCount:0}]};
    return{rows:[]};
  }} as unknown as Pool;
  const store=new session.MemoryStore(); const cookie=new session.Cookie();cookie.maxAge=60000;
  await new Promise<void>((resolve,reject)=>store.set(sid,{cookie,identity:{oid,email:'fixture@example.invalid',name:'Fixture'},testRole:forgedRole},e=>e?reject(e):resolve()));
  const old={node:process.env.NODE_ENV,flag:process.env.DEV_ROLE_TESTING,secret:process.env.SESSION_SECRET};
  let app;
  try{process.env.NODE_ENV=environment;process.env.DEV_ROLE_TESTING=String(enabled);process.env.SESSION_SECRET=secret;app=createApp({pool,store}).app;}
  finally{for(const [key,value] of Object.entries({NODE_ENV:old.node,DEV_ROLE_TESTING:old.flag,SESSION_SECRET:old.secret})){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
  const sig=createHmac('sha256',secret).update(sid).digest('base64').replace(/=+$/,'');
  const header=`codeline.sid=${encodeURIComponent(`s:${sid}.${sig}`)}`;
  return{client:request(app),app,header,oid,queries,demote(){role='student';}};
}
test('role testing requires explicit development opt-in and loopback origin',()=>{
  assert.equal(roleTestingEnabled('development','true',origin),true);
  for(const environment of ['production','test',undefined])assert.equal(roleTestingEnabled(environment,'true',origin),false);
  assert.equal(roleTestingEnabled('development','false',origin),false);
  assert.equal(roleTestingEnabled('development','true','https://codeline.example'),false);
});
test('testing routes are absent when disabled or in production, ignoring stale preview sessions',async()=>{
  for(const [enabled,environment] of [[false,'development'],[true,'production']] as const){
    const f=await fixture('admin',enabled,'student',environment);
    assert.equal((await f.client.post('/api/dev/role-testing/role').set('Cookie',f.header).set('Origin',origin).send({role:'student'})).status,404);
    const me=await f.client.get('/api/me').set('Cookie',f.header);assert.equal(me.body.user.role,'admin');assert.equal(me.body.roleTesting,false);
  }
});
test('role testing needs a real saved admin session, same origin and local host',async()=>{
  const f=await fixture();
  assert.equal((await f.client.post('/api/dev/role-testing/role').set('Origin',origin).send({role:'student'})).status,401);
  assert.equal((await f.client.post('/api/dev/role-testing/role').set('Cookie',f.header).set('Origin','https://foreign.example').send({role:'student'})).status,403);
  assert.equal((await f.client.post('/api/dev/role-testing/role').set('Cookie',f.header).set('Host','public.example').set('Origin',origin).send({role:'student'})).status,404);
  assert.equal((await f.client.post('/api/dev/role-testing/role').set('Cookie',f.header).set('Origin',origin).send({role:'owner'})).status,400);
  const student=await fixture('student',true,'lecturer');
  assert.equal((await student.client.post('/api/dev/role-testing/role').set('Cookie',student.header).set('Origin',origin).send({role:'lecturer'})).status,403);
  assert.equal((await student.client.put('/api/dev/role-testing/enrollment').set('Cookie',student.header).set('Origin',origin).send({courseId:1})).status,403);
  assert.equal((await student.client.get('/api/me').set('Cookie',student.header)).body.user.role,'student');
});
test('student and lecturer previews enforce backend permissions without changing saved roles or other sessions',async()=>{
  const f=await fixture();
  const other=await fixture('admin',true,undefined,'development',f.oid);
  assert.equal((await f.client.post('/api/dev/role-testing/role').set('Cookie',f.header).set('Origin',origin).send({role:'student'})).status,204);
  let me=await f.client.get('/api/me').set('Cookie',f.header);assert.equal(me.body.user.role,'student');assert.equal(me.body.roleTesting,true);assert.equal(me.body.identity.oid,f.oid);
  assert.equal((await f.client.get('/api/admin/summary').set('Cookie',f.header)).status,403);
  assert.equal((await f.client.get('/api/exercises').set('Cookie',f.header)).status,403);
  assert.equal((await f.client.post('/api/courses').set('Cookie',f.header).set('Origin',origin).send({code:'TEST',studentCount:0})).status,403);
  assert.equal((await f.client.get('/api/courses').set('Cookie',f.header)).status,200);
  assert.ok(f.queries.some(q=>q.sql.includes('JOIN "courseStudents"')&&q.values?.[0]===f.oid));
  assert.equal((await other.client.get('/api/me').set('Cookie',other.header)).body.user.role,'admin');
  assert.equal((await f.client.post('/api/dev/role-testing/role').set('Cookie',f.header).set('Origin',origin).send({role:'lecturer'})).status,204);
  assert.equal((await f.client.get('/api/exercises').set('Cookie',f.header)).status,200);
  assert.equal((await f.client.get('/api/admin/summary').set('Cookie',f.header)).status,403);
  assert.equal((await f.client.post('/api/courses').set('Cookie',f.header).set('Origin',origin).send({code:'TEST',studentCount:0})).status,201);
  assert.equal((await f.client.post('/api/dev/role-testing/role').set('Cookie',f.header).set('Origin',origin).send({role:'admin'})).status,204);
  me=await f.client.get('/api/me').set('Cookie',f.header);assert.equal(me.body.user.role,'admin');
  assert.ok(!f.queries.some(q=>q.sql.startsWith('UPDATE "users"')));
  f.demote();
  assert.equal((await f.client.post('/api/dev/role-testing/role').set('Cookie',f.header).set('Origin',origin).send({role:'lecturer'})).status,403);
});
