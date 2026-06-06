// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * sandbox-exec.ts — coverage closer for the async API + secret-purge + buffer.
 *
 *   bun test packages/agent-runtime/src/__tests__/sandbox-exec-extra.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'
import { EventEmitter } from 'events'

type SpawnCall = { cmd: string; args: any; opts: any; child: FakeChild }
const spawnCalls: SpawnCall[] = []
const execSyncCalls: Array<{ cmd: string; opts: any }> = []
let execSyncImpl: (cmd: string, opts: any) => string = () => ''

class FakeStream extends EventEmitter {
  encoding: BufferEncoding | undefined
  setEncoding(enc: BufferEncoding) { this.encoding = enc; return this }
}

class FakeChild extends EventEmitter {
  pid = 4242
  stdout = new FakeStream()
  stderr = new FakeStream()
  killSignal: NodeJS.Signals | undefined
  killThrows = false
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.killSignal = signal
    if (this.killThrows) throw new Error('already gone')
    return true
  }
  emitExit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.emit('exit', code, signal)
  }
  emitError(err: Error) {
    this.emit('error', err)
  }
}

mock.module('child_process', () => ({
  spawn: (cmd: string, args: any, opts: any) => {
    const child = new FakeChild()
    spawnCalls.push({ cmd, args, opts, child })
    return child
  },
  execSync: (cmd: string, opts: any) => {
    execSyncCalls.push({ cmd, opts })
    return execSyncImpl(cmd, opts)
  },
}))

const sandbox = await import('../sandbox-exec')

beforeEach(() => {
  spawnCalls.length = 0
  execSyncCalls.length = 0
  execSyncImpl = () => ''
})

afterEach(() => {
  delete process.env.SHOGO_EXEC_HARD_TIMEOUT_MS
})

describe('purgeSecretsFromEnv', () => {
  test('captures + clears known secret keys and pattern-matched keys', () => {
    process.env.OPENAI_API_KEY = 'sk-purge-me'
    process.env.MY_CUSTOM_SECRET_TOKEN = 'pat-keep'
    process.env.HARMLESS_VAR = 'visible'
    sandbox.purgeSecretsFromEnv()
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.HARMLESS_VAR).toBe('visible')
    expect(sandbox.getCapturedSecret('OPENAI_API_KEY')).toBe('sk-purge-me')
    expect(sandbox.getCapturedSecret('NEVER_SET')).toBeUndefined()
    delete process.env.HARMLESS_VAR
  })

  test('is a no-op for env vars that were never set', () => {
    delete process.env.STRIPE_SECRET_KEY
    sandbox.purgeSecretsFromEnv()
    expect(sandbox.getCapturedSecret('STRIPE_SECRET_KEY')).toBeUndefined()
  })

  test('keeps non-secret sqlite file: DATABASE_URL but purges a postgres one', () => {
    process.env.DATABASE_URL = 'file:/workspace/prisma/dev.db'
    sandbox.purgeSecretsFromEnv()
    // sqlite file URL is not a credential — the agent needs it for prisma.
    expect(process.env.DATABASE_URL).toBe('file:/workspace/prisma/dev.db')

    process.env.DATABASE_URL = 'postgres://user:pw@host:5432/db'
    sandbox.purgeSecretsFromEnv()
    expect(process.env.DATABASE_URL).toBeUndefined()
    expect(sandbox.getCapturedSecret('DATABASE_URL')).toBe('postgres://user:pw@host:5432/db')
    delete process.env.DATABASE_URL
  })
})

describe('getSanitizedEnv — DATABASE_URL value-awareness', () => {
  afterEach(() => {
    delete process.env.DATABASE_URL
    delete process.env.PROJECTS_DATABASE_URL
  })

  test('lets a sqlite file: DATABASE_URL through to agent commands', () => {
    process.env.DATABASE_URL = 'file:/workspace/prisma/dev.db'
    expect(sandbox.getSanitizedEnv().DATABASE_URL).toBe('file:/workspace/prisma/dev.db')
  })

  test('still redacts a real postgres DATABASE_URL credential', () => {
    process.env.DATABASE_URL = 'postgres://user:pw@host:5432/db'
    expect(sandbox.getSanitizedEnv().DATABASE_URL).toBeUndefined()
  })

  test('redacts non-file PROJECTS_DATABASE_URL but allows file: form', () => {
    process.env.PROJECTS_DATABASE_URL = 'mysql://root@host/app'
    expect(sandbox.getSanitizedEnv().PROJECTS_DATABASE_URL).toBeUndefined()
    process.env.PROJECTS_DATABASE_URL = 'file:./prisma/dev.db'
    expect(sandbox.getSanitizedEnv().PROJECTS_DATABASE_URL).toBe('file:./prisma/dev.db')
  })
})

describe('sandboxExecAsync (non-sandbox)', () => {
  test('spawns a shell child and resolves done on exit code 0', async () => {
    const handle = sandbox.sandboxExecAsync({
      command: 'echo hi',
      workspaceDir: '/tmp/ws',
      sandboxConfig: { enabled: false },
    })
    expect(handle.sandboxed).toBe(false)
    expect(handle.pid).toBe(4242)
    expect(typeof handle.startedAt).toBe('number')
    expect(handle.exited()).toBe(false)
    const call = spawnCalls.at(-1)!
    call.child.stdout.emit('data', 'hello\n')
    call.child.stderr.emit('data', 'warn\n')
    call.child.emitExit(0)
    const result = await handle.done
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hello')
    expect(result.stderr).toContain('warn')
    expect(result.killed).toBe(false)
    expect(result.timedOut).toBe(false)
    expect(handle.exited()).toBe(true)
    expect(handle.stdout()).toContain('hello')
    expect(handle.stderr()).toContain('warn')
  })

  test('child error event is surfaced into stderr buffer', async () => {
    const handle = sandbox.sandboxExecAsync({
      command: 'bogus-bin',
      workspaceDir: '/tmp/ws',
      sandboxConfig: { enabled: false },
    })
    const call = spawnCalls.at(-1)!
    call.child.emitError(new Error('ENOENT bogus-bin'))
    call.child.emitExit(127)
    const result = await handle.done
    expect(result.stderr).toContain('spawn error: ENOENT bogus-bin')
    expect(result.exitCode).toBe(127)
  })

  test('exit by signal computes 128 + signalNumber', async () => {
    const handle = sandbox.sandboxExecAsync({
      command: 'sleep 9',
      workspaceDir: '/tmp/ws',
      sandboxConfig: { enabled: false },
    })
    const call = spawnCalls.at(-1)!
    call.child.emitExit(null, 'SIGKILL')
    const result = await handle.done
    expect(result.exitCode).toBe(128 + 9)
  })

  test('exit by unknown signal falls back to 128 + 0', async () => {
    const handle = sandbox.sandboxExecAsync({
      command: 'sleep 9',
      workspaceDir: '/tmp/ws',
      sandboxConfig: { enabled: false },
    })
    const call = spawnCalls.at(-1)!
    call.child.emitExit(null, 'SIGCONT' as NodeJS.Signals)
    const result = await handle.done
    expect(result.exitCode).toBe(128)
  })
})

describe('sandboxExecAsync kill paths', () => {
  test('kill(SIGTERM) graceful: child.kill called with SIGTERM', async () => {
    const handle = sandbox.sandboxExecAsync({
      command: 'sleep 99',
      workspaceDir: '/tmp/ws',
      sandboxConfig: { enabled: false },
    })
    const call = spawnCalls.at(-1)!
    handle.kill('SIGTERM')
    expect(call.child.killSignal).toBe('SIGTERM')
    call.child.emitExit(143, null)
    const r = await handle.done
    expect(r.killed).toBe(true)
    expect(r.exitCode).toBe(143)
  })

  test('kill(SIGKILL) on sandboxed run also invokes docker kill', async () => {
    const handle = sandbox.sandboxExecAsync({
      command: 'true',
      workspaceDir: '/tmp/ws',
      sandboxConfig: { enabled: true, mode: 'all', image: 'busybox:latest', memoryLimit: '256m', cpuLimit: '0.5', networkEnabled: false },
    })
    expect(handle.sandboxed).toBe(true)
    expect(handle.containerName).toMatch(/^shogo-exec-/)
    const call = spawnCalls.at(-1)!
    expect(call.cmd).toBe('docker')
    expect(call.args).toContain('--rm')
    expect(call.args).toContain('--network')
    handle.kill('SIGKILL')
    expect(call.child.killSignal).toBe('SIGKILL')
    expect(execSyncCalls.length).toBe(1)
    expect(execSyncCalls[0]!.cmd).toContain('docker kill')
    call.child.emitExit(137)
    await handle.done
  })

  test('kill(SIGKILL) tolerates child.kill throwing and execSync throwing', async () => {
    execSyncImpl = () => { throw new Error('container gone') }
    const handle = sandbox.sandboxExecAsync({
      command: 'true',
      workspaceDir: '/tmp/ws',
      sandboxConfig: { enabled: true, mode: 'all', image: 'busybox:latest', memoryLimit: '256m', cpuLimit: '0.5', networkEnabled: true },
    })
    const call = spawnCalls.at(-1)!
    call.child.killThrows = true
    handle.kill('SIGKILL')
    expect(execSyncCalls.length).toBe(1)
    call.child.emitExit(137)
    const r = await handle.done
    expect(r.killed).toBe(true)
  })

  test('hard timeout auto-SIGKILLs and marks timedOut', async () => {
    process.env.SHOGO_EXEC_HARD_TIMEOUT_MS = '20'
    const handle = sandbox.sandboxExecAsync({
      command: 'sleep 99',
      workspaceDir: '/tmp/ws',
      sandboxConfig: { enabled: false },
    })
    const call = spawnCalls.at(-1)!
    await new Promise((r) => setTimeout(r, 60))
    expect(call.child.killSignal).toBe('SIGKILL')
    call.child.emitExit(137)
    const r = await handle.done
    expect(r.timedOut).toBe(true)
    expect(r.killed).toBe(true)
  })

  test('explicit hardTimeoutMs option overrides env', async () => {
    const handle = sandbox.sandboxExecAsync({
      command: 'sleep 99',
      workspaceDir: '/tmp/ws',
      sandboxConfig: { enabled: false },
      hardTimeoutMs: 15,
    })
    const call = spawnCalls.at(-1)!
    await new Promise((r) => setTimeout(r, 50))
    expect(call.child.killSignal).toBe('SIGKILL')
    call.child.emitExit(137)
    await handle.done
  })

  test('SHOGO_EXEC_HARD_TIMEOUT_MS=invalid falls back to default', async () => {
    process.env.SHOGO_EXEC_HARD_TIMEOUT_MS = 'not-a-number'
    const handle = sandbox.sandboxExecAsync({
      command: 'true',
      workspaceDir: '/tmp/ws',
      sandboxConfig: { enabled: false },
    })
    const call = spawnCalls.at(-1)!
    call.child.emitExit(0)
    await handle.done
  })
})

describe('gracefulKill escalation', () => {
  test('kill(SIGTERM) escalates to SIGKILL after 2s if not exited', async () => {
    const handle = sandbox.sandboxExecAsync({
      command: 'sleep 99',
      workspaceDir: '/tmp/ws',
      sandboxConfig: { enabled: false },
    })
    const call = spawnCalls.at(-1)!
    handle.kill('SIGTERM')
    expect(call.child.killSignal).toBe('SIGTERM')
    await new Promise((r) => setTimeout(r, 2100))
    expect(call.child.killSignal).toBe('SIGKILL')
    call.child.emitExit(137)
    const r = await handle.done
    expect(r.killed).toBe(true)
  }, 5000)
})

describe('BoundedBuffer overflow path', () => {
  test('emits dropped-bytes marker once head+tail are full', async () => {
    const handle = sandbox.sandboxExecAsync({
      command: 'echo big',
      workspaceDir: '/tmp/ws',
      sandboxConfig: { enabled: false },
    })
    const call = spawnCalls.at(-1)!
    call.child.stdout.emit('data', 'A'.repeat(40 * 1024))
    call.child.stdout.emit('data', 'B'.repeat(30 * 1024))
    call.child.stdout.emit('data', 'C'.repeat(30 * 1024))
    call.child.stdout.emit('data', '')
    call.child.emitExit(0)
    const r = await handle.done
    expect(r.stdout).toContain('bytes dropped from middle')
    expect(r.stdout.startsWith('A')).toBe(true)
    expect(r.stdout.endsWith('C')).toBe(true)
  })

  test('toString returns head+tail directly when nothing dropped', async () => {
    const handle = sandbox.sandboxExecAsync({
      command: 'echo small',
      workspaceDir: '/tmp/ws',
      sandboxConfig: { enabled: false },
    })
    const call = spawnCalls.at(-1)!
    call.child.stdout.emit('data', 'tiny')
    call.child.emitExit(0)
    const r = await handle.done
    expect(r.stdout).toBe('tiny')
  })

  test('first chunk that fits entirely in head returns early', async () => {
    const handle = sandbox.sandboxExecAsync({
      command: 'echo small',
      workspaceDir: '/tmp/ws',
      sandboxConfig: { enabled: false },
    })
    const call = spawnCalls.at(-1)!
    call.child.stdout.emit('data', 'x'.repeat(100))
    call.child.stdout.emit('data', 'y'.repeat(50))
    call.child.emitExit(0)
    const r = await handle.done
    expect(r.stdout).toContain('x')
    expect(r.stdout).toContain('y')
  })
})

describe('sandboxExecAsync docker arg assembly', () => {
  test('network: true omits --network none', async () => {
    const handle = sandbox.sandboxExecAsync({
      command: 'ls',
      workspaceDir: '/tmp/ws',
      sandboxConfig: { enabled: true, mode: 'all', image: 'alpine:3.19', memoryLimit: '128m', cpuLimit: '0.25', networkEnabled: true },
    })
    const call = spawnCalls.at(-1)!
    expect(call.cmd).toBe('docker')
    const args = call.args as string[]
    const idx = args.indexOf('--network')
    if (idx >= 0) expect(args[idx + 1]).not.toBe('none')
    expect(args).toContain('alpine:3.19')
    call.child.emitExit(0)
    await handle.done
  })
})
