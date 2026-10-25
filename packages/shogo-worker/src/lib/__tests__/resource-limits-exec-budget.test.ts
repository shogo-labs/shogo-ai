// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-203: the agent-command budget is separate from the runtime's own leak
 * ceiling, and the kernel cap has to sit above it so the guard (which writes a
 * note) always trips before the kernel (which writes nothing).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyLiveMemoryCap,
  resolveExecMemoryMB,
  resolveResourceLimits,
  type RuntimeResourceLimits,
} from '../resource-limits';

const dirs: string[] = [];
function limitsFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'host-limits-'));
  dirs.push(dir);
  const file = join(dir, 'host-limits.json');
  writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return file;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const baseEnv = { RUNTIME_MEMORY_MB: '8192' };

describe('resolveResourceLimits', () => {
  it('keeps the runtime ceiling unchanged when no command budget is known', () => {
    const limits = resolveResourceLimits({ ...baseEnv });
    expect(limits?.memoryMB).toBe(8192);
    expect(limits?.osMemoryMB).toBe(8192);
  });

  it('adds an explicit SHOGO_EXEC_MEMORY_MB to the OS cap only', () => {
    const limits = resolveResourceLimits({ ...baseEnv, SHOGO_EXEC_MEMORY_MB: '131072' });
    expect(limits?.memoryMB).toBe(8192);
    expect(limits?.osMemoryMB).toBe(8192 + 131072);
  });

  it('reads the command budget from the watched host-limits file', () => {
    const file = limitsFile({ execMemoryMB: 122880, totalMemMB: 131072, source: 'auto' });
    const limits = resolveResourceLimits({ ...baseEnv, SHOGO_HOST_LIMITS_FILE: file });
    expect(limits?.osMemoryMB).toBe(8192 + 122880);
  });

  it('prefers an explicit env budget over the file', () => {
    const file = limitsFile({ execMemoryMB: 4096 });
    const limits = resolveResourceLimits({
      ...baseEnv,
      SHOGO_HOST_LIMITS_FILE: file,
      SHOGO_EXEC_MEMORY_MB: '2048',
    });
    expect(limits?.osMemoryMB).toBe(8192 + 2048);
  });

  it('ignores a missing or malformed limits file', () => {
    expect(resolveExecMemoryMB({ SHOGO_HOST_LIMITS_FILE: join(tmpdir(), 'nope.json') })).toBe(0);
    expect(resolveExecMemoryMB({ SHOGO_HOST_LIMITS_FILE: limitsFile('{oops') })).toBe(0);
    expect(resolveExecMemoryMB({ SHOGO_HOST_LIMITS_FILE: limitsFile({ execMemoryMB: -5 }) })).toBe(0);
  });
});

describe('applyLiveMemoryCap', () => {
  const limits: RuntimeResourceLimits = { memoryMB: 8192, osMemoryMB: 8192 + 122880, cpuPercent: 0, tasksMax: 4096 };

  it('raises a live systemd scope with set-property, using the combined cap', () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const ok = applyLiveMemoryCap(
      { scopeName: 'shogo-rt-abc12345-m1', limits },
      { platform: 'linux', run: (command, args) => calls.push({ command, args }) },
    );
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('systemctl');
    expect(calls[0]!.args).toEqual([
      '--user',
      'set-property',
      '--runtime',
      'shogo-rt-abc12345-m1',
      'MemoryMax=131072M',
      'MemoryHigh=117964M',
    ]);
  });

  it('rewrites a direct cgroup memory.max, in bytes', () => {
    const writes: Array<{ path: string; data: string }> = [];
    const ok = applyLiveMemoryCap(
      { pid: 4242, limits },
      {
        platform: 'linux',
        exists: (path) => path.endsWith('memory.max') || path.endsWith('memory.high'),
        writeFile: (path, data) => writes.push({ path, data }),
      },
    );
    expect(ok).toBe(true);
    expect(writes).toEqual([
      { path: '/sys/fs/cgroup/shogo/rt-4242/memory.max', data: String(131072 * 1024 * 1024) },
      { path: '/sys/fs/cgroup/shogo/rt-4242/memory.high', data: String(117964 * 1024 * 1024) },
    ]);
  });

  it('does nothing where the limit cannot be changed in place', () => {
    expect(applyLiveMemoryCap({ scopeName: 'x', limits }, { platform: 'win32' })).toBe(false);
    expect(applyLiveMemoryCap({ scopeName: 'x', limits }, { platform: 'darwin' })).toBe(false);
    expect(
      applyLiveMemoryCap({ pid: 7, limits }, { platform: 'linux', exists: () => false }),
    ).toBe(false);
  });
});
