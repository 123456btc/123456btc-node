import { SqlJsDatabase } from '../src/infra/db/SqlJsDatabase.js';

async function main() {
  const db = await SqlJsDatabase.open('/tmp/test-sqljs.db');
  db.exec('CREATE TABLE IF NOT EXISTS test (id TEXT PRIMARY KEY, name TEXT)');
  const stmt = db.prepare('INSERT INTO test (id, name) VALUES (?, ?)');
  stmt.run('1', 'hello');
  const row = db.prepare('SELECT * FROM test WHERE id = ?').get('1');
  console.log('Row:', row);
  db.close();
}

main().catch(console.error);
