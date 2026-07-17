// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { M, metrics } from './metrics'
import { SerialWatcher, classifySerialLine, sanitizeSerialLine, type WatchedVm } from './serial-watcher'

describe('classifySerialLine', () => {
  test('detects TLS clock-skew (the resume-skew incident signature)', () => {
    expect(classifySerialLine('Error: certificate is not yet valid')?.category).toBe('tls_clock_skew')
    expect(classifySerialLine('write EPROTO ... CERT_NOT_YET_VALID')?.category).toBe('tls_clock_skew')
  })

  test('detects provider errors', () => {
    expect(classifySerialLine('[AgentLoop] Provider error: connection refused')?.category).toBe('provider_error')
    expect(classifySerialLine('Agent produced no output — possible provider error')?.category).toBe('provider_error')
  })

  test('detects connection/network errors', () => {
    expect(classifySerialLine('pi-agent-core: Connection error')?.category).toBe('connection_error')
    expect(classifySerialLine('fetch failed: ECONNREFUSED')?.category).toBe('connection_error')
    expect(classifySerialLine('getaddrinfo EAI_AGAIN studio.shogo.ai')?.category).toBe('connection_error')
  })

  test('detects inference retries as WARN, not ERROR', () => {
    const sig = classifySerialLine('[AgentLoop] INFERENCE_RETRY attempt=1/3 reason=network')
    expect(sig?.category).toBe('inference_retry')
    expect(sig?.level).toBe(4)
  })

  test('returns null for benign lines', () => {
    expect(classifySerialLine('[entrypoint] starting agent-runtime')).toBeNull()
    expect(classifySerialLine('GET /health 200')).toBeNull()
  })
})

describe('sanitizeSerialLine', () => {
  test('strips CR, ANSI escapes and control chars', () => {
    expect(sanitizeSerialLine('\x1b[31mProvider error:\x1b[0m boom\r')).toBe('Provider error: boom')
    expect(sanitizeSerialLine('  padded \x00\x07 ')).toBe('padded')
  })
})

describe('SerialWatcher', () => {
  let dir: string
  const cleanups: string[] = []

  afterEach(() => {
    for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function tmp(): string {
    dir = mkdtempSync(join(tmpdir(), 'serialwatch-'))
    cleanups.push(dir)
    return dir
  }

  test('first sight starts at EOF (never replays pre-existing history)', () => {
    const d = tmp()
    const serial = join(d, 'vm.serial')
    writeFileSync(serial, 'Provider error: old pre-existing failure\n')
    const emitted: string[] = []
    const vm: WatchedVm = { projectId: 'p1', vmId: 'vm1', serialLog: serial }
    const w = new SerialWatcher(1 << 20, 60_000, (l) => emitted.push(l), () => [vm])

    w.scanOnce() // establishes offset at EOF
    expect(emitted).toEqual([])
  })

  test('emits newly-appended matches with syslog level + project/vm fields', () => {
    const d = tmp()
    const serial = join(d, 'vm.serial')
    writeFileSync(serial, '')
    const emitted: string[] = []
    const vm: WatchedVm = { projectId: 'proj-abc', vmId: 'fcvm-9', serialLog: serial }
    const w = new SerialWatcher(1 << 20, 60_000, (l) => emitted.push(l), () => [vm])

    w.scanOnce() // offset -> 0 (empty)
    const before = metrics.getCounter(M.guestTlsClockSkew)
    writeFileSync(
      serial,
      'GET /health 200\nError: certificate is not yet valid\n[entrypoint] noise\n',
    )
    w.scanOnce()

    expect(emitted.length).toBe(1)
    expect(emitted[0]).toContain('<3>[guest-error]')
    expect(emitted[0]).toContain('category=tls_clock_skew')
    expect(emitted[0]).toContain('project=proj-abc')
    expect(emitted[0]).toContain('vm=fcvm-9')
    expect(metrics.getCounter(M.guestTlsClockSkew)).toBe(before + 1)
  })

  test('counts every match but throttles emits per category, surfacing suppressed=', () => {
    const d = tmp()
    const serial = join(d, 'vm.serial')
    writeFileSync(serial, '')
    const emitted: string[] = []
    const vm: WatchedVm = { projectId: 'p', vmId: 'v', serialLog: serial }
    let clock = 1_000_000
    const w = new SerialWatcher(1 << 20, 10_000, (l) => emitted.push(l), () => [vm], () => clock)

    w.scanOnce() // offset -> 0
    const before = metrics.getCounter(M.guestConnectionError)

    // Three matches inside the throttle window -> 1 emit, 3 counted.
    writeFileSync(serial, 'Connection error\nConnection error\nConnection error\n')
    w.scanOnce()
    expect(emitted.length).toBe(1)
    expect(metrics.getCounter(M.guestConnectionError)).toBe(before + 3)

    // Advance past the throttle window; the next match emits and reports the
    // count suppressed in the meantime.
    clock += 10_001
    writeFileSync(serial, 'Connection error\nConnection error\nConnection error\nConnection error\n', { flag: 'a' })
    w.scanOnce()
    expect(emitted.length).toBe(2)
    expect(emitted[1]).toContain('suppressed=2')
    expect(metrics.getCounter(M.guestConnectionError)).toBe(before + 7)
  })

  test('resets and re-reads from the top when a serial file is truncated', () => {
    const d = tmp()
    const serial = join(d, 'vm.serial')
    writeFileSync(serial, 'x'.repeat(500) + '\n')
    const emitted: string[] = []
    const vm: WatchedVm = { projectId: 'p', vmId: 'v', serialLog: serial }
    const w = new SerialWatcher(1 << 20, 60_000, (l) => emitted.push(l), () => [vm])

    w.scanOnce() // offset at ~501
    writeFileSync(serial, 'Provider error: after truncate\n') // now smaller than offset
    w.scanOnce()

    expect(emitted.length).toBe(1)
    expect(emitted[0]).toContain('category=provider_error')
  })
})
