// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  RemoteRuntimeManager,
  buildEnvScript,
  type RemoteRuntimeConnection,
  type RemoteRuntimeOptions,
} from './remote-runtime'
import type { RemoteCommandResult, RemoteExecOptions } from './shell'
import type { SSHForwardHandle } from './connection'

const ok = (stdout = ''): RemoteCommandResult => ({ stdout, stderr: '', exitCode: 0 })

class FakeConnection implements RemoteRuntimeConnection {
  readonly commands: Array<{ command: string; input?: string }> = []
  readonly forwards: Array<{ direction: string; spec: string; closed: boolean }> = []
  pidfile = ''
  /** Result of the remote `is_ours` identity check. */
  ours = true
  statusCalls = 0
  nextPid = 4242

  async exec(command: string, options: RemoteExecOptions = {}): Promise<RemoteCommandResult> {
    this.commands.push({
      command,
      input: typeof options.input === 'string' ? options.input : undefined,
    })
    if (command.includes('if test -s "$pidfile"')) return ok(this.pidfile)
    if (command.endsWith('\nis_ours')) return { stdout: '', stderr: '', exitCode: this.ours ? 0 : 1 }
    if (command.includes('env_script=$(cat)')) return ok(`${this.nextPid++}\n`)
    return ok()
  }

  async upload(): Promise<void> {}

  async status(): Promise<{ connected: boolean }> {
    this.statusCalls++
    return { connected: true }
  }

  async forward(localPort: number, remoteHostPort: string): Promise<SSHForwardHandle> {
    return this.makeForward('local', `${localPort}:${remoteHostPort}`)
  }

  async reverseForward(remotePort: number, localPort: number): Promise<SSHForwardHandle> {
    return this.makeForward('reverse', `${remotePort}:127.0.0.1:${localPort}`)
  }

  launches() {
    return this.commands.filter((entry) => entry.command.includes('env_script=$(cat)'))
  }

  kills() {
    return this.commands.filter((entry) => entry.command.includes('is_ours || exit 0'))
  }

  private makeForward(direction: string, spec: string): SSHForwardHandle {
    const entry = { direction, spec, closed: false }
    this.forwards.push(entry)
    return {
      direction: direction as 'local' | 'reverse',
      spec,
      close: async () => {
        entry.closed = true
      },
    }
  }
}

const healthy = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch

function pidfile(pid: number, metadata: Record<string, unknown>): string {
  return [String(pid), JSON.stringify(metadata)].join('\n')
}

function manager(connection: FakeConnection, options: Partial<RemoteRuntimeOptions> = {}) {
  return new RemoteRuntimeManager({
    connection,
    workspaceKey: 'workspace-1',
    remoteProjectDir: '/srv/workspace',
    localApiPort: 8002,
    localAgentPort: 51234,
    remoteAgentPort: 41234,
    runtimeBinaryPath: '/opt/shogo/agent-runtime',
    env: { RUNTIME_AUTH_SECRET: 'secret' },
    fetch: healthy,
    healthPollMs: 5,
    idleMs: 0,
    ...options,
  })
}

describe('RemoteRuntimeManager', () => {
  test('sends the environment on stdin and forwards to the API gateway on loopback', async () => {
    const connection = new FakeConnection()
    const runtime = manager(connection, {
      env: {
        RUNTIME_AUTH_SECRET: 'super-secret',
        WORKSPACE_DIR: '/old/workspace',
        SHOGO_API_URL: 'https://api.example.test',
        AI_PROXY_URL: 'https://api.example.test/api/ai/v1',
      },
    })

    const started = await runtime.start()
    expect(started.status).toBe('running')
    expect(started.agentPort).toBe(51234)
    expect(started.remoteAgentPort).toBe(41234)
    expect(started.remoteApiPort).toBe(41235)

    const [launch] = connection.launches()
    expect(launch.command).not.toContain('super-secret')
    expect(launch.command).toContain('.shogo-server/run/workspace-1')
    expect(launch.input).toContain("export RUNTIME_AUTH_SECRET='super-secret'")
    expect(launch.input).toContain("export WORKSPACE_DIR='/srv/workspace'")
    expect(launch.input).toContain("export SHOGO_API_URL='http://127.0.0.1:41235'")
    expect(launch.input).toContain("export AI_PROXY_URL='http://127.0.0.1:41235/api/ai/v1'")
    expect(launch.input).toContain("export WORKSPACE_API_PORT_BASE='41236'")
    expect(launch.input).toContain("export HOST='127.0.0.1'")
    expect(connection.forwards.map((forward) => forward.spec)).toEqual([
      '51234:127.0.0.1:41234',
      '41235:127.0.0.1:8002',
    ])

    await runtime.stop()
    expect(connection.forwards.every((forward) => forward.closed)).toBe(true)
    expect(connection.kills()).toHaveLength(1)
    expect(runtime.status().status).toBe('stopped')
  })

  test('refuses to launch without RUNTIME_AUTH_SECRET', async () => {
    const connection = new FakeConnection()
    const runtime = manager(connection, { env: {} })

    await expect(runtime.start()).rejects.toThrow('RUNTIME_AUTH_SECRET is required')
    expect(connection.launches()).toHaveLength(0)
    expect(runtime.status().status).toBe('error')
  })

  test('reattaches only after identity and version verification', async () => {
    const connection = new FakeConnection()
    connection.pidfile = pidfile(9876, {
      agentPort: 41234,
      apiPort: 41235,
      workspaceKey: 'workspace-1',
      binaryPath: '~/.shogo-server/1.2.3/agent-runtime',
      version: '1.2.3',
      startedAt: 123,
    })
    let bootstrapCalls = 0
    const runtime = manager(connection, {
      runtimeBinaryPath: undefined,
      runtimeVersion: '1.2.3',
      bootstrap: async () => {
        bootstrapCalls++
        return { binaryPath: '~/.shogo-server/1.2.3/agent-runtime' }
      },
    })

    const status = await runtime.start()
    expect(status.reattached).toBe(true)
    expect(status.pid).toBe(9876)
    expect(status.startedAt).toBe(123)
    expect(connection.launches()).toHaveLength(0)
    expect(bootstrapCalls).toBe(0)
    expect(connection.commands.some((entry) => entry.command.endsWith('\nis_ours'))).toBe(true)
  })

  test('replaces a runtime from an older version instead of reattaching', async () => {
    const connection = new FakeConnection()
    connection.pidfile = pidfile(9876, {
      agentPort: 41234,
      apiPort: 41235,
      workspaceKey: 'workspace-1',
      binaryPath: '~/.shogo-server/1.2.2/agent-runtime',
      version: '1.2.2',
    })
    const runtime = manager(connection, {
      runtimeBinaryPath: undefined,
      runtimeVersion: '1.2.3',
      bootstrap: async (_connection, options) => ({
        binaryPath: `~/.shogo-server/${options.version}/agent-runtime`,
        version: options.version,
      }),
    })

    const status = await runtime.start()
    expect(status.reattached).toBe(false)
    expect(status.pid).toBe(4242)
    expect(connection.kills()).toHaveLength(1)
    expect(connection.kills()[0].command).toContain('pid=9876')
    expect(connection.launches()[0].command).toContain('"version":"1.2.3"')
  })

  test('never signals a recorded PID that is no longer our runtime', async () => {
    const connection = new FakeConnection()
    connection.ours = false
    connection.pidfile = pidfile(9876, {
      agentPort: 41234,
      apiPort: 41235,
      workspaceKey: 'workspace-1',
      binaryPath: '/opt/shogo/agent-runtime',
    })
    const runtime = manager(connection)

    const status = await runtime.start()
    expect(status.reattached).toBe(false)
    expect(connection.kills()).toHaveLength(0)
    expect(connection.launches()).toHaveLength(1)
  })

  test('gives concurrent runtimes on one host non-overlapping port slots', async () => {
    const connection = new FakeConnection()
    const excludes: number[][] = []
    const portAllocator: RemoteRuntimeOptions['portAllocator'] = async (_connection, options) => {
      excludes.push([...options.exclude])
      let base = options.start
      while (options.exclude.includes(base)) base += options.slotSize
      return base
    }
    const first = manager(connection, { remoteAgentPort: undefined, portAllocator })
    const second = manager(connection, {
      workspaceKey: 'workspace-2',
      remoteAgentPort: undefined,
      localAgentPort: 51235,
      portAllocator,
    })

    const [a, b] = await Promise.all([first.start(), second.start()])
    expect(a.remoteAgentPort).toBe(37_100)
    expect(b.remoteAgentPort).toBe(37_120)
    expect(excludes[1]).toContain(37_100)

    await first.stop()
    const third = manager(connection, {
      workspaceKey: 'workspace-3',
      remoteAgentPort: undefined,
      localAgentPort: 51236,
      portAllocator,
    })
    expect((await third.start()).remoteAgentPort).toBe(37_100)
  })

  test('reconnects and reattaches after repeated health failures', async () => {
    const connection = new FakeConnection()
    let up = true
    const runtime = manager(connection, {
      recoveryThreshold: 2,
      fetch: (async () => new Response('', { status: up ? 200 : 503 })) as unknown as typeof fetch,
    })
    await runtime.start()
    connection.pidfile = pidfile(4242, {
      agentPort: 41234,
      apiPort: 41235,
      workspaceKey: 'workspace-1',
      binaryPath: '/opt/shogo/agent-runtime',
    })

    up = false
    await runtime.getHealth()
    expect(runtime.status().status).toBe('running')
    await runtime.getHealth()
    up = true

    for (let i = 0; i < 100 && !runtime.status().reattached; i++) await Bun.sleep(5)
    const status = runtime.status()
    expect(status.status).toBe('running')
    expect(status.reattached).toBe(true)
    expect(status.agentPort).toBe(51234)
    expect(connection.statusCalls).toBe(1)
    expect(connection.launches()).toHaveLength(1)
    expect(connection.forwards.filter((forward) => !forward.closed)).toHaveLength(2)
  })

  test('rejects invalid environment variable names', () => {
    expect(() => buildEnvScript({ 'BAD NAME': 'x' })).toThrow('Invalid remote environment')
    expect(buildEnvScript({ A: "it's" })).toBe("export A='it'\\''s'")
  })
})
