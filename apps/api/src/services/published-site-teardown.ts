// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tear down a project's PUBLISHED site ({subdomain}.shogo.one) everywhere it
 * lives.
 *
 * This is the ONE place that knows what a published site is made of, so the
 * unpublish route and the project-delete hook can't drift apart:
 *
 *   1. the published runtime + edge routing on BOTH substrates (Knative
 *      `published-{id}` ksvc + DomainMapping, metal `published:{id}` microVM +
 *      subdomain placement) — a drain/cutover project can have both;
 *   2. the static bundle in PUBLISH_BUCKET;
 *   3. the published-DATA archive (`{subdomain}/data.tar.gz`) — ONLY when the
 *      caller asks for it: unpublish keeps it so a republish restores end-user
 *      writes, project delete purges it because nothing can republish again;
 *   4. the site-password gate in the Worker KV;
 *   5. the server-backed flag in the Worker KV (a stale flag would keep the
 *      Worker proxying `/api/*` at a backend that no longer exists);
 *   6. the custom-domain KV mappings of every domain pointing at the project;
 *   7. the stable `published/<subdomain>` git pointer.
 *
 * Every step is independent and best-effort: one failure is logged and the rest
 * still run, and the caller always gets a per-step outcome it can log/report.
 * Nothing here touches the DB — the caller owns the project row, and the delete
 * hook runs after the row is already gone.
 */

import { prisma } from '../lib/prisma'
import { clearSitePassword } from '../lib/cloudflare-site-auth-kv'
import { clearServerBackedFlag } from '../lib/cloudflare-server-backed-kv'
import { getCustomHostnamesConfig, deleteHostnameMapping } from '../lib/cloudflare-custom-hostnames'
import { deletePublishedStaticBundle, deletePublishedDataArchive } from '../lib/publish-storage'
import { deletePublishPointer } from './publish-git.service'

/** Per-step result. `ok:false` is logged, never thrown. */
export interface TeardownStepOutcome {
  step: TeardownStep
  ok: boolean
  error?: string
}

export type TeardownStep =
  | 'runtime'
  | 'static-bundle'
  | 'published-data'
  | 'site-password'
  | 'server-backed-flag'
  | 'custom-domains'
  | 'publish-pointer'

/**
 * Test seam: every side effect is injectable so the unit tests can assert what
 * the teardown calls without a cluster, S3, Cloudflare or a pod. Production uses
 * the defaults below.
 */
export interface PublishedSiteTeardownDeps {
  unpublishRuntime: (projectId: string, subdomain: string) => Promise<void>
  deleteStaticBundle: (subdomain: string) => Promise<void>
  deleteDataArchive: (subdomain: string) => Promise<void>
  clearSitePassword: (subdomain: string) => Promise<void>
  clearServerBackedFlag: (subdomain: string) => Promise<void>
  clearCustomDomains: (projectId: string) => Promise<void>
  deletePublishPointer: (projectId: string, subdomain: string) => Promise<void>
}

/**
 * Remove the Worker KV routing for all of a project's custom domains so they
 * stop serving once the project is unpublished. CF custom hostnames + DB rows
 * are kept so a later republish restores routing. Best-effort.
 */
async function clearCustomDomainKv(projectId: string): Promise<void> {
  if (!getCustomHostnamesConfig()) return
  const domains = await prisma.customDomain.findMany({
    where: { projectId },
    select: { hostname: true },
  })
  for (const d of domains) {
    await deleteHostnameMapping(d.hostname)
  }
}

const defaultDeps: PublishedSiteTeardownDeps = {
  unpublishRuntime: async (projectId, subdomain) => {
    // Lazily imported: this pulls the k8s/metal control planes, and the delete
    // hook runs on every project delete (desktop included, where it no-ops).
    const { unpublishProjectEverywhere } = await import('../lib/substrate/router')
    await unpublishProjectEverywhere(projectId, subdomain)
  },
  deleteStaticBundle: deletePublishedStaticBundle,
  deleteDataArchive: deletePublishedDataArchive,
  clearSitePassword: async (subdomain) => {
    await clearSitePassword(subdomain)
  },
  clearServerBackedFlag: async (subdomain) => {
    await clearServerBackedFlag(subdomain)
  },
  clearCustomDomains: clearCustomDomainKv,
  deletePublishPointer,
}

export interface TeardownPublishedSiteOptions {
  /**
   * Also delete the published-data archive. FALSE for unpublish (kept so a
   * republish restores end-user writes), TRUE for project delete (nothing can
   * republish a project whose row is gone).
   */
  purgePublishedData?: boolean
  /**
   * Drop the `published/<subdomain>` git pointer. Default TRUE. The project
   * DELETE hook passes FALSE: the pointer lives in the project's own pod repo
   * and dropping it resolves the pod URL, which COLD-STARTS a runtime for a
   * project that no longer exists. The row is gone, so nothing resolves that
   * pointer any more anyway.
   */
  dropPublishPointer?: boolean
  /** Test seam; merged over the production defaults. */
  deps?: Partial<PublishedSiteTeardownDeps>
}

/**
 * Tear down a published site. Never throws: each step is attempted, failures are
 * collected. Returns one outcome per attempted step, in execution order.
 */
export async function teardownPublishedSite(
  projectId: string,
  subdomain: string,
  opts: TeardownPublishedSiteOptions = {},
): Promise<TeardownStepOutcome[]> {
  const deps: PublishedSiteTeardownDeps = { ...defaultDeps, ...opts.deps }

  const steps: Array<[TeardownStep, () => Promise<void>]> = [
    ['runtime', () => deps.unpublishRuntime(projectId, subdomain)],
    ['static-bundle', () => deps.deleteStaticBundle(subdomain)],
    ...(opts.purgePublishedData
      ? ([['published-data', () => deps.deleteDataArchive(subdomain)]] as Array<[TeardownStep, () => Promise<void>]>)
      : []),
    ['site-password', () => deps.clearSitePassword(subdomain)],
    ['server-backed-flag', () => deps.clearServerBackedFlag(subdomain)],
    ['custom-domains', () => deps.clearCustomDomains(projectId)],
    ...(opts.dropPublishPointer === false
      ? []
      : ([['publish-pointer', () => deps.deletePublishPointer(projectId, subdomain)]] as Array<
          [TeardownStep, () => Promise<void>]
        >)),
  ]

  const outcomes: TeardownStepOutcome[] = []
  for (const [step, run] of steps) {
    try {
      await run()
      outcomes.push({ step, ok: true })
    } catch (err: any) {
      console.warn(
        `[published-site-teardown] ${step} failed for ${projectId} (${subdomain}):`,
        err?.message ?? err,
      )
      outcomes.push({ step, ok: false, error: err?.message ?? String(err) })
    }
  }
  return outcomes
}
