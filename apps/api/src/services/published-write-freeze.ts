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

export interface FlushResult {
  ok: boolean
  /** The pod uploaded (its content had changed since the last upload). */
  flushed: boolean
  /** The archive already matched the pod's bytes, so no upload was needed. */
  unchanged: boolean
  /** False when nothing is serving — no pod, so no pending writes. */
  warm: boolean
  detail?: string
}

export interface WriteFreezeDeps {
  setMaintenance(on: boolean, detail?: string | null): Promise<void>
  requestFlush(): Promise<FlushResult>
  headArchive(): Promise<{ lastModifiedMs: number; bytes: number } | null>
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

      const deadline = startedAt + FLUSH_TIMEOUT_MS
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
          return {
            ok: false as const,
            code: 'write_freeze_failed',
            message:
              `The live app flushed its database but the archive did not update within ` +
              `${Math.round(FLUSH_TIMEOUT_MS / 1000)}s, so the last writes cannot be proven copied. ` +
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
      const { deriveProjectRuntimeToken } = await import('../lib/project-runtime-token')
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
          headers: { 'x-runtime-token': await deriveProjectRuntimeToken(input.projectId) },
          signal: AbortSignal.timeout(45_000),
        })
        const body = (await res.json().catch(() => ({}))) as {
          flushed?: boolean
          unchanged?: boolean
          error?: string
          message?: string
        }
        if (!res.ok) {
          return {
            ok: false,
            flushed: false,
            unchanged: false,
            warm: true,
            detail: body?.message ?? body?.error ?? `HTTP ${res.status}`,
          }
        }
        return {
          ok: true,
          flushed: body.flushed === true,
          unchanged: body.unchanged === true,
          warm: true,
        }
      } catch (err: any) {
        return { ok: false, flushed: false, unchanged: false, warm: true, detail: err?.message ?? String(err) }
      }
    },

    async headArchive() {
      const { defaultCutoverDeps } = await import('./published-cutover.service')
      const head = await defaultCutoverDeps().headArchive(input.subdomain)
      return head ? { lastModifiedMs: head.lastModifiedMs, bytes: head.bytes } : null
    },

    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (message) => console.log(message),
  }
}
