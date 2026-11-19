// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  HostSampler,
  listFirecrackerPids,
  parseLoadavg,
  parseMeminfo,
  parsePressure,
  parseSchedstat,
  parseVmstat,
  percentile,
  processRssMiB,
} from '../host-sampler'

const MEMINFO = `MemTotal:       263845120 kB
MemFree:         1234567 kB
MemAvailable:   131922560 kB
Buffers:          123456 kB
Cached:          98765432 kB
SwapTotal:       8388608 kB
SwapFree:        7340032 kB
`

const PRESSURE = `some avg10=1.25 avg60=4.50 avg300=2.00 total=123456
full avg10=0.00 avg60=0.10 avg300=0.05 total=789
`

describe('parseMeminfo', () => {
  test('reads MiB', () => {
    const m = parseMeminfo(MEMINFO)
    expect(m.totalMiB).toBe(257661)
    expect(m.availableMiB).toBe(128831)
    expect(m.swapTotalMiB).toBe(8192)
    expect(m.swapFreeMiB).toBe(7168)
  })

  test('missing fields are 0', () => {
    expect(parseMeminfo('MemTotal: 1024 kB\n')).toMatchObject({ totalMiB: 1, availableMiB: 0 })
  })
})

describe('parsePressure', () => {
  test('reads some and full', () => {
    const p = parsePressure(PRESSURE)
    expect(p.some10).toBe(1.25)
    expect(p.some60).toBe(4.5)
    expect(p.some300).toBe(2)
    expect(p.full60).toBe(0.1)
  })

  test('a cpu file with no full line leaves full at 0', () => {
    const p = parsePressure('some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n')
    expect(p.some60).toBe(0)
    expect(p.full60).toBe(0)
  })
})

describe('parseLoadavg', () => {
  test('reads load and procs', () => {
    expect(parseLoadavg('0.52 0.58 0.59 2/1234 5678\n')).toEqual({ load1: 0.52, load5: 0.58, load15: 0.59, procsRunning: 2, procsTotal: 1234 })
  })
})

describe('parseVmstat', () => {
  test('reads the swap counters', () => {
    const v = parseVmstat('nr_free_pages 123\npswpin 456\npswpout 789\n')
    expect(v).toEqual({ pswpin: 456, pswpout: 789 })
  })
})

describe('parseSchedstat', () => {
  test('reads run_delay (field 2)', () => {
    expect(parseSchedstat('123456789 987654 42\n')).toBe(987654)
  })
})

describe('percentile', () => {
  test('nearest rank', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3)
    expect(percentile([1, 2, 3, 4, 5], 95)).toBe(5)
    expect(percentile([], 95)).toBe(0)
  })
})

describe('HostSampler', () => {
  test('reads a fake /proc tree and turns counters into rates', () => {
    const root = mkdtempSync(join(tmpdir(), 'density-proc-'))
    writeFileSync(join(root, 'meminfo'), MEMINFO)
    writeFileSync(join(root, 'loadavg'), '1.00 1.00 1.00 3/500 999\n')
    writeFileSync(join(root, 'vmstat'), 'pswpin 100\npswpout 0\n')
    mkdirSync(join(root, 'pressure'))
    writeFileSync(join(root, 'pressure', 'cpu'), PRESSURE)
    writeFileSync(join(root, 'pressure', 'memory'), 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n')

    // One fake firecracker process with two vCPU threads.
    const pid = 4242
    mkdirSync(join(root, String(pid), 'task', '4243'), { recursive: true })
    mkdirSync(join(root, String(pid), 'task', '4244'), { recursive: true })
    writeFileSync(join(root, String(pid), 'comm'), 'firecracker\n')
    writeFileSync(join(root, String(pid), 'status'), 'Name:\tfirecracker\nVmRSS:\t  524288 kB\n')
    writeFileSync(join(root, String(pid), 'task', '4243', 'schedstat'), '1000 0 1\n')
    writeFileSync(join(root, String(pid), 'task', '4244', 'schedstat'), '1000 0 1\n')

    expect(listFirecrackerPids(root)).toEqual([pid])
    expect(processRssMiB(pid, root)).toBe(512)

    const sampler = new HostSampler(root)
    const first = sampler.sample(1_000)
    expect(first.mem?.totalMiB).toBe(257661)
    expect(first.memAvailablePct).toBe(50)
    expect(first.fcProcs).toBe(1)
    expect(first.fcRssMiB).toBe(512)
    expect(first.cpuPressure?.some60).toBe(4.5)
    // No previous sample: no rate yet.
    expect(first.swapInPagesPerSec).toBeNull()
    expect(first.runDelayMsPerSec).toBeNull()

    // 1 s later: 200 ms of run_delay on each thread, 50 pages swapped in.
    writeFileSync(join(root, String(pid), 'task', '4243', 'schedstat'), '1000 200000000 1\n')
    writeFileSync(join(root, String(pid), 'task', '4244', 'schedstat'), '1000 200000000 1\n')
    writeFileSync(join(root, 'vmstat'), 'pswpin 150\npswpout 0\n')

    const second = sampler.sample(2_000)
    expect(second.swapInPagesPerSec).toBe(50)
    expect(second.runDelayMsPerSec?.p95).toBe(200)
    expect(second.runDelayMsPerSec?.threads).toBe(2)
  })

  test('degrades to nulls when /proc is missing', () => {
    const sampler = new HostSampler('/nonexistent-proc')
    const s = sampler.sample()
    expect(s.mem).toBeNull()
    expect(s.cpuPressure).toBeNull()
    expect(s.fcProcs).toBe(0)
    expect(s.memAvailablePct).toBeNull()
  })
})
