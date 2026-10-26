// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Runtime memory is summed from one process snapshot shared by every
 * watchdog, read without blocking the caller's thread.
 */
import { describe, expect, it } from 'bun:test';
import { RssWatchdog, snapshotProcesses, treeRssKb, type ProcessRow } from '../resource-limits';

const row = (pid: number, ppid: number, kb: number, pgid = 0): ProcessRow => ({ pid, ppid, pgid, kb });

describe('treeRssKb on Windows', () => {
  const rows = [row(0, 0, 8), row(10, 1, 100), row(11, 10, 50), row(12, 11, 25), row(13, 10, 1000), row(20, 1, 7)];

  it('sums the root and all of its descendants', () => {
    expect(treeRssKb(rows, 10, 'win32')).toBe(1175);
  });

  it('prunes excluded subtrees', () => {
    expect(treeRssKb(rows, 10, 'win32', [13])).toBe(175);
    expect(treeRssKb(rows, 10, 'win32', [11])).toBe(1100);
  });

  it('never excludes the root itself', () => {
    expect(treeRssKb(rows, 10, 'win32', [10])).toBe(1175);
  });

  it('reads a missing root as no reading', () => {
    expect(treeRssKb(rows, 99, 'win32')).toBeNull();
  });

  it('survives a parent-pid cycle', () => {
    expect(treeRssKb([row(5, 6, 1), row(6, 5, 2)], 5, 'win32')).toBe(3);
  });
});

describe('treeRssKb on POSIX', () => {
  const rows = [row(10, 1, 100, 10), row(11, 10, 50, 10), row(12, 11, 25, 12), row(20, 1, 7, 20)];

  it('sums the process group led by the root', () => {
    expect(treeRssKb(rows, 10, 'darwin')).toBe(150);
  });

  it('reads an empty group as no reading', () => {
    expect(treeRssKb(rows, 99, 'linux')).toBeNull();
  });
});

describe('RssWatchdog.observe', () => {
  const over = [row(10, 1, 300 * 1024)];
  const under = [row(10, 1, 100 * 1024)];

  it('fires once after consecutive over-ceiling snapshots', () => {
    const breaches: number[] = [];
    const watchdog = new RssWatchdog({ pid: 10, ceilingMB: 200, platform: 'win32', strikes: 2, onBreach: (mb) => breaches.push(mb) });
    watchdog.observe(over);
    expect(breaches).toEqual([]);
    watchdog.observe(over);
    expect(breaches).toEqual([300]);
    watchdog.observe(over);
    expect(breaches).toEqual([300]);
  });

  it('resets strikes on a reading under the ceiling or a failed snapshot', () => {
    const breaches: number[] = [];
    const watchdog = new RssWatchdog({ pid: 10, ceilingMB: 200, platform: 'win32', strikes: 2, onBreach: (mb) => breaches.push(mb) });
    watchdog.observe(over);
    watchdog.observe(under);
    watchdog.observe(over);
    watchdog.observe(null);
    watchdog.observe(over);
    expect(breaches).toEqual([]);
  });
});

describe('snapshotProcesses', () => {
  it('lists this process without blocking the event loop', async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 10);
    try {
      const rows = await snapshotProcesses();
      expect(rows).not.toBeNull();
      const self = rows!.find((r) => r.pid === process.pid);
      expect(self).toBeDefined();
      expect(self!.kb).toBeGreaterThan(0);
      expect(ticks).toBeGreaterThan(0);
    } finally {
      clearInterval(timer);
    }
  }, 30_000);
});
