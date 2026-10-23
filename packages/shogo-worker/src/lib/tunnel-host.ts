// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Main-thread side of the tunnel Worker (SHO-185 §5)
 *
 * `startTunnelInWorker()` puts `WorkerTunnel` on its own thread and answers the
 * questions it cannot answer itself: which local URL a path maps to, the runtime
 * token for a project, and — once per heartbeat — which runtimes are up. The
 * socket, its timers and its local `fetch`es never touch this thread, so a busy
 * local API cannot cost the machine its connection any more.
 */

import type { ResolveRejection, RuntimeResolver } from './tunnel'
import type { HostProjectStatus, HostReply, WorkerEvent, WorkerRequest } from './tunnel-worker'

export interface TunnelHostOptions {
  apiKey: string
  cloudUrl: string
  name?: string
  kind?: string
  wsUrlOverride?: string
  /** Everything the tunnel asks about the local machine. */
  resolver: RuntimeResolver
  logger?: Pick<Console, 'log' | 'warn' | 'error'>
  onAuthRevoked?: (reason: string) => void
  /** Called when the cloud tells us this machine's instance id (or forgets it). */
  onInstanceId?: (instanceId: string | null) => void
  /** Called when the socket's connected state changes. */
  onConnection?: (connected: boolean) => void
}

export interface TunnelHost {
  stop(): void
  instanceId(): string | null
  isConnected(): boolean
  /** Resolves once the worker has the tunnel running. */
  ready(): Promise<void>
}

/**
 * Start the tunnel on its own thread.
 *
 * Throws if the worker cannot be created (a bundle without the entry file, a
 * runtime that will not spawn one), which is the caller's cue to fall back to an
 * in-process tunnel rather than lose remote control entirely.
 */
export function startTunnelInWorker(options: TunnelHostOptions): TunnelHost {
  const log = options.logger ?? console
  // The web Worker API, which is what Bun implements (and what the worker file
  // uses on its side with `self.postMessage`). `node:worker_threads` needs
  // `parentPort` instead, and mixing the two silently never delivers a message.
  const worker = new Worker(new URL('./tunnel-worker.ts', import.meta.url))

  let instanceId: string | null = null
  let connected = false
  let stopped = false
  let settleReady: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    settleReady = resolve
  })

  /** What the last `resolve` decided, so a rejection needs no extra round trip. */
  const rejections = new Map<string, ResolveRejection>()

  worker.onmessage = (event: MessageEvent) => {
    const data = event.data as any
    if (!data || typeof data !== 'object') return

    if (data.type === 'ready') {
      settleReady()
      return
    }

    if (data.type === 'log') {
      const sink = data.level === 'error' ? log.error : data.level === 'warn' ? log.warn : log.log
      sink.call(log, data.message)
      return
    }

    if (data.type === 'event') {
      if (data.name === 'instance') {
        instanceId = data.instanceId ?? null
        options.onInstanceId?.(instanceId)
      } else if (data.name === 'connection') {
        connected = Boolean(data.connected)
        options.onConnection?.(connected)
      } else if (data.name === 'auth-revoked') {
        options.onAuthRevoked?.(String(data.reason ?? 'auth revoked'))
      }
      return
    }

    void answer(data as WorkerRequest)
  }

  worker.onerror = (event: any) => {
    log.error(`[TunnelHost] worker error: ${event?.message ?? event}`)
  }

  async function answer(request: WorkerRequest): Promise<void> {
    const resolver = options.resolver
    try {
      if (request.type === 'resolve') {
        const url = await resolver.resolveLocalUrl(request.path, request.projectId)
        const rejection =
          url === null
            ? await Promise.resolve(resolver.describeRejection?.(request.path, request.projectId))
            : undefined
        if (rejection) rejections.set(`${request.path}|${request.projectId ?? ''}`, rejection)
        reply({ type: 'resolved', id: request.id, url, rejection })
        return
      }

      if (request.type === 'token') {
        const token = await resolver.deriveRuntimeToken(request.projectId)
        reply({ type: 'token-result', id: request.id, token })
        return
      }

      if (request.type === 'refresh') {
        const projects: HostProjectStatus[] = resolver.getActiveProjects().map((projectId) => {
          const status = resolver.status(projectId)
          return { projectId, status: status?.status ?? 'unknown', agentPort: status?.agentPort }
        })
        reply({
          type: 'refresh-result',
          id: request.id,
          projects,
          rejections: Object.fromEntries(rejections),
        })
        return
      }

      if (request.type === 'machineSnapshot') {
        const snapshot = (await resolver.machineSnapshot?.()) ?? null
        reply({ type: 'machine-snapshot-result', id: request.id, snapshot })
      }
    } catch (error: any) {
      log.warn(`[TunnelHost] ${request.type} failed: ${error?.message ?? error}`)
      if (request.type === 'resolve') reply({ type: 'resolved', id: request.id, url: null })
      else if (request.type === 'token') reply({ type: 'token-result', id: request.id, token: null })
      else if (request.type === 'refresh') reply({ type: 'refresh-result', id: request.id, projects: [] })
      else reply({ type: 'machine-snapshot-result', id: request.id, snapshot: null })
    }
  }

  function reply(message: HostReply): void {
    if (stopped) return
    worker.postMessage(message)
  }

  worker.postMessage({
    type: 'init',
    config: {
      apiKey: options.apiKey,
      cloudUrl: options.cloudUrl,
      name: options.name,
      kind: options.kind,
      wsUrlOverride: options.wsUrlOverride,
    },
  })

  return {
    stop() {
      stopped = true
      void worker.terminate()
    },
    instanceId: () => instanceId,
    isConnected: () => connected,
    ready: () => ready,
  }
}
