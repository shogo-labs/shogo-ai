// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-203: the agent-command budget must not be borrowed from the runtime's own
 * leak ceiling. When the desktop publishes `host-limits.json`, the runtime gets
 * the file's path and *no* `SHOGO_EXEC_MEMORY_MB` — otherwise the env value,
 * baked in at spawn, would win and a settings change would need a restart.
 *
 * `buildEnv` is private; it is driven through a typed cast, the same way
 * `runtime-manager-tree-sitter-env.test.ts` does.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerRuntimeManager } from '../runtime-manager';

const dir = mkdtempSync(join(tmpdir(), 'rm-exec-budget-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const BIN = '/opt/shogo/runtime/shogo-agent-runtime-linux-x64';

type EnvBuilder = { buildEnv(slot: unknown, runtimeBinPath: string): NodeJS.ProcessEnv };

/** The fields `buildEnv` reads, plus an idempotent port for the PID file path. */
function fakeSlot(): unknown {
  return {
    projectId: 'proj-exec-budget-test',
    agentPort: 41000,
    apiServerPort: 41100,
    spawnConfig: { cloudUrl: 'https://cloud.test', apiKey: 'api-key' },
  };
}

function limitsFile(): string {
  const file = join(dir, 'host-limits.json');
  writeFileSync(file, JSON.stringify({ execMemoryMB: 122880, totalMemMB: 131072, source: 'auto' }));
  return file;
}

describe('WorkerRuntimeManager.buildEnv — agent-command budget', () => {
  it('hands the desktop limits file through and leaves the env budget unset', async () => {
    const file = limitsFile();
    const mgr = new WorkerRuntimeManager({
      env: { RUNTIME_MEMORY_MB: '8192', SHOGO_HOST_LIMITS_FILE: file } as NodeJS.ProcessEnv,
    });
    const env = (mgr as unknown as EnvBuilder).buildEnv(fakeSlot(), BIN);

    expect(env.SHOGO_HOST_LIMITS_FILE).toBe(file);
    // The bug: this used to be `String(limits.memoryMB)`.
    expect(env.SHOGO_EXEC_MEMORY_MB).toBeUndefined();
    expect(env.SHOGO_EXEC_PIDS_FILE).toBeTruthy();
    await mgr.stopAll();
  });

  it('falls back to the runtime ceiling for a headless worker with no limits file', () => {
    const mgr = new WorkerRuntimeManager({
      env: { RUNTIME_MEMORY_MB: '8192' } as NodeJS.ProcessEnv,
    });
    const env = (mgr as unknown as EnvBuilder).buildEnv(fakeSlot(), BIN);
    expect(env.SHOGO_EXEC_MEMORY_MB).toBe('8192');
  });

  it('keeps an explicit SHOGO_EXEC_MEMORY_MB in front of the file', async () => {
    const file = limitsFile();
    const mgr = new WorkerRuntimeManager({
      env: {
        RUNTIME_MEMORY_MB: '8192',
        SHOGO_EXEC_MEMORY_MB: '4096',
        SHOGO_HOST_LIMITS_FILE: file,
      } as NodeJS.ProcessEnv,
    });
    const env = (mgr as unknown as EnvBuilder).buildEnv(fakeSlot(), BIN);
    expect(env.SHOGO_EXEC_MEMORY_MB).toBe('4096');
    await mgr.stopAll();
  });

  it('leaves the runtime ceiling itself alone', () => {
    const mgr = new WorkerRuntimeManager({
      env: { RUNTIME_MEMORY_MB: '8192' } as NodeJS.ProcessEnv,
    });
    const env = (mgr as unknown as EnvBuilder).buildEnv(fakeSlot(), BIN);
    // The heap hint still comes from the runtime ceiling, not the command budget.
    expect(env.NODE_OPTIONS).toContain('--max-old-space-size=6144');
    expect(env.RUNTIME_MEMORY_MB).toBe('8192');
  });
});
