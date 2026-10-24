// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The tunnel, in its own thread (SHO-185 §5)
 *
 * `WorkerTunnel` answers the cloud's `{type:'ping'}` with `{type:'pong'}` and
 * drops its socket after an idle window. Run on the local API's thread — which
 * is what it did — a busy moment (a `lsof`, a migration, an agent writing a
 * large file) means no pong, and the cloud closes the socket: the desktop
 * disappears from Studio with a 1006 and the person is told the machine is
 * offline while it is sitting right there.
 *
 * So the socket, its timers and its `fetch`es live here, in a Bun `Worker`,
 * where the only thing that can delay a pong is this file. What the tunnel
 * needs from the main thread — which local URL a request maps to, which runtime
 * token it wants, which projects are up — arrives as messages; the parts of
 * `RuntimeResolver` that are synchronous per heartbeat read a snapshot the host
 * refreshes before each one.
 */

import { WorkerTunnel, type ResolveRejection, type RuntimeResolver } from './tunnel'

export interface TunnelWorkerInit {
  type: 'init'
  config: {
    apiKey: string
    cloudUrl: string
    name?: string
    kind?: string
    wsUrlOverride?: string
  }
}

export interface HostProjectStatus {
  projectId: string
  status: string
  agentPort?: number
}

/** Worker → host: something the tunnel needs resolved on the main thread. */
export type WorkerRequest =
  | { type: 'resolve'; id: number; path: string; projectId?: string }
  | { type: 'token'; id: number; projectId: string }
  | { type: 'refresh'; id: number }
  | { type: 'machineSnapshot'; id: number }

/** Host → worker: the answer, plus what the host learned meanwhile. */
export type HostReply =
  | {
      type: 'resolved'
      id: number
      url: string | null
      rejection?: ResolveRejection
    }
  | { type: 'token-result'; id: number; token: string | null }
  | {
      type: 'refresh-result'
      id: number
      projects: HostProjectStatus[]
      /** Keyed `path|projectId`, filled in by the `resolve` that just failed. */
      rejections?: Record<string, ResolveRejection>
    }
  | { type: 'machine-snapshot-result'; id: number; snapshot: Record<string, unknown> | null }

/** Worker → host: what happened, so the main thread can answer questions. */
export type WorkerEvent =
  | { type: 'event'; name: 'instance'; instanceId: string | null }
  | { type: 'event'; name: 'connection'; connected: boolean }
  | { type: 'event'; name: 'auth-revoked'; reason: string }
  | { type: 'log'; level: 'log' | 'warn' | 'error'; message: string }
  | { type: 'ready' }

type Pending = { resolve: (value: any) => void }

/** A request before the id is assigned. */
type WorkerRequestInput =
  | { type: 'resolve'; path: string; projectId?: string }
  | { type: 'token'; projectId: string }
  | { type: 'refresh' }
  | { type: 'machineSnapshot' }

/**
 * `RuntimeResolver` for the worker: async calls round-trip to the host, sync
 * calls read the snapshot the last `refresh()` left behind.
 */
class BridgedResolver implements RuntimeResolver {
  private projects: HostProjectStatus[] = []
  private rejections = new Map<string, ResolveRejection>()
  private pending = new Map<number, Pending>()
  private nextId = 1

  constructor(private readonly post: (message: WorkerRequest) => void) {}

  /** Called by the tunnel before each heartbeat. */
  async refresh(): Promise<void> {
    const reply = (await this.request({ type: 'refresh' })) as Extract<HostReply, { type: 'refresh-result' }>
    this.projects = reply.projects ?? []
    this.rejections.clear()
    for (const [key, rejection] of Object.entries(reply.rejections ?? {})) {
      this.rejections.set(key, rejection)
    }
  }

  private request(request: WorkerRequestInput): Promise<HostReply> {
    const id = this.nextId++
    return new Promise<HostReply>((resolve) => {
      this.pending.set(id, { resolve })
      this.post({ ...request, id } as WorkerRequest)
    })
  }

  /** The host's answer to one of our requests. */
  handleReply(reply: HostReply): void {
    const entry = this.pending.get(reply.id)
    if (!entry) return
    this.pending.delete(reply.id)
    if (reply.type === 'resolved' && reply.url === null && reply.rejection) {
      entry.resolve(reply)
      return
    }
    entry.resolve(reply)
  }

  async resolveLocalUrl(pathWithQuery: string, projectId?: string): Promise<string | null> {
    const reply = (await this.request({ type: 'resolve', path: pathWithQuery, projectId })) as Extract<
      HostReply,
      { type: 'resolved' }
    >
    if (reply.url === null && reply.rejection) {
      this.rejections.set(`${pathWithQuery}|${projectId ?? ''}`, reply.rejection)
    }
    return reply.url
  }

  async deriveRuntimeToken(projectId: string): Promise<string | null> {
    const reply = (await this.request({ type: 'token', projectId })) as Extract<
      HostReply,
      { type: 'token-result' }
    >
    return reply.token
  }

  getActiveProjects(): string[] {
    return this.projects.map((project) => project.projectId)
  }

  status(projectId: string): { status: string; agentPort?: number } | null {
    const project = this.projects.find((entry) => entry.projectId === projectId)
    if (!project) return null
    return { status: project.status, agentPort: project.agentPort }
  }

  describeRejection(pathWithQuery: string, projectId?: string): ResolveRejection {
    return (
      this.rejections.get(`${pathWithQuery}|${projectId ?? ''}`) ?? {
        code: 'NO_LOCAL_RUNTIME',
        message: `no local runtime available for path: ${pathWithQuery}`,
      }
    )
  }

  async machineSnapshot(): Promise<Record<string, unknown> | null> {
    const reply = (await this.request({ type: 'machineSnapshot' })) as Extract<
      HostReply,
      { type: 'machine-snapshot-result' }
    >
    return reply.snapshot
  }
}

const scope = self as unknown as {
  postMessage: (message: unknown) => void
  onmessage: ((event: MessageEvent) => void) | null
}

const post = (message: WorkerEvent | WorkerRequest) => scope.postMessage(message)

let tunnel: WorkerTunnel | null = null
let resolver: BridgedResolver | null = null
let connected = false
let instanceId: string | null = null

scope.onmessage = (event: MessageEvent) => {
  const data = event.data as TunnelWorkerInit | HostReply
  if (!data || typeof data !== 'object') return

  if ((data as TunnelWorkerInit).type === 'init') {
    const init = data as TunnelWorkerInit
    resolver = new BridgedResolver(post as (message: WorkerRequest) => void)
    tunnel = new WorkerTunnel({
      ...init.config,
      resolver,
      logger: {
        log: (message: string) => post({ type: 'log', level: 'log', message }),
        warn: (message: string) => post({ type: 'log', level: 'warn', message }),
        error: (message: string) => post({ type: 'log', level: 'error', message }),
      },
      onAuthRevoked: (reason: string) => post({ type: 'event', name: 'auth-revoked', reason }),
    })
    tunnel.start()
    post({ type: 'ready' })
    // The cloud only knows this machine's id after the first heartbeat, and the
    // machine copy (SHO-185) pushes under it, so the host has to learn it here.
    setInterval(() => {
      if (!tunnel) return
      const nextInstance = tunnel.instanceId ?? null
      if (nextInstance !== instanceId) {
        instanceId = nextInstance
        post({ type: 'event', name: 'instance', instanceId })
      }
      const nextConnected = tunnel.isConnected()
      if (nextConnected !== connected) {
        connected = nextConnected
        post({ type: 'event', name: 'connection', connected })
      }
    }, 1_000)
    return
  }

  if (typeof (data as any).type === 'string' && (data as any).id !== undefined) {
    resolver?.handleReply(data as HostReply)
  }
}
