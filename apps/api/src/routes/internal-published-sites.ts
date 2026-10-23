// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Internal published-site reconcile routes (SHO-138).
 *
 * `apps/api/src/services/published-site-sweep.ts` finds `published-{id}`
 * runtimes whose project is gone (deleted projects used to leave their site
 * serving) and, when asked to apply, tears them down. These routes let an
 * operator run it from inside the cluster — the only place that can see both
 * the substrate inventory (Knative ksvcs + DomainMappings, metal placements) and
 * the region's DB.
 *
 * Mounted at `/api/internal/published-sites/*`, which shares the
 * `/api/internal/*` auth-skip; every handler enforces its own shared secret.
 *
 *   GET  /rows?ids=a,b,c      project publish rows this region knows about
 *   POST /sweep { dryRun }    run the sweep (DRY RUN unless dryRun === false)
 *
 * Both are read-only without `dryRun: false` plus a matching
 * `PUBLISHED_SITE_SWEEP_SECRET` header (`x-published-sweep-secret`).
 */

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import {
  createPublishedSiteSweepDeps,
  runPublishedSiteSweep,
  type ProjectPublishRow,
} from '../services/published-site-sweep'

const app = new Hono()

function sweepSecret(): string | null {
  return process.env.PUBLISHED_SITE_SWEEP_SECRET || null
}

function authorized(header: string | undefined): boolean {
  const expected = sweepSecret()
  // Unset secret → the endpoint is disabled, exactly like the e2e bootstrap.
  if (!expected || !header) return false
  return header === expected
}

function unauthorized() {
  return { error: { code: 'sweep_disabled', message: 'Published-site sweep is not enabled (PUBLISHED_SITE_SWEEP_SECRET unset or wrong secret)' } }
}

/**
 * GET /rows?ids=a,b,c
 *
 * The project rows THIS region can see, for the given ids. A peer region calls
 * this so a sweep never deletes a site whose project lives in the other region.
 */
app.get('/rows', async (c) => {
  if (!authorized(c.req.header('x-published-sweep-secret'))) return c.json(unauthorized(), 403)

  const ids = (c.req.query('ids') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (ids.length === 0) return c.json({ rows: [] })

  const rows = await prisma.project.findMany({
    where: { id: { in: ids } },
    select: { id: true, publishedSubdomain: true, publishStatus: true },
  })
  return c.json({
    rows: rows.map((row) => ({
      id: row.id,
      publishedSubdomain: row.publishedSubdomain ?? null,
      publishStatus: (row as any).publishStatus ?? null,
    })),
  })
})

/**
 * POST /sweep   { dryRun?: boolean, minAgeMs?: number }
 *
 * Dry run by default: returns what it WOULD remove without touching anything.
 * `dryRun: false` is the apply — read the dry-run report and confirm every
 * selected id/subdomain really is dead BEFORE applying, because a torn-down site
 * cannot be restored.
 */
app.post('/sweep', async (c) => {
  if (!authorized(c.req.header('x-published-sweep-secret'))) return c.json(unauthorized(), 403)

  let body: { dryRun?: boolean; minAgeMs?: number } = {}
  try {
    body = await c.req.json()
  } catch {
    // Empty body is a dry run.
  }

  // Peer regions: a project homed elsewhere must never be deleted from here.
  // `PUBLISHED_SITE_SWEEP_PEERS` is a comma-separated list of api base URLs
  // (e.g. "http://api.production-us.shogo.svc.cluster.local:3000").
  //
  // Coverage FAILS CLOSED. Both selection rules read an ABSENT row as an orphan,
  // so a peer we could not reach (or never asked) turns a live project into a
  // teardown candidate. A deployment that really has no peer region declares it
  // with `PUBLISHED_SITE_SWEEP_SINGLE_REGION=true`; anything else must name its
  // peers, and every one of them has to answer.
  const peerUrls = (process.env.PUBLISHED_SITE_SWEEP_PEERS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean)
  const declaredSingleRegion = process.env.PUBLISHED_SITE_SWEEP_SINGLE_REGION === 'true'
  const secret = sweepSecret()

  const deps = await createPublishedSiteSweepDeps({
    loadPeerRows: async (projectIds) => {
      if (declaredSingleRegion && peerUrls.length === 0) return { rows: [], complete: true }
      if (peerUrls.length === 0 || !secret) {
        console.warn(
          '[published-site-sweep] no peer regions configured and PUBLISHED_SITE_SWEEP_SINGLE_REGION is not "true" — row coverage is incomplete, so nothing will be selected',
        )
        return { rows: [], complete: false }
      }
      const rows: Array<{ id: string } & ProjectPublishRow> = []
      const unreachable: string[] = []
      await Promise.all(
        peerUrls.map(async (base) => {
          try {
            const res = await fetch(
              `${base}/api/internal/published-sites/rows?ids=${encodeURIComponent(projectIds.join(','))}`,
              {
                headers: { 'x-published-sweep-secret': secret },
                signal: AbortSignal.timeout(15_000),
              },
            )
            if (!res.ok) {
              console.warn(`[published-site-sweep] peer ${base} returned ${res.status}`)
              unreachable.push(`${base} (${res.status})`)
              return
            }
            const json = (await res.json()) as { rows?: Array<{ id: string } & ProjectPublishRow> }
            if (!Array.isArray(json.rows)) {
              unreachable.push(`${base} (no rows array)`)
              return
            }
            rows.push(...json.rows)
          } catch (err: any) {
            console.warn(`[published-site-sweep] peer ${base} lookup failed:`, err?.message ?? err)
            unreachable.push(`${base} (${err?.message ?? 'error'})`)
          }
        }),
      )
      if (unreachable.length) {
        console.warn(
          `[published-site-sweep] ${unreachable.length}/${peerUrls.length} peer region(s) unreachable: ${unreachable.join(', ')}`,
        )
        return { rows, complete: false }
      }
      return { rows, complete: true }
    },
  })

  const report = await runPublishedSiteSweep(deps, {
    dryRun: body.dryRun !== false,
    minAgeMs: typeof body.minAgeMs === 'number' ? body.minAgeMs : undefined,
  })

  console.log(
    `[published-site-sweep] ${report.dryRun ? 'DRY RUN' : 'APPLY'}: ` +
      `row coverage ${report.rowCoverageComplete ? 'complete' : 'INCOMPLETE'}, ` +
      `${report.selected.length} to remove, ${report.tornDown.length} removed, ` +
      `${report.failed.length} failed, ${report.skipped.length} kept` +
      (report.blocked ? ` — blocked: ${report.blocked}` : ''),
  )

  const payload = {
    region: process.env.SHOGO_REGION || process.env.REGION_ID || null,
    peers: peerUrls.length,
    singleRegion: declaredSingleRegion,
    ...report,
  }

  // An apply on incomplete coverage is a refusal, not a no-op success: the
  // operator has to fix the peer configuration before anything may be deleted.
  if (report.blocked === 'row-coverage-incomplete') {
    return c.json(
      {
        ...payload,
        error: 'row-coverage-incomplete',
        message:
          'Refusing to delete: project rows for every region were not available. Set PUBLISHED_SITE_SWEEP_PEERS (and the same secret on each peer), or PUBLISHED_SITE_SWEEP_SINGLE_REGION=true if this deployment truly has no peer region.',
      },
      412,
    )
  }

  return c.json(payload)
})

export function publishedSiteSweepRoutes(): Hono {
  return app
}
