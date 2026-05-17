import { SqlJsDatabase } from '../src/infra/db/SqlJsDatabase.js';

async function main() {
  const db = await SqlJsDatabase.open('/tmp/test-undef.db');
  db.exec('CREATE TABLE IF NOT EXISTS t (id TEXT, name TEXT, price REAL)');
  const stmt = db.prepare('INSERT INTO t (id, name, price) VALUES (?, ?, ?)');
  try {
    stmt.run('1', undefined as any, undefined as any);
    console.log('OK');
  } catch (e) {
    console.log('Error:', e);
  }
  db.close();
}

main();
