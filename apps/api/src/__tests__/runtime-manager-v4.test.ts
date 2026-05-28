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
  execFile: () => {},
  execFileSync: () => '',
  exec: () => {},
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

const {
  RuntimeManager,
  createRuntimeManager,
  getRuntimeManager,
  setRuntimeManager,
  __resetRuntimeManagerInternalsForTests,
} = await import('../lib/runtime/manager')

const originalPlatform = process.platform
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

const originalFetch = globalThis.fetch

beforeEach(() => {
  execCalls.length = 0
  execPlan = []
  __resetRuntimeManagerInternalsForTests()
  globalThis.fetch = originalFetch
})

afterEach(() => {
  setPlatform(originalPlatform)
  __resetRuntimeManagerInternalsForTests()
  globalThis.fetch = originalFetch
})

describe('RuntimeManager findStalePidsPosix (private)', () => {
  test('parses lsof PIDs, drops self/parent/init/non-numeric tokens, dedupes', () => {
    setPlatform('linux')
    const rm = new RuntimeManager() as unknown as {
      findStalePidsPosix: (s: number, e: number, sp: string, pp: string) => string[]
    }
    execPlan = [
      `${process.pid}\n9999\n9999\n${process.ppid}\n1\nlsof(blah)\n12345\n`,
    ]
    const pids = rm.findStalePidsPosix(
      37100,
      37900,
      String(process.pid),
      String(process.ppid),
    )
    expect(pids.sort()).toEqual(['12345', '9999'])
    expect(execCalls[execCalls.length - 1]).toContain('lsof -iTCP:37100-37900')
  })

  test('returns empty array when lsof throws', () => {
    setPlatform('linux')
    execPlan = [new Error('lsof not installed')]
    const rm = new RuntimeManager() as unknown as {
      findStalePidsPosix: (s: number, e: number, sp: string, pp: string) => string[]
    }
    expect(rm.findStalePidsPosix(37100, 37900, '1', '1')).toEqual([])
  })

  test('returns empty array when lsof returns empty string', () => {
    setPlatform('linux')
    execPlan = ['']
    const rm = new RuntimeManager() as unknown as {
      findStalePidsPosix: (s: number, e: number, sp: string, pp: string) => string[]
    }
    expect(rm.findStalePidsPosix(37100, 37900, '111', '222')).toEqual([])
  })
})

describe('RuntimeManager findStalePidsWindows (private)', () => {
  test('parses netstat tabular output, filters by port range and PID, dedupes', () => {
    setPlatform('win32')
    const netstat = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    127.0.0.1:37100        0.0.0.0:0              LISTENING       9000',
      '  TCP    [::]:37500             [::]:0                 LISTENING       9001',
      '  TCP    127.0.0.1:37500        0.0.0.0:0              LISTENING       9001',
      '  TCP    127.0.0.1:50000        0.0.0.0:0              LISTENING       1234', // out of range
      '  TCP    127.0.0.1:37200        0.0.0.0:0              LISTENING       0', // pid 0 — drop
      '  TCP    127.0.0.1:37300        0.0.0.0:0              LISTENING       222', // self — drop
      '  TCP    127.0.0.1:37400        0.0.0.0:0              LISTENING       333', // parent — drop
      '  TCP    127.0.0.1:bad          0.0.0.0:0              LISTENING       42', // bad port format
      '  short',
      '  TCP    127.0.0.1:37600        0.0.0.0:0              LISTENING       abc', // non-numeric pid
      '',
    ].join('\n')
    const rm = new RuntimeManager() as unknown as {
      findStalePidsWindows: (s: number, e: number, sp: string, pp: string) => string[]
    }
    execPlan = [netstat]
    const pids = rm.findStalePidsWindows(37100, 37900, '222', '333')
    expect(pids.sort()).toEqual(['9000', '9001'])
    expect(execCalls[execCalls.length - 1]).toContain('netstat -ano')
  })

  test('returns empty when netstat errors (findstr no-match)', () => {
    setPlatform('win32')
    execPlan = [new Error('exit 1')]
    const rm = new RuntimeManager() as unknown as {
      findStalePidsWindows: (s: number, e: number, sp: string, pp: string) => string[]
    }
    expect(rm.findStalePidsWindows(37100, 37900, '1', '2')).toEqual([])
  })
})

describe('RuntimeManager.cleanupStaleProcesses (constructor)', () => {
  test('POSIX: kill -9 every discovered PID, swallowing failures', () => {
    setPlatform('linux')
    // first call = lsof for port range A, second = lsof for port range B
    // then kill -9 for each PID found in range A, then kill -9 for each in B
    execPlan = ['11111\n22222\n', '', '', '', '']
    new RuntimeManager()
    const killCmds = execCalls.filter((c) => c.startsWith('kill -9'))
    expect(killCmds).toContain('kill -9 11111 2>/dev/null || true')
    expect(killCmds).toContain('kill -9 22222 2>/dev/null || true')
  })

  test('Windows: taskkill /F /PID for each discovered PID', () => {
    setPlatform('win32')
    const netstat =
      '  TCP    127.0.0.1:37150        0.0.0.0:0              LISTENING       4444\n' +
      '  TCP    127.0.0.1:37160        0.0.0.0:0              LISTENING       5555\n'
    execPlan = [netstat, '']
    new RuntimeManager()
    const taskkill = execCalls.filter((c) => c.startsWith('taskkill'))
    expect(taskkill).toEqual(expect.arrayContaining(['taskkill /F /PID 4444', 'taskkill /F /PID 5555']))
  })

  test('kill failure is swallowed (process already exited)', () => {
    setPlatform('linux')
    execPlan = ['12345\n', new Error('No such process'), '']
    expect(() => new RuntimeManager()).not.toThrow()
  })

  test('cleanupStaleProcesses runs only ONCE per process (module guard)', () => {
    setPlatform('linux')
    execPlan = ['11111\n', '', '']
    new RuntimeManager()
    const callsAfterFirst = execCalls.length
    new RuntimeManager()
    expect(execCalls.length).toBe(callsAfterFirst) // guard prevents re-entry
  })
})

describe('createRuntimeManager / getRuntimeManager / setRuntimeManager', () => {
  test('createRuntimeManager applies env vars with overrides taking precedence', () => {
    setPlatform('linux')
    const prevMax = process.env.RUNTIME_MAX_COUNT
    const prevInt = process.env.RUNTIME_HEALTH_INTERVAL
    const prevSuf = process.env.RUNTIME_DOMAIN_SUFFIX
    const prevWS = process.env.WORKSPACES_DIR
    process.env.RUNTIME_MAX_COUNT = '42'
    process.env.RUNTIME_HEALTH_INTERVAL = '7777'
    process.env.RUNTIME_DOMAIN_SUFFIX = 'example.test'
    process.env.WORKSPACES_DIR = '/custom/ws'
    try {
      const rm = createRuntimeManager() as unknown as { config: { maxRuntimes: number; healthCheckInterval: number; domainSuffix: string; workspacesDir: string } }
      expect(rm.config.maxRuntimes).toBe(42)
      expect(rm.config.healthCheckInterval).toBe(7777)
      expect(rm.config.domainSuffix).toBe('example.test')
      expect(rm.config.workspacesDir).toBe('/custom/ws')

      const rm2 = createRuntimeManager({ maxRuntimes: 99 }) as unknown as { config: { maxRuntimes: number } }
      expect(rm2.config.maxRuntimes).toBe(99)
    } finally {
      process.env.RUNTIME_MAX_COUNT = prevMax
      process.env.RUNTIME_HEALTH_INTERVAL = prevInt
      process.env.RUNTIME_DOMAIN_SUFFIX = prevSuf
      process.env.WORKSPACES_DIR = prevWS
    }
  })

  test('createRuntimeManager defaults when env vars unset', () => {
    setPlatform('linux')
    const prevMax = process.env.RUNTIME_MAX_COUNT
    const prevInt = process.env.RUNTIME_HEALTH_INTERVAL
    const prevSuf = process.env.RUNTIME_DOMAIN_SUFFIX
    const prevWS = process.env.WORKSPACES_DIR
    delete process.env.RUNTIME_MAX_COUNT
    delete process.env.RUNTIME_HEALTH_INTERVAL
    delete process.env.RUNTIME_DOMAIN_SUFFIX
    delete process.env.WORKSPACES_DIR
    try {
      const rm = createRuntimeManager() as unknown as { config: { maxRuntimes: number; healthCheckInterval: number; domainSuffix: string; workspacesDir: string } }
      expect(rm.config.maxRuntimes).toBe(10)
      expect(rm.config.healthCheckInterval).toBe(30000)
      expect(rm.config.domainSuffix).toBe('localhost')
      expect(rm.config.workspacesDir).toContain('workspaces')
    } finally {
      process.env.RUNTIME_MAX_COUNT = prevMax
      process.env.RUNTIME_HEALTH_INTERVAL = prevInt
      process.env.RUNTIME_DOMAIN_SUFFIX = prevSuf
      process.env.WORKSPACES_DIR = prevWS
    }
  })

  test('getRuntimeManager returns the same singleton on subsequent calls', () => {
    setPlatform('linux')
    const a = getRuntimeManager()
    const b = getRuntimeManager()
    expect(a).toBe(b)
  })

  test('setRuntimeManager installs an externally-constructed instance as the singleton', () => {
    setPlatform('linux')
    const external = new RuntimeManager()
    setRuntimeManager(external)
    expect(getRuntimeManager()).toBe(external)
  })
})

describe('RuntimeManager.touch (uncov edge cases)', () => {
  test('no-op for empty projectId', () => {
    setPlatform('linux')
    const rm = new RuntimeManager()
    expect(() => rm.touch('')).not.toThrow()
  })

  test('no-op for sentinel "api-key" projectId', () => {
    setPlatform('linux')
    const rm = new RuntimeManager()
    expect(() => rm.touch('api-key')).not.toThrow()
  })

  test('swallows agentManager.touch errors', () => {
    setPlatform('linux')
    const rm = new RuntimeManager() as unknown as { agentManager: { touch: (id: string) => void } }
    rm.agentManager.touch = () => {
      throw new Error('boom')
    }
    expect(() => (rm as unknown as { touch: (id: string) => void }).touch('proj-1')).not.toThrow()
  })

  test('forwards to agentManager.touch on the happy path', () => {
    setPlatform('linux')
    const rm = new RuntimeManager() as unknown as { agentManager: { touch: (id: string) => void } }
    const calls: string[] = []
    rm.agentManager.touch = (id: string) => calls.push(id)
    ;(rm as unknown as { touch: (id: string) => void }).touch('proj-1')
    expect(calls).toEqual(['proj-1'])
  })
})

describe('RuntimeManager.restart (uncov branches)', () => {
  test('restart with no existing runtime calls start directly', async () => {
    setPlatform('linux')
    const rm = new RuntimeManager() as unknown as {
      runtimes: Map<string, unknown>
      start: (id: string) => Promise<unknown>
      restart: (id: string) => Promise<unknown>
    }
    let started = false
    rm.start = async (id: string) => {
      started = true
      return { id, port: 1, status: 'running' as const, url: '', startedAt: new Date(), agentPort: undefined, agentProcess: null, process: null }
    }
    const result = await rm.restart('newproj')
    expect(started).toBe(true)
    expect(result).toBeTruthy()
  })

  test('restart with a stopped runtime skips stop and calls start', async () => {
    setPlatform('linux')
    const rm = new RuntimeManager() as unknown as {
      runtimes: Map<string, { status: string }>
      stop: (id: string) => Promise<void>
      start: (id: string) => Promise<unknown>
      restart: (id: string) => Promise<unknown>
    }
    rm.runtimes.set('p', { status: 'stopped' })
    let stopCalled = false
    rm.stop = async () => {
      stopCalled = true
    }
    rm.start = async () => ({})
    await rm.restart('p')
    expect(stopCalled).toBe(false)
  })

  test('restart with a running runtime stops then starts', async () => {
    setPlatform('linux')
    const rm = new RuntimeManager() as unknown as {
      runtimes: Map<string, { status: string }>
      stop: (id: string) => Promise<void>
      start: (id: string) => Promise<unknown>
      restart: (id: string) => Promise<unknown>
    }
    rm.runtimes.set('p', { status: 'running' })
    const order: string[] = []
    rm.stop = async () => {
      order.push('stop')
    }
    rm.start = async () => {
      order.push('start')
      return {}
    }
    await rm.restart('p')
    expect(order).toEqual(['stop', 'start'])
  })
})

describe('RuntimeManager.stopAll (error swallowing)', () => {
  test('stops every runtime even when one stop rejects', async () => {
    setPlatform('linux')
    const rm = new RuntimeManager() as unknown as {
      runtimes: Map<string, unknown>
      stop: (id: string) => Promise<void>
      stopAll: () => Promise<void>
    }
    rm.runtimes.set('a', {})
    rm.runtimes.set('b', {})
    rm.runtimes.set('c', {})
    const stopped: string[] = []
    rm.stop = async (id: string) => {
      stopped.push(id)
      if (id === 'b') throw new Error('boom')
    }
    await rm.stopAll()
    expect(stopped.sort()).toEqual(['a', 'b', 'c'])
  })

  test('stopAll is a no-op when no runtimes exist', async () => {
    setPlatform('linux')
    const rm = new RuntimeManager()
    await expect(rm.stopAll()).resolves.toBeUndefined()
  })
})

describe('RuntimeManager.status / getActiveProjects edge cases', () => {
  test('status returns null for unknown projectId', () => {
    setPlatform('linux')
    const rm = new RuntimeManager()
    expect(rm.status('nope')).toBeNull()
  })

  test('getActiveProjects only returns running/starting', () => {
    setPlatform('linux')
    const rm = new RuntimeManager() as unknown as {
      runtimes: Map<string, { status: string; id: string }>
      getActiveProjects: () => string[]
    }
    rm.runtimes.set('a', { status: 'running', id: 'a' })
    rm.runtimes.set('b', { status: 'starting', id: 'b' })
    rm.runtimes.set('c', { status: 'stopped', id: 'c' })
    rm.runtimes.set('d', { status: 'error', id: 'd' })
    expect(rm.getActiveProjects().sort()).toEqual(['a', 'b'])
  })
})

describe('RuntimeManager.getHealth (uncov branches)', () => {
  test('returns missing when no runtime', async () => {
    setPlatform('linux')
    const rm = new RuntimeManager()
    const h = await rm.getHealth('nope')
    expect(h.healthy).toBe(false)
    expect(h.error).toContain('No runtime found')
  })

  test('records error when fetch rejects', async () => {
    setPlatform('linux')
    const rm = new RuntimeManager() as unknown as {
      runtimes: Map<string, unknown>
      getHealth: (id: string) => Promise<{ healthy: boolean; error?: string }>
    }
    rm.runtimes.set('p', {
      id: 'p',
      port: 37123,
      agentPort: 38123,
      status: 'running',
      url: 'http://localhost:37123',
      startedAt: new Date(),
      process: { killed: false, exitCode: null },
      agentProcess: null,
      lastHealthCheck: undefined,
    })
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as typeof fetch
    const h = await rm.getHealth('p')
    expect(h.healthy).toBe(false)
    expect(h.error).toBe('network down')
  })

  test('falls back to /health on agentPort when vite process is dead', async () => {
    setPlatform('linux')
    const rm = new RuntimeManager() as unknown as {
      runtimes: Map<string, unknown>
      getHealth: (id: string) => Promise<{ healthy: boolean }>
    }
    rm.runtimes.set('p', {
      id: 'p',
      port: 37123,
      agentPort: 38123,
      status: 'running',
      url: 'http://localhost:37123',
      startedAt: new Date(),
      process: { killed: true, exitCode: 1 },
      agentProcess: null,
      lastHealthCheck: undefined,
    })
    let urlSeen = ''
    let methodSeen = ''
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      urlSeen = String(input)
      methodSeen = init?.method ?? ''
      return new Response('ok', { status: 200 })
    }) as typeof fetch
    const h = await rm.getHealth('p')
    expect(h.healthy).toBe(true)
    expect(urlSeen).toBe('http://localhost:38123/health')
    expect(methodSeen).toBe('GET')
  })
})

describe('__resetRuntimeManagerInternalsForTests', () => {
  test('clears module-scope singleton AND re-arms cleanup guard', () => {
    setPlatform('linux')
    execPlan = ['', '']
    const first = getRuntimeManager()
    expect(first).toBeTruthy()

    const callsBefore = execCalls.length
    __resetRuntimeManagerInternalsForTests()

    // After reset, getRuntimeManager() returns a NEW instance and the
    // new constructor re-runs cleanupStaleProcesses (which re-executes
    // execSync calls), proving the guard was re-armed.
    execPlan = ['', '']
    const second = getRuntimeManager()
    expect(second).not.toBe(first)
    expect(execCalls.length).toBeGreaterThan(callsBefore)
  })
})
