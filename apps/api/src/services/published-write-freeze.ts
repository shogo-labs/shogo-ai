// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The write freeze a SQLite → Postgres move needs (§G3).
 *
 * A published SQLite environment keeps its database in `{subdomain}/data.tar.gz`
 * and rewrites it from the serving pod every 30 s. A Postgres move seeds from
 * that archive, so any write that lands between the last upload and the seed —
 * and every write the old SQLite pod accepts while the Postgres revision rolls
 * out — would be copied nowhere and lost. `PUBLISHED_DATA_SYNC_INTERVAL` is 30 s,
 * so on a busy app that is up to thirty seconds of real writes, every time.
 *
 * The freeze closes that window in three steps, in this order:
 *
 *   1. `setMaintenance(on)` — the environment's status becomes `switching`, which
 *      makes the published wake/proxy answer 503 + `Retry-After` instead of
 *      waking the SQLite pod. New writes stop reaching it.
 *   2. `requestFlush()` — the pod uploads its database NOW rather than at its
 *      next interval. A `false` answer with `unchanged: true` means the archive
 *      already holds the pod's current bytes, which is just as good.
 *   3. Wait until the archive's `LastModified` is at or after the freeze began
 *      (`isArchiveFresh`), so the seed cannot read the copy from before the flush.
 *
 * A pod published before the flush endpoint existed answers 404. That is not a
 * failed freeze: it still rewrites the same archive every
 * `PUBLISHED_DATA_SYNC_INTERVAL` (30 s), and the archive carries `dev.db-wal`, so
 * once writes are stopped a periodic upload is complete by construction. Step 2
 * then means "wait one interval for that upload" — and step 3 still proves it, so
 * an old pod that never uploads fails the move instead of seeding a stale copy.
 *
 * The caller must `end()` in a `finally`: lifting maintenance is what puts the
 * site back, and a failure that left it on would turn a refused publish into a
 * site-wide outage. `end()` is a no-op when `begin()` never ran.
 */

import {
  ARCHIVE_FRESHNESS_GRACE_MS,
  MAINTENANCE_ENV_STATUS,
  FAILED_ENV_STATUS,
  LIVE_ENV_STATUS,
  cutoverArchiveKey,
  isArchiveFresh,
} from './published-cutover.service'

/** How long the pod gets to finish its final upload after the freeze. */
export const FLUSH_TIMEOUT_MS = 60_000
const FLUSH_POLL_MS = 1_000

/**
 * `PUBLISHED_DATA_SYNC_INTERVAL`: how often a published pod rewrites its archive
 * when it cannot be asked to flush on demand. A pod older than the flush endpoint
 * uploads on this timer, so the wait for it is one interval on top of the flush
 * budget — a slow snapshot of a large database still gets room.
 */
export const PERIODIC_ARCHIVE_INTERVAL_MS = 30_000

export interface FlushResult {
  ok: boolean
  /** The pod uploaded (its content had changed since the last upload). */
  flushed: boolean
  /** The archive already matched the pod's bytes, so no upload was needed. */
  unchanged: boolean
  /** False when nothing is serving — no pod, so no pending writes. */
  warm: boolean
  /**
   * The pod predates `/agent/published-data/flush` (HTTP 404/405). Its periodic
   * upload is the only flush it has, so the freeze waits for that instead of
   * refusing a move that can be done safely.
   */
  unsupported?: boolean
  detail?: string
}

/**
 * How a flush response maps to a freeze decision.
 *
 * 404/405 is the one status that is not a failure: it means the serving pod was
 * built before the endpoint existed. It still uploads to the same archive on its
 * own timer, so the freeze waits for that instead — and the archive's freshness
 * still has to be proven before anything seeds from it.
 */
export function flushResultFromResponse(
  status: number,
  body: { ok?: boolean; flushed?: boolean; unchanged?: boolean; error?: string; message?: string } = {},
): FlushResult {
  if (status === 404 || status === 405) {
    return { ok: true, flushed: false, unchanged: false, warm: true, unsupported: true }
  }
  if (status < 200 || status >= 300) {
    return {
      ok: false,
      flushed: false,
      unchanged: false,
      warm: true,
      detail: body.message ?? body.error ?? `HTTP ${status}`,
    }
  }
  return { ok: true, flushed: body.flushed === true, unchanged: body.unchanged === true, warm: true }
}

export interface WriteFreezeDeps {
  setMaintenance(on: boolean, detail?: string | null): Promise<void>
  requestFlush(): Promise<FlushResult>
  headArchive(): Promise<{ lastModifiedMs: number; bytes: number } | null>
  /**
   * Is the serving runtime up and answering? Used only for the old-pod path: a
   * pod whose sync loop is running flushes within `PERIODIC_ARCHIVE_INTERVAL_MS`
   * of any write, so an unchanged archive on a live pod means nothing is pending.
   */
  podAnswers?(): Promise<boolean>
  now(): number
  sleep(ms: number): Promise<void>
  log(message: string): void
}

export interface WriteFreeze {
  /** True once maintenance is up — `end()` only does work when this is set. */
  readonly begun: boolean
  /** How long writes were frozen, once `end()` has run. */
  readonly frozenMs: number
  begin(): Promise<{ ok: true } | { ok: false; code: string; message: string }>
  end(detail?: string | null): Promise<void>
}

export function createWriteFreeze(
  input: {
    projectId: string
    subdomain: string
    environmentId: string
    environmentName: string
  },
  deps: WriteFreezeDeps = defaultWriteFreezeDeps(input),
): WriteFreeze {
  let begun = false
  let released = false
  let startedAt = 0
  let frozenMs = 0

  return {
    get begun() {
      return begun && !released
    },
    get frozenMs() {
      return frozenMs
    },

    async begin() {
      if (begun) return { ok: true as const }
      await deps.setMaintenance(true, null)
      begun = true
      startedAt = deps.now()
      deps.log(
        `[Publish] Write freeze on ${input.subdomain} (${input.environmentName}): maintenance up, flushing the SQLite pod`,
      )

      const flush = await deps.requestFlush()
      if (!flush.ok) {
        return {
          ok: false as const,
          code: 'write_freeze_failed',
          message:
            `The live app could not flush its database before the move ` +
            `(${flush.detail ?? 'no answer'}), so writes made after its last upload cannot be copied. ` +
            `It is still serving on SQLite with its data.`,
        }
      }
      if (!flush.warm || flush.unchanged) {
        // Nothing serving (no writes are being accepted) or the archive already
        // holds the pod's current bytes: there is nothing to wait for.
        deps.log(`[Publish] Freeze satisfied without a fresh upload (warm=${flush.warm}, unchanged=${flush.unchanged})`)
        return { ok: true as const }
      }

      // A pod built before the flush endpoint can only upload on its own timer,
      // so allow one interval on top of the flush budget. The freshness check
      // below is what keeps this safe: the move still refuses to seed an archive
      // written before writes stopped, so an old pod that never uploads fails.
      const waitBudgetMs = flush.unsupported
        ? FLUSH_TIMEOUT_MS + PERIODIC_ARCHIVE_INTERVAL_MS
        : FLUSH_TIMEOUT_MS
      if (flush.unsupported) {
        deps.log(
          `[Publish] The serving pod predates the flush endpoint, so it uploads on its own ` +
            `${Math.round(PERIODIC_ARCHIVE_INTERVAL_MS / 1000)}s timer; waiting up to ` +
            `${Math.round(waitBudgetMs / 1000)}s for that archive`,
        )
      }

      const deadline = startedAt + waitBudgetMs
      while (true) {
        const archive = await deps.headArchive().catch(() => null)
        const fresh =
          archive !== null &&
          isArchiveFresh(
            {
              key: cutoverArchiveKey(input.subdomain),
              bytes: archive.bytes,
              lastModifiedMs: archive.lastModifiedMs,
            },
            startedAt,
            ARCHIVE_FRESHNESS_GRACE_MS,
          )
        if (archive && fresh) {
          deps.log(
            `[Publish] Final flush landed (${archive.bytes} bytes, ${deps.now() - startedAt}ms into the freeze)`,
          )
          return { ok: true as const }
        }
        if (deps.now() >= deadline) {
          // An old pod only uploads when its content changed, so a quiet app
          // never produces the fresh archive. If the runtime is still answering,
          // its 30 s sync loop is running and nothing can be pending — the
          // archive it last wrote is the pod's state. A pod that does not answer
          // proves nothing, so that still fails.
          if (flush.unsupported && (await deps.podAnswers?.().catch(() => false))) {
            deps.log(
              `[Publish] No new upload in ${Math.round(waitBudgetMs / 1000)}s, but the serving pod is ` +
                `answering and its sync loop flushes within ` +
                `${Math.round(PERIODIC_ARCHIVE_INTERVAL_MS / 1000)}s of any write: nothing is pending, ` +
                `the archive already holds its state`,
            )
            return { ok: true as const }
          }
          return {
            ok: false as const,
            code: 'write_freeze_failed',
            message: flush.unsupported
              ? `The live app predates the flush endpoint and its own periodic archive did not ` +
                `update within ${Math.round(waitBudgetMs / 1000)}s, so the last writes cannot be proven copied. ` +
                `It is still serving on SQLite with its data.`
              : `The live app flushed its database but the archive did not update within ` +
                `${Math.round(waitBudgetMs / 1000)}s, so the last writes cannot be proven copied. ` +
                `It is still serving on SQLite with its data.`,
          }
        }
        await deps.sleep(FLUSH_POLL_MS)
      }
    },

    async end(detail?: string | null) {
      if (!begun || released) return
      released = true
      frozenMs = Math.max(0, deps.now() - startedAt)
      await deps.setMaintenance(false, detail ?? null).catch((err: any) => {
        deps.log(`WARNING: could not lift maintenance: ${err?.message ?? err}`)
      })
      deps.log(
        `[Publish] Write freeze off ${input.subdomain} after ${(frozenMs / 1000).toFixed(1)}s` +
          (detail ? ` (${detail})` : ''),
      )
    },
  }
}

/**
 * The production dependencies: the environment row for the flag, the pod for the
 * flush, the published-data bucket for the archive.
 */
export function defaultWriteFreezeDeps(input: {
  projectId: string
  subdomain: string
  environmentId: string
}): WriteFreezeDeps {
  return {
    async setMaintenance(on, detail) {
      const { prisma } = await import('../lib/prisma')
      await prisma.publishedEnvironment.update({
        where: { id: input.environmentId },
        data: on
          ? { publishStatus: MAINTENANCE_ENV_STATUS, publishError: null, publishStatusAt: new Date() }
          : {
              publishStatus: detail ? FAILED_ENV_STATUS : LIVE_ENV_STATUS,
              publishError: detail ?? null,
              publishStatusAt: new Date(),
            },
      })
    },

    async requestFlush() {
      const { getKnativeProjectManager } = await import('../lib/knative-project-manager')
      // A *published* pod's env carries `RUNTIME_AUTH_SECRET` — the project token —
      // and nothing else. `deriveProjectRuntimeToken` resolves to the workspace
      // token, which a published pod answers 401 to (verified on KIF's prod pod),
      // so the flush would look like a failure even on a runtime that has the route.
      const { deriveRuntimeToken } = await import('../lib/runtime-token')
      const manager = getKnativeProjectManager()
      try {
        const status = await manager.getServiceStatus(`published-${input.projectId}`, input.projectId)
        if (!status.exists || !status.ready || status.replicas <= 0) {
          return { ok: true, flushed: false, unchanged: false, warm: false }
        }
      } catch (err: any) {
        // A status read that fails says nothing about the pod's writes: treat it
        // as warm and let the flush itself decide.
        console.warn(`[Publish] Could not read published status before the freeze: ${err?.message ?? err}`)
      }
      try {
        const res = await fetch(`${manager.publishedServiceUrl(input.projectId)}/agent/published-data/flush`, {
          method: 'POST',
          headers: { 'x-runtime-token': await deriveRuntimeToken(input.projectId) },
          signal: AbortSignal.timeout(45_000),
        })
        const body = (await res.json().catch(() => ({}))) as {
          flushed?: boolean
          unchanged?: boolean
          error?: string
          message?: string
        }
        // A 404/405 here is a pod published before the flush endpoint existed:
        // not a failed freeze, but a wait for its own periodic upload.
        return flushResultFromResponse(res.status, body ?? {})
      } catch (err: any) {
        return { ok: false, flushed: false, unchanged: false, warm: true, detail: err?.message ?? String(err) }
      }
    },

    async headArchive() {
      const { defaultCutoverDeps } = await import('./published-cutover.service')
      const head = await defaultCutoverDeps().headArchive(input.subdomain)
      return head ? { lastModifiedMs: head.lastModifiedMs, bytes: head.bytes } : null
    },

    /**
     * `/agent/status` is the one probe every published runtime has had for as
     * long as published data has synced, so it works on a pod older than the
     * flush endpoint too.
     */
    async podAnswers() {
      const { getKnativeProjectManager } = await import('../lib/knative-project-manager')
      const { deriveRuntimeToken } = await import('../lib/runtime-token')
      const manager = getKnativeProjectManager()
      try {
        const res = await fetch(`${manager.publishedServiceUrl(input.projectId)}/agent/status`, {
          headers: { 'x-runtime-token': await deriveRuntimeToken(input.projectId) },
          signal: AbortSignal.timeout(15_000),
        })
        return res.ok
      } catch {
        return false
      }
    },

    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (message) => console.log(message),
  }
}
