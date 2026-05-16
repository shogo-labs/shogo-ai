// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const execCalls: string[] = []
let execPlan: Array<string | Error> = []

mock.module('child_process', () => ({
  execSync: (cmd: string) => {
    execCalls.push(cmd)
    const next = execPlan.shift()
    if (next instanceof Error) throw next
    return next ?? ''
  },
  // Newer code paths reachable from RuntimeManager (e.g. via
  // services/git.service.ts) reference execFile/execFileSync/exec. Bun's
  // `mock.module` replaces the *entire* module shape with whatever we
  // return here, so if these names aren't present the static import in
  // the consumer fails with `Export named 'execFile' not found in module
  // 'node:child_process'`. Stub them as no-op so the import resolves;
  // the actual ports test doesn't exercise these paths.
  execFile: () => {},
  execFileSync: () => '',
  exec: () => {},
  spawn: mock(() => ({
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: () => {},
    kill: () => true,
    killed: false,
    exitCode: null,
  })),
}))

const { RuntimeManager } = await import('../lib/runtime/manager')

const originalFetch = globalThis.fetch
const originalRandom = Math.random
const originalSetTimeout = globalThis.setTimeout

beforeEach(() => {
  execCalls.length = 0
  execPlan = []
  globalThis.fetch = originalFetch
  Math.random = originalRandom
  globalThis.setTimeout = originalSetTimeout
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Math.random = originalRandom
  globalThis.setTimeout = originalSetTimeout
})

function managerPrivate() {
  return new RuntimeManager({ domainSuffix: 'apps.example' }) as unknown as {
    isPortInUse: (port: number) => Promise<boolean>
    killProcessOnPort: (port: number) => Promise<boolean>
    isPortListening: (port: number) => Promise<boolean>
    allocatePortAsync: () => Promise<number>
    releasePort: (port: number) => void
    buildUrl: (projectId: string, port: number) => string
    usedPorts: Set<number>
  }
}

describe('RuntimeManager private port helpers', () => {
  test('isPortInUse returns true for any HTTP response and false for fetch failures', async () => {
    const rm = managerPrivate()
    globalThis.fetch = (async () => new Response('', { status: 500 })) as typeof fetch
    await expect(rm.isPortInUse(37123)).resolves.toBe(true)

    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch
    await expect(rm.isPortInUse(37123)).resolves.toBe(false)
  })

  test('isPortListening ignores self and parent pids, accepts other numeric listeners, and swallows exec errors', async () => {
    const rm = managerPrivate()
    execPlan = [`${process.pid}\n${process.ppid}\nabc\n43210\n`]
    await expect(rm.isPortListening(37123)).resolves.toBe(true)

    execPlan = [`${process.pid}\n${process.ppid}\n`]
    await expect(rm.isPortListening(37123)).resolves.toBe(false)

    execPlan = [new Error('lsof failed')]
    await expect(rm.isPortListening(37123)).resolves.toBe(false)
  })

  test('killProcessOnPort returns true when no external pid holds the port', async () => {
    const rm = managerPrivate()
    execPlan = [`${process.pid}\n${process.ppid}\n`]

    await expect(rm.killProcessOnPort(37123)).resolves.toBe(true)
    expect(execCalls.some((cmd) => cmd.includes('kill'))).toBe(false)
  })

  test('killProcessOnPort sends SIGTERM first and succeeds once the port is free', async () => {
    const rm = managerPrivate()
    globalThis.setTimeout = ((cb: (...args: any[]) => void) => {
      cb()
      return 0 as any
    }) as typeof setTimeout
    ;(rm as any).isPortListening = mock(async () => false)
    // The pid-discovery exec returns a single line containing "43210". On
    // Windows that's the trailing column of a netstat -ano LISTENING row,
    // on POSIX it's the bare lsof -t output. Both shapes parse to PID
    // 43210 in the implementation.
    const isWindows = process.platform === 'win32'
    execPlan = isWindows
      ? ['  TCP    127.0.0.1:37123        0.0.0.0:0              LISTENING       43210\n', '', '']
      : ['43210\n', '', '']

    await expect(rm.killProcessOnPort(37123)).resolves.toBe(true)
    if (isWindows) {
      // Windows path: taskkill /F goes straight to a hard kill — there's
      // no SIGTERM-equivalent on win32, so killProcessOnPort skips the
      // graceful step and only emits one taskkill.
      expect(execCalls.some((cmd) => cmd.includes('taskkill /F /PID 43210'))).toBe(true)
      expect(execCalls.some((cmd) => cmd.startsWith('kill '))).toBe(false)
    } else {
      expect(execCalls).toContain('kill -15 43210 2>/dev/null || true')
    }
  })

  test('allocatePortAsync skips used ports, checks companion ports, and releases allocated ports', async () => {
    const rm = managerPrivate()
    const randomValues = [0, 0.01]
    Math.random = () => randomValues.shift() ?? 0.01
    rm.usedPorts.add(37100)
    const checked: number[] = []
    ;(rm as any).isPortListening = mock(async (port: number) => {
      checked.push(port)
      return false
    })

    const port = await rm.allocatePortAsync()

    expect(port).toBe(37108)
    expect(checked).toEqual([37108, 38108, 38109])
    expect(rm.usedPorts.has(37108)).toBe(true)
    rm.releasePort(37108)
    expect(rm.usedPorts.has(37108)).toBe(false)
  })

  test('allocatePortAsync throws after repeated busy candidates', async () => {
    const rm = managerPrivate()
    Math.random = () => 0
    ;(rm as any).isPortListening = mock(async () => true)

    await expect(rm.allocatePortAsync()).rejects.toThrow(/Cannot allocate port after/)
  })

  test('buildUrl uses localhost ports or project subdomains based on config', () => {
    const remote = managerPrivate()
    expect(remote.buildUrl('proj-1', 37123)).toBe('http://proj-1.apps.example')

    const local = new RuntimeManager({ domainSuffix: 'localhost' }) as any
    expect(local.buildUrl('proj-1', 37123)).toBe('http://localhost:37123')
  })
})
