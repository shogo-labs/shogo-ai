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
