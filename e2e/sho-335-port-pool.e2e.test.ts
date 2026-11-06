// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-335 — one port pool for every allocator in the API process, end to end.
 *
 * The API's `RuntimeManager` (Vite / remote-forward port, plus `+1000`/`+1001`
 * for the agent and its API server) and the `WorkerRuntimeManager` it embeds (a
 * 16-port block per agent runtime) used to keep separate reservation sets over
 * the same 37100–37900 range, and the worker probed occupancy with an HTTP
 * HEAD. The result was intermittent `EADDRINUSE` crash-loops in `E2E (phone)`:
 * api handed 37566 to Vite while the worker picked the block containing it, and
 * a listener that was up but slow to answer read as free.
 *
 * The unit tests pin the probe's semantics and the shared pool with a stubbed
 * probe. This spec is the real thing: the real `RuntimeManager`, its real
 * embedded `WorkerRuntimeManager`, the real `PortPool` with its real TCP probe,
 * real `net` listeners inside the range, and real concurrent allocations. It
 * fails on `main` for the root cause (api's Vite port is not reserved where the
 * worker can see it, and the HTTP probe misses a silent listener).
 *
 * Run:
 *   SHOGO_LOCAL_MODE=true DATABASE_URL=file:./shogo.db \
 *     bun test e2e/sho-335-port-pool.e2e.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createServer, type Server, type Socket } from 'node:net'

// The manager's constructor kicks off an orphan sweep over the runtime port
// range (`lsof`/`ps`). Harmless here, but it would race the listeners this
// spec binds on purpose, and a slow scan would make the run timing-dependent.
process.env.SHOGO_SKIP_STALE_RUNTIME_CLEANUP = '1'

const { RuntimeManager } = await import('../apps/api/src/lib/runtime/manager')
const { DEFAULT_PORT_RANGE_END, DEFAULT_PORT_RANGE_START, PortPool } = await import(
  '@shogo-ai/worker/port-pool'
)

const RUNTIME_PORT_BLOCK = 16
/** The three ports api reserves per project: Vite, agent, agent's API server. */
const API_AGENT_OFFSET = 1000

interface ManagerInternals {
  ports: InstanceType<typeof PortPool>
  allocatePortAsync: () => Promise<number>
  releasePort: (port: number) => void
  agentManager: {
    allocatePort: () => Promise<number>
    releasePort: (port: number) => void
  }
}

const sockets: Socket[] = []
const servers: Server[] = []
const logs: string[] = []
const originalLog = console.log

function internals(manager: InstanceType<typeof RuntimeManager>): ManagerInternals {
  return manager as unknown as ManagerInternals
}

/** Bind a listener that accepts connections and never writes a byte. */
async function silentListener(port: number): Promise<Server | null> {
  const server = createServer((socket) => {
    sockets.push(socket)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => resolve())
    })
  } catch {
    return null
  }
  servers.push(server)
  return server
}

async function bindSomewhere(port: number): Promise<boolean> {
  return (await silentListener(port)) !== null
}

const manager = new RuntimeManager({ domainSuffix: 'apps.example' })

beforeAll(() => {
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
    originalLog(...args)
  }
})

afterAll(() => {
  console.log = originalLog
})

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const server of servers.splice(0)) server.close()
})

function interval(port: number, size: number): Set<number> {
  const ports = new Set<number>()
  for (let offset = 0; offset < size; offset++) ports.add(port + offset)
  return ports
}

describe('SHO-335 api + embedded worker share one real port pool', () => {
  test('neither allocator returns a port a real listener already holds', async () => {
    const rm = internals(manager)
    const bound: number[] = []
    for (let candidate = 37600; candidate < 37600 + 40 && bound.length < 4; candidate++) {
      if (await bindSomewhere(candidate)) bound.push(candidate)
    }
    expect(bound.length).toBe(4)

    const apiPorts = await Promise.all(Array.from({ length: 12 }, () => rm.allocatePortAsync()))
    const agentPorts = await Promise.all(Array.from({ length: 12 }, () => rm.agentManager.allocatePort()))

    for (const port of apiPorts) {
      for (const held of bound) {
        expect(port).not.toBe(held)
        expect(port + API_AGENT_OFFSET).not.toBe(held)
        expect(port + API_AGENT_OFFSET + 1).not.toBe(held)
      }
    }
    for (const port of agentPorts) {
      // Only the two eagerly-bound ports are probed (see allocatePort); those
      // are the ones that must never have been handed to the agent runtime.
      for (const held of bound) {
        expect(port).not.toBe(held)
        expect(port + 1).not.toBe(held)
      }
      expect(rm.ports.isReserved(port)).toBe(true)
    }

    for (const port of apiPorts) rm.releasePort(port)
    for (const port of agentPorts) rm.agentManager.releasePort(port)
  }, 60_000)

  test('a concurrent burst never double-allocates, in either direction', async () => {
    const rm = internals(manager)

    // A desktop with a handful of warm projects: this is where the two
    // allocators used to collide, not a 25-runtime stress test (the random
    // block search runs out of attempts long before 25 blocks at ~50% density).
    const apiPorts = await Promise.all(Array.from({ length: 10 }, () => rm.allocatePortAsync()))
    const agentPorts = await Promise.all(Array.from({ length: 10 }, () => rm.agentManager.allocatePort()))

    // One Vite port per project, never repeated.
    expect(new Set(apiPorts).size).toBe(apiPorts.length)
    // Blocks never overlap each other.
    const blocks = agentPorts.map((port) => interval(port, RUNTIME_PORT_BLOCK))
    for (let i = 0; i < blocks.length; i++) {
      for (let j = i + 1; j < blocks.length; j++) {
        for (const port of blocks[i]) expect(blocks[j].has(port)).toBe(false)
      }
    }

    // ...and no agent block contains any of api's three ports for any project,
    // nor api's Vite port any agent port. This is the EADDRINUSE crash-loop.
    for (const block of blocks) {
      for (const port of apiPorts) {
        expect(block.has(port)).toBe(false)
        expect(block.has(port + API_AGENT_OFFSET)).toBe(false)
        expect(block.has(port + API_AGENT_OFFSET + 1)).toBe(false)
      }
      expect(block.size).toBe(RUNTIME_PORT_BLOCK)
    }
    for (const port of apiPorts) {
      for (const agentPort of agentPorts) expect(port).not.toBe(agentPort)
    }

    // Both allocators left their own reservation behind, so a send-back is safe.
    for (const port of apiPorts) {
      expect(rm.ports.isReserved(port)).toBe(true)
      expect(rm.ports.isReserved(port + API_AGENT_OFFSET)).toBe(true)
      expect(rm.ports.isReserved(port + API_AGENT_OFFSET + 1)).toBe(true)
    }

    // Release everything: the pool is empty again, for both allocators.
    for (const port of apiPorts) rm.releasePort(port)
    for (const port of agentPorts) rm.agentManager.releasePort(port)
    expect(rm.ports.reserved.size).toBe(0)

    // The next EADDRINUSE must be attributable from the log alone (AC3).
    expect(logs.some((line) => line.includes('[RuntimeManager] Allocated ports '))).toBe(true)
    expect(logs.some((line) => line.includes('[WorkerRuntimeManager] Allocated agent block '))).toBe(true)
  }, 60_000)

  test('a port api released can come back as an agent block, and vice versa', async () => {
    const rm = internals(manager)

    const vitePort = await rm.allocatePortAsync()
    rm.releasePort(vitePort)
    expect(rm.ports.isReserved(vitePort)).toBe(false)

    const agentPort = await rm.agentManager.allocatePort()
    rm.agentManager.releasePort(agentPort)
    expect(rm.ports.isReserved(agentPort)).toBe(false)
    for (let offset = 0; offset < RUNTIME_PORT_BLOCK; offset++) {
      expect(rm.ports.isReserved(agentPort + offset)).toBe(false)
    }

    // Every released port is really bindable again — the reservation set is the
    // only thing that stopped a reallocation, not a leaked socket.
    expect(await bindSomewhere(vitePort)).toBe(true)
    expect(vitePort).toBeGreaterThanOrEqual(DEFAULT_PORT_RANGE_START)
    expect(agentPort).toBeLessThanOrEqual(DEFAULT_PORT_RANGE_END - RUNTIME_PORT_BLOCK + 1)
  }, 30_000)
})
