#!/usr/bin/env node
import { spawn, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

import {
  AutoCleanupParamsSchema,
  CleanupSuggestionsParamsSchema,
  CommandHistoryQueryParamsSchema,
  FileDeleteParamsSchema,
  FileListParamsSchema,
  FileReadParamsSchema,
  ServerCurrentParamsSchema,
  ServerDetachParamsSchema,
  ServerGetParamsSchema,
  ServerListAttachableParamsSchema,
  ServerReattachParamsSchema,
  ServerStartParamsSchema,
  ServerStopParamsSchema,
  ShellExecuteParamsSchema,
  ShellGetExecutionParamsSchema,
  ShellSetDefaultWorkdirParamsSchema,
  TerminalCloseParamsSchema,
  TerminalGetParamsSchema,
  TerminalListParamsSchema,
} from './types/schemas.js';
import { TerminalOperateParamsSchema } from './types/quick-schemas.js';

const DEFAULT_BRANCH = 'main';
const RUNTIME_DIR_NAME = 'mcp-shell';
const SOCKET_REQUEST_TIMEOUT_MS = 1000;
const DAEMON_STARTUP_TIMEOUT_MS = 5000;
const DAEMON_STARTUP_POLL_INTERVAL_MS = 100;
const ALLOWED_SUBCMDS = ['status', 'info', 'attach', 'detach', 'reattach', 'stop'] as const;

type Subcmd = (typeof ALLOWED_SUBCMDS)[number];

type DaemonRequest = {
  action: Subcmd | 'tool';
  tool_name?: string;
  params?: Record<string, unknown>;
};

type QuerySegment =
  | { type: 'prop'; key: string }
  | { type: 'index'; index: number }
  | { type: 'iterate' };

const TOOL_SCHEMA_MAP: Record<string, z.ZodTypeAny> = {
  shell_execute: ShellExecuteParamsSchema,
  process_get_execution: ShellGetExecutionParamsSchema,
  shell_set_default_workdir: ShellSetDefaultWorkdirParamsSchema,
  list_execution_outputs: FileListParamsSchema,
  read_execution_output: FileReadParamsSchema,
  delete_execution_outputs: FileDeleteParamsSchema,
  get_cleanup_suggestions: CleanupSuggestionsParamsSchema,
  perform_auto_cleanup: AutoCleanupParamsSchema,
  terminal_operate: TerminalOperateParamsSchema,
  terminal_list: TerminalListParamsSchema,
  terminal_get_info: TerminalGetParamsSchema,
  terminal_close: TerminalCloseParamsSchema,
  command_history_query: CommandHistoryQueryParamsSchema,
  server_current: ServerCurrentParamsSchema,
  server_list_attachable: ServerListAttachableParamsSchema,
  server_start: ServerStartParamsSchema,
  server_stop: ServerStopParamsSchema,
  server_get: ServerGetParamsSchema,
  server_detach: ServerDetachParamsSchema,
  server_reattach: ServerReattachParamsSchema,
};

const HELP_TEXT = `shell-server-cli

Usage:
  shell-server-cli [--socket <path>] [--cwd <path>] [--branch <name>] [subcmd [subcmd options]]

Subcmd (function name):
  status | info | attach | detach | reattach | stop
  tool <tool-name> [--tool-option <value> ...]
  help

Tool name and option mapping:
  - tool-name: kebab-case is converted to internal snake_case
  - --tool-option: --working-directory -> working_directory
  - value parsing: JSON literal if parseable, otherwise string
  - --input-json: JSON text or @path/to/file.json

Output query:
  --query <jq-expression>
  - uses system jq when available
  - falls back to simple queries: .foo.bar, .items[0], .items[]

Options:
  --socket <path>  Override daemon socket path
  --cwd <path>     Working directory for socket namespace
  --branch <name>  Branch name for socket namespace
  --input-json <json|@file>  Tool input JSON object
  --query <expr>   Filter output with jq-style query
  -h, --help       Show this help message
  -v, --version    Show version

Environment:
  SHELL_SERVER_DAEMON_SOCKET  Socket path override
  SHELL_SERVER_DAEMON_CWD     Working directory override
  SHELL_SERVER_DAEMON_BRANCH  Branch name override

Behavior:
  - Daemon is auto-started on first request when socket is unavailable
`;

function getArgValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1 || index === args.length - 1) {
    return undefined;
  }
  return args[index + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function hashCwd(cwd: string): string {
  return crypto.createHash('sha256').update(cwd).digest('hex');
}

function resolveSocketPath(cwd: string, branch: string): string {
  const runtimeRoot = process.env['XDG_RUNTIME_DIR'] || os.tmpdir();
  return path.join(runtimeRoot, RUNTIME_DIR_NAME, hashCwd(cwd), branch, 'daemon.sock');
}

function stripConnectionArgs(args: string[]): string[] {
  const stripped: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) {
      continue;
    }

    if (
      value === '--socket' ||
      value === '--cwd' ||
      value === '--branch' ||
      value === '--input-json' ||
      value === '--query'
    ) {
      index += 1;
      continue;
    }

    stripped.push(value);
  }
  return stripped;
}

async function readVersion(): Promise<string> {
  const packageUrl = new URL('../package.json', import.meta.url);
  const raw = await fs.readFile(packageUrl, 'utf8');
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version || '0.0.0';
}

function isSubcmd(value: string): value is Subcmd {
  return (ALLOWED_SUBCMDS as readonly string[]).includes(value);
}

function kebabToSnake(value: string): string {
  return value.replace(/-/g, '_');
}

function parseScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    return raw;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return raw;
  }
}

function parseToolParams(args: string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token || !token.startsWith('--')) {
      continue;
    }

    const rawKey = token.slice(2);
    if (!rawKey) {
      continue;
    }

    const key = kebabToSnake(rawKey);
    const next = args[index + 1];
    if (!next || next.startsWith('--')) {
      params[key] = true;
      continue;
    }

    params[key] = parseScalar(next);
    index += 1;
  }

  return params;
}

async function parseInputJson(raw: string | undefined): Promise<Record<string, unknown>> {
  if (!raw) {
    return {};
  }

  const isFileRef = raw.startsWith('@') || raw.startsWith('file://');
  const rawContent = isFileRef
    ? await fs.readFile(raw.startsWith('@') ? raw.slice(1) : raw.replace('file://', ''), 'utf8')
    : raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent) as unknown;
  } catch (error) {
    throw new Error(`Failed to parse --input-json: ${String(error)}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--input-json must be a JSON object.');
  }

  return parsed as Record<string, unknown>;
}

function parseSimpleQuerySegments(query: string): QuerySegment[] {
  if (query === '.') {
    return [];
  }

  if (!query.startsWith('.')) {
    throw new Error('Simple query must start with "."');
  }

  const segments: QuerySegment[] = [];
  let index = 1;
  while (index < query.length) {
    const token = query[index];

    if (token === '.') {
      index += 1;
      continue;
    }

    if (query.startsWith('[]', index)) {
      segments.push({ type: 'iterate' });
      index += 2;
      continue;
    }

    if (token === '[') {
      const closeIndex = query.indexOf(']', index + 1);
      if (closeIndex < 0) {
        throw new Error(`Invalid query: missing ] in ${query}`);
      }
      const content = query.slice(index + 1, closeIndex).trim();
      if (/^-?\d+$/.test(content)) {
        segments.push({ type: 'index', index: Number.parseInt(content, 10) });
      } else if (
        (content.startsWith('"') && content.endsWith('"')) ||
        (content.startsWith("'") && content.endsWith("'"))
      ) {
        segments.push({ type: 'prop', key: content.slice(1, -1) });
      } else {
        throw new Error(`Unsupported bracket expression: [${content}]`);
      }
      index = closeIndex + 1;
      continue;
    }

    const rest = query.slice(index);
    const match = rest.match(/^[A-Za-z0-9_-]+/);
    if (!match) {
      throw new Error(`Unsupported query token near: ${rest}`);
    }
    segments.push({ type: 'prop', key: match[0] || '' });
    index += (match[0] || '').length;
  }

  return segments;
}

function executeSimpleQuery(data: unknown, query: string): unknown {
  const segments = parseSimpleQuerySegments(query);
  let current: unknown[] = [data];

  for (const segment of segments) {
    const next: unknown[] = [];
    for (const value of current) {
      if (segment.type === 'prop') {
        if (value && typeof value === 'object') {
          const record = value as Record<string, unknown>;
          next.push(record[segment.key]);
        } else {
          next.push(undefined);
        }
        continue;
      }

      if (segment.type === 'index') {
        if (Array.isArray(value)) {
          next.push(value[segment.index]);
        } else {
          next.push(undefined);
        }
        continue;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          next.push(item);
        }
      } else if (value && typeof value === 'object') {
        for (const item of Object.values(value as Record<string, unknown>)) {
          next.push(item);
        }
      }
    }

    current = next;
  }

  if (current.length === 1) {
    return current[0];
  }
  return current;
}

async function executeNodeJq(data: unknown, query: string): Promise<unknown> {
  const nodeJqModule = (await import('node-jq')) as unknown as {
    default?: {
      run: (
        filter: string,
        input: unknown,
        options?: { input?: 'json' | 'string'; output?: 'json' | 'string' | 'compact' }
      ) => Promise<unknown>;
    };
    run?: (
      filter: string,
      input: unknown,
      options?: { input?: 'json' | 'string'; output?: 'json' | 'string' | 'compact' }
    ) => Promise<unknown>;
  };

  const run = nodeJqModule.default?.run ?? nodeJqModule.run;
  if (!run) {
    throw new Error('node-jq run() not found');
  }

  return run(query, data, { input: 'json', output: 'json' });
}

function executeSystemJq(data: unknown, query: string): unknown {
  const jqResult = spawnSync('jq', ['-c', query], {
    input: JSON.stringify(data),
    encoding: 'utf8',
  });

  if (jqResult.error) {
    throw jqResult.error;
  }

  if (jqResult.status !== 0) {
    throw new Error((jqResult.stderr || 'jq query failed').trim());
  }

  const lines = (jqResult.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return null;
  }

  const parsed = lines.map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return line;
    }
  });

  if (parsed.length === 1) {
    return parsed[0];
  }
  return parsed;
}

async function executeJq(data: unknown, query: string): Promise<unknown> {
  const failures: Array<{ engine: string; message: string }> = [];

  try {
    return await executeNodeJq(data, query);
  } catch (error) {
    failures.push({
      engine: 'node-jq',
      message: error instanceof Error ? error.message : String(error),
    });

    try {
      return executeSystemJq(data, query);
    } catch (systemError) {
      failures.push({
        engine: 'system-jq',
        message: systemError instanceof Error ? systemError.message : String(systemError),
      });

      try {
        return executeSimpleQuery(data, query);
      } catch (simpleError) {
        failures.push({
          engine: 'built-in-simple',
          message: simpleError instanceof Error ? simpleError.message : String(simpleError),
        });

        const detail = failures
          .map((entry) => `  - ${entry.engine}: ${entry.message}`)
          .join('\n');
        throw new Error(
          `Failed to evaluate --query "${query}" with all engines:\n${detail}`
        );
      }
    }
  }
}

function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current: z.ZodTypeAny = schema;
  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable ||
    current instanceof z.ZodDefault ||
    current instanceof z.ZodEffects
  ) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap();
      continue;
    }
    if (current instanceof z.ZodDefault) {
      current = current.removeDefault();
      continue;
    }
    current = current.innerType();
  }
  return current;
}

function schemaTypeName(schema: z.ZodTypeAny): string {
  const base = unwrapSchema(schema);
  if (base instanceof z.ZodString) return 'string';
  if (base instanceof z.ZodNumber) return 'number';
  if (base instanceof z.ZodBoolean) return 'boolean';
  if (base instanceof z.ZodArray) return `array<${schemaTypeName(base.element)}>`;
  if (base instanceof z.ZodObject) return 'object';
  if (base instanceof z.ZodEnum) return `enum(${base.options.join('|')})`;
  if (base instanceof z.ZodUnion) return 'union';
  if (base instanceof z.ZodLiteral) return `literal(${String(base.value)})`;
  return 'unknown';
}

function renderToolListHelp(): string {
  const tools = Object.keys(TOOL_SCHEMA_MAP).sort();
  return `Tool list:\n${tools.map((name) => `  - ${name}`).join('\n')}\n\nUse:\n  shell-server-cli tool <tool-name> --help\n  shell-server-cli tool <tool-name> --input-json '{...}'`;
}

function renderToolSchemaHelp(toolName: string): string {
  const schema = TOOL_SCHEMA_MAP[toolName];
  if (!schema) {
    return `Unknown tool: ${toolName}\n\n${renderToolListHelp()}`;
  }

  const base = unwrapSchema(schema);
  if (!(base instanceof z.ZodObject)) {
    return `Tool: ${toolName}\nSchema type: ${schemaTypeName(base)}`;
  }

  const shape = base.shape;
  const keys = Object.keys(shape);
  if (keys.length === 0) {
    return `Tool: ${toolName}\n\nNo parameters.`;
  }

  const lines = keys.map((key) => {
    const field = shape[key];
    const required = field.isOptional() ? 'optional' : 'required';
    const type = schemaTypeName(field);
    const desc = field.description || '';
    const option = `--${key.replace(/_/g, '-')}`;
    return `  ${option} <${type}> (${required})${desc ? ` ${desc}` : ''}`;
  });

  return `Tool: ${toolName}\n\nParameters:\n${lines.join('\n')}`;
}

async function printResponse(response: unknown, query: string | undefined): Promise<number> {
  const payload = query ? await executeJq(response, query) : response;
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);

  if (
    payload &&
    typeof payload === 'object' &&
    'ok' in (payload as Record<string, unknown>) &&
    (payload as Record<string, unknown>)['ok'] === false
  ) {
    return 1;
  }
  return 0;
}

async function requestDaemon(socketPath: string, request: DaemonRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: socketPath }, () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });

    let buffer = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Daemon request timed out: ${request.action}`));
    }, SOCKET_REQUEST_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeAllListeners();
    };

    socket.setEncoding('utf-8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes('\n')) {
        socket.end();
      }
    });

    socket.on('end', () => {
      cleanup();
      const line = buffer.trim();
      if (!line) {
        reject(new Error('Daemon response was empty.'));
        return;
      }

      try {
        resolve(JSON.parse(line) as unknown);
      } catch (error) {
        reject(new Error(`Failed to parse daemon response: ${String(error)}`));
      }
    });

    socket.on('error', (error) => {
      cleanup();
      reject(new Error(`Daemon request failed: ${String(error)}`));
    });
  });
}

function isDaemonUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('ENOENT') || message.includes('ECONNREFUSED') || message.includes('ENOTSOCK');
}

function resolveDaemonEntryPath(): string {
  return fileURLToPath(new URL('./index.js', import.meta.url));
}

async function canConnectSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ path: socketPath });
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 300);

    socket.once('connect', () => {
      clearTimeout(timeout);
      socket.end();
      resolve(true);
    });

    socket.once('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function ensureDaemonStarted(options: {
  socketPath: string;
  cwd: string;
  branch: string;
}): Promise<void> {
  const daemonEntry = resolveDaemonEntryPath();
  const daemonProcess = spawn(
    process.execPath,
    [daemonEntry, '--socket', options.socketPath, '--cwd', options.cwd, '--branch', options.branch],
    {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    }
  );
  daemonProcess.unref();

  const startedAt = Date.now();
  while (Date.now() - startedAt < DAEMON_STARTUP_TIMEOUT_MS) {
    if (await canConnectSocket(options.socketPath)) {
      return;
    }
    await sleep(DAEMON_STARTUP_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Failed to start daemon within ${DAEMON_STARTUP_TIMEOUT_MS}ms: ${options.socketPath}`
  );
}

async function requestDaemonWithAutoStart(
  socketPath: string,
  request: DaemonRequest,
  options: { cwd: string; branch: string }
): Promise<unknown> {
  try {
    return await requestDaemon(socketPath, request);
  } catch (error) {
    if (request.action === 'stop' || !isDaemonUnavailableError(error)) {
      throw error;
    }

    await ensureDaemonStarted({ socketPath, cwd: options.cwd, branch: options.branch });
    return requestDaemon(socketPath, request);
  }
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (hasFlag(args, '-v') || hasFlag(args, '--version')) {
    process.stdout.write(`${await readVersion()}\n`);
    return;
  }

  const inputJsonRaw = getArgValue(args, '--input-json');
  const query = getArgValue(args, '--query');

  const cwd =
    getArgValue(args, '--cwd') || process.env['SHELL_SERVER_DAEMON_CWD'] || process.cwd();
  const branch =
    getArgValue(args, '--branch') ||
    process.env['SHELL_SERVER_DAEMON_BRANCH'] ||
    process.env['SHELL_SERVER_BRANCH'] ||
    DEFAULT_BRANCH;
  const socketPath =
    getArgValue(args, '--socket') ||
    process.env['SHELL_SERVER_DAEMON_SOCKET'] ||
    resolveSocketPath(cwd, branch);

  const rest = stripConnectionArgs(args);
  if (hasFlag(rest, '-h') || hasFlag(rest, '--help') || rest[0] === 'help') {
    if (rest[0] === 'tool' && rest[1] && rest[1] !== '--help') {
      const toolName = kebabToSnake(rest[1]);
      process.stdout.write(`${renderToolSchemaHelp(toolName)}\n`);
      return;
    }

    if (rest[0] === 'tool' || rest[1] === 'tool') {
      process.stdout.write(`${renderToolListHelp()}\n`);
      return;
    }

    process.stdout.write(HELP_TEXT);
    return;
  }

  const subcmdRaw = rest[0] || 'status';

  if (subcmdRaw === 'tool') {
    const toolNameRaw = rest[1];
    if (!toolNameRaw) {
      throw new Error('Missing tool name. Usage: shell-server-cli ... tool <tool-name> [--key value]');
    }

    if (toolNameRaw === 'help') {
      process.stdout.write(`${renderToolListHelp()}\n`);
      return;
    }

    if (rest.includes('--help') || rest.includes('-h')) {
      process.stdout.write(`${renderToolSchemaHelp(kebabToSnake(toolNameRaw))}\n`);
      return;
    }

    const toolName = kebabToSnake(toolNameRaw);
    const inputJson = await parseInputJson(inputJsonRaw);
    const params = {
      ...inputJson,
      ...parseToolParams(rest.slice(2)),
    };
    const response = await requestDaemonWithAutoStart(socketPath, {
      action: 'tool',
      tool_name: toolName,
      params,
    }, { cwd, branch });
    process.exitCode = await printResponse(response, query);
    return;
  }

  if (!isSubcmd(subcmdRaw)) {
    throw new Error(
      `Unsupported subcmd: ${subcmdRaw}. Expected one of: ${ALLOWED_SUBCMDS.join(', ')}`
    );
  }

  const response = await requestDaemonWithAutoStart(socketPath, { action: subcmdRaw }, { cwd, branch });
  process.exitCode = await printResponse(response, query);
}

run().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
