import * as path from 'path';
import * as vscode from 'vscode';
import initSqlJs, { Database, QueryExecResult, SqlJsStatic } from 'sql.js';
import { CodeGraphFile, CodeSymbol, ImportReference, IndexedWorkspace } from './graphTypes';
import { buildFileGraph } from './graphAlgorithms';
import { GraphStore } from './graphStore';

const schemaVersion = 3;
const databaseFileName = 'codegraph.sqlite';

interface FileRow {
  id: number;
  uri: string;
  path: string;
  decorators_json: string;
  module: string | null;
  content_hash: string | null;
}

interface SymbolRow {
  file_id: number;
  name: string;
  type: CodeSymbol['type'];
  start_line: number;
  end_line: number;
  signature: string;
  snippet: string | null;
  exported: number;
  decorators_json: string;
  parent_name: string | null;
  tags_json: string;
}

interface ImportRow {
  file_id: number;
  specifier: string;
  imported_names_json: string;
  is_type_only: number;
  line: number;
}

export class SqliteGraphStore implements GraphStore {
  private sql?: SqlJsStatic;
  private database?: Database;
  private workspace?: IndexedWorkspace;
  private readonly databaseUri: vscode.Uri;

  public constructor(private readonly globalStorageUri: vscode.Uri) {
    this.databaseUri = vscode.Uri.joinPath(globalStorageUri, databaseFileName);
  }

  public async initialize(): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.globalStorageUri);

    this.sql = await initSqlJs({
      locateFile: (fileName) => require.resolve(path.posix.join('sql.js/dist', fileName)),
    });

    const existingBytes = await readFileIfExists(this.databaseUri);
    this.database = existingBytes ? new this.sql.Database(existingBytes) : new this.sql.Database();
    this.initializeSchema();
    this.workspace = this.readWorkspace();

    if (this.workspace && !this.isIndexForCurrentWorkspace()) {
      this.database.exec('DELETE FROM edges; DELETE FROM imports; DELETE FROM symbols; DELETE FROM files;');
      this.workspace = undefined;
    }

    await this.persist();
  }

  public async replace(files: CodeGraphFile[]): Promise<void> {
    const database = this.getDatabase();
    database.exec('BEGIN TRANSACTION;');

    try {
      database.exec('DELETE FROM edges; DELETE FROM imports; DELETE FROM symbols; DELETE FROM files;');
      this.insertFiles(files);
      this.insertEdges(files);
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }

    this.workspace = {
      files,
      indexedAt: new Date(),
    };
    await this.persist();
  }

  public async upsert(files: CodeGraphFile[], removedPaths: string[] = []): Promise<void> {
    if (files.length === 0 && removedPaths.length === 0) {
      return;
    }

    const database = this.getDatabase();
    const touchedPaths = [...new Set([...files.map((f) => f.path), ...removedPaths])];

    database.exec('BEGIN TRANSACTION;');
    try {
      // Drop rows for every touched path (symbols/imports cascade), then reinsert the
      // updated files. Untouched files keep their existing rows.
      const deleteFile = database.prepare('DELETE FROM files WHERE path = ?;');
      try {
        for (const filePath of touchedPaths) {
          deleteFile.run([filePath]);
        }
      } finally {
        deleteFile.free();
      }

      this.insertFiles(files);

      // Edges reference resolution is global (an added/removed file can change how any
      // other file's imports resolve), but recomputing it is pure in-memory work over the
      // already-parsed file set — the expensive part (re-reading + re-parsing every file)
      // is what this method avoids.
      const merged = this.mergeWorkspaceFiles(files, removedPaths);
      database.exec('DELETE FROM edges;');
      this.insertEdges(merged);
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }

    this.workspace = {
      files: this.mergeWorkspaceFiles(files, removedPaths),
      indexedAt: new Date(),
    };
    await this.persist();
  }

  /** In-memory content hashes by path, for the incremental reindexer's dirty check. */
  public getContentHashes(): Map<string, string> {
    const hashes = new Map<string, string>();
    for (const file of this.getFiles()) {
      if (file.contentHash) {
        hashes.set(file.path, file.contentHash);
      }
    }
    return hashes;
  }

  private mergeWorkspaceFiles(updated: CodeGraphFile[], removedPaths: string[]): CodeGraphFile[] {
    const removed = new Set(removedPaths);
    const updatedByPath = new Map(updated.map((file) => [file.path, file]));
    const kept = (this.workspace?.files ?? []).filter(
      (file) => !removed.has(file.path) && !updatedByPath.has(file.path),
    );
    return [...kept, ...updated].sort((a, b) => a.path.localeCompare(b.path));
  }

  public async clear(): Promise<void> {
    const database = this.getDatabase();
    database.exec('DELETE FROM edges; DELETE FROM imports; DELETE FROM symbols; DELETE FROM files;');
    this.workspace = undefined;
    await this.persist();
  }

  public hasIndex(): boolean {
    return (this.workspace?.files.length ?? 0) > 0;
  }

  public getWorkspace(): IndexedWorkspace | undefined {
    return this.workspace;
  }

  public getFiles(): CodeGraphFile[] {
    return this.workspace?.files ?? [];
  }

  public getFile(filePath: string): CodeGraphFile | undefined {
    return this.getFiles().find((file) => file.path === filePath);
  }

  public getDatabasePath(): string {
    return this.databaseUri.fsPath;
  }

  private isIndexForCurrentWorkspace(): boolean {
    const folders = vscode.workspace.workspaceFolders;

    if (!folders || folders.length === 0 || !this.workspace || this.workspace.files.length === 0) {
      return true;
    }

    const folderPrefixes = folders.map((folder) => folder.uri.toString());
    return this.workspace.files.some((file) =>
      folderPrefixes.some((prefix) => file.uri.startsWith(prefix)),
    );
  }

  private initializeSchema(): void {
    const database = this.getDatabase();
    const currentVersion = this.readUserVersion();

    if (currentVersion > schemaVersion) {
      throw new Error(`CodeGraph index database schema ${currentVersion} is newer than this extension supports.`);
    }

    // Older schema present: the index is fully derived from the workspace and cheap to
    // rebuild, so drop everything and recreate at the current version rather than writing
    // per-version ALTER migrations. A `CodeGraph: Build Local Index` repopulates it.
    if (currentVersion > 0 && currentVersion < schemaVersion) {
      database.exec('DROP TABLE IF EXISTS edges; DROP TABLE IF EXISTS imports; DROP TABLE IF EXISTS symbols; DROP TABLE IF EXISTS files;');
    }

    database.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uri TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        decorators_json TEXT NOT NULL DEFAULT '[]',
        module TEXT,
        content_hash TEXT
      );

      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        signature TEXT NOT NULL,
        snippet TEXT,
        exported INTEGER NOT NULL,
        decorators_json TEXT NOT NULL DEFAULT '[]',
        parent_name TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        specifier TEXT NOT NULL,
        imported_names_json TEXT NOT NULL DEFAULT '[]',
        is_type_only INTEGER NOT NULL,
        line INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        to_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        edge_type TEXT NOT NULL,
        UNIQUE(from_file_id, to_file_id, edge_type)
      );

      CREATE INDEX IF NOT EXISTS idx_symbols_file_id ON symbols(file_id);
      CREATE INDEX IF NOT EXISTS idx_imports_file_id ON imports(file_id);
      CREATE INDEX IF NOT EXISTS idx_edges_from_file_id ON edges(from_file_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to_file_id ON edges(to_file_id);
      PRAGMA user_version = ${schemaVersion};
    `);
  }

  private readUserVersion(): number {
    const database = this.getDatabase();
    const result = database.exec('PRAGMA user_version;')[0];
    const value = result?.values[0]?.[0];
    return typeof value === 'number' ? value : 0;
  }

  private insertFiles(files: CodeGraphFile[]): void {
    const database = this.getDatabase();
    const insertFile = database.prepare('INSERT INTO files (uri, path, decorators_json, module, content_hash) VALUES (?, ?, ?, ?, ?);');
    const insertSymbol = database.prepare(`
      INSERT INTO symbols (
        file_id, name, type, start_line, end_line, signature, snippet, exported, decorators_json, parent_name, tags_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);
    const insertImport = database.prepare(`
      INSERT INTO imports (file_id, specifier, imported_names_json, is_type_only, line)
      VALUES (?, ?, ?, ?, ?);
    `);

    try {
      for (const file of files) {
        insertFile.run([file.uri, file.path, JSON.stringify(file.decorators), file.moduleName ?? null, file.contentHash ?? null]);
        const fileId = Number(database.exec('SELECT last_insert_rowid();')[0].values[0][0]);

        for (const symbol of file.symbols) {
          insertSymbol.run([
            fileId,
            symbol.name,
            symbol.type,
            symbol.lineRange.start,
            symbol.lineRange.end,
            symbol.signature,
            symbol.snippet ?? null,
            symbol.exported ? 1 : 0,
            JSON.stringify(symbol.decorators),
            symbol.parentName ?? null,
            JSON.stringify(symbol.tags),
          ]);
        }

        for (const importRef of file.imports) {
          insertImport.run([
            fileId,
            importRef.specifier,
            JSON.stringify(importRef.importedNames),
            importRef.isTypeOnly ? 1 : 0,
            importRef.line,
          ]);
        }
      }
    } finally {
      insertFile.free();
      insertSymbol.free();
      insertImport.free();
    }
  }

  private insertEdges(files: CodeGraphFile[]): void {
    const database = this.getDatabase();
    const fileIds = new Map<string, number>();
    const fileRows = readRows<FileRow>(database.exec('SELECT id, uri, path, decorators_json, module, content_hash FROM files;')[0]);
    fileRows.forEach((row) => fileIds.set(row.path, row.id));

    // Resolve edges with the same multi-language logic the graph view uses, so the stored
    // graph and the rendered graph stay identical.
    const graph = buildFileGraph(files);
    const insertEdge = database.prepare('INSERT OR IGNORE INTO edges (from_file_id, to_file_id, edge_type) VALUES (?, ?, ?);');

    try {
      for (const [fromPath, targets] of graph.adjacency) {
        const fromFileId = fileIds.get(fromPath);
        if (!fromFileId) continue;

        for (const toPath of targets) {
          const toFileId = fileIds.get(toPath);
          if (toFileId) {
            insertEdge.run([fromFileId, toFileId, 'imports']);
          }
        }
      }
    } finally {
      insertEdge.free();
    }
  }

  private readWorkspace(): IndexedWorkspace | undefined {
    const database = this.getDatabase();
    const fileRows = readRows<FileRow>(database.exec('SELECT id, uri, path, decorators_json, module, content_hash FROM files ORDER BY path;')[0]);

    if (fileRows.length === 0) {
      return undefined;
    }

    const symbolsByFile = groupByFileId(readRows<SymbolRow>(database.exec('SELECT * FROM symbols ORDER BY start_line, name;')[0]));
    const importsByFile = groupByFileId(readRows<ImportRow>(database.exec('SELECT * FROM imports ORDER BY line, specifier;')[0]));
    const files = fileRows.map((fileRow): CodeGraphFile => ({
      uri: fileRow.uri,
      path: fileRow.path,
      decorators: parseJsonArray(fileRow.decorators_json),
      imports: (importsByFile.get(fileRow.id) ?? []).map(readImportRow),
      symbols: (symbolsByFile.get(fileRow.id) ?? []).map((symbolRow) => readSymbolRow(symbolRow, fileRow.path)),
      moduleName: fileRow.module ?? undefined,
      contentHash: fileRow.content_hash ?? undefined,
    }));

    return {
      files,
      indexedAt: new Date(),
    };
  }

  private async persist(): Promise<void> {
    const database = this.getDatabase();
    await vscode.workspace.fs.writeFile(this.databaseUri, database.export());
  }

  private getDatabase(): Database {
    if (!this.database) {
      throw new Error('CodeGraph SQLite store has not been initialized.');
    }

    return this.database;
  }
}

async function readFileIfExists(uri: vscode.Uri): Promise<Uint8Array | undefined> {
  try {
    return await vscode.workspace.fs.readFile(uri);
  } catch (error) {
    if (isFileNotFound(error)) {
      return undefined;
    }

    throw error;
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}

function readRows<Row extends object>(result: QueryExecResult | undefined): Row[] {
  if (!result) {
    return [];
  }

  return result.values.map((values) => {
    const row: Record<string, unknown> = {};
    result.columns.forEach((column, index) => {
      row[column] = values[index];
    });
    return row as Row;
  });
}

function groupByFileId<Row extends { file_id: number }>(rows: Row[]): Map<number, Row[]> {
  const grouped = new Map<number, Row[]>();

  for (const row of rows) {
    const group = grouped.get(row.file_id) ?? [];
    group.push(row);
    grouped.set(row.file_id, group);
  }

  return grouped;
}

function readImportRow(row: ImportRow): ImportReference {
  return {
    specifier: row.specifier,
    importedNames: parseJsonArray(row.imported_names_json),
    isTypeOnly: row.is_type_only === 1,
    line: row.line,
  };
}

function readSymbolRow(row: SymbolRow, filePath: string): CodeSymbol {
  return {
    id: `${filePath}:${row.name}:${row.start_line}:${row.type}`,
    name: row.name,
    type: row.type,
    filePath,
    lineRange: {
      start: row.start_line,
      end: row.end_line,
    },
    signature: row.signature,
    snippet: row.snippet ?? undefined,
    exported: row.exported === 1,
    decorators: parseJsonArray(row.decorators_json),
    parentName: row.parent_name ?? undefined,
    tags: parseJsonArray(row.tags_json),
  };
}

function parseJsonArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
}
