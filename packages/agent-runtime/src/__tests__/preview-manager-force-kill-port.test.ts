// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Regression for the Windows runtime-exit log spam that surfaced as:
//
//   [api] [runtime:…] [preview-manager] API server exited (code=null, signal=SIGTERM)
//   [api] [runtime:…] The system cannot find the path specified.
//   [api] [runtime:…] The system cannot find the path specified.
//   [api] [runtime:…] 'true' is not recognized as an internal or external command,
//   [api] [runtime:…] operable program or batch file.
//
// Root cause: `PreviewManager.forceKillPort` shelled out via `execSync` with a
// POSIX one-liner (`lsof -ti :PORT 2>/dev/null || fuser PORT/tcp 2>/dev/null
// || true`). On Windows that runs through `cmd.exe`, which doesn't understand
// `2>/dev/null` (path redirection) or `|| true` (`true` is a POSIX builtin,
// not a Win32 binary). Every API-server restart — custom-routes save, schema
// change, crash recovery — sprayed the four lines above into the runtime log.
//
// These tests pin the platform branching: on win32 we must use `netstat` /
// `taskkill` and never fall through to the POSIX one-liner, regardless of
// whether the platform path errors out.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'

const execCalls: string[] = []
let execPlan: Array<string | Error> = []

mock.module('child_process', () => ({
  spawn: () => ({
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: () => {},
    kill: () => true,
    killed: false,
    exitCode: null,
    pid: 9999,
  }),
  execSync: (cmd: string) => {
    execCalls.push(cmd)
    const next = execPlan.shift()
    if (next instanceof Error) throw next
    return next ?? ''
  },
}))

const { PreviewManager, parseListeningInodesForPort } = await import('../preview-manager')

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

beforeAll(() => {
  // Capture the real platform once so afterAll can put it back deterministically.
})

afterAll(() => {
  setPlatform(originalPlatform)
})

beforeEach(() => {
  execCalls.length = 0
  execPlan = []
})

afterEach(() => {
  setPlatform(originalPlatform)
})

function callForceKillPort(port: number): Promise<void> {
  const pm = new PreviewManager({ workspaceDir: '/tmp/forceKillPort-fixture', runtimePort: 8080 }) as unknown as {
    apiPort: number
    forceKillPort: () => Promise<void>
  }
  pm.apiPort = port
  return pm.forceKillPort()
}

describe('PreviewManager.forceKillPort platform branching', () => {
  test('on POSIX: shells out to lsof/fuser', async () => {
    setPlatform('linux')
    execPlan = ['12345\n']

    await callForceKillPort(37123)

    expect(execCalls.length).toBe(1)
    expect(execCalls[0]).toContain('lsof -ti :37123')
    expect(execCalls[0]).toContain('fuser 37123/tcp')
    expect(execCalls[0]).toContain('|| true')
  })

  test('on win32: never invokes the POSIX one-liner — must use netstat/taskkill', async () => {
    setPlatform('win32')
    // findstr exits 1 when nothing matches — modeled as a thrown error so the
    // function takes the early-return branch and we don't accidentally try to
    // taskkill a phantom PID.
    execPlan = [new Error('findstr: no match')]

    await callForceKillPort(37123)

    // The exact failure mode we're regressing against:
    expect(execCalls.some((c) => c.includes('lsof'))).toBe(false)
    expect(execCalls.some((c) => c.includes('fuser'))).toBe(false)
    expect(execCalls.some((c) => c.includes('2>/dev/null'))).toBe(false)
    expect(execCalls.some((c) => c.includes('|| true'))).toBe(false)
    // And we must reach for the Windows tooling instead.
    expect(execCalls.length).toBe(1)
    expect(execCalls[0]).toContain('netstat -ano')
    expect(execCalls[0]).toContain('findstr :37123')
    expect(execCalls[0]).toContain('LISTENING')
  })

  test('on win32 with a listening PID: invokes taskkill /F /PID, never kill', async () => {
    setPlatform('win32')
    // Realistic netstat output line shape; trailing token is the PID.
    execPlan = [
      '  TCP    127.0.0.1:37123        0.0.0.0:0              LISTENING       54321\r\n',
      '', // taskkill returns nothing on success
    ]

    await callForceKillPort(37123)

    expect(execCalls.length).toBe(2)
    expect(execCalls[0]).toContain('netstat -ano')
    expect(execCalls[1]).toBe('taskkill /F /PID 54321')
    expect(execCalls.some((c) => c.startsWith('kill '))).toBe(false)
  })

  test('on win32: skips PID 0 (system idle), self pid, and parent pid', async () => {
    setPlatform('win32')
    const lines = [
      `  TCP    127.0.0.1:37123        0.0.0.0:0              LISTENING       0`,
      `  TCP    127.0.0.1:37123        0.0.0.0:0              LISTENING       ${process.pid}`,
      `  TCP    127.0.0.1:37123        0.0.0.0:0              LISTENING       ${process.ppid}`,
      `  TCP    127.0.0.1:37123        0.0.0.0:0              LISTENING       77777`,
    ].join('\r\n')
    execPlan = [lines, '']

    await callForceKillPort(37123)

    const taskkills = execCalls.filter((c) => c.startsWith('taskkill'))
    expect(taskkills).toEqual(['taskkill /F /PID 77777'])
  })
})

// The /proc fallback is what makes forceKillPort actually work on the slim
// production runtime image (no lsof, no fuser). These pin the pure parser that
// resolves the LISTEN socket inode(s) for a port from a /proc/net/tcp table.
describe('parseListeningInodesForPort (/proc/net/tcp parser)', () => {
  // Port 3001 == 0x0BB9; state 0A == TCP_LISTEN; inode is column index 9.
  const header =
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'

  test('extracts the inode of a LISTEN socket on the requested port', () => {
    const table = [
      header,
      '   0: 0100007F:0BB9 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 987654 1 0000 100 0 0 10 0',
    ].join('\n')
    expect([...parseListeningInodesForPort(table, 3001)]).toEqual(['987654'])
  })

  test('ignores rows in a non-LISTEN state even when the port matches', () => {
    const table = [
      header,
      // st 01 == ESTABLISHED — a client connection to :3001, not a listener.
      '   0: 0100007F:0BB9 0100007F:C001 01 00000000:00000000 00:00000000 00000000  1000        0 111111 1 0000 100 0 0 10 0',
    ].join('\n')
    expect([...parseListeningInodesForPort(table, 3001)]).toEqual([])
  })

  test('ignores LISTEN sockets on a different port', () => {
    const table = [
      header,
      // 0x1F90 == 8080
      '   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222222 1 0000 100 0 0 10 0',
    ].join('\n')
    expect([...parseListeningInodesForPort(table, 3001)]).toEqual([])
  })

  test('matches a wildcard (0.0.0.0) bind and skips a zero inode', () => {
    const table = [
      header,
      // wildcard bind on :3001, LISTEN, but inode 0 (kernel-internal) — skipped
      '   0: 00000000:0BB9 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 0 1 0000 100 0 0 10 0',
      // real listener on :3001
      '   1: 00000000:0BB9 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 333333 1 0000 100 0 0 10 0',
    ].join('\n')
    expect([...parseListeningInodesForPort(table, 3001)]).toEqual(['333333'])
  })

  test('tolerates blank lines and the header without throwing', () => {
    const table = ['', header, '', ''].join('\n')
    expect([...parseListeningInodesForPort(table, 3001)]).toEqual([])
  })
})
