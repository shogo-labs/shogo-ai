// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'

import { createSSHConnection, getSharedControlPath, type SSHProcessRunner } from '../connection'

interface SpawnCall {
  command: string
  args: string[]
  stdin: string
}

type Reply = number | { exitCode: number | null; stdout?: string; stderr?: string } | 'hang'

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly signals: string[] = []
  stdin: Writable | null = null

  kill(signal = 'SIGTERM'): boolean {
    this.signals.push(signal)
    if (signal === 'SIGKILL') this.emit('close', null)
    return true
  }
}

function makeRunner(reply: (args: string[]) => Reply = () => 0) {
  const calls: SpawnCall[] = []
  const children: FakeChild[] = []
  const runner: SSHProcessRunner = (command, args, options) => {
    const child = new FakeChild()
    const call: SpawnCall = { command, args: [...args], stdin: '' }
    calls.push(call)
    children.push(child)
    const stdio = options.stdio as string[] | undefined
    const answer = reply(call.args)
    const respond = () => {
      if (answer === 'hang') return
      const result = typeof answer === 'number' ? { exitCode: answer } : answer
      if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout))
      if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr))
      child.emit('close', result.exitCode)
    }
    if (stdio?.[0] === 'pipe') {
      child.stdin = new Writable({
        write(chunk, _encoding, callback) {
          call.stdin += chunk.toString()
          callback()
        },
        final(callback) {
          callback()
          queueMicrotask(respond)
        },
      })
    } else {
      queueMicrotask(respond)
    }
    return child as unknown as ChildProcess
  }
  return { calls, children, runner }
}

let socketCounter = 0
function configFor(extra: Record<string, unknown> = {}) {
  socketCounter += 1
  return {
    host: 'example.com',
    username: 'alice',
    port: 2222,
    controlPath: join(tmpdir(), `shogo-remote-ssh-test-${process.pid}-${socketCounter}.sock`),
    ...extra,
  }
}

const isCheck = (args: string[]) => args.includes('-O') && args.includes('check')

describe('remote SSH helpers', () => {
  test('uses one stable ControlMaster path per target and port', () => {
    expect(getSharedControlPath({ host: 'example.com', username: 'alice', port: 2222 }))
      .toBe(getSharedControlPath({ host: 'example.com', username: 'alice', port: 2222 }))
    expect(getSharedControlPath({ host: 'example.com', username: 'alice', port: 2222 }))
      .not.toBe(getSharedControlPath({ host: 'example.com', username: 'alice', port: 2223 }))
  })
})

describe('SSHConnection', () => {
  test('reuses a live master and executes a remote command as one ssh argument', async () => {
    const { calls, runner } = makeRunner()
    const connection = createSSHConnection(configFor(), { processRunner: runner })

    const result = await connection.exec('printf "not a local shell command"')

    expect(result).toEqual({ stdout: '', stderr: '', exitCode: 0 })
    expect(calls).toHaveLength(2)
    expect(isCheck(calls[0].args)).toBe(true)
    expect(calls[1].command).toBe('ssh')
    expect(calls[1].args.slice(-3)).toEqual([
      '--',
      'alice@example.com',
      'printf "not a local shell command"',
    ])
    await connection.close()
  })

  test('starts a master with keepalives when none is running', async () => {
    let checks = 0
    const { calls, runner } = makeRunner((args) => (isCheck(args) ? (checks++ === 0 ? 255 : 0) : 0))
    const connection = createSSHConnection(configFor(), { processRunner: runner })

    await connection.connect()

    const master = calls.find((call) => call.args.includes('-M'))
    expect(master?.args).toEqual(expect.arrayContaining(['-N', '-f']))
    expect(master?.args).toContain('ServerAliveInterval=15')
    expect(master?.args).toContain('ServerAliveCountMax=3')
    await connection.close()
  })

  test('reports connect failures with ssh stderr', async () => {
    const { runner } = makeRunner((args) =>
      args.includes('-M')
        ? { exitCode: 255, stderr: 'Permission denied (publickey).\n' }
        : 255,
    )
    const connection = createSSHConnection(configFor(), { processRunner: runner })

    await expect(connection.connect()).rejects.toThrow('connect failed: Permission denied (publickey).')
  })

  test('streams uploads over stdin to a quoted remote path instead of scp', async () => {
    const { calls, runner } = makeRunner()
    const connection = createSSHConnection(configFor(), { processRunner: runner })
    const dir = mkdtempSync(join(tmpdir(), 'shogo-upload-test-'))
    const localFile = join(dir, 'local file')
    writeFileSync(localFile, 'artifact bytes')

    await connection.upload(localFile, "/srv/it's safe")

    expect(calls.every((call) => call.command === 'ssh')).toBe(true)
    const upload = calls[calls.length - 1]
    expect(upload.args[upload.args.length - 1]).toBe("umask 077 && cat > '/srv/it'\\''s safe'")
    expect(upload.stdin).toBe('artifact bytes')
    await connection.close()
  })

  test('passes stdin input without placing it in argv', async () => {
    const { calls, runner } = makeRunner()
    const connection = createSSHConnection(configFor(), { processRunner: runner })

    await connection.exec('cat >/dev/null', { input: 'SECRET=value' })

    const call = calls[calls.length - 1]
    expect(call.stdin).toBe('SECRET=value')
    expect(call.args.join(' ')).not.toContain('SECRET')
    await connection.close()
  })

  test('times out a hung command and kills the ssh process', async () => {
    const { children, runner } = makeRunner((args) => (args.includes('sleep 100') ? 'hang' : 0))
    const connection = createSSHConnection(configFor(), { processRunner: runner })

    const result = await connection.exec('sleep 100', { timeoutMs: 20 })

    expect(result.exitCode).toBeNull()
    expect(result.stderr).toContain('timed out after 20ms')
    expect(children[children.length - 1].signals).toContain('SIGTERM')
    await connection.close()
  })

  test('keeps askpass usable when batch mode is disabled', async () => {
    const { calls, runner } = makeRunner()
    const connection = createSSHConnection(
      configFor({ batchMode: false, env: { SHOGO_TEST_ASKPASS: '1' } }),
      { processRunner: runner },
    )

    await connection.exec('true')

    expect(calls[1]?.args).toContain('BatchMode=no')
    await connection.close()
  })

  test('opens and cancels forwards, binding reverse forwards to loopback', async () => {
    const { calls, runner } = makeRunner()
    const connection = createSSHConnection(configFor(), { processRunner: runner })

    const local = await connection.forward(8123, '127.0.0.1:3000')
    const reverse = await connection.reverseForward(9000, 4000)

    expect(local.direction).toBe('local')
    expect(local.spec).toBe('8123:127.0.0.1:3000')
    expect(reverse.direction).toBe('reverse')
    expect(reverse.spec).toBe('9000:127.0.0.1:4000')
    expect(calls.filter((call) => call.args.includes('forward'))).toHaveLength(2)

    await local.close()
    await reverse.close()
    expect(calls.filter((call) => call.args.includes('cancel'))).toHaveLength(2)
    await connection.close()
  })

  test('does not close a shared master while another connection owns it', async () => {
    const config = configFor()
    const { calls, runner } = makeRunner()
    const first = createSSHConnection(config, { processRunner: runner })
    const second = createSSHConnection(config, { processRunner: runner })

    await first.connect()
    await second.connect()
    await first.close()
    expect(calls.filter((call) => call.args.includes('exit'))).toHaveLength(0)

    await second.close()
    expect(calls.filter((call) => call.args.includes('exit'))).toHaveLength(1)
  })

  test('a dead master resets the connection so the next call reconnects', async () => {
    let masterAlive = true
    const { calls, runner } = makeRunner((args) => {
      if (isCheck(args)) return masterAlive ? 0 : 255
      if (args.includes('-M')) {
        masterAlive = true
        return 0
      }
      return 0
    })
    const connection = createSSHConnection(configFor(), { processRunner: runner })
    await connection.forward(8123, '127.0.0.1:3000')

    masterAlive = false
    const status = await connection.status()
    expect(status.connected).toBe(false)
    expect(status.state).toBe('disconnected')

    await connection.exec('true')
    expect(calls.some((call) => call.args.includes('-M'))).toBe(true)

    // The forward died with the old master, so close() must not cancel it.
    const cancelsBefore = calls.filter((call) => call.args.includes('cancel')).length
    await connection.close()
    expect(calls.filter((call) => call.args.includes('cancel')).length).toBe(cancelsBefore)
  })
})

type ForwardBehavior = 'ready' | 'silent' | { exitCode: number; stderr: string }

/**
 * Runner for `multiplex: false`: plain ssh invocations exit 0, while the
 * long-lived `-N` forward children stay up until killed or told to exit.
 */
function makeSupervisedRunner(forward: (args: string[]) => ForwardBehavior = () => 'ready') {
  const calls: SpawnCall[] = []
  const forwardChildren: FakeChild[] = []
  const runner: SSHProcessRunner = (command, args) => {
    const child = new FakeChild()
    calls.push({ command, args: [...args], stdin: '' })
    if (args.includes('-N')) {
      forwardChildren.push(child)
      child.kill = (signal = 'SIGTERM') => {
        child.signals.push(signal)
        queueMicrotask(() => child.emit('close', null))
        return true
      }
      const behavior = forward(args)
      queueMicrotask(() => {
        if (behavior === 'silent') return
        if (behavior === 'ready') {
          const marker = args.includes('-R')
            ? 'debug1: remote forward success for: listen 9000, connect 127.0.0.1:4000\n'
            : 'debug1: Local forwarding listening on 127.0.0.1 port 8123.\n'
          child.stderr.emit('data', Buffer.from(`debug1: Authenticated to host.\n${marker}`))
          return
        }
        child.stderr.emit('data', Buffer.from(behavior.stderr))
        child.emit('close', behavior.exitCode)
      })
    } else {
      queueMicrotask(() => child.emit('close', 0))
    }
    return child as unknown as ChildProcess
  }
  return { calls, forwardChildren, runner }
}

const noMux = (extra: Record<string, unknown> = {}) => configFor({ multiplex: false, ...extra })

describe('SSHConnection without multiplexing (Windows)', () => {
  test('multiplexing defaults on except for win32', () => {
    const connection = createSSHConnection(configFor(), { processRunner: makeRunner().runner })
    expect(connection.multiplex).toBe(process.platform !== 'win32')
  })

  test('disables ControlMaster explicitly and never uses control commands', async () => {
    const { calls, runner } = makeSupervisedRunner()
    const connection = createSSHConnection(noMux(), { processRunner: runner })

    await connection.exec('echo hi')

    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.args).toContain('ControlMaster=no')
      expect(call.args).toContain('ControlPath=none')
      expect(call.args.some((arg) => arg.startsWith('ControlPersist'))).toBe(false)
      expect(call.args).not.toContain('-M')
      expect(call.args).not.toContain('-O')
    }
    await connection.close()
  })

  test('connect verifies credentials with a single `true` probe', async () => {
    const { calls, runner } = makeSupervisedRunner()
    const connection = createSSHConnection(noMux(), { processRunner: runner })

    await connection.connect()
    await connection.connect()

    expect(calls).toHaveLength(1)
    expect(calls[0].args.slice(-3)).toEqual(['--', 'alice@example.com', 'true'])
    await connection.close()
  })

  test('reports connect failures with ssh stderr', async () => {
    const { runner } = makeRunner(() => ({ exitCode: 255, stderr: 'Permission denied (publickey).\n' }))
    const connection = createSSHConnection(noMux(), { processRunner: runner })

    await expect(connection.connect()).rejects.toThrow('connect failed: Permission denied (publickey).')
  })

  test('exec runs one ssh process per command after the connect probe', async () => {
    const { calls, runner } = makeSupervisedRunner()
    const connection = createSSHConnection(noMux(), { processRunner: runner })

    await connection.exec('first')
    await connection.exec('second')

    expect(calls).toHaveLength(3)
    expect(calls[1].args[calls[1].args.length - 1]).toBe('first')
    expect(calls[2].args[calls[2].args.length - 1]).toBe('second')
    await connection.close()
  })

  test('opens supervised -L and -R children and resolves on their readiness lines', async () => {
    const { calls, forwardChildren, runner } = makeSupervisedRunner()
    const connection = createSSHConnection(noMux(), { processRunner: runner })

    const local = await connection.forward(8123, '127.0.0.1:3000')
    const reverse = await connection.reverseForward(9000, 4000)

    expect(local.direction).toBe('local')
    expect(local.spec).toBe('8123:127.0.0.1:3000')
    expect(reverse.direction).toBe('reverse')
    expect(reverse.spec).toBe('9000:127.0.0.1:4000')
    expect(forwardChildren).toHaveLength(2)

    const [localCall, reverseCall] = calls.filter((call) => call.args.includes('-N'))
    expect(localCall.args).toEqual(expect.arrayContaining(['-v', '-N', 'ExitOnForwardFailure=yes']))
    expect(localCall.args).toContain('-L')
    expect(localCall.args).toContain('8123:127.0.0.1:3000')
    expect(reverseCall.args).toContain('-R')
    expect(reverseCall.args).toContain('9000:127.0.0.1:4000')
    expect(calls.some((call) => call.args.includes('-O'))).toBe(false)

    await connection.close()
  })

  test('rejects a forward whose ssh exits before it is established', async () => {
    const { runner } = makeSupervisedRunner(() => ({
      exitCode: 255,
      stderr:
        'debug1: connecting\nbind [127.0.0.1]:8123: Address already in use\n' +
        'Could not request local forwarding.\ndebug1: exit\n',
    }))
    const connection = createSSHConnection(noMux(), { processRunner: runner })

    const failure = await connection.forward(8123, '127.0.0.1:3000').catch((error: Error) => error)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('-L 8123:127.0.0.1:3000 failed')
    expect((failure as Error).message).toContain('Address already in use')
    expect((failure as Error).message).not.toContain('debug1')
    await connection.close()
  })

  test('kills the child of a forward that never reports ready', async () => {
    const { forwardChildren, runner } = makeSupervisedRunner(() => 'silent')
    const connection = createSSHConnection(noMux(), { processRunner: runner })
    await connection.connect()

    const realSetTimeout = globalThis.setTimeout
    // Make the 150s start timeout fire immediately.
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) =>
      realSetTimeout(fn, ms === 150_000 ? 0 : ms, ...rest)) as typeof setTimeout
    try {
      await expect(connection.forward(8123, '127.0.0.1:3000')).rejects.toThrow('not established')
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
    expect(forwardChildren[0].signals).toContain('SIGTERM')
  })

  test('closing a handle kills its child; close() kills the rest', async () => {
    const { forwardChildren, runner } = makeSupervisedRunner()
    const connection = createSSHConnection(noMux(), { processRunner: runner })

    const local = await connection.forward(8123, '127.0.0.1:3000')
    await connection.reverseForward(9000, 4000)

    await local.close()
    await local.close()
    expect(forwardChildren[0].signals).toEqual(['SIGTERM'])
    expect(forwardChildren[1].signals).toEqual([])

    await connection.close()
    expect(forwardChildren[1].signals).toEqual(['SIGTERM'])
    // A deliberate kill is not a dead link.
    expect((await connection.status()).connected).toBe(false)
  })

  test('status needs no probe while forwards are alive and flags a dead forward', async () => {
    const { calls, forwardChildren, runner } = makeSupervisedRunner()
    const connection = createSSHConnection(noMux(), { processRunner: runner })

    expect((await connection.status()).connected).toBe(false)
    expect(calls).toHaveLength(0)

    const local = await connection.forward(8123, '127.0.0.1:3000')
    const spawned = calls.length
    expect(await connection.status()).toMatchObject({ connected: true, state: 'connected' })
    expect(calls).toHaveLength(spawned)

    // The ssh child dies on its own (network drop).
    forwardChildren[0].emit('close', 255)
    const dead = await connection.status()
    expect(dead.connected).toBe(false)
    expect(dead.state).toBe('disconnected')

    // The owner closes the dead handle (as RemoteRuntimeManager.recover does)
    // and the next command reconnects.
    await local.close()
    expect((await connection.status()).connected).toBe(false)
    await connection.exec('true')
    expect((await connection.status()).connected).toBe(true)
    await connection.close()
  })

  test('re-requesting a forward replaces the previous child', async () => {
    const { forwardChildren, runner } = makeSupervisedRunner()
    const connection = createSSHConnection(noMux(), { processRunner: runner })

    await connection.forward(8123, '127.0.0.1:3000')
    await connection.forward(8123, '127.0.0.1:3000')

    expect(forwardChildren).toHaveLength(2)
    expect(forwardChildren[0].signals).toContain('SIGTERM')
    expect(forwardChildren[1].signals).toEqual([])
    await connection.close()
  })
})
