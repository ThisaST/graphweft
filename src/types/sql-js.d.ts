declare module 'sql.js' {
  export type SqlValue = number | string | Uint8Array | null;

  export interface QueryExecResult {
    columns: string[];
    values: SqlValue[][];
  }

  export interface Statement {
    run(values?: SqlValue[]): void;
    free(): void;
  }

  export class Database {
    public constructor(data?: Uint8Array);
    public exec(sql: string): QueryExecResult[];
    public prepare(sql: string): Statement;
    public export(): Uint8Array;
  }

  export interface SqlJsStatic {
    Database: typeof Database;
  }

  export interface InitSqlJsOptions {
    locateFile?: (fileName: string) => string;
  }

  export default function initSqlJs(options?: InitSqlJsOptions): Promise<SqlJsStatic>;
}
