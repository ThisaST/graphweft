import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import Module = require('module');
import { GraphRetriever } from '../graph/graphRetriever';
import { indexTypeScriptFile } from '../indexer/typescriptAstIndexer';
import type { WorkspaceSourceFile } from '../indexer/workspaceScanner';

interface MockUri {
  fsPath: string;
  toString(): string;
}

interface TestUri {
  toString(): string;
}

class MockFileSystemError extends Error {
  public static FileNotFound(filePath: string): MockFileSystemError {
    const error = new MockFileSystemError(filePath);
    error.code = 'FileNotFound';
    return error;
  }

  public code = 'Unknown';
}

type ModuleWithLoad = typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

const moduleWithLoad = Module as ModuleWithLoad;
const originalLoad = moduleWithLoad._load;

function installVscodeMock(): void {
  const vscodeMock = {
    Uri: {
      file: (filePath: string): MockUri => ({
        fsPath: filePath,
        toString: () => `file://${filePath}`,
      }),
      joinPath: (base: MockUri, ...segments: string[]): MockUri => {
        const joinedPath = path.join(base.fsPath, ...segments);
        return {
          fsPath: joinedPath,
          toString: () => `file://${joinedPath}`,
        };
      },
    },
    workspace: {
      fs: {
        createDirectory: async (uri: MockUri): Promise<void> => {
          await fs.mkdir(uri.fsPath, { recursive: true });
        },
        readFile: async (uri: MockUri): Promise<Uint8Array> => {
          try {
            return await fs.readFile(uri.fsPath);
          } catch (error) {
            if (isNodeNotFound(error)) {
              throw MockFileSystemError.FileNotFound(uri.fsPath);
            }

            throw error;
          }
        },
        writeFile: async (uri: MockUri, content: Uint8Array): Promise<void> => {
          await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
          await fs.writeFile(uri.fsPath, content);
        },
      },
    },
    FileSystemError: MockFileSystemError,
  };

  moduleWithLoad._load = (request, parent, isMain) => {
    if (request === 'vscode') {
      return vscodeMock;
    }

    return originalLoad(request, parent, isMain);
  };
}

function isNodeNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function testFile(workspaceRelativePath: string, text: string): WorkspaceSourceFile {
  return {
    uri: {
      toString: () => `file:///test/${workspaceRelativePath}`,
    } as TestUri as WorkspaceSourceFile['uri'],
    workspaceRelativePath,
    text,
    isTypescript: true,
  };
}

async function runTests(): Promise<void> {
  installVscodeMock();

  const { SqliteGraphStore } = require('../graph/sqliteGraphStore') as typeof import('../graph/sqliteGraphStore');
  const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'codegraph-sqlite-test-'));
  const storageUri = {
    fsPath: storagePath,
    toString: () => `file://${storagePath}`,
  };

  const files = [
    testFile(
      'src/user.service.ts',
      ['export class UserService {', '  findUser(): string {', '    return "1";', '  }', '}'].join('\n'),
    ),
    testFile(
      'src/user.controller.ts',
      ['import { UserService } from "./user.service";', '', 'export class UserController {', '  getUser(): string {', '    return new UserService().findUser();', '  }', '}'].join('\n'),
    ),
  ].map(indexTypeScriptFile);

  const firstStore = new SqliteGraphStore(storageUri as unknown as import('vscode').Uri);
  await firstStore.initialize();
  await firstStore.replace(files);

  const databaseBytes = await fs.readFile(path.join(storagePath, 'codegraph.sqlite'));
  assert.ok(databaseBytes.length > 0, 'SQLite database file should be persisted');

  const secondStore = new SqliteGraphStore(storageUri as unknown as import('vscode').Uri);
  await secondStore.initialize();
  assert.ok(secondStore.hasIndex(), 'reinitialized SQLite store should load existing index');
  assert.strictEqual(secondStore.getFiles().length, 2, 'persisted index should restore files');

  const result = new GraphRetriever(secondStore).retrieve('UserController');
  assert.ok(result.files.some((entry) => entry.file.path === 'src/user.controller.ts'), 'retriever should read from rehydrated SQLite cache');
  assert.ok(result.files.some((entry) => entry.file.path === 'src/user.service.ts'), 'retriever should expand persisted import relationships');

  // --- Incremental upsert -----------------------------------------------------------

  // Add a new file that imports the controller: it must appear, and edges must connect it.
  const auditFile = indexTypeScriptFile(
    testFile(
      'src/audit.service.ts',
      ['import { UserController } from "./user.controller";', '', 'export class AuditService {', '  log(): string {', '    return new UserController().getUser();', '  }', '}'].join('\n'),
    ),
  );
  auditFile.contentHash = 'hash-audit-v1';
  await secondStore.upsert([auditFile]);
  assert.strictEqual(secondStore.getFiles().length, 3, 'upsert should add the new file');

  // Update an existing file in place: symbol changes must be reflected, others untouched.
  const updatedService = indexTypeScriptFile(
    testFile(
      'src/user.service.ts',
      ['export class UserService {', '  findUser(): string {', '    return "2";', '  }', '  deleteUser(): void {}', '}'].join('\n'),
    ),
  );
  updatedService.contentHash = 'hash-service-v2';
  await secondStore.upsert([updatedService]);
  assert.strictEqual(secondStore.getFiles().length, 3, 'in-place update should not change file count');
  const reloadedService = secondStore.getFile('src/user.service.ts');
  assert.ok(reloadedService?.symbols.some((s) => s.name === 'deleteUser'), 'updated symbols should be stored');
  assert.strictEqual(reloadedService?.contentHash, 'hash-service-v2', 'content hash should be stored');

  // Remove a file: it must disappear from the file set and the edges must drop with it.
  await secondStore.upsert([], ['src/audit.service.ts']);
  assert.strictEqual(secondStore.getFiles().length, 2, 'upsert should remove deleted files');
  assert.strictEqual(secondStore.getFile('src/audit.service.ts'), undefined, 'removed file should not be returned');

  // Persistence: a fresh store must see the incremental changes, and edges must survive.
  // Incremental persists are debounced, so flush via dispose() first (the deactivate path).
  await secondStore.dispose();
  const thirdStore = new SqliteGraphStore(storageUri as unknown as import('vscode').Uri);
  await thirdStore.initialize();
  assert.strictEqual(thirdStore.getFiles().length, 2, 'incremental changes should be persisted');
  assert.ok(
    thirdStore.getFile('src/user.service.ts')?.symbols.some((s) => s.name === 'deleteUser'),
    'persisted store should have updated symbols',
  );
  const rehydrated = new GraphRetriever(thirdStore).retrieve('UserController');
  assert.ok(
    rehydrated.files.some((entry) => entry.file.path === 'src/user.service.ts'),
    'edges should survive incremental persist',
  );
}

runTests()
  .then(() => console.log('sqliteStore.test.ts passed'))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
