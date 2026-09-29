// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'

import {
  buildScpRemoteDestination,
  createSSHConnection,
  getSharedControlPath,
  quoteRemoteShellArgument,
  type SSHProcessRunner,
} from '../connection'

interface SpawnCall {
  command: string
  args: string[]
}

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()

  kill(): boolean {
    this.emit('close', null)
    return true
  }
}

function makeRunner(exitCode = 0) {
  const calls: SpawnCall[] = []
  const runner: SSHProcessRunner = (command, args) => {
    const child = new FakeChild()
    calls.push({ command, args: [...args] })
    queueMicrotask(() => child.emit('close', exitCode))
    return child as unknown as ChildProcess
  }
  return { calls, runner }
}

const config = {
  host: 'example.com',
  username: 'alice',
  port: 2222,
  controlPath: '/tmp/shogo-remote-ssh-test.sock',
}

describe('remote SSH helpers', () => {
  test('quotes remote shell arguments without invoking a local shell', () => {
    expect(quoteRemoteShellArgument("a path/with 'quotes'")).toBe("'a path/with '\\''quotes'\\'''")
    expect(buildScpRemoteDestination(config, '/srv/app with spaces')).toBe(
      "alice@example.com:'/srv/app with spaces'",
    )
  })

  test('uses one stable ControlMaster path per target and port', () => {
    expect(getSharedControlPath({ host: 'example.com', user: 'alice', port: 2222 }))
      .toBe(getSharedControlPath({ host: 'example.com', user: 'alice', port: 2222 }))
    expect(getSharedControlPath({ host: 'example.com', user: 'alice', port: 2222 }))
      .not.toBe(getSharedControlPath({ host: 'example.com', user: 'alice', port: 2223 }))
  })
})

describe('SSHConnection', () => {
  test('executes a remote command as one ssh argument', async () => {
    const { calls, runner } = makeRunner()
    const connection = createSSHConnection(config, { processRunner: runner })

    const result = await connection.exec('printf "not a local shell command"')

    expect(result.exitCode).toBe(0)
    expect(calls).toHaveLength(2)
    expect(calls[0].command).toBe('ssh')
    expect(calls[0].args.slice(-2)).toEqual(['--', 'alice@example.com'])
    expect(calls[1].args.slice(-2)).toEqual([
      'alice@example.com',
      'printf "not a local shell command"',
    ])
    await connection.close()
  })

  test('uploads with scp argument arrays and a quoted remote path', async () => {
    const { calls, runner } = makeRunner()
    const connection = createSSHConnection(config, { processRunner: runner })

    await connection.upload('/tmp/local file', "/srv/it's safe")

    expect(calls).toHaveLength(2)
    expect(calls[1].command).toBe('scp')
    expect(calls[1].args.slice(-3)).toEqual([
      '--',
      '/tmp/local file',
      "alice@example.com:'/srv/it'\\''s safe'",
    ])
    await connection.close()
  })

  test('keeps scp askpass-compatible when batch mode is disabled', async () => {
    const { calls, runner } = makeRunner()
    const connection = createSSHConnection(
      { ...config, batchMode: false, env: { SHOGO_TEST_ASKPASS: '1' } },
      { processRunner: runner },
    )

    await connection.upload('/tmp/local', '/srv/app')

    expect(calls[1]?.args).not.toContain('-B')
    expect(calls[1]?.args).toContain('BatchMode=no')
    await connection.close()
  })

  test('opens and cancels local and reverse forwards through the master', async () => {
    const { calls, runner } = makeRunner()
    const connection = createSSHConnection(config, { processRunner: runner })

    const local = await connection.forward(8123, '127.0.0.1:3000')
    const reverse = await connection.reverseForward(9000, 4000)

    expect(local.direction).toBe('local')
    expect(local.spec).toBe('8123:127.0.0.1:3000')
    expect(reverse.direction).toBe('reverse')
    expect(reverse.spec).toBe('9000:localhost:4000')
    expect(calls.filter((call) => call.args.includes('forward'))).toHaveLength(2)

    await local.close()
    await reverse.close()
    expect(calls.filter((call) => call.args.includes('cancel'))).toHaveLength(2)
    await connection.close()
  })

  test('does not close a shared master while another connection owns it', async () => {
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

  test('status reports a failed control socket check as disconnected', async () => {
    const { runner } = makeRunner(1)
    const connection = createSSHConnection(config, { processRunner: runner })

    const status = await connection.status()

    expect(status.connected).toBe(false)
    expect(status.state).toBe('disconnected')
  })
})
