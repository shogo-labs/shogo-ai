// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Keeps a cloud workspace runtime's root `.env*` across a cold boot (SHO-384).
 *
 * The pod's root tree is rebuilt from the durable git repo, and git ignores
 * `.env*` — so the tokens an agent saved at the workspace root were gone after
 * every cold boot. Metal guests already keep them in the encrypted home archive
 * (SHO-382); a pod has no host in front of it, so the API holds them, sealed
 * with a key derived per runtime key, and this module is the pod's half:
 *
 *   - {@link restore} runs ONCE, after the members are hydrated and the git
 *     repo bootstrap has finished rewriting the tree. Anything restored earlier
 *     would be replaced by either of those.
 *   - {@link start} then re-exports on an interval and on shutdown, so an edit
 *     survives `SIGTERM` and, mostly, a hard kill.
 *
 * The file semantics (replace, prune, 0600) are the shared one in
 * `@shogo/shared-runtime/workspace-root-secrets`, which is also what the metal
 * archive path uses. The transport is HTTP because that is the only way a pod
 * reaches the API; on desktop the store is not configured at all and the
 * runtime keeps reading its own disk.
 */

import { resolveApiUrl } from '@shogo/shared-runtime/standalone'
import {
  flushWorkspaceRootSecrets,
  restoreWorkspaceRootSecrets,
  workspaceSecretsTag,
  type WorkspaceRootSecrets,
  type WorkspaceRootSecretsTransport,
} from '@shogo/shared-runtime/workspace-root-secrets'
import { workspaceSecretRoots } from './home-state'

/** Env flag the API sets for an in-cluster workspace runtime (see buildWorkspaceEnv). */
export const WORKSPACE_SECRET_STORE_ENV = 'SHOGO_WORKSPACE_SECRET_STORE'

export interface WorkspaceRootSecretSyncConfig {
  apiUrl: string
  workspaceId: string
  anchorProjectId: string | null
  runtimeAuthSecret: string
  /** Slot name -> live directory. Always the runtime's own root today. */
  roots: Record<string, string>
  intervalMs: number
}

function truthy(value: string | undefined): boolean {
  return value === '1' || value === 'true'
}

/**
 * The store's settings, or null when this runtime has none.
 *
 * Null is the normal answer on desktop and in standalone mode: the root is a
 * real directory there, nothing rebuilds it, and a store would only be a second
 * copy of the truth. A metal guest answers null too — the host-mediated home
 * archive already carries the same files, and two durable copies of a `.env`
 * is how the older one wins.
 */
export function workspaceRootSecretSyncFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceRootSecretSyncConfig | null {
  if (env[WORKSPACE_SECRET_STORE_ENV] !== 'rest') return null
  if (truthy(env.SHOGO_DURABILITY_HOST_MEDIATED)) return null
  const workspaceId = env.WORKSPACE_ID?.trim()
  const runtimeAuthSecret = env.RUNTIME_AUTH_SECRET?.trim()
  if (!workspaceId || !runtimeAuthSecret) return null
  const apiUrl = resolveApiUrl(env)
  if (!apiUrl) return null
  const roots: Record<string, string> = {}
  for (const root of workspaceSecretRoots(env)) roots[root.slot] = root.dir
  if (Object.keys(roots).length === 0) return null
  const interval = Number(env.SHOGO_WORKSPACE_SECRET_SYNC_MS ?? '60000')
  return {
    apiUrl: apiUrl.replace(/\/+$/, ''),
    workspaceId,
    anchorProjectId: env.WORKSPACE_ANCHOR_PROJECT_ID?.trim() || null,
    runtimeAuthSecret,
    roots,
    intervalMs: Number.isFinite(interval) && interval >= 5_000 ? interval : 60_000,
  }
}

/** The parts of the config the HTTP transport needs. */
type TransportTarget = Pick<
  WorkspaceRootSecretSyncConfig,
  'apiUrl' | 'workspaceId' | 'anchorProjectId' | 'runtimeAuthSecret'
>

/** `/api/internal/workspaces/:id/root-secrets`, with the anchor that names the runtime. */
function endpoint(cfg: TransportTarget): string {
  const query = cfg.anchorProjectId ? `?anchor=${encodeURIComponent(cfg.anchorProjectId)}` : ''
  return `${cfg.apiUrl}/api/internal/workspaces/${encodeURIComponent(cfg.workspaceId)}/root-secrets${query}`
}

function headers(cfg: TransportTarget): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-runtime-token': cfg.runtimeAuthSecret,
  }
}

/**
 * The API-side store over HTTP. Split out from the config so a test can drive
 * the file semantics without a server, and so a caller that already has a
 * transport (desktop through the local relay) can reuse the same logic.
 */
export function createWorkspaceRootSecretsTransport(
  cfg: TransportTarget,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): WorkspaceRootSecretsTransport {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch)
  const timeoutMs = opts.timeoutMs ?? 15_000
  const url = endpoint(cfg)
  return {
    async pull() {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: headers(cfg),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.status === 204) return null
      if (!res.ok) throw new Error(`root-secrets GET HTTP ${res.status}`)
      const body = (await res.json().catch(() => null)) as
        | { tag?: string; secrets?: WorkspaceRootSecrets }
        | null
      if (!body?.secrets) return null
      return { tag: body.tag ?? workspaceSecretsTag(body.secrets), secrets: body.secrets }
    },
    async push(secrets, pushOpts) {
      const res = await fetchImpl(url, {
        method: 'PUT',
        headers: headers(cfg),
        body: JSON.stringify(secrets),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`root-secrets PUT HTTP ${res.status}`)
      const body = (await res.json().catch(() => null)) as { stored?: boolean; tag?: string } | null
      return { stored: body?.stored === true, tag: body?.tag ?? pushOpts.tag }
    },
  }
}

export interface WorkspaceRootSecretSync {
  /** Pull the stored set into the live roots. Safe to call once, after the tree is final. */
  restore(): Promise<{ restored: string[]; removed: string[]; skippedSlots: string[] } | null>
  /** Push the live set. `stored: false` when nothing changed. */
  flush(): Promise<{ stored: boolean; files: number } | null>
  /** Push on an interval; returns the stop function. */
  start(): () => void
  stop(): void
}

/**
 * Build the sync. Every call is best-effort: a runtime that cannot reach the
 * store must still boot and still serve turns, so callers see a logged failure
 * rather than a rejection that would take the boot down.
 */
export function createWorkspaceRootSecretsSync(
  cfg: WorkspaceRootSecretSyncConfig,
  opts: { transport?: WorkspaceRootSecretsTransport; log?: (msg: string) => void; fetchImpl?: typeof fetch } = {},
): WorkspaceRootSecretSync {
  const log = opts.log ?? ((msg: string) => console.log(msg))
  const transport = opts.transport ?? createWorkspaceRootSecretsTransport(cfg, { fetchImpl: opts.fetchImpl })
  let lastTag: string | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false

  async function restore() {
    try {
      const result = await restoreWorkspaceRootSecrets({ transport, roots: cfg.roots, log })
      if (result.restored.length || result.removed.length) {
        log(
          `[workspace-secrets] restored ${result.restored.length} .env file(s)` +
            (result.removed.length ? `, removed ${result.removed.join(', ')}` : ''),
        )
      }
      return result
    } catch (err: any) {
      console.warn('[workspace-secrets] restore failed:', err?.message ?? err)
      return null
    }
  }

  async function flush() {
    if (running) return null
    running = true
    try {
      const result = await flushWorkspaceRootSecrets({ transport, roots: cfg.roots, lastTag, log })
      lastTag = result.tag
      return result
    } catch (err: any) {
      console.warn('[workspace-secrets] export failed:', err?.message ?? err)
      return null
    } finally {
      running = false
    }
  }

  function stop(): void {
    if (timer) clearInterval(timer)
    timer = null
  }

  function start(): () => void {
    stop()
    timer = setInterval(() => {
      void flush()
    }, cfg.intervalMs)
    // Never hold the process open for a sync of a handful of files.
    ;(timer as any)?.unref?.()
    return stop
  }

  return { restore, flush, start, stop }
}

let current: WorkspaceRootSecretSync | null = null

/** The process-wide sync for this runtime, or null when no store is configured. */
export function getWorkspaceRootSecretsSync(
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceRootSecretSync | null {
  if (current) return current
  const cfg = workspaceRootSecretSyncFromEnv(env)
  if (!cfg) return null
  current = createWorkspaceRootSecretsSync(cfg)
  return current
}

/** Test seam: forget the process-wide sync. */
export function resetWorkspaceRootSecretsSync(): void {
  current?.stop()
  current = null
}
