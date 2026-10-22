// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Orphaned published-site reconcile sweep.
 *
 * `project.afterDelete` now tears a published site down, so nothing NEW leaks.
 * This sweep is for what already leaked, plus the best-effort steps in that
 * teardown that fail silently on a bad day (a ksvc deleted but its
 * DomainMapping left behind, an unpublish whose S3 call timed out): a periodic,
 * safe-to-re-run pass that removes `published-{id}` runtimes whose PROJECT IS
 * GONE, or whose row says the project is not published.
 *
 * It is deliberately conservative — it never touches a project that still has a
 * subdomain, a publish that is mid-flight, or a runtime younger than
 * `minAgeMs` (1 h). Deleting customer-facing infra is the one thing a mistake
 * here can't undo, so the decision function is pure and unit-tested, and every
 * sweep is a DRY RUN unless the caller explicitly asks to apply.
 *
 * Dry-run output is what the card needs before the first prod run: the ids and
 * subdomains it would remove.
 */

import type { SubstrateKind } from '../lib/substrate/types'

/** One published runtime found on a substrate. */
export interface PublishedRuntimeSnapshot {
  projectId: string
  substrate: SubstrateKind
  /** Runtime identifier for logs (ksvc name / metal published runtime key). */
  name: string
  /** Public subdomain it serves; null when the substrate can't report one. */
  subdomain: string | null
  /** Creation time (ms epoch), or null when the substrate doesn't report one. */
  createdAtMs: number | null
}

/** The slice of a project row the decision needs. */
export interface ProjectPublishRow {
  publishedSubdomain: string | null
  publishStatus: string | null
}

export type SweepSkipReason =
  | 'no-subdomain'
  | 'has-subdomain'
  | 'publishing'
  | 'too-young'
  | 'row-coverage-incomplete'

export interface SweepDecision {
  projectId: string
  substrate: SubstrateKind
  name: string
  subdomain: string
  reason: 'project-row-missing' | 'row-unpublished'
}

export interface SweepSkip {
  projectId: string
  substrate: SubstrateKind
  name: string
  reason: SweepSkipReason
}

/**
 * Publish states that mean "a publish is happening right now — hands off".
 * These are exactly the members of the Prisma `PublishStatus` enum that a first
 * publish passes through BEFORE `publishedSubdomain` is written (at the very
 * end, together with `live`): `building` → `uploading` → `configuring`. The
 * last one matters most — `configuring` is when `published-{id}` and its
 * DomainMapping are created, i.e. when this sweep first has something to find.
 */
const PUBLISHING_STATES = new Set(['building', 'uploading', 'configuring'])

export const DEFAULT_SWEEP_MIN_AGE_MS = 60 * 60 * 1000

/**
 * Decide which published runtimes are orphans. Pure: no I/O, no clock reads
 * (pass `now`), so the whole rule set is unit-testable.
 *
 * Selects a runtime when:
 *   - its project row is missing from EVERY region we were given rows for, or
 *   - its row exists, has no `publishedSubdomain`, isn't publishing, and the
 *     runtime is older than `minAgeMs`.
 * Never selects a runtime whose row still has a subdomain, whose publish is in
 * flight, that is younger than `minAgeMs`, or whose subdomain we don't know
 * (without it we can't purge the right S3 prefix / KV entry, and a half teardown
 * is worse than none).
 *
 * `rowCoverageComplete: false` selects NOTHING. Both rules above are conclusions
 * drawn from what the row map does *not* contain, so a row map missing a peer
 * region reads as "this project's row is gone" for a project that is in fact
 * alive in that region — and the teardown is not recoverable. Callers that
 * cannot prove they saw every region must leave this false; the default is true
 * only so a single caller with local rows can state the pure rule directly.
 */
export function selectOrphanedPublishedSites(input: {
  runtimes: PublishedRuntimeSnapshot[]
  rowsById: Map<string, ProjectPublishRow> | Record<string, ProjectPublishRow>
  now?: number
  minAgeMs?: number
  rowCoverageComplete?: boolean
}): { selected: SweepDecision[]; skipped: SweepSkip[] } {
  const now = input.now ?? Date.now()
  const minAgeMs = input.minAgeMs ?? DEFAULT_SWEEP_MIN_AGE_MS
  const rows = input.rowsById instanceof Map ? input.rowsById : new Map(Object.entries(input.rowsById))
  const rowCoverageComplete = input.rowCoverageComplete !== false

  const selected: SweepDecision[] = []
  const skipped: SweepSkip[] = []
  const seen = new Set<string>()

  for (const rt of input.runtimes) {
    const base = { projectId: rt.projectId, substrate: rt.substrate, name: rt.name }
    const skip = (reason: SweepSkipReason) => skipped.push({ ...base, reason })

    // Two substrates can hold the same project's site during a cutover; one
    // decision per project is enough (the teardown covers both).
    if (seen.has(rt.projectId)) continue

    if (!rowCoverageComplete) {
      skip('row-coverage-incomplete')
      continue
    }

    if (!rt.subdomain) {
      skip('no-subdomain')
      continue
    }

    const row = rows.get(rt.projectId)
    if (!row) {
      // The project row is gone everywhere we can see — nothing can ever
      // republish or reference this site again.
      seen.add(rt.projectId)
      selected.push({ ...base, subdomain: rt.subdomain, reason: 'project-row-missing' })
      continue
    }

    if (row.publishedSubdomain) {
      // Still published per the DB: the runtime is the live site, keep it.
      skip('has-subdomain')
      continue
    }
    if (row.publishStatus && PUBLISHING_STATES.has(row.publishStatus.toLowerCase())) {
      skip('publishing')
      continue
    }
    if (rt.createdAtMs !== null && now - rt.createdAtMs < minAgeMs) {
      skip('too-young')
      continue
    }

    seen.add(rt.projectId)
    selected.push({ ...base, subdomain: rt.subdomain, reason: 'row-unpublished' })
  }

  return { selected, skipped }
}

/**
 * Merge this region's rows with the rows other regions reported. A project id
 * has a row in EVERY regional DB, and any one of them may hold the stale copy,
 * so the merge is deliberately one-sided:
 *
 *   - a row in any region keeps the project alive (never tear a site down for a
 *     row that only exists somewhere else), and
 *   - a `publishedSubdomain` from ANY region wins over a null, because the
 *     region that actually runs the project is the one that publishes it.
 *
 * Both rules can only ever KEEP a site, never remove one.
 */
export function mergeProjectRows(
  local: Map<string, ProjectPublishRow>,
  peerRows: Array<{ id: string } & ProjectPublishRow>,
): Map<string, ProjectPublishRow> {
  const merged = new Map(local)
  for (const row of peerRows) {
    const existing = merged.get(row.id)
    const peerSubdomain = row.publishedSubdomain ?? null
    if (!existing) {
      merged.set(row.id, {
        publishedSubdomain: peerSubdomain,
        publishStatus: row.publishStatus ?? null,
      })
      continue
    }
    if (peerSubdomain && !existing.publishedSubdomain) {
      merged.set(row.id, { ...existing, publishedSubdomain: peerSubdomain })
    }
  }
  return merged
}

/**
 * What a row load saw. `complete` is the load's own claim that it covered
 * EVERY region this deployment can have a project row in — the sweep refuses to
 * select anything when it is false, so a loader that cannot check must say so.
 */
export interface ProjectRowLoad {
  rows: Map<string, ProjectPublishRow>
  complete: boolean
}

export interface PublishedSiteSweepDeps {
  /** Published runtimes on every substrate this region runs. */
  listRuntimes: () => Promise<PublishedRuntimeSnapshot[]>
  /** Every project row visible across regions, keyed by project id. */
  loadProjectRows: (projectIds: string[]) => Promise<ProjectRowLoad>
  /** Tear a site down for good (substrates + S3 + KV + pointer + data archive). */
  teardown: (projectId: string, subdomain: string) => Promise<void>
  now?: () => number
  /** Non-fatal enumeration problems (a substrate that wouldn't list). */
  warn?: (message: string) => void
}

export interface SweepReport {
  dryRun: boolean
  /** Did the row load cover every region? False ⇒ nothing was selected. */
  rowCoverageComplete: boolean
  /** Why an apply refused to run, when it did. */
  blocked: 'row-coverage-incomplete' | null
  selected: SweepDecision[]
  skipped: SweepSkip[]
  tornDown: Array<{ projectId: string; subdomain: string }>
  failed: Array<{ projectId: string; subdomain: string; error: string }>
}

/**
 * Run the sweep. `dryRun` defaults to TRUE — a caller has to ask to delete
 * anything. Enumeration errors are reported, never thrown: a partial inventory
 * still produces a valid (smaller) report, and the decision function is safe on
 * a partial one.
 *
 * Apply REFUSES when the row load could not cover every region
 * (`rowCoverageComplete: false`): without all the rows, an alive project looks
 * deleted, and a torn-down site cannot be restored. The dry run still reports
 * the runtime inventory so an operator can see why it is blocking.
 */
export async function runPublishedSiteSweep(
  deps: PublishedSiteSweepDeps,
  opts: { dryRun?: boolean; minAgeMs?: number } = {},
): Promise<SweepReport> {
  const dryRun = opts.dryRun !== false
  const now = deps.now?.() ?? Date.now()

  const runtimes = await deps.listRuntimes()
  const load = await deps.loadProjectRows(runtimes.map((r) => r.projectId))
  const rowCoverageComplete = load.complete

  const { selected, skipped } = selectOrphanedPublishedSites({
    runtimes,
    rowsById: load.rows,
    now,
    minAgeMs: opts.minAgeMs,
    rowCoverageComplete,
  })

  const report: SweepReport = {
    dryRun,
    rowCoverageComplete,
    blocked: null,
    selected,
    skipped,
    tornDown: [],
    failed: [],
  }
  if (dryRun) return report

  if (!rowCoverageComplete) {
    // Defence in depth: the decision function already selected nothing, and an
    // apply must not be able to delete on a partial row map even if it did.
    report.blocked = 'row-coverage-incomplete'
    deps.warn?.(
      'apply refused: project rows for every region were not available, so an orphan cannot be told apart from a project homed in another region',
    )
    return report
  }

  for (const decision of selected) {
    try {
      await deps.teardown(decision.projectId, decision.subdomain)
      report.tornDown.push({ projectId: decision.projectId, subdomain: decision.subdomain })
    } catch (err: any) {
      const error = err?.message ?? String(err)
      deps.warn?.(`teardown failed for ${decision.projectId} (${decision.subdomain}): ${error}`)
      report.failed.push({ projectId: decision.projectId, subdomain: decision.subdomain, error })
    }
  }

  return report
}

/**
 * Production wiring: Knative published ksvcs + DomainMappings, metal published
 * placements, this region's project rows plus any peer region's, and the shared
 * teardown. Kept in one place so the internal route (and only it) has to know
 * how the pieces fit.
 */
export async function createPublishedSiteSweepDeps(opts: {
  /**
   * Extra regions' rows, e.g. from a peer API. The loader must report whether it
   * actually saw every peer — a `complete: false` result stops the sweep from
   * selecting anything, because "no row" and "no row *here*" are the same thing
   * in the map and only one of them means the project is gone.
   */
  loadPeerRows?: (
    projectIds: string[],
  ) => Promise<{ rows: Array<{ id: string } & ProjectPublishRow>; complete: boolean }>
} = {}): Promise<PublishedSiteSweepDeps> {
  return {
    listRuntimes: async () => {
      const out: PublishedRuntimeSnapshot[] = []

      // Knative: `published-{id}` ksvcs (labelled `shogo.io/component=published-app`)
      // plus their published DomainMappings, which carry the subdomain.
      try {
        const { getKnativeProjectManager } = await import('../lib/knative-project-manager')
        const manager = getKnativeProjectManager()
        const [services, mappings] = await Promise.all([
          manager.listAllServices(),
          manager.listPublishedDomainMappings(),
        ])
        const subdomainByProject = new Map<string, string>()
        const mappingCreatedByProject = new Map<string, number | null>()
        for (const m of mappings) {
          subdomainByProject.set(m.projectId, m.subdomain)
          mappingCreatedByProject.set(m.projectId, m.createdAtMs)
        }
        for (const svc of services) {
          if (!svc.name?.startsWith('published-')) continue
          const created = svc.status?.createdAt ? Date.parse(svc.status.createdAt) : NaN
          out.push({
            projectId: svc.projectId,
            substrate: 'knative',
            name: svc.name,
            subdomain: subdomainByProject.get(svc.projectId) ?? null,
            createdAtMs: Number.isFinite(created)
              ? created
              : (mappingCreatedByProject.get(svc.projectId) ?? null),
          })
        }
        // A DomainMapping whose ksvc is already gone is still an edge route to a
        // dead service — include it so the sweep can retire the mapping too.
        for (const m of mappings) {
          if (out.some((r) => r.projectId === m.projectId)) continue
          out.push({
            projectId: m.projectId,
            substrate: 'knative',
            name: m.hostname,
            subdomain: m.subdomain,
            createdAtMs: m.createdAtMs,
          })
        }
      } catch (err: any) {
        console.warn('[published-site-sweep] knative inventory failed:', err?.message ?? err)
      }

      // Metal: published placements (subdomain -> published:{id} microVM).
      try {
        const { isMetalEnabled } = await import('../lib/metal-eligibility')
        if (isMetalEnabled()) {
          const { getMetalPlacementRegistry } = await import('../lib/metal-placement-registry')
          const placements = await getMetalPlacementRegistry().listPublishedPlacements()
          for (const p of placements) {
            out.push({
              projectId: p.projectId,
              substrate: 'metal',
              name: `published:${p.projectId}`,
              subdomain: p.subdomain,
              // The registry records when the placement was last written, not
              // when the VM booted; a placement is refreshed on every wake, so
              // treating it as the age is the conservative (never-too-young) read.
              createdAtMs: p.updatedAt ?? null,
            })
          }
        }
      } catch (err: any) {
        console.warn('[published-site-sweep] metal inventory failed:', err?.message ?? err)
      }

      return out
    },

    loadProjectRows: async (projectIds) => {
      const rows = new Map<string, ProjectPublishRow>()
      const { prisma } = await import('../lib/prisma')
      const local = await prisma.project.findMany({
        where: { id: { in: projectIds } },
        select: { id: true, publishedSubdomain: true, publishStatus: true },
      })
      for (const row of local) {
        rows.set(row.id, {
          publishedSubdomain: row.publishedSubdomain ?? null,
          publishStatus: (row as any).publishStatus ?? null,
        })
      }
      const peers = opts.loadPeerRows
        ? await opts.loadPeerRows(projectIds)
        : {
            // No peer loader at all: this caller cannot see another region.
            // Treating that as "complete" is what makes a project homed
            // elsewhere look deleted, so it is incomplete by definition.
            rows: [] as Array<{ id: string } & ProjectPublishRow>,
            complete: false,
          }
      return {
        rows: mergeProjectRows(rows, peers.rows),
        complete: peers.complete,
      }
    },

    teardown: async (projectId, subdomain) => {
      const { teardownPublishedSite } = await import('./published-site-teardown')
      // `dropPublishPointer: false` for the same reason the delete hook does it:
      // resolving the pod URL for a project whose row is gone cold-starts a
      // runtime. The sweep's projects are exactly those.
      const outcomes = await teardownPublishedSite(projectId, subdomain, {
        purgePublishedData: true,
        dropPublishPointer: false,
      })
      const failed = outcomes.filter((o) => !o.ok)
      // Partial teardown is still progress (the ksvc usually goes first); only
      // surface it, the runtime step is the one that must stick.
      if (failed.some((f) => f.step === 'runtime')) {
        throw new Error(failed.map((f) => `${f.step}: ${f.error}`).join('; '))
      }
      if (failed.length) {
        console.warn(
          `[published-site-sweep] ${projectId} torn down with ${failed.length} failed step(s):`,
          failed.map((f) => `${f.step}: ${f.error}`).join('; '),
        )
      }
    },
  }
}
