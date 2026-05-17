/**
 * SqlJsDatabase — sql.js 同步包装器
 * 提供类似 better-sqlite3 的 API，数据自动持久化到磁盘
 */

import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';

interface SqlJsStatement {
  bind(values: any[]): boolean;
  step(): boolean;
  getAsObject(): Record<string, any>;
  free(): void;
}

interface SqlJsDB {
  run(sql: string, params?: any[]): void;
  exec(sql: string): any[];
  prepare(sql: string): SqlJsStatement;
  export(): Uint8Array;
  close(): void;
}

export class SqlJsDatabase {
  private db: SqlJsDB;
  private path: string;

  static async open(filePath: string): Promise<SqlJsDatabase> {
    const SQL = await initSqlJs();
    let db: SqlJsDB;
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath);
      db = new SQL.Database(data) as unknown as SqlJsDB;
    } else {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      db = new SQL.Database() as unknown as SqlJsDB;
    }
    return new SqlJsDatabase(db, filePath);
  }

  private constructor(db: SqlJsDB, filePath: string) {
    this.db = db;
    this.path = filePath;
  }

  pragma(_sql: string): void {
    // sql.js does not support PRAGMA; skip silently
  }

  exec(sql: string): void {
    this.db.exec(sql);
    this.save();
  }

  prepare(sql: string): SqlJsStatementWrapper {
    const stmt = this.db.prepare(sql);
    return new SqlJsStatementWrapper(stmt, () => this.save());
  }

  close(): void {
    this.save();
    this.db.close();
  }

  private save(): void {
    try {
      const data = this.db.export();
      fs.writeFileSync(this.path, Buffer.from(data));
    } catch (e) {
      console.error('[SqlJsDatabase] Failed to persist:', e);
    }
  }
}

class SqlJsStatementWrapper {
  private stmt: SqlJsStatement;
  private onMutate: () => void;

  constructor(stmt: SqlJsStatement, onMutate: () => void) {
    this.stmt = stmt;
    this.onMutate = onMutate;
  }

  private sanitize(params: any[]): any[] {
    return params.map((v) => (v === undefined ? null : v));
  }

  get(...params: any[]): Record<string, any> | undefined {
    this.stmt.bind(this.sanitize(params));
    if (this.stmt.step()) {
      const row = this.stmt.getAsObject();
      this.stmt.free();
      return row;
    }
    this.stmt.free();
    return undefined;
  }

  all(...params: any[]): Record<string, any>[] {
    this.stmt.bind(this.sanitize(params));
    const rows: Record<string, any>[] = [];
    while (this.stmt.step()) {
      rows.push(this.stmt.getAsObject());
    }
    this.stmt.free();
    return rows;
  }

  run(...params: any[]): void {
    this.stmt.bind(this.sanitize(params));
    this.stmt.step();
    this.stmt.free();
    this.onMutate();
  }
}
