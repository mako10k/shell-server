import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { startDaemon } from './daemon/server.js';
import { logger } from './utils/helpers.js';

const DEFAULT_BRANCH = 'main';
const RUNTIME_DIR_NAME = 'mcp-shell';

const HELP_TEXT = `shell-server

Usage:
  shell-server [--socket <path>] [--cwd <path>] [--branch <name>]

Options:
  --socket <path>  Override daemon socket path
  --cwd <path>     Working directory for daemon
  --branch <name>  Branch name for socket namespace
  -h, --help       Show this help message
  -v, --version    Show version

Environment:
  SHELL_SERVER_DAEMON_SOCKET  Socket path override
  SHELL_SERVER_DAEMON_CWD     Working directory override
  SHELL_SERVER_DAEMON_BRANCH  Branch name override
`;

function getArgValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
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

async function readVersion(): Promise<string> {
  const packageUrl = new URL('../package.json', import.meta.url);
  const raw = await fs.readFile(packageUrl, 'utf8');
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version || '0.0.0';
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

  await startDaemon({ socketPath, cwd, branch });
}

run().catch((error) => {
  logger.error('shell-server failed', { error: String(error) }, 'shell-server');
  process.exitCode = 1;
});
