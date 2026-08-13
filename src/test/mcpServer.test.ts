import * as assert from 'assert';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

async function runTests(): Promise<void> {
  // Build a tiny workspace on disk.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codegraph-mcp-test-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'src', 'user.service.ts'),
    'export class UserService { findUser(): string { return "1"; } }\n',
  );
  await fs.writeFile(
    path.join(root, 'src', 'user.controller.ts'),
    'import { UserService } from "./user.service";\nexport class UserController { getUser(): string { return new UserService().findUser(); } }\n',
  );

  const serverPath = path.join(__dirname, '..', 'mcp', 'server.js');
  // Deterministic semantic behavior: no embedding backend, and an isolated vector-cache dir.
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codegraph-mcp-cache-'));
  const child = spawn(process.execPath, [serverPath, root], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEGRAPH_EMBED_RUNTIME: 'off', CODEGRAPH_CACHE_DIR: cacheDir },
  });

  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      const message = JSON.parse(line) as JsonRpcResponse;
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });

  let nextId = 0;
  const request = (method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> => {
    const id = ++nextId;
    const promise = new Promise<JsonRpcResponse>((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
      }, 20000);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  };

  try {
    const init = await request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
    });
    assert.strictEqual(init.result?.protocolVersion, '2025-03-26', 'echoes supported protocol version');
    assert.ok((init.result?.serverInfo as { name: string }).name === 'codegraph-mcp', 'server info present');

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const list = await request('tools/list');
    const tools = (list.result?.tools as Array<{ name: string }>).map((t) => t.name);
    assert.ok(tools.includes('codegraph_context'), 'context tool listed');
    assert.ok(tools.includes('codegraph_impact'), 'impact tool listed');
    assert.ok(tools.includes('codegraph_stats'), 'stats tool listed');
    assert.ok(tools.includes('codegraph_semantic_search'), 'semantic search tool listed');
    assert.ok(tools.includes('codegraph_embed'), 'embed tool listed');

    const stats = await request('tools/call', { name: 'codegraph_stats', arguments: {} });
    const statsText = (stats.result?.content as Array<{ text: string }>)[0].text;
    assert.ok(/Indexed 2 files/.test(statsText), `stats reflect the workspace: ${statsText}`);
    assert.ok(/1 import edges/.test(statsText), `edge resolved: ${statsText}`);

    const impact = await request('tools/call', {
      name: 'codegraph_impact',
      arguments: { path: 'src/user.service.ts' },
    });
    const impactText = (impact.result?.content as Array<{ text: string }>)[0].text;
    assert.ok(impactText.includes('src/user.controller.ts'), `impact finds importer: ${impactText}`);

    const context = await request('tools/call', {
      name: 'codegraph_context',
      arguments: { task: 'fix UserService findUser' },
    });
    const contextText = (context.result?.content as Array<{ text: string }>)[0].text;
    assert.ok(contextText.includes('user.service.ts'), 'context package includes matched file');

    const badTool = await request('tools/call', { name: 'nope', arguments: {} });
    assert.ok(badTool.error, 'unknown tool is a JSON-RPC error');

    // Semantic tools degrade gracefully when embeddings are disabled and no index exists.
    const semantic = await request('tools/call', {
      name: 'codegraph_semantic_search',
      arguments: { query: 'find the user lookup' },
    });
    const semanticText = (semantic.result?.content as Array<{ text: string }>)[0].text;
    assert.ok(/No embedding index exists/.test(semanticText), `semantic search explains missing index: ${semanticText}`);

    const embed = await request('tools/call', { name: 'codegraph_embed', arguments: {} });
    const embedText = (embed.result?.content as Array<{ text: string }>)[0].text;
    assert.ok(/No embedding backend is available/.test(embedText), `embed explains missing backend: ${embedText}`);

    const badMethod = await request('bogus/method');
    assert.strictEqual(badMethod.error?.code, -32601, 'unknown method returns -32601');

    // Freshness: write a new file, then confirm the next call sees it (fs.watch latency
    // is variable on CI, so poll briefly).
    await fs.writeFile(
      path.join(root, 'src', 'audit.service.ts'),
      'import { UserService } from "./user.service";\nexport class AuditService {}\n',
    );
    let sawUpdate = false;
    for (let attempt = 0; attempt < 20 && !sawUpdate; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const fresh = await request('tools/call', { name: 'codegraph_stats', arguments: {} });
      const freshText = (fresh.result?.content as Array<{ text: string }>)[0].text;
      sawUpdate = /Indexed 3 files/.test(freshText);
    }
    assert.ok(sawUpdate, 'watcher-driven refresh picks up a newly created file');

    console.log('mcpServer.test.ts passed');
  } finally {
    child.kill();
  }
}

runTests().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
