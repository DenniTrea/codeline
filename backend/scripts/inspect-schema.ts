import { createPool } from '../src/db.js';
const pool = createPool();
if (!pool) throw new Error('Set DATABASE_URL in backend/.env first');
try {
  const result = await pool.query(`
    SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `);
  const constraints = await pool.query(`
    SELECT c.relname AS table_name, con.conname AS constraint_name,
           pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' ORDER BY c.relname, con.conname
  `);
  console.log(JSON.stringify({ columns: result.rows, constraints: constraints.rows }, null, 2));
} finally { await pool.end(); }
