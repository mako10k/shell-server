import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ProcessManager } from '../dist/core/process-manager.js';

test('adaptive execution waits for a free slot within foreground wait budget', async () => {
  const outputDir = path.join(os.tmpdir(), `mcp-shell-outputs-${randomUUID()}`);
  const manager = new ProcessManager(1, outputDir);

  const first = await manager.executeCommand({
    command: 'sleep 1',
    executionMode: 'background',
    timeoutSeconds: 30,
    maxOutputSize: 1024 * 1024,
    captureStderr: true,
    returnPartialOnTimeout: true,
  });

  assert.equal(first.status, 'running');

  const startedAt = Date.now();
  const second = await manager.executeCommand({
    command: 'echo second',
    executionMode: 'adaptive',
    foregroundTimeoutSeconds: 3,
    timeoutSeconds: 30,
    maxOutputSize: 1024 * 1024,
    captureStderr: true,
    returnPartialOnTimeout: true,
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(second.status, 'completed');
  assert.match(second.stdout ?? '', /second/);
  assert.equal(elapsedMs >= 800, true);

  manager.cleanup();
});

test('adaptive execution returns English diagnostics when queue wait budget is exhausted', async () => {
  const outputDir = path.join(os.tmpdir(), `mcp-shell-outputs-${randomUUID()}`);
  const manager = new ProcessManager(1, outputDir);

  const first = await manager.executeCommand({
    command: 'sleep 2',
    executionMode: 'background',
    timeoutSeconds: 30,
    maxOutputSize: 1024 * 1024,
    captureStderr: true,
    returnPartialOnTimeout: true,
  });

  assert.equal(first.status, 'running');

  await assert.rejects(
    async () => {
      await manager.executeCommand({
        command: 'echo second',
        executionMode: 'adaptive',
        foregroundTimeoutSeconds: 1,
        timeoutSeconds: 30,
        maxOutputSize: 1024 * 1024,
        captureStderr: true,
        returnPartialOnTimeout: true,
      });
    },
    (error) => {
      assert.equal(error?.code, 'RESOURCE_005');
      assert.equal(error?.category, 'RESOURCE');

      const details = error?.details ?? {};
      assert.equal(details.code, 'CONCURRENCY_LIMIT_EXCEEDED');
      assert.equal(typeof details.reason, 'string');
      assert.match(details.reason, /Concurrent execution limit reached/);
      assert.equal(details.limit, 1);
      assert.equal(details.running_count, 1);
      assert.equal(Array.isArray(details.stop_candidates), true);
      assert.equal(details.stop_candidates.length > 0, true);
      assert.equal(Array.isArray(details.next_steps), true);
      return true;
    }
  );

  manager.cleanup();
});
