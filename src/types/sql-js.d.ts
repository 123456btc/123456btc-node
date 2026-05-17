declare module 'sql.js' {
  interface SqlJsConfig {
    locateFile?: (file: string) => string;
  }

  interface QueryExecResult {
    columns: string[];
    values: any[][];
  }

  interface Statement {
    bind(values: any[]): boolean;
    step(): boolean;
    get(params?: any[]): any[];
    getAsObject(params?: any[]): Record<string, any>;
    free(): boolean;
    reset(): void;
  }

  class Database {
    constructor(data?: Uint8Array);
    run(sql: string, params?: any[]): void;
    exec(sql: string): QueryExecResult[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }

  function initSqlJs(config?: SqlJsConfig): Promise<{ Database: typeof Database }>;

  export default initSqlJs;
}
