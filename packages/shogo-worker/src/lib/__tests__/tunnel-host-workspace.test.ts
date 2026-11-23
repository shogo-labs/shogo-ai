// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The worker-thread bridge carries a workspace target (SHO-526).
 *
 * The tunnel runs on its own thread, so everything it needs about the machine is
 * asked of the main thread: which local URL a path maps to, and which token to
 * send with it. Those two questions had no way to name a workspace, which is why
 * a workspace chat landed on an unrelated runtime with no credential.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { startTunnelInWorker } from '../tunnel-host'
import type { RuntimeResolver } from '../tunnel'

type Message = { data: any }

class FakeWorker {
  onmessage: ((event: Message) => void) | null = null
  onerror: ((event: any) => void) | null = null
  posted: any[] = []
  constructor(public url: unknown) {}

  postMessage(message: any) {
    this.posted.push(message)
    if (message?.type === 'init') queueMicrotask(() => this.deliver({ type: 'ready' }))
  }

  deliver(data: any) {
    this.onmessage?.({ data })
  }

  terminate() {
    return Promise.resolve(0)
  }

  reply(type: string): any {
    return this.posted.filter((message) => message.type === type).at(-1)
  }
}

/** The host answers on the microtask queue after awaiting the resolver. */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

let worker: FakeWorker
const originalWorker = (globalThis as any).Worker
const originalEntry = process.env.SHOGO_TUNNEL_WORKER_PATH

beforeEach(() => {
  // The host only needs a path that exists; `FakeWorker` never loads it.
  process.env.SHOGO_TUNNEL_WORKER_PATH = fileURLToPath(new URL('../tunnel.ts', import.meta.url))
  worker = new FakeWorker('')
  ;(globalThis as any).Worker = function () {
    return worker
  } as any
})

afterEach(() => {
  ;(globalThis as any).Worker = originalWorker
  if (originalEntry === undefined) delete process.env.SHOGO_TUNNEL_WORKER_PATH
  else process.env.SHOGO_TUNNEL_WORKER_PATH = originalEntry
})

function makeResolver(calls: {
  resolved: Array<{ path: string; projectId?: string; workspaceId?: string }>
  tokens: Array<{ projectId?: string; workspaceId?: string }>
}): RuntimeResolver {
  return {
    async resolveLocalUrl(path, projectId, workspaceId) {
      calls.resolved.push({ path, projectId, workspaceId })
      return workspaceId ? 'http://localhost:4100/agent/x' : null
    },
    async deriveRuntimeToken(projectId) {
      calls.tokens.push({ projectId })
      return 'project-token'
    },
    async deriveWorkspaceRuntimeToken(workspaceId) {
      calls.tokens.push({ workspaceId })
      return 'workspace-token'
    },
    getActiveProjects: () => [],
    status: () => null,
    describeRejection: (path, projectId, workspaceId) => ({
      code: 'RUNTIME_STARTING',
      message: `${path}|${projectId ?? ''}|${workspaceId ?? ''}`,
    }),
  }
}

describe('tunnel worker bridge (SHO-526)', () => {
  it('passes the workspace id to the resolver, and returns the workspace token', async () => {
    const calls = { resolved: [] as any[], tokens: [] as any[] }
    const host = startTunnelInWorker({
      apiKey: 'shogo_sk_test',
      cloudUrl: 'http://127.0.0.1:1',
      resolver: makeResolver(calls),
    })
    await host.ready()

    worker.deliver({ type: 'resolve', id: 1, path: '/agent/workspace/download/a.png', workspaceId: 'ws-1' })
    await tick()

    expect(calls.resolved).toEqual([
      { path: '/agent/workspace/download/a.png', projectId: undefined, workspaceId: 'ws-1' },
    ])
    expect(worker.reply('resolved')).toMatchObject({ id: 1, url: 'http://localhost:4100/agent/x' })

    worker.deliver({ type: 'token', id: 2, workspaceId: 'ws-1' })
    await tick()

    expect(calls.tokens).toEqual([{ workspaceId: 'ws-1' }])
    expect(worker.reply('token-result')).toMatchObject({ id: 2, token: 'workspace-token' })

    host.stop()
  })

  it('keeps the project token for a project-targeted request', async () => {
    const calls = { resolved: [] as any[], tokens: [] as any[] }
    const host = startTunnelInWorker({
      apiKey: 'shogo_sk_test',
      cloudUrl: 'http://127.0.0.1:1',
      resolver: makeResolver(calls),
    })
    await host.ready()

    worker.deliver({ type: 'token', id: 3, projectId: 'p-1' })
    await tick()

    expect(calls.tokens).toEqual([{ projectId: 'p-1' }])
    expect(worker.reply('token-result')).toMatchObject({ id: 3, token: 'project-token' })

    host.stop()
  })

  it('caches a rejection under the workspace it was about', async () => {
    const calls = { resolved: [] as any[], tokens: [] as any[] }
    const host = startTunnelInWorker({
      apiKey: 'shogo_sk_test',
      cloudUrl: 'http://127.0.0.1:1',
      resolver: makeResolver(calls),
    })
    await host.ready()

    // No workspace id ⇒ this resolver returns null, and the rejection is what
    // the tunnel echoes back on the next refusal of the same path + target.
    worker.deliver({ type: 'resolve', id: 4, path: '/agent/x', projectId: 'p-9' })
    await tick()
    expect(worker.reply('resolved')).toMatchObject({ id: 4, url: null })

    worker.deliver({ type: 'refresh', id: 5 })
    await tick()

    const refresh = worker.reply('refresh-result')
    expect(refresh.rejections).toHaveProperty(['/agent/x|p-9|'])

    host.stop()
  })
})
