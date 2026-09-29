// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import type { RemoteCommandResult } from './bootstrap'
import {
  RemoteRuntimeManager,
  type RemoteRuntimeConnection,
  type RemoteRuntimePorts,
} from './remote-runtime'
import type { SSHForwardHandle } from './connection'

class FakeConnection implements RemoteRuntimeConnection {
  readonly commands: string[] = []
  readonly forwards: Array<{ direction: string; spec: string; closed: boolean }> = []
  pidfile = ''

  async exec(command: string): Promise<RemoteCommandResult> {
    this.commands.push(command)
    if (command.includes('if test -s "$pidfile"')) return { stdout: this.pidfile, exitCode: 0 }
    if (command.startsWith('kill -0')) return { stdout: '', exitCode: 0 }
    if (command.includes('nohup env')) return { stdout: '4242\n', exitCode: 0 }
    return { stdout: '', exitCode: 0 }
  }

  async upload(): Promise<void> {}

  async forward(localPort: number, remoteHostPort: string): Promise<SSHForwardHandle> {
    return this.makeForward('local', `${localPort}:${remoteHostPort}`)
  }

  async reverseForward(remotePort: number, localPort: number): Promise<SSHForwardHandle> {
    return this.makeForward('reverse', `${remotePort}:localhost:${localPort}`)
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

const ports: RemoteRuntimePorts = { agentPort: 41234, apiPort: 41235 }

describe('RemoteRuntimeManager', () => {
  test('launches with rewritten env and closes both forwards on stop', async () => {
    const connection = new FakeConnection()
    const manager = new RemoteRuntimeManager({
      connection,
      workspaceKey: 'workspace-1',
      remoteProjectDir: '/srv/workspace',
      runtimeBinaryPath: '/opt/shogo/agent-runtime',
      remoteAgentPort: ports.agentPort,
      remoteApiPort: ports.apiPort,
      localAgentPort: 51234,
      localApiPort: 8002,
      env: {
        RUNTIME_AUTH_SECRET: 'secret',
        WORKSPACE_DIR: '/old/workspace',
        PROJECT_DIR: '/old/project',
        SHOGO_API_URL: 'https://api.example.test',
        AI_PROXY_URL: 'https://api.example.test/api/ai/v1',
        SHOGO_PUBLIC_API_URL: 'https://public.example.test',
      },
      fetch: (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch,
    })

    const started = await manager.start()
    expect(started.status).toBe('running')
    expect(started.agentPort).toBe(51234)
    expect(started.remoteAgentPort).toBe(ports.agentPort)
    expect(started.remoteApiPort).toBe(ports.apiPort)

    const launch = connection.commands.find((command) => command.includes('nohup env'))
    expect(launch).toContain("'WORKSPACE_DIR=/srv/workspace'")
    expect(launch).toContain("'PROJECT_DIR=/srv/workspace'")
    expect(launch).toContain("'SHOGO_API_URL=http://127.0.0.1:41235'")
    expect(launch).toContain("'AI_PROXY_URL=http://127.0.0.1:41235/api/ai/v1'")
    expect(launch).toContain("'HOST=127.0.0.1'")
    expect(launch).toContain("'RUNTIME_AUTH_SECRET=secret'")
    expect(launch).toContain('.shogo-server/run/workspace-1')
    expect(connection.forwards.map((forward) => forward.spec)).toEqual([
      '51234:127.0.0.1:41234',
      '41235:localhost:8002',
    ])

    await manager.stop()
    expect(connection.forwards.every((forward) => forward.closed)).toBe(true)
    expect(manager.status().status).toBe('stopped')
  })

  test('reattaches only after pidfile and kill -0 verification', async () => {
    const connection = new FakeConnection()
    connection.pidfile = [
      '9876',
      JSON.stringify({
        agentPort: ports.agentPort,
        apiPort: ports.apiPort,
        workspaceKey: 'workspace-2',
        binaryPath: '/opt/shogo/agent-runtime',
        startedAt: 123,
      }),
    ].join('\n')
    const manager = new RemoteRuntimeManager({
      connection,
      workspaceKey: 'workspace-2',
      remoteProjectDir: '/srv/workspace',
      localAgentPort: 51235,
      localApiPort: 8002,
      fetch: (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch,
    })

    const status = await manager.start()
    expect(status.reattached).toBe(true)
    expect(status.pid).toBe(9876)
    expect(connection.commands.some((command) => command.includes('nohup env'))).toBe(false)
    expect(connection.commands.some((command) => command.startsWith('kill -0 9876'))).toBe(true)
  })

  test('uses an injected bootstrapper when no binary is installed', async () => {
    const connection = new FakeConnection()
    let bootstrapCalls = 0
    const manager = new RemoteRuntimeManager({
      connection,
      workspaceKey: 'workspace-3',
      remoteProjectDir: '/srv/workspace',
      runtimeVersion: '1.2.3',
      bootstrap: async (_connection, options) => {
        bootstrapCalls++
        expect(options.version).toBe('1.2.3')
        return { binaryPath: '/opt/shogo/agent-runtime' }
      },
      remoteAgentPort: ports.agentPort,
      remoteApiPort: ports.apiPort,
      localAgentPort: 51236,
      fetch: (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch,
    })

    await manager.start()
    expect(bootstrapCalls).toBe(1)
  })
})
