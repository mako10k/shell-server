#!/usr/bin/env node
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const DEFAULT_BRANCH = 'main';
const RUNTIME_DIR_NAME = 'mcp-shell';
const SOCKET_REQUEST_TIMEOUT_MS = 1000;
const ALLOWED_SUBCMDS = ['status', 'info', 'attach', 'detach', 'reattach', 'stop'] as const;

type Subcmd = (typeof ALLOWED_SUBCMDS)[number];

type DaemonRequest = {
  action: Subcmd;
};

const HELP_TEXT = `shell-server-cli

Usage:
  shell-server-cli [--socket <path>] [--cwd <path>] [--branch <name>] [subcmd [subcmd options]]

Subcmd (function name):
  status | info | attach | detach | reattach | stop

Options:
  --socket <path>  Override daemon socket path
  --cwd <path>     Working directory for socket namespace
  --branch <name>  Branch name for socket namespace
  -h, --help       Show this help message
  -v, --version    Show version

Environment:
  MCP_SHELL_DAEMON_SOCKET  Socket path override
  MCP_SHELL_DAEMON_CWD     Working directory override
  MCP_SHELL_DAEMON_BRANCH  Branch name override
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

    if (value === '--socket' || value === '--cwd' || value === '--branch') {
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

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (hasFlag(args, '-h') || hasFlag(args, '--help')) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  if (hasFlag(args, '-v') || hasFlag(args, '--version')) {
    process.stdout.write(`${await readVersion()}\n`);
    return;
  }

  const cwd =
    getArgValue(args, '--cwd') || process.env['MCP_SHELL_DAEMON_CWD'] || process.cwd();
  const branch =
    getArgValue(args, '--branch') ||
    process.env['MCP_SHELL_DAEMON_BRANCH'] ||
    process.env['MCP_SHELL_SERVER_BRANCH'] ||
    DEFAULT_BRANCH;
  const socketPath =
    getArgValue(args, '--socket') ||
    process.env['MCP_SHELL_DAEMON_SOCKET'] ||
    resolveSocketPath(cwd, branch);

  const rest = stripConnectionArgs(args);
  const subcmdRaw = rest[0] || 'status';
  if (!isSubcmd(subcmdRaw)) {
    throw new Error(
      `Unsupported subcmd: ${subcmdRaw}. Expected one of: ${ALLOWED_SUBCMDS.join(', ')}`
    );
  }

  const response = await requestDaemon(socketPath, { action: subcmdRaw });
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
}

run().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
