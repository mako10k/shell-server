import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const projectRoot = process.cwd();
const cliPath = path.join(projectRoot, 'dist', 'cli.js');
const daemonPath = path.join(projectRoot, 'dist', 'daemon', 'server.js');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSocket(socketPath, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(socketPath);
      return;
    } catch {
      await sleep(50);
    }
  }

  throw new Error(`Timed out waiting for daemon socket: ${socketPath}`);
}

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: process.env,
  });
}

function parseJsonOutput(result) {
  const output = (result.stdout || '').trim();
  if (!output) {
    throw new Error(`Expected JSON output but got empty stdout. stderr=${result.stderr || ''}`);
  }
  return JSON.parse(output);
}

test('shell-server-cli E2E: daemon + tool + query + help', async (t) => {
  const socketPath = path.join(os.tmpdir(), 'mcp-shell', `e2e-${randomUUID()}.sock`);

  const daemon = spawn(
    process.execPath,
    [daemonPath, '--socket', socketPath, '--cwd', projectRoot, '--branch', 'main'],
    {
      cwd: projectRoot,
      env: process.env,
      stdio: 'ignore',
    }
  );

  t.after(async () => {
    const stopResult = runCli(['--socket', socketPath, 'stop']);
    if (stopResult.status !== 0 && daemon.pid) {
      try {
        process.kill(daemon.pid, 'SIGTERM');
      } catch {
        // best effort only
      }
    }

    try {
      await rm(socketPath, { force: true });
    } catch {
      // best effort only
    }
  });

  await waitForSocket(socketPath);

  const helpResult = runCli(['tool', 'shell-execute', '--help']);
  assert.equal(helpResult.status, 0, helpResult.stderr);
  assert.match(helpResult.stdout, /--command <string>/);

  const toolResult = runCli([
    '--socket',
    socketPath,
    'tool',
    'shell-execute',
    '--input-json',
    '{"command":"echo e2e-json","execution_mode":"foreground"}',
    '--query',
    '.result.stdout',
  ]);
  assert.equal(toolResult.status, 0, toolResult.stderr);
  assert.match(toolResult.stdout, /e2e-json/);

  const terminalOperateResult = runCli([
    '--socket',
    socketPath,
    'tool',
    'terminal-operate',
    '--command',
    'echo term-e2e',
    '--query',
    '.result',
  ]);
  assert.equal(terminalOperateResult.status, 0, terminalOperateResult.stderr);
  const terminalPayload = parseJsonOutput(terminalOperateResult);
  assert.equal(terminalPayload.success, true);
  assert.equal(typeof terminalPayload.terminal_id, 'string');

  const historyResult = runCli([
    '--socket',
    socketPath,
    'tool',
    'command-history-query',
    '--page',
    '1',
    '--page-size',
    '2',
    '--query',
    '.result',
  ]);
  assert.equal(historyResult.status, 0, historyResult.stderr);
  const historyPayload = parseJsonOutput(historyResult);
  assert.equal(historyPayload.success, true);
  assert.equal(Array.isArray(historyPayload.entries), true);
  assert.equal(typeof historyPayload.pagination, 'object');

  const invalidQueryResult = runCli([
    '--socket',
    socketPath,
    '--query',
    'invalid(',
    'status',
  ]);
  assert.equal(invalidQueryResult.status, 1);
  assert.match(invalidQueryResult.stderr, /Failed to evaluate --query/);
  assert.match(invalidQueryResult.stderr, /node-jq/);
  assert.match(invalidQueryResult.stderr, /system-jq/);
  assert.match(invalidQueryResult.stderr, /built-in-simple/);
});
