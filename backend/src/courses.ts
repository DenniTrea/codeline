import type { Pool, PoolClient } from 'pg';
export type Role = 'lecturer' | 'ta' | 'student' | 'admin';
export type Course = { id: number; code: string; studentCount: number };
export function parseCourse(body: unknown): { code: string; studentCount: number } | null {
  if (!body || typeof body !== 'object') return null;
  const { code, studentCount } = body as Record<string, unknown>;
  if (typeof code !== 'string' || !code.trim() || [...code.trim()].length > 30 ||
    typeof studentCount !== 'number' || !Number.isInteger(studentCount) || studentCount < 0 || studentCount > 32767) return null;
  return { code: code.trim(), studentCount };
}
export async function createCourse(db: Pool | PoolClient, course: { code: string; studentCount: number }): Promise<Course> {
  const r = await db.query<Course>('INSERT INTO "courses" ("code", "studentCount") VALUES ($1, $2) RETURNING "id", "code", "studentCount"', [course.code, course.studentCount]);
  return r.rows[0];
}
export async function listCourses(db: Pool | PoolClient, oid: string, role: Role): Promise<Course[]> {
  const r = role === 'student' ? await db.query<Course>(
    'SELECT c."id", c."code", c."studentCount" FROM "courses" c JOIN "courseStudents" cs ON cs."courseId"=c."id" WHERE cs."studentId"=$1 ORDER BY c."code"', [oid]) :
    await db.query<Course>('SELECT "id", "code", "studentCount" FROM "courses" ORDER BY "code"');
  return r.rows;
}
