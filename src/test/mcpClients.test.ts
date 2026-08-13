/**
 * MCP client-compatibility test: simulates the exact initialize handshakes that
 * Claude Code, VS Code / GitHub Copilot agent mode, and Codex CLI send, then runs a
 * real tool call for each — proving protocol-level compatibility without needing the
 * actual clients in CI.
 *
 * Client → protocol version matrix (what each ships today):
 *   Claude Code            → 2025-06-18
 *   VS Code Copilot agent  → 2025-03-26
 *   Codex CLI              → 2025-03-26
 *   Older MCP hosts        → 2024-11-05
 *   Future/unknown version → server must fall back gracefully, not crash
 */
import * as assert from 'assert';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface ClientSim {
  name: string;
  clientInfo: { name: string; version: string };
  protocolVersion: string;
  /** What the server must answer with. */
  expectEcho: string;
}

const CLIENTS: ClientSim[] = [
  { name: 'Claude Code', clientInfo: { name: 'claude-code', version: '2.1.0' }, protocolVersion: '2025-06-18', expectEcho: '2025-06-18' },
  { name: 'VS Code Copilot agent mode', clientInfo: { name: 'Visual Studio Code', version: '1.102.0' }, protocolVersion: '2025-03-26', expectEcho: '2025-03-26' },
  { name: 'Codex CLI', clientInfo: { name: 'codex', version: '0.20.0' }, protocolVersion: '2025-03-26', expectEcho: '2025-03-26' },
  { name: 'Legacy MCP host', clientInfo: { name: 'legacy', version: '1.0.0' }, protocolVersion: '2024-11-05', expectEcho: '2024-11-05' },
  { name: 'Future client (unknown version)', clientInfo: { name: 'future', version: '9.9.9' }, protocolVersion: '2099-01-01', expectEcho: '2024-11-05' },
];

function connect(child: ChildProcess) {
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  let buffer = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
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
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  };
  const notify = (method: string): void => {
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  };
  return { request, notify };
}

async function runTests(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'graphweft-mcp-clients-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'src', 'auth.service.ts'),
    'export class AuthService { login(): boolean { return true; } }\n',
  );
  await fs.writeFile(
    path.join(root, 'src', 'auth.controller.ts'),
    'import { AuthService } from "./auth.service";\nexport class AuthController { post(): boolean { return new AuthService().login(); } }\n',
  );

  const serverPath = path.join(__dirname, '..', 'mcp', 'server.js');

  for (const client of CLIENTS) {
    // Each simulated client gets a fresh server process — exactly how real hosts spawn MCP servers.
    const child = spawn(process.execPath, [serverPath, root], { stdio: ['pipe', 'pipe', 'pipe'] });
    const { request, notify } = connect(child);
    try {
      const init = await request('initialize', {
        protocolVersion: client.protocolVersion,
        capabilities: { tools: {} },
        clientInfo: client.clientInfo,
      });
      assert.strictEqual(
        init.result?.protocolVersion,
        client.expectEcho,
        `${client.name}: server negotiates ${client.expectEcho} for requested ${client.protocolVersion}`,
      );
      const capabilities = init.result?.capabilities as { tools?: unknown };
      assert.ok(capabilities?.tools !== undefined, `${client.name}: server advertises tools capability`);

      notify('notifications/initialized');

      const list = await request('tools/list');
      const tools = (list.result?.tools as Array<{ name: string; inputSchema: unknown }>);
      assert.ok(tools.length >= 7, `${client.name}: all 7 tools listed`);
      assert.ok(tools.every((t) => t.inputSchema !== undefined), `${client.name}: every tool has an inputSchema`);

      const call = await request('tools/call', {
        name: 'graphweft_impact',
        arguments: { path: 'src/auth.service.ts' },
      });
      assert.strictEqual(call.error, undefined, `${client.name}: tools/call succeeds`);
      const text = (call.result?.content as Array<{ type: string; text: string }>)[0];
      assert.strictEqual(text.type, 'text', `${client.name}: content is text`);
      assert.ok(text.text.includes('auth.controller.ts'), `${client.name}: impact resolves the import edge`);

      // Unknown method must return a JSON-RPC error, not kill the process (hosts probe optional methods).
      const unknown = await request('resources/list');
      assert.ok(unknown.error, `${client.name}: unknown method yields JSON-RPC error`);

      // …and the server must still work afterwards.
      const stats = await request('tools/call', { name: 'graphweft_stats', arguments: {} });
      assert.ok((stats.result?.content as Array<{ text: string }>)[0].text.includes('2 files'), `${client.name}: server alive after unknown method`);
    } finally {
      child.kill();
    }
  }

  await fs.rm(root, { recursive: true, force: true });
  console.log('mcpClients.test.ts passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
