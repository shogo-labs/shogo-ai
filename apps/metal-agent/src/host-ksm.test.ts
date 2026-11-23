// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Host KSM counters (SHO-534). Pure parsers, so the host's own files are mocked:
 * the point is that a host with KSM off, a host with it on, and a `ksmd` that is
 * not running all report distinctly, because "0 sharing" and "no KSM at all" mean
 * different things when reading the staging numbers.
 */

import { describe, expect, test } from 'bun:test'
import { findKsmdPid, ksmdCpuPct, parseKsmCounters, procCpuTicks } from './host-ksm'

describe('parseKsmCounters', () => {
  test('reads the sysfs counters a host with KSM enabled reports', () => {
    const files: Record<string, string> = {
      run: '1\n',
      pages_sharing: '182344\n',
      pages_shared: '2071\n',
      full_scans: '42\n',
    }
    expect(parseKsmCounters((f) => files[f])).toEqual({
      run: true,
      pagesSharing: 182344,
      pagesShared: 2071,
      fullScans: 42,
    })
  })

  test('a host that never started ksmd reads as off with zero sharing', () => {
    // Every prod host today: the sysfs tree exists, run=0.
    const files: Record<string, string> = { run: '0\n', pages_sharing: '0\n', pages_shared: '0\n', full_scans: '0\n' }
    expect(parseKsmCounters((f) => files[f])).toEqual({
      run: false,
      pagesSharing: 0,
      pagesShared: 0,
      fullScans: 0,
    })
  })

  test('no KSM at all is undefined, not zero (a missing kernel feature)', () => {
    expect(parseKsmCounters(() => undefined)).toBeUndefined()
  })

  test('a missing counter file counts as zero rather than failing the sample', () => {
    expect(parseKsmCounters((f) => (f === 'run' ? '1\n' : undefined))).toEqual({
      run: true,
      pagesSharing: 0,
      pagesShared: 0,
      fullScans: 0,
    })
  })
})

describe('ksmdCpuPct', () => {
  test('is undefined on the first sample (no delta to divide by)', () => {
    expect(ksmdCpuPct(undefined, { ticks: 500, at: 1_000 })).toBeUndefined()
  })

  test('a percent of one core over the sample window', () => {
    // 100 ticks = 1s of CPU over a 10s window → 10% of one core.
    expect(ksmdCpuPct({ ticks: 1_000, at: 0 }, { ticks: 1_100, at: 10_000 })).toBe(10)
    // 50 ticks = 0.5s over 60s → 0.83%
    expect(ksmdCpuPct({ ticks: 0, at: 0 }, { ticks: 50, at: 60_000 })).toBe(0.83)
  })

  test('a clock stepping backwards or a vanished thread yields no spike', () => {
    expect(ksmdCpuPct({ ticks: 100, at: 10_000 }, { ticks: 200, at: 10_000 })).toBeUndefined()
    expect(ksmdCpuPct({ ticks: 5_000, at: 10_000 }, { ticks: 10, at: 20_000 })).toBe(0)
  })
})

describe('findKsmdPid / procCpuTicks', () => {
  test('finds the ksmd kernel thread and nothing else', () => {
    const comms: Record<string, string> = {
      '/proc/1/comm': 'systemd\n',
      '/proc/77/comm': 'ksmd\n',
      '/proc/9/comm': 'firecracker\n',
    }
    const pid = findKsmdPid(
      () => ['1', '9', '77', 'self', 'net'],
      (f) => comms[f],
    )
    expect(pid).toBe(77)
  })

  test('undefined when the thread is not running (KSM never started)', () => {
    expect(findKsmdPid(() => ['1', '9'], () => 'bash\n')).toBeUndefined()
  })

  test('utime + stime survive a comm containing spaces and parentheses', () => {
    // fields: pid (comm) state ppid ... ; utime/stime are 14 and 15 overall.
    const stat = '77 (ksm d) S 2 0 0 0 -1 4194560 0 0 0 0 1234 66 0 0 20 0 1 0'
    // After the closing paren: state ppid pgrp session tty tpgid flags minflt
    // cminflt majflt cmajflt utime stime → utime is index 11, stime 12.
    expect(procCpuTicks(stat)).toBe(1300)
  })

  test('a malformed or missing stat file is undefined, not NaN', () => {
    expect(procCpuTicks(undefined)).toBeUndefined()
    expect(procCpuTicks('77 (ksmd) S')).toBeUndefined()
  })
})
