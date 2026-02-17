import * as fs from 'fs/promises';
import * as net from 'net';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

import { createShellToolRuntime, dispatchToolCall, TOOL_NAMES, type ToolName } from '../runtime/tool-runtime.js';
import { logger } from '../utils/helpers.js';

const DAEMON_COMPONENT = 'daemon';
const SOCKET_REQUEST_TIMEOUT_MS = 1000;
const HEARTBEAT_TIMEOUT_MS = 500;
const CHILD_SOCKET_FILE_NAME = 'child.sock';

type DaemonRequest = {
  action?: 'status' | 'info' | 'attach' | 'detach' | 'reattach' | 'stop' | 'tool';
  tool_name?: string;
  params?: Record<string, unknown>;
};

type DaemonResponse = {
  ok: boolean;
  error?: string;
  result?: unknown;
  attached?: boolean;
  detached?: boolean;
  attachedAt?: string;
  detachedAt?: string;
  startedAt?: string;
  uptimeSeconds?: number;
  pid?: number;
  cwd?: string;
  branch?: string;
  socketPath?: string;
  childSocketPath?: string;
};

type HeartbeatMessage = {
  type?: 'ping' | 'pong';
};

function getArgValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0 || index === args.length - 1) {
    return undefined;
  }
  return args[index + 1];
}

async function removeIfEmpty(dirPath: string): Promise<void> {
  try {
    const entries = await fs.readdir(dirPath);
    if (entries.length === 0) {
      await fs.rmdir(dirPath);
    }
  } catch {
    // Best-effort cleanup only.
  }
}

async function cleanupSocket(socketPath: string): Promise<void> {
  try {
    await fs.unlink(socketPath);
  } catch {
    return;
  }

  const branchDir = path.dirname(socketPath);
  const hashDir = path.dirname(branchDir);
  await removeIfEmpty(branchDir);
  await removeIfEmpty(hashDir);
}

export type DaemonStartOptions = {
  socketPath: string;
  cwd?: string;
  branch?: string;
};

export function resolveDaemonOptionsFromProcess(): DaemonStartOptions {
  const args = process.argv.slice(2);
  const socketPath =
    getArgValue(args, '--socket') || process.env['SHELL_SERVER_DAEMON_SOCKET'];
  const cwd = getArgValue(args, '--cwd') || process.env['SHELL_SERVER_DAEMON_CWD'];
  const branch = getArgValue(args, '--branch') || process.env['SHELL_SERVER_DAEMON_BRANCH'];

  if (!socketPath) {
    throw new Error('Daemon socket path is required.');
  }

  return {
    socketPath,
    ...(cwd ? { cwd } : {}),
    ...(branch ? { branch } : {}),
  };
}

export async function startDaemon(options: DaemonStartOptions): Promise<void> {
  const socketPath = options.socketPath;
  const cwd = options.cwd;
  const branch = options.branch;
  const toolRuntime = createShellToolRuntime({
    ...(cwd ? { defaultWorkingDirectory: cwd } : {}),
    enhancedConfigOverrides: {
      enhanced_mode_enabled: false,
    },
  });

  if (!socketPath) {
    throw new Error('Daemon socket path is required.');
  }

  if (cwd) {
    process.chdir(cwd);
  }

  const socketDir = path.dirname(socketPath);
  await fs.mkdir(socketDir, { recursive: true });

  try {
    const stat = await fs.stat(socketPath);
    if (stat.isSocket()) {
      await fs.unlink(socketPath);
    }
  } catch {
    // Ignore missing socket.
  }

  const startedAt = new Date().toISOString();
  const state = {
    attached: false,
    detached: false,
    attachedAt: undefined as string | undefined,
    detachedAt: undefined as string | undefined,
  };
  let childDaemonProcess: ChildProcess | null = null;
  const childSocketPath = path.join(path.dirname(socketPath), CHILD_SOCKET_FILE_NAME);

  const resolveChildDaemonEntry = (): string => {
    const override = process.env['SHELL_SERVER_CHILD_DAEMON_ENTRY'];
    if (override) {
      return override;
    }

    const require = createRequire(import.meta.url);

    try {
      const mcpShellMainEntry = require.resolve('@mako10k/mcp-shell');
      const fromPackageMain = path.resolve(path.dirname(mcpShellMainEntry), 'daemon.js');
      if (existsSync(fromPackageMain)) {
        return fromPackageMain;
      }
    } catch {
      // Fallback to static path candidates.
    }

    const moduleDir = path.dirname(fileURLToPath(import.meta.url));

    // Prefer resolving relative to this module's location so that packaged
    // environments (VS Code extension / node_modules) work without relying on cwd.
    const packagedCandidate = path.resolve(moduleDir, '..', '..', '..', 'mcp-shell', 'dist', 'daemon.js');
    const candidates = [
      // Installed package in node_modules/@mako10k/shell-server -> ../mcp-shell.
      packagedCandidate,
      // Mono-repo build output co-located under dist/packages.
      path.resolve(moduleDir, '..', 'packages', 'mcp-shell', 'src', 'daemon.js'),
      // Legacy cwd-based mono-repo path.
      path.resolve(process.cwd(), 'dist/packages/mcp-shell/src/daemon.js'),
      // Mono-repo package path when invoked from repository root.
      path.resolve(process.cwd(), 'packages/mcp-shell/dist/daemon.js'),
      // Installed package lookup from current working directory.
      path.resolve(process.cwd(), 'node_modules', '@mako10k', 'mcp-shell', 'dist', 'daemon.js'),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    // Best guess (validated by fs.access in startChildDaemon).
    return packagedCandidate;
  };

  const startChildDaemon = async () => {
    if (childDaemonProcess) {
      return;
    }

    const daemonEntry = resolveChildDaemonEntry();
    try {
      await fs.access(daemonEntry);
    } catch (error) {
      logger.error('Child daemon entry not found', { error: String(error), daemonEntry }, DAEMON_COMPONENT);
      return;
    }

    try {
      await fs.unlink(childSocketPath);
    } catch {
      // Ignore missing socket.
    }

    childDaemonProcess = spawn(process.execPath, [daemonEntry], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        SHELL_SERVER_CHILD_DAEMON_SOCKET: childSocketPath,
      },
    });
    childDaemonProcess.unref();
  };
  let attachSocket: net.Socket | null = null;
  let pongResolver: ((result: boolean) => void) | null = null;

  const markDetached = () => {
    state.attached = false;
    state.detached = true;
    state.detachedAt = new Date().toISOString();
  };

  const closeAttachSocket = () => {
    if (attachSocket) {
      attachSocket.destroy();
      attachSocket = null;
    }
  };

  const checkAttachLiveness = async (): Promise<boolean> => {
    if (!attachSocket) {
      return false;
    }

    if (pongResolver) {
      return false;
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pongResolver = null;
        resolve(false);
      }, HEARTBEAT_TIMEOUT_MS);

      pongResolver = (result: boolean) => {
        clearTimeout(timeout);
        pongResolver = null;
        resolve(result);
      };

      try {
        attachSocket?.write(`${JSON.stringify({ type: 'ping' })}\n`);
      } catch {
        pongResolver = null;
        clearTimeout(timeout);
        resolve(false);
      }
    });
  };

  const sendResponse = (
    socket: net.Socket,
    response: DaemonResponse,
    close: boolean = true
  ) => {
    try {
      socket.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      logger.error('Failed to write daemon response', { error: String(error) }, DAEMON_COMPONENT);
    } finally {
      if (close) {
        socket.end();
      }
    }
  };

  const server = net.createServer((socket) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      socket.destroy();
    }, SOCKET_REQUEST_TIMEOUT_MS);

    socket.setEncoding('utf-8');

    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeAllListeners();
    };

    let handled = false;

    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes('\n')) {
        void handleRequest();
      }
    });

    const handleRequest = async () => {
      if (handled) {
        return;
      }
      handled = true;

      cleanup();
      const line = buffer.split('\n')[0]?.trim();
      if (!line) {
        return;
      }

      socket.removeAllListeners('data');
      socket.removeAllListeners('end');

      let request: DaemonRequest;
      try {
        request = JSON.parse(line) as DaemonRequest;
      } catch (error) {
        sendResponse(socket, { ok: false, error: 'invalid_request' });
        return;
      }

      const action = request.action || 'status';
      if (action === 'status' || action === 'info') {
        if (attachSocket) {
          const alive = await checkAttachLiveness();
          if (!alive) {
            closeAttachSocket();
            markDetached();
          }
        }

        const uptimeSeconds = Math.max(0, Math.floor(process.uptime()));
        sendResponse(socket, {
          ok: true,
          attached: state.attached,
          detached: state.detached,
          ...(state.attachedAt ? { attachedAt: state.attachedAt } : {}),
          ...(state.detachedAt ? { detachedAt: state.detachedAt } : {}),
          ...(action === 'info' ? { startedAt } : {}),
          ...(action === 'info' ? { uptimeSeconds } : {}),
          pid: process.pid,
          cwd: process.cwd(),
          ...(branch ? { branch } : {}),
          ...(action === 'info' ? { socketPath } : {}),
          ...(action === 'info' ? { childSocketPath } : {}),
        });
        return;
      }

      if (action === 'attach' || action === 'reattach') {
        if (attachSocket) {
          const alive = await checkAttachLiveness();
          if (!alive) {
            closeAttachSocket();
            markDetached();
          }
        }

        if (state.attached && !state.detached) {
          sendResponse(socket, { ok: false, error: 'already_attached' });
          return;
        }

        attachSocket = socket;
        socket.setEncoding('utf-8');
        socket.on('data', (data) => {
          const messages = data.toString().split('\n');
          for (const message of messages) {
            if (!message.trim()) {
              continue;
            }
            let parsed: HeartbeatMessage;
            try {
              parsed = JSON.parse(message) as HeartbeatMessage;
            } catch {
              continue;
            }

            if (parsed.type === 'pong' && pongResolver) {
              pongResolver(true);
            }
          }
        });
        socket.on('close', () => {
          if (attachSocket === socket) {
            attachSocket = null;
          }
          markDetached();
        });
        socket.on('error', () => {
          if (attachSocket === socket) {
            attachSocket = null;
          }
          markDetached();
        });

        state.attached = true;
        state.detached = false;
        state.attachedAt = new Date().toISOString();
        sendResponse(
          socket,
          {
            ok: true,
            attached: state.attached,
            detached: state.detached,
            ...(state.attachedAt ? { attachedAt: state.attachedAt } : {}),
            ...(state.detachedAt ? { detachedAt: state.detachedAt } : {}),
            pid: process.pid,
            cwd: process.cwd(),
            ...(branch ? { branch } : {}),
          },
          false
        );
        return;
      }

      if (action === 'detach') {
        closeAttachSocket();
        markDetached();
        sendResponse(socket, {
          ok: true,
          attached: state.attached,
          detached: state.detached,
          ...(state.attachedAt ? { attachedAt: state.attachedAt } : {}),
          ...(state.detachedAt ? { detachedAt: state.detachedAt } : {}),
          pid: process.pid,
          cwd: process.cwd(),
          ...(branch ? { branch } : {}),
        });
        return;
      }
      if (action === 'stop') {
        sendResponse(socket, { ok: true });
        if (childDaemonProcess?.pid) {
          try {
            process.kill(childDaemonProcess.pid);
          } catch {
            // Best-effort shutdown only.
          }
        }
        await shutdown();
        process.exit(0);
      }

      if (action === 'tool') {
        const toolNameRaw = request.tool_name;
        const params = request.params ?? {};

        if (!toolNameRaw) {
          sendResponse(socket, { ok: false, error: 'missing_tool_name' });
          return;
        }

        if (!(TOOL_NAMES as readonly string[]).includes(toolNameRaw)) {
          sendResponse(socket, {
            ok: false,
            error: `unsupported_tool:${toolNameRaw}`,
          });
          return;
        }

        try {
          const result = await dispatchToolCall(
            toolRuntime.shellTools,
            toolRuntime.serverManager,
            toolNameRaw as ToolName,
            params,
            {
              ...(cwd ? { defaultWorkingDirectory: cwd } : {}),
              fallbackWorkingDirectory: process.cwd(),
            }
          );
          sendResponse(socket, { ok: true, result });
        } catch (error) {
          sendResponse(socket, { ok: false, error: String(error) });
        }
        return;
      }

      sendResponse(socket, { ok: false, error: 'unsupported_action' });
    };

    socket.on('end', () => {
      void handleRequest();
    });

    socket.on('error', (error) => {
      cleanup();
      logger.error('Daemon socket error', { error: String(error) }, DAEMON_COMPONENT);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });

  await fs.chmod(socketPath, 0o600);
  await startChildDaemon();
  logger.info('Daemon socket ready', { socketPath, cwd, branch }, DAEMON_COMPONENT);

  const shutdown = async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await toolRuntime.cleanup();
    await cleanupSocket(socketPath);
  };

  process.on('SIGTERM', () => {
    shutdown().catch((error) => {
      logger.error('Daemon shutdown failed', { error: String(error) }, DAEMON_COMPONENT);
    });
  });
  process.on('SIGINT', () => {
    shutdown().catch((error) => {
      logger.error('Daemon shutdown failed', { error: String(error) }, DAEMON_COMPONENT);
    });
  });
}

const isMain = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;

if (isMain) {
  startDaemon(resolveDaemonOptionsFromProcess()).catch((error) => {
    logger.error('Daemon startup failed', { error: String(error) }, DAEMON_COMPONENT);
    process.exitCode = 1;
  });
}
