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
  // spawnSync added when shogo-worker RuntimeExecutor.executeAsync was
  // introduced — without it static import { spawnSync } fails.
  spawnSync: () => ({ status: 0, stdout: "", stderr: "", error: null }),
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
    isPortListening: (port: number) => Promise<boolean>
    allocatePortAsync: () => Promise<number>
    releasePort: (port: number) => void
    buildUrl: (projectId: string, port: number) => string
    usedPorts: Set<number>
  }
}

describe('RuntimeManager private port helpers', () => {
  test('isPortListening ignores self and parent pids, accepts other numeric listeners, and swallows exec errors', async () => {
    const rm = managerPrivate()
    execPlan = [`${process.pid}\n${process.ppid}\nabc\n43210\n`]
    await expect(rm.isPortListening(37123)).resolves.toBe(true)

    execPlan = [`${process.pid}\n${process.ppid}\n`]
    await expect(rm.isPortListening(37123)).resolves.toBe(false)

    execPlan = [new Error('lsof failed')]
    await expect(rm.isPortListening(37123)).resolves.toBe(false)
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

  test('buildUrl uses 127.0.0.1 loopback for localhost dev, project subdomain otherwise', () => {
    const remote = managerPrivate()
    expect(remote.buildUrl('proj-1', 37123)).toBe('http://proj-1.apps.example')

    // Local dev uses the IPv4 loopback literal `127.0.0.1` rather than the
    // hostname `localhost` to avoid the Windows IPv6-first DNS resolution
    // hanging against Bun.serve's IPv4-only default bind. See the comment
    // on `RuntimeManager.buildUrl` for the full motivation.
    const local = new RuntimeManager({ domainSuffix: 'localhost' }) as any
    expect(local.buildUrl('proj-1', 37123)).toBe('http://127.0.0.1:37123')
  })
})
