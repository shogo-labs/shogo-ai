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

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ResolveRejection, RuntimeResolver } from './tunnel'
import type { HostProjectStatus, HostReply, WorkerEvent, WorkerRequest } from './tunnel-worker'

/**
 * How long the worker gets to answer `ready` before it is written off.
 *
 * The worker posts `ready` from its `init` handler, before it touches the
 * network, so this is only ever spent on a worker that never came up at all
 * (crashed on load, wrong entry file, a runtime that quietly refuses to spawn
 * one). A tunnel that is slow to connect is not slow to be ready.
 */
const READY_TIMEOUT_MS = 10_000

/** This module's directory: `resources/bundle/` once packaged, `src/lib/` in a checkout. */
const HOST_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * The Worker entry file that sits next to this module.
 *
 * A source checkout has only `tunnel-worker.ts`; the desktop ships the compiled
 * `resources/bundle/tunnel-worker.js` (see `apps/desktop/scripts/bundle-api.mjs`)
 * and no source tree at all. Relative to `import.meta.url` — which inside
 * `resources/bundle/api.js` is the bundle itself — `new URL('./tunnel-worker.ts')`
 * could only ever name the checkout, so the packaged app asked for a `.ts` file
 * that was never shipped, the worker never started, and the tunnel vanished.
 *
 * `SHOGO_TUNNEL_WORKER_PATH` overrides the search for packagers that relocate
 * the bundle.
 */
export function resolveTunnelWorkerEntry(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SHOGO_TUNNEL_WORKER_PATH?.trim()
  if (override) return override

  const candidates = [join(HOST_DIR, 'tunnel-worker.js'), join(HOST_DIR, 'tunnel-worker.ts')]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found) return found

  throw new Error(
    `no tunnel worker entry next to ${HOST_DIR} (looked for ${candidates.join(', ')}); ` +
      `packaging must ship the tunnel-worker build output beside the API bundle`,
  )
}

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
  /** The worker died (on load or later). The host is not usable after this. */
  onWorkerError?: (error: Error) => void
  /** Overrides the readiness deadline. Tests only. */
  readyTimeoutMs?: number
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
 * in-process tunnel rather than lose remote control entirely. A worker that is
 * created but never answers `ready` rejects `ready()` for the same reason — the
 * throw alone is not enough, because a missing entry file does not always fail
 * synchronously.
 */
export function startTunnelInWorker(options: TunnelHostOptions): TunnelHost {
  const log = options.logger ?? console
  const entry = resolveTunnelWorkerEntry()
  // The web Worker API, which is what Bun implements (and what the worker file
  // uses on its side with `self.postMessage`). `node:worker_threads` needs
  // `parentPort` instead, and mixing the two silently never delivers a message.
  const worker = new Worker(pathToFileURL(entry))

  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS
  let instanceId: string | null = null
  let connected = false
  let stopped = false
  let readySettled = false
  let settleReady: () => void = () => {}
  let failReady: (error: Error) => void = () => {}
  const ready = new Promise<void>((resolve, reject) => {
    settleReady = resolve
    failReady = reject
  })
  // Nobody is obliged to await `ready()`; an unobserved rejection would take the
  // process down instead of letting the caller fall back.
  void ready.catch(() => {})

  const readyTimer = setTimeout(() => {
    failReady(new Error(`tunnel worker (${entry}) did not answer ready within ${readyTimeoutMs}ms`))
  }, readyTimeoutMs)
  void ready.then(
    () => {
      readySettled = true
      clearTimeout(readyTimer)
    },
    () => {
      readySettled = true
      clearTimeout(readyTimer)
    },
  )

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
    const message = event?.message ?? event
    log.error(`[TunnelHost] worker error: ${message}`)
    const error = new Error(`tunnel worker failed: ${message}`)
    // A worker that dies on load never posts `ready`. Reject now so the caller
    // can fall back instead of waiting out the whole deadline.
    if (!readySettled) failReady(error)
    // A worker that dies later leaves a socket nobody is watching, which looks
    // exactly like an offline machine. Same answer: hand it back to the caller.
    options.onWorkerError?.(error)
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
      clearTimeout(readyTimer)
      void worker.terminate()
    },
    instanceId: () => instanceId,
    isConnected: () => connected,
    ready: () => ready,
  }
}
