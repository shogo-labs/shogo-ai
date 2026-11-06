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
  // Async form used by the process-table scans and Windows kills. It must call
  // back, or the awaited scan hangs the test (SHO-185 moved these off execSync).
  exec: (cmd: string, optsOrCb: any, maybeCb?: any) => {
    execCalls.push(cmd)
    const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb
    const next = execPlan.shift()
    if (next instanceof Error) cb(next, '', '')
    else cb(null, String(next ?? ''), '')
  },
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
const { PortPool, probeTcpPort } = await import('@shogo-ai/worker/port-pool')

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
    ports: InstanceType<typeof PortPool>
    agentManager: { allocatePort: () => Promise<number>; releasePort: (port: number) => void }
  }
}

/** Take over the manager's own pool so the probes/candidates are deterministic. */
function stubPool(
  rm: ReturnType<typeof managerPrivate>,
  probe: (port: number) => Promise<'free' | 'in-use'>,
  random: () => number,
) {
  ;(rm.ports as any).probe = probe
  ;(rm.ports as any).random = random
}

describe('RuntimeManager private port helpers', () => {
  test('isPortListening probes the port directly, with no subprocess', async () => {
    // It used to shell out to `lsof` three times per attempt, up to 50 attempts,
    // on the runtime start path — which froze the local API's event loop and made
    // the desktop supervisor kill it mid-tunnel-request (SHO-185).
    const rm = managerPrivate()

    const server = Bun.serve({ port: 0, fetch: () => new Response('ok') })
    const port = server.port!
    try {
      await expect(rm.isPortListening(port)).resolves.toBe(true)
    } finally {
      server.stop(true)
    }

    // Nothing is listening on the port we just released.
    await expect(rm.isPortListening(port)).resolves.toBe(false)
  })

  test('allocatePortAsync skips used ports, checks companion ports, and releases every reserved port', async () => {
    const rm = managerPrivate()
    const randomValues = [0, 0.01]
    rm.usedPorts.add(37100)
    const checked: number[] = []
    stubPool(rm, async (port: number) => {
      checked.push(port)
      return 'free'
    }, () => randomValues.shift() ?? 0.01)

    const port = await rm.allocatePortAsync()

    expect(port).toBe(37108)
    // The Vite port AND the agent / API-server ports it implies are probed...
    expect(checked).toEqual([37108, 38108, 38109])
    // ...and all three are reserved, not just the Vite port: the worker draws
    // agent ports from the same 37100–37900 range (SHO-335).
    expect(rm.usedPorts.has(37108)).toBe(true)
    expect(rm.usedPorts.has(38108)).toBe(true)
    expect(rm.usedPorts.has(38109)).toBe(true)

    rm.releasePort(37108)
    expect(rm.usedPorts.has(37108)).toBe(false)
    expect(rm.usedPorts.has(38108)).toBe(false)
    expect(rm.usedPorts.has(38109)).toBe(false)
  })

  test('allocatePortAsync throws after repeated busy candidates', async () => {
    const rm = managerPrivate()
    stubPool(rm, async () => 'in-use', () => 0)

    await expect(rm.allocatePortAsync()).rejects.toThrow(/Cannot allocate port after/)
  })

  test('a probe that times out counts as in use', async () => {
    // A listener whose accept queue never completes is busy, not free. This is
    // the semantics the shared probe applies for both managers (SHO-335).
    const timedOut = {
      setTimeout: () => timedOut,
      destroy: () => timedOut,
      once(event: string, listener: (...args: any[]) => void) {
        if (event === 'timeout') queueMicrotask(() => listener())
        return timedOut
      },
    }
    await expect(
      probeTcpPort(37123, { connect: (() => timedOut) as any }),
    ).resolves.toBe('in-use')

    // ...and api's own check reports such a port as listening.
    const rm = managerPrivate()
    stubPool(rm, async () => 'in-use', () => 0)
    await expect(rm.isPortListening(37123)).resolves.toBe(true)
  })

  test('api and its embedded worker share one reservation pool', async () => {
    const rm = managerPrivate()
    stubPool(rm, async () => 'free', () => 0)

    // 1. A Vite port api hands out can never come back as part of an agent
    //    block: 37100 → agent 38100, api server 38101.
    const vitePort = await rm.allocatePortAsync()
    expect(vitePort).toBe(37100)

    const forbidden = new Set([vitePort, vitePort + 1000, vitePort + 1001])
    // Real randomness from here on: every block must still dodge those ports.
    ;(rm.ports as any).random = () => Math.random()
    for (let i = 0; i < 40; i++) {
      const block = await rm.agentManager.allocatePort()
      const blockPorts = new Set<number>()
      for (let offset = 0; offset < 16; offset++) blockPorts.add(block + offset)
      for (const port of forbidden) {
        expect(blockPorts.has(port)).toBe(false)
        expect(block).not.toBe(port)
      }
      rm.agentManager.releasePort(block)
    }

    // 2. The reverse: a port inside a live agent block is never handed out as
    //    api's Vite port.
    rm.releasePort(vitePort)
    const agentBlock = await rm.agentManager.allocatePort()
    const outsideBlock = agentBlock > 37110 ? 37100 : agentBlock + 200
    const picks = [(agentBlock - 37100 + 0.5) / 800, (outsideBlock - 37100 + 0.5) / 800]
    ;(rm.ports as any).random = () => picks.shift() ?? (outsideBlock - 37100 + 0.5) / 800
    const next = await rm.allocatePortAsync()
    expect(next).not.toBe(agentBlock)
    expect(next < agentBlock || next > agentBlock + 15).toBe(true)

    // 3. Releasing frees the ports for both.
    rm.releasePort(next)
    expect(rm.usedPorts.has(next)).toBe(false)
    expect(rm.usedPorts.has(next + 1000)).toBe(false)
    rm.agentManager.releasePort(agentBlock)
    expect(rm.usedPorts.has(agentBlock)).toBe(false)
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
