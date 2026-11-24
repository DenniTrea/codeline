import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import session from 'express-session';
import request from 'supertest';
import type { Pool } from 'pg';
import { createApp } from '../src/app.js';
import { createPool } from '../src/db.js';

async function signedIn(pool:Pool|null, id:string) {
  process.env.SESSION_SECRET='isolated-admin-tests-session-secret';
  const sid=randomUUID(); const store=new session.MemoryStore(); const cookie=new session.Cookie();cookie.maxAge=60000;
  await new Promise<void>((resolve,reject)=>store.set(sid,{cookie,identity:{oid:id,email:'fixture@example.invalid',name:'Fixture'}},error=>error?reject(error):resolve()));
  const sig=createHmac('sha256',process.env.SESSION_SECRET).update(sid).digest('base64').replace(/=+$/,'');
  const {app}=createApp({pool,store});
  const client=request(app);
  const header=`codeline.sid=${encodeURIComponent(`s:${sid}.${sig}`)}`;
  return {client,header};
}
test('anonymous requests cannot read or mutate admin data',async()=>{
  const {app}=createApp({pool:null,store:new session.MemoryStore()});
  for(const path of ['/summary','/users','/courses','/courses/1/students']) assert.equal((await request(app).get('/api/admin'+path)).status,401);
  assert.equal((await request(app).patch('/api/admin/users/'+randomUUID()+'/role').send({role:'admin'})).status,401);
  assert.equal((await request(app).delete('/api/admin/courses/1').send({confirmCode:'test',expectedEnrolledCount:0})).status,401);
});
test('every non-admin role is denied admin endpoints, even with forged role fields',async()=>{
  for(const role of ['student','lecturer','ta']) {
    const id=randomUUID();const pool={on(){},async query(){return{rows:[{id,email:'fixture@example.invalid',role}]};}} as unknown as Pool;
    const {client,header}=await signedIn(pool,id);
    assert.equal((await client.get('/api/admin/users').set('Cookie',header)).status,403);
    assert.equal((await client.delete('/api/admin/courses/1').set('Cookie',header).set('Origin','http://localhost:5173').send({confirmCode:'test',expectedEnrolledCount:0})).status,403);
    assert.equal((await client.patch(`/api/admin/users/${id}/role`).set('Cookie',header).set('Origin','http://localhost:5173').send({role:'admin'})).status,403);
  }
});
test('admin mutations require the expected Origin',async()=>{
  const id=randomUUID();const pool={on(){},async query(){return{rows:[{id,email:'fixture@example.invalid',role:'admin'}]};}} as unknown as Pool;
  const {client,header}=await signedIn(pool,id);
  assert.equal((await client.post('/api/admin/courses').set('Cookie',header).set('Origin','https://foreign.example').send({code:'bad',studentCount:0})).status,403);
  assert.equal((await client.delete(`/api/admin/courses/1/students/${randomUUID()}`).set('Cookie',header)).status,403);
  assert.equal((await client.delete('/api/admin/courses/1').set('Cookie',header).set('Origin','https://foreign.example').send({confirmCode:'test',expectedEnrolledCount:0})).status,403);
});
test('real admin course, profile, role and enrollment flow rolls back all fixtures', {skip:process.env.TEST_DATABASE!=='1'},async()=>{
  const pool=createPool();assert.ok(pool);const db=await pool.connect();
  const admin=randomUUID(),student=randomUUID(),staff=randomUUID();
  let courseId=0;
  try {
    await db.query('BEGIN');
    for(const [id,role] of [[admin,'admin'],[student,'student'],[staff,'lecturer']]) {
      await db.query('INSERT INTO "users" ("id","email","role") VALUES ($1,$2,$3)',[id,`${id}@fixture.invalid`,role]);
    }
    await db.query('INSERT INTO "students" ("userId","displayName") VALUES ($1,$2)',[student,'Test fixture student']);
    // Only the test adapter maps nested transactions to savepoints. Production
    // always uses independent Pool clients and genuine BEGIN/COMMIT boundaries.
    const nested={async query(sql:string,values?:unknown[]){
      if(sql==='BEGIN')return db.query('SAVEPOINT admin_action');
      if(sql==='COMMIT')return db.query('RELEASE SAVEPOINT admin_action');
      if(sql==='ROLLBACK')return db.query('ROLLBACK TO SAVEPOINT admin_action');
      return db.query(sql,values);
    },release(){}};
    const adapter={on(){},query:db.query.bind(db),async connect(){return nested;}} as unknown as Pool;
    const {client,header}=await signedIn(adapter,admin);
    const origin='http://localhost:5173';
    let r=await client.post('/api/admin/courses').set('Cookie',header).set('Origin',origin).send({code:`test-${randomUUID().slice(0,12)}`,studentCount:58});
    assert.equal(r.status,201);courseId=r.body.course.id;
    r=await client.patch(`/api/admin/courses/${courseId}`).set('Cookie',header).set('Origin',origin).send({code:`edit-${courseId}`,studentCount:60});
    assert.equal(r.status,200);assert.equal(r.body.course.studentCount,60);
    r=await client.post(`/api/admin/courses/${courseId}/students`).set('Cookie',header).set('Origin',origin).send({studentIds:[student,student]});
    assert.equal(r.status,200);assert.equal(r.body.added,1);
    r=await client.post(`/api/admin/courses/${courseId}/students`).set('Cookie',header).set('Origin',origin).send({studentIds:[student]});
    assert.equal(r.status,200);assert.equal(r.body.added,0);assert.equal(r.body.alreadyEnrolled,1);
    r=await client.post(`/api/admin/courses/${courseId}/students`).set('Cookie',header).set('Origin',origin).send({studentIds:[staff]});
    assert.equal(r.status,400);
    r=await client.post(`/api/admin/courses/${courseId}/students`).set('Cookie',header).set('Origin',origin).send({studentIds:['not-a-uuid']});assert.equal(r.status,400);
    r=await client.get(`/api/admin/courses/${courseId}/students`).set('Cookie',header);assert.equal(r.status,200);assert.equal(r.body.students.length,1);
    r=await client.get('/api/admin/courses').set('Cookie',header);assert.equal(r.status,200);
    assert.equal(r.body.courses.find((c:{id:number})=>c.id===courseId).enrolledCount,1);
    assert.equal(r.body.courses.find((c:{id:number})=>c.id===courseId).studentCount,60);
    r=await client.patch(`/api/admin/users/${student}/student`).set('Cookie',header).set('Origin',origin).send({displayName:'Updated fixture',studentNumber:null});assert.equal(r.status,200);
    r=await client.patch(`/api/admin/users/${student}/student`).set('Cookie',header).set('Origin',origin).send({displayName:'Updated fixture',studentNumber:'abc'});assert.equal(r.status,400);
    r=await client.patch(`/api/admin/users/${admin}/role`).set('Cookie',header).set('Origin',origin).send({role:'student'});assert.equal(r.status,409);
    r=await client.patch(`/api/admin/users/${staff}/role`).set('Cookie',header).set('Origin',origin).send({role:'student'});assert.equal(r.status,200);
    const profile=await db.query('SELECT 1 FROM "students" WHERE "userId"=$1',[staff]);assert.equal(profile.rowCount,1);
    const disposableCode=`delete-${randomUUID().slice(0,10)}`;
    r=await client.post('/api/admin/courses').set('Cookie',header).set('Origin',origin).send({code:disposableCode,studentCount:1});assert.equal(r.status,201);
    const disposableId=r.body.course.id;
    r=await client.post(`/api/admin/courses/${disposableId}/students`).set('Cookie',header).set('Origin',origin).send({studentIds:[student]});assert.equal(r.status,200);
    r=await client.delete(`/api/admin/courses/${disposableId}`).set('Cookie',header).set('Origin',origin).send({confirmCode:disposableCode,expectedEnrolledCount:0});assert.equal(r.status,409);
    r=await client.delete(`/api/admin/courses/${disposableId}`).set('Cookie',header).set('Origin',origin).send({confirmCode:'wrong',expectedEnrolledCount:1});assert.equal(r.status,409);
    r=await client.delete(`/api/admin/courses/${disposableId}`).set('Cookie',header).set('Origin',origin).send({confirmCode:disposableCode,expectedEnrolledCount:1});assert.equal(r.status,204);
    const remaining=await db.query('SELECT 1 FROM "courseStudents" WHERE "courseId"=$1',[disposableId]);assert.equal(remaining.rowCount,0);
    const account=await db.query('SELECT 1 FROM "users" WHERE "id"=$1',[student]);assert.equal(account.rowCount,1);
    r=await client.delete(`/api/admin/courses/${disposableId}`).set('Cookie',header).set('Origin',origin).send({confirmCode:disposableCode,expectedEnrolledCount:0});assert.equal(r.status,404);
    const priorEnvironment=process.env.NODE_ENV,priorTesting=process.env.DEV_ROLE_TESTING;
    let preview;
    try{process.env.NODE_ENV='development';process.env.DEV_ROLE_TESTING='true';preview=await signedIn(adapter,admin);}
    finally{if(priorEnvironment===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=priorEnvironment;if(priorTesting===undefined)delete process.env.DEV_ROLE_TESTING;else process.env.DEV_ROLE_TESTING=priorTesting;}
    r=await preview.client.post('/api/dev/role-testing/role').set('Cookie',preview.header).set('Origin',origin).send({role:'student'});assert.equal(r.status,204);
    r=await preview.client.get('/api/courses').set('Cookie',preview.header);assert.ok(!r.body.courses.some((c:{id:number})=>c.id===courseId));
    r=await preview.client.put('/api/dev/role-testing/enrollment').set('Cookie',preview.header).set('Origin',origin).send({courseId});assert.equal(r.status,204);
    r=await preview.client.get('/api/courses').set('Cookie',preview.header);assert.ok(r.body.courses.some((c:{id:number})=>c.id===courseId));
    r=await preview.client.put('/api/dev/role-testing/enrollment').set('Cookie',preview.header).set('Origin',origin).send({courseId});assert.equal(r.status,204);
    const savedAdmin=await db.query('SELECT "role" FROM "users" WHERE "id"=$1',[admin]);assert.equal(savedAdmin.rows[0].role,'admin');
    r=await preview.client.delete('/api/dev/role-testing/enrollment').set('Cookie',preview.header).set('Origin',origin).send({courseId});assert.equal(r.status,204);
    r=await preview.client.get('/api/courses').set('Cookie',preview.header);assert.ok(!r.body.courses.some((c:{id:number})=>c.id===courseId));
    r=await preview.client.get('/api/dev/role-testing/courses').set('Cookie',preview.header);assert.equal(r.body.courses.find((c:{id:number})=>c.id===courseId).enrolled,false);
    r=await preview.client.post('/api/dev/role-testing/role').set('Cookie',preview.header).set('Origin',origin).send({role:'admin'});assert.equal(r.status,204);
    const topic=await db.query('INSERT INTO "topics" ("name") VALUES ($1) RETURNING "id"',[`fixture-${randomUUID()}`]);
    const exercise=await db.query('INSERT INTO "exercises" ("courseId","topicId","ownerId","title") VALUES ($1,$2,$3,$4) RETURNING "id"',[courseId,topic.rows[0].id,admin,'Fixture exercise']);
    await db.query('INSERT INTO "exerciseLines" ("exerciseId","lineNumber","codeText","isGiven") VALUES ($1,1,$2,true)',[exercise.rows[0].id,'total = 0']);
    r=await client.get('/api/exercises').set('Cookie',header);assert.equal(r.status,200);
    const libraryItem=r.body.exercises.find((e:{id:number})=>e.id===exercise.rows[0].id);assert.equal(libraryItem.lineCount,1);assert.equal(libraryItem.preview,'total = 0');assert.equal(libraryItem.usedCount,0);
    await db.query('UPDATE "exercises" SET "deletedAt"=now() WHERE "id"=$1',[exercise.rows[0].id]);
    r=await client.get('/api/exercises').set('Cookie',header);assert.ok(!r.body.exercises.some((e:{id:number})=>e.id===exercise.rows[0].id));
    await db.query('UPDATE "exercises" SET "deletedAt"=NULL WHERE "id"=$1',[exercise.rows[0].id]);
    const pin=await db.query(`SELECT lpad(i::text,6,'0') AS pin FROM generate_series(100000,999999) s(i) WHERE NOT EXISTS (SELECT 1 FROM "gameSessions" WHERE "joinPin"=lpad(i::text,6,'0')) LIMIT 1`);
    const game=await db.query('INSERT INTO "gameSessions" ("exerciseId","hostUserId","joinPin","timeLimitSeconds") VALUES ($1,$2,$3,$4) RETURNING "id"',[exercise.rows[0].id,admin,pin.rows[0].pin,300]);
    await db.query('INSERT INTO "gameParticipants" ("sessionId","studentId") VALUES ($1,$2)',[game.rows[0].id,student]);
    r=await client.delete(`/api/admin/courses/${courseId}/students/${student}`).set('Cookie',header).set('Origin',origin);assert.equal(r.status,409);
    r=await client.patch(`/api/admin/users/${student}/role`).set('Cookie',header).set('Origin',origin).send({role:'lecturer'});assert.equal(r.status,409);
    await db.query('UPDATE "gameSessions" SET "startedAt"=now(),"endedAt"=now() WHERE "id"=$1',[game.rows[0].id]);
    r=await client.delete(`/api/admin/courses/${courseId}/students/${student}`).set('Cookie',header).set('Origin',origin);assert.equal(r.status,204);
    const kept=await db.query('SELECT 1 FROM "students" WHERE "userId"=$1',[student]);assert.equal(kept.rowCount,1);
    r=await client.get(`/api/admin/courses/${courseId}/students`).set('Cookie',header);assert.equal(r.body.students.length,0);
    r=await client.get('/api/admin/users?q=fixture.invalid&role=student').set('Cookie',header);assert.equal(r.status,200);assert.ok(r.body.users.some((u:{id:string})=>u.id===student));
    r=await client.delete(`/api/admin/courses/${courseId}`).set('Cookie',header).set('Origin',origin).send({confirmCode:`edit-${courseId}`,expectedEnrolledCount:0});assert.equal(r.status,409);
    const retainedGame=await db.query('SELECT 1 FROM "gameSessions" WHERE "id"=$1',[game.rows[0].id]);assert.equal(retainedGame.rowCount,1);
    // Permissions are read again on every request, not cached in the session.
    await db.query('UPDATE "users" SET "role"=$1 WHERE "id"=$2',['student',admin]);
    r=await client.get('/api/admin/summary').set('Cookie',header);assert.equal(r.status,403);
  } finally {await db.query('ROLLBACK');db.release();await pool.end();}
  const verify=createPool();assert.ok(verify);
  try {const r=await verify.query('SELECT 1 FROM "users" WHERE "id"=ANY($1::uuid[])',[ [admin,student,staff] ]);assert.equal(r.rowCount,0);}
  finally {await verify.end();}
});
