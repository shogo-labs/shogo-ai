// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

const hosts = new Map<string, any>([
  ['host-1', {
    id: 'host-1',
    label: 'Build host',
    sshTarget: 'alice@example.com',
    port: 2222,
    identityFile: '~/.ssh/id_ed25519',
    platform: null,
    lastConnectedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  }],
])
const projects: any[] = []
let connection: any
let askpassPrompt: { prompt: string; createdAt: number } | null = null
let askpassAnswer: string | null = null
let transactionProjectId = 1

const prisma = {
  remoteHost: {
    findMany: mock(async () => [...hosts.values()]),
    findUnique: mock(async ({ where }: any) => hosts.get(where.id) ?? null),
    update: mock(async ({ where, data }: any) => {
      const host = hosts.get(where.id)
      Object.assign(host, data)
      return host
    }),
    create: mock(async ({ data }: any) => {
      const host = {
        id: `host-${hosts.size + 1}`,
        platform: null,
        lastConnectedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      }
      hosts.set(host.id, host)
      return host
    }),
  },
  project: {
    findMany: mock(async () => projects),
    findUnique: mock(async ({ where }: any) => projects.find((project) => project.id === where.id) ?? null),
  },
  workspace: {
    findFirst: mock(async () => ({ id: 'workspace-1', kind: 'team' })),
  },
  $transaction: mock(async (fn: any) => fn({
    project: {
      create: mock(async ({ data }: any) => {
        const project = { id: `project-${transactionProjectId++}`, ...data }
        projects.push(project)
        return project
      }),
    },
    projectFolder: {
      create: mock(async ({ data }: any) => data),
    },
  })),
}

mock.module('../lib/prisma', () => ({ prisma }))

const { localRemoteHostsRoutes, parseSshConfigAliases } = await import(
  '../routes/local-remote-hosts'
)

function app() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth' as never, { userId: 'user-1' } as never)
    await next()
  })
  app.route('/', localRemoteHostsRoutes({
    prisma,
    connectionForHost: () => connection,
    detectPlatform: async () => ({
      os: 'linux',
      arch: 'x64',
      target: 'linux-x64',
    }),
    runtimeManager: {
      getRemoteAskpassPrompt: () => askpassPrompt,
      respondRemoteAskpass: (_hostId: string, answer: string) => {
        askpassAnswer = answer
      },
    },
    readSshConfig: async () => [
      'Host staging',
      '  HostName staging.example.com',
      '  User deploy',
      '  Port 2200',
      '  IdentityFile ~/.ssh/staging',
      'Host *',
      '  ForwardAgent yes',
    ].join('\n'),
    prewarmRuntime: async () => {},
  }))
  return app
}

beforeEach(() => {
  projects.length = 0
  askpassPrompt = null
  askpassAnswer = null
  connection = {
    connect: mock(async () => {}),
    status: mock(async () => ({ connected: true, state: 'connected' })),
    exec: mock(async (command: string) => {
      if (command.includes('uname')) return { stdout: 'Linux\nx86_64\n', exitCode: 0 }
      if (command.includes('for child')) return { stdout: '/home/deploy/a\0/home/deploy/b\0', exitCode: 0 }
      if (command.includes('test -d')) return { stdout: '', exitCode: 0 }
      return { stdout: '', exitCode: 0 }
    }),
  }
})

describe('local Remote-SSH routes', () => {
  test('parses explicit ssh config aliases without wildcard blocks', () => {
    expect(parseSshConfigAliases('Host *\n  User root\nHost build\n  Port 2201'))
      .toEqual([{ alias: 'build', port: 2201 }])
  })

  test('lists saved hosts and safe ssh config alias fields', async () => {
    const response = await app().request('/remote-hosts')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      hosts: [
        { id: 'host-1', source: 'saved', identityFile: '~/.ssh/id_ed25519' },
        {
          source: 'ssh-config',
          alias: 'staging',
          sshTarget: 'staging',
          port: 2200,
          identityFile: '~/.ssh/staging',
        },
      ],
    })
  })

  test('connects, browses with a quoted remote path, and creates a remote project', async () => {
    const connect = await app().request('/remote-hosts/host-1/connect', { method: 'POST' })
    expect(connect.status).toBe(200)
    expect((await connect.json() as any).platform).toBe('linux-x64')
    expect(hosts.get('host-1').platform).toBe('linux-x64')

    const browse = await app().request(
      `/remote-hosts/host-1/browse?path=${encodeURIComponent(`/srv/a'; touch /tmp/pwned`)}`,
    )
    expect(browse.status).toBe(200)
    expect((await browse.json() as any).entries).toEqual([
      { name: 'a', path: '/home/deploy/a' },
      { name: 'b', path: '/home/deploy/b' },
    ])
    expect(connection.exec.mock.calls.some(([command]: [string]) =>
      command.includes("a'\\''; touch"),
    )).toBe(true)

    const created = await app().request('/projects/from-remote-folder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        remoteHostId: 'host-1',
        path: '~/projects/app',
        name: 'Remote App',
      }),
    })
    expect(created.status).toBe(201)
    expect((await created.json() as any).project).toMatchObject({
      name: 'Remote App',
      workspaceId: 'workspace-1',
      remoteHostId: 'host-1',
      workingMode: 'external',
      runtimeEnabled: true,
      trustLevel: 'restricted',
    })
  })

  test('rejects local/remote mixing and reports disconnected without a connection', async () => {
    const mixed = await app().request('/projects/from-remote-folder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        remoteHostId: 'host-1',
        path: '/srv/app',
        paths: ['/local/app'],
      }),
    })
    expect(mixed.status).toBe(400)

    connection = null
    const status = await app().request('/remote-hosts/host-1/status')
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({
      connected: false,
      state: 'disconnected',
    })
  })

  test('relays askpass prompts and answers through the local API', async () => {
    askpassPrompt = { prompt: 'Enter passphrase for key:', createdAt: Date.now() }
    const prompt = await app().request('/remote-hosts/host-1/askpass')
    expect(prompt.status).toBe(200)
    expect(await prompt.json()).toMatchObject({
      pending: true,
      prompt: 'Enter passphrase for key:',
    })

    const response = await app().request('/remote-hosts/host-1/askpass', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: 'secret' }),
    })
    expect(response.status).toBe(200)
    expect(askpassAnswer).toBe('secret')
  })
})
