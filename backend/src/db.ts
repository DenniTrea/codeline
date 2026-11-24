import pg from 'pg';
import 'dotenv/config';
export function createPool() {
  if (!process.env.DATABASE_URL) return null;
  const url = new URL(process.env.DATABASE_URL);
  const mode = process.env.DATABASE_SSL_MODE || url.searchParams.get('sslmode') || 'verify-full';
  url.searchParams.delete('sslmode');
  if (!['require', 'verify-full', 'disable'].includes(mode)) throw new Error('Unsupported DATABASE_SSL_MODE');
  return new pg.Pool({
    connectionString: url.toString(), max: 5, connectionTimeoutMillis: 5000,
    // Explicit compatibility with the existing self-signed server. require encrypts
    // but does not authenticate the server; use verify-full with DATABASE_CA_FILE later.
    ssl: mode === 'disable' ? false : { rejectUnauthorized: mode !== 'require',
      ...(process.env.DATABASE_CA_FILE ? { ca: readCa(process.env.DATABASE_CA_FILE) } : {}) },
  });
}
import { readFileSync } from 'node:fs';
function readCa(path: string) { return readFileSync(path, 'utf8'); }
