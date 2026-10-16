// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readExecPidsFile, samplePgidRssKb } from '../resource-limits';

describe('readExecPidsFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'exec-pids-'));
  afterEach(() => rmSync(join(dir, 'pids.json'), { force: true }));

  it('reads the PIDs the runtime publishes', () => {
    writeFileSync(join(dir, 'pids.json'), JSON.stringify({ pids: [12, 34] }));
    expect(readExecPidsFile(join(dir, 'pids.json'))).toEqual([12, 34]);
  });

  it('treats a missing or malformed file as no PIDs', () => {
    expect(readExecPidsFile(join(dir, 'missing.json'))).toEqual([]);
    writeFileSync(join(dir, 'pids.json'), '{not json');
    expect(readExecPidsFile(join(dir, 'pids.json'))).toEqual([]);
    writeFileSync(join(dir, 'pids.json'), JSON.stringify({ pids: [5, -1, 'x', 1.5] }));
    expect(readExecPidsFile(join(dir, 'pids.json'))).toEqual([5]);
  });
});

describe.skipIf(process.platform !== 'win32')('samplePgidRssKb exclusion (Windows)', () => {
  let parent: ChildProcess | null = null;
  afterEach(() => {
    if (parent?.pid) spawn('taskkill', ['/F', '/T', '/PID', String(parent.pid)], { stdio: 'ignore' });
    parent = null;
  });

  it('leaves an excluded subtree out of the sum', async () => {
    const childScript = 'const b = Buffer.alloc(200 * 1024 * 1024, 1); setInterval(() => b[0]++, 1000)';
    const parentScript =
      `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });` +
      `console.log(c.pid); setInterval(() => {}, 1000)`;
    parent = spawn(process.execPath, ['-e', parentScript], { stdio: ['ignore', 'pipe', 'ignore'] });
    const childPid = await new Promise<number>((resolve) => {
      parent!.stdout!.once('data', (d) => resolve(parseInt(String(d).trim(), 10)));
    });
    await new Promise((r) => setTimeout(r, 1500));

    const all = samplePgidRssKb(parent.pid!, 'win32');
    const withoutChild = samplePgidRssKb(parent.pid!, 'win32', [childPid]);
    expect(all).not.toBeNull();
    expect(withoutChild).not.toBeNull();
    expect(all! - withoutChild!).toBeGreaterThan(150 * 1024);
  }, 30_000);
});
