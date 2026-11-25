// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Publishing as a background job (SHO-542).
//
// The pipeline (build → upload → configure → tag → DB write) used to run inside
// the HTTP request, so any publish slower than Cloudflare's ~100s edge limit
// answered 524 while it carried on server-side — the panel never learned the
// outcome and a retry collided with the build still running.
//
// These tests pin the new contract on the real routes: the POST answers 202
// immediately, `publishStatus` is the observable state, a second publish is
// refused while one is in flight, and a dead publish is recovered on read.
// Fetch (the project pod) and S3 are faked; the state machine is real.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { publishInFlightTtlMs } from '@shogo/shared-runtime/publish-status'

process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
process.env.PUBLISH_BUCKET = 'test-publish-bucket'
process.env.PUBLISH_DOMAIN = 'shogo.one'
delete process.env.SHOGO_LOCAL_MODE

type Project = {
  id: string
  workspaceId: string
  publishedSubdomain: string | null
  publishedAlwaysOn: boolean
  publishStatus: string
  publishError: string | null
  publishStatusAt: Date | null
  accessLevel: string
  sitePasswordHash: string | null
  siteTitle: string | null
  siteDescription: string | null
  publishedAt: Date | null
}

const projects = new Map<string, Project>()
/** Every status write the pipeline makes, in order — the ladder clients poll. */
const statusWrites: Array<{ status: string; error: string | null }> = []
/** Knative merge-patches: the publish-in-flight lock's acquire / release. */
const lockPatches: Array<Record<string, any> | null> = []

/** When set, the S3 upload parks here until the test releases it. */
let uploadGate: Promise<void> | null = null
/** When set, configuring the published service throws this. */
let configureError: Error | null = null

function seed(id: string, subdomain: string | null = null): Project {
  const row: Project = {
    id,
    workspaceId: 'ws_1',
    publishedSubdomain: subdomain,
    publishedAlwaysOn: false,
    publishStatus: 'idle',
    publishError: null,
    publishStatusAt: null,
    accessLevel: 'anyone',
    sitePasswordHash: null,
    siteTitle: null,
    siteDescription: null,
    publishedAt: null,
  }
  projects.set(id, row)
  return row
}

const prismaApi = {
  project: {
    findUnique: async ({ where }: any) => {
      if (where.id) {
        const row = projects.get(where.id)
        return row ? { ...row } : null
      }
      if (where.publishedSubdomain) {
        for (const row of projects.values()) {
          if (row.publishedSubdomain === where.publishedSubdomain) return { id: row.id }
        }
      }
      return null
    },
    findFirst: async () => null,
    update: async ({ where, data }: any) => {
      if (typeof data?.publishStatus === 'string') {
        statusWrites.push({ status: data.publishStatus, error: data.publishError ?? null })
      }
      const row = projects.get(where.id)
      if (row) Object.assign(row, data)
      return row ? { ...row } : null
    },
    // The in-flight lease: one conditional statement, like the real updateMany.
    updateMany: async ({ where, data }: any) => {
      const row = projects.get(where.id)
      if (!row) return { count: 0 }
      const inFlight = ['building', 'uploading', 'configuring'].includes(row.publishStatus)
      const at = row.publishStatusAt instanceof Date ? row.publishStatusAt.getTime() : 0
      const stale = !at || Date.now() - at > 30 * 60_000
      if (inFlight && !stale) return { count: 0 }
      if (typeof data?.publishStatus === 'string') {
        statusWrites.push({ status: data.publishStatus, error: data.publishError ?? null })
      }
      Object.assign(row, data)
      return { count: 1 }
    },
  },
  customDomain: { findMany: async () => [] },
  publishedEnvironment: {
    findUnique: async () => null,
    create: async ({ data }: any) => ({ id: 'env-1', minReplicas: 0, maxReplicas: 1, size: 's', ...data }),
    update: async ({ data }: any) => ({ id: 'env-1', ...data }),
  },
  publishedDeployment: { create: async ({ data }: any) => ({ id: 'dep-1', ...data }) },
}

mock.module('../../lib/prisma', () => ({
  prisma: prismaApi,
  SubscriptionStatus: {},
  BillingInterval: {},
}))
mock.module('../../services/billing.service', () => ({
  canPublishSubdomain: async () => true,
  canEnableAlwaysOn: async () => ({ allowed: true, planAllows: true, allowance: 1, used: 0 }),
  getAlwaysOnAllowanceForWorkspace: async () => 1,
  countAlwaysOnUsed: async () => 0,
}))
mock.module('../../lib/knative-project-manager', () => ({
  getProjectPodUrl: async () => 'http://pod.local',
  mergePatchKnativeService: async (_ns: string, _name: string, patch: any) => {
    lockPatches.push(patch?.metadata?.annotations?.['shogo.io/publish-in-flight'] ?? null)
  },
  getKnativeProjectManager: () => ({}),
}))
mock.module('../../lib/project-runtime-token', () => ({
  deriveProjectRuntimeToken: async () => 'tok',
}))
mock.module('../../lib/cloudflare-site-auth-kv', () => ({
  getSiteAuthKvConfig: () => null,
  setSitePassword: async () => true,
  clearSitePassword: async () => true,
  hashSitePassword: () => 'hash',
}))
mock.module('../../lib/cloudflare-custom-hostnames', () => ({
  // No Cloudflare in this test: every hostname call is a no-op.
  getCustomHostnamesConfig: () => null,
  _resetCustomHostnamesConfigForTest: () => {},
  createCustomHostname: async () => null,
  getCustomHostname: async () => null,
  retriggerCustomHostname: async () => null,
  findCustomHostnameByName: async () => null,
  deleteCustomHostname: async () => true,
  putHostnameMapping: async () => true,
  deleteHostnameMapping: async () => true,
}))
mock.module('../../lib/publish-storage', () => ({
  PUBLISH_BUCKET: 'test-publish-bucket',
  PUBLISH_DATA_BUCKET: null,
  publishS3Client: {
    send: async (cmd: any) => {
      // The upload step is where a real publish spends its slowest minute.
      if (uploadGate && String(cmd?.constructor?.name).startsWith('PutObject')) await uploadGate
      return {}
    },
  },
  deletePublishedStaticBundle: async () => {},
  deletePublishedDataArchive: async () => {},
}))
mock.module('../../lib/substrate/router', () => ({
  getPublishSubstrate: async () => ({
    kind: 'knative',
    publish: async () => {
      if (configureError) throw configureError
      return { substrate: 'knative', serverBacked: false, url: 'https://pod.local' }
    },
    setPublishedAlwaysOn: async () => {},
    unpublish: async () => {},
  }),
}))
mock.module('../../lib/publish-substrate-config', () => ({
  // The publish route asks for the whole decision (§G1): an environment already
  // on Postgres stays there. These tests keep everything on SQLite.
  resolvePublishDbProvider: () => ({ provider: 'sqlite', reason: 'off' }),
  missingProjectsDatabaseConfig: () => [],
}))
mock.module('../../services/published-environments.service', () => ({
  ensureProductionEnvironment: async (projectId: string, subdomain: string) => ({
    id: 'env-1',
    projectId,
    name: 'production',
    subdomain,
    minReplicas: 0,
    maxReplicas: 1,
    size: 's',
  }),
  getEnvironment: async () => null,
  scaleSettingsOf: () => ({ minReplicas: 0, maxReplicas: 1, size: 's' }),
}))
mock.module('../../services/published-deployments.service', () => ({
  recordPublishedDeployment: async () => ({ id: 'dep-1' }),
  markPublishedDeploymentReady: async () => {},
  markPublishedDeploymentFailed: async () => {},
}))
mock.module('../../services/published-ops.service', () => ({
  resolvePublishedImageRef: () => 'img:test',
  setEnvironmentPublishStatus: async () => {},
}))
mock.module('../../services/publish-git.service', () => ({
  // No durable repo on this side: no tag, no checkpoint, no pointer to drop.
  flushGitSync: async () => ({}),
  deletePublishPointer: async () => {},
}))
mock.module('../../services/checkpoint.service', () => ({
  recordCheckpointForCommit: async () => {},
}))

const DIST_FILES = [
  { path: 'index.html', content: Buffer.from('<html>async</html>').toString('base64') },
]

const realFetch = globalThis.fetch
beforeEach(() => {
  globalThis.fetch = (async (url: any) => {
    const path = new URL(String(url)).pathname
    if (path === '/agent/server-info') return Response.json({ serverBacked: false })
    if (path === '/agent/publish-build') return Response.json({ ok: true })
    if (path === '/agent/dist-files') return Response.json(DIST_FILES)
    return new Response('{}', { status: 200 })
  }) as any
  projects.clear()
  statusWrites.length = 0
  lockPatches.length = 0
  uploadGate = null
  configureError = null
})
afterEach(() => {
  globalThis.fetch = realFetch
})

const { publishRoutes } = await import('../publish')
const app = publishRoutes()

function postPublish(projectId: string, body: any = {}) {
  return app.request(`/projects/${projectId}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function getState(projectId: string) {
  return app.request(`/projects/${projectId}/publish`)
}

/** Let the background pipeline run until `done()` (or fail the test). */
async function until(done: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (done()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('publish as a background job', () => {
  it('answers 202 in well under the edge limit while the pipeline keeps running', async () => {
    seed('p1')
    // Park the pipeline in `uploading`: this is the slow middle the old
    // request-scoped publish held the connection through.
    let releaseUpload!: () => void
    uploadGate = new Promise<void>((r) => {
      releaseUpload = r
    })

    const startedAt = Date.now()
    const res = await postPublish('p1', { subdomain: 'async-app' })
    const elapsed = Date.now() - startedAt

    // AC 1: accepted fast, with the state the client polls.
    expect(res.status).toBe(202)
    expect(elapsed).toBeLessThan(2_000)
    expect(await res.json()).toMatchObject({
      accepted: true,
      status: 'building',
      subdomain: 'async-app',
      url: 'https://async-app.shogo.one',
    })

    // The pipeline really is still running: it is in the upload step.
    await until(() => projects.get('p1')!.publishStatus === 'uploading', 'uploading')
    const during = await (await getState('p1')).json()
    expect(during.subdomain).toBeUndefined()
    expect(during.publishStatus).toBe('uploading')

    releaseUpload()
    await until(() => projects.get('p1')!.publishStatus === 'live', 'live')

    // AC 1: the ladder is observable, and GET reports the live URL afterwards.
    const ladder = statusWrites.map((w) => w.status)
    expect(ladder[0]).toBe('building')
    expect(ladder).toContain('uploading')
    expect(ladder).toContain('configuring')
    expect(ladder[ladder.length - 1]).toBe('live')

    const after = await (await getState('p1')).json()
    expect(after.subdomain).toBe('async-app')
    expect(after.subdomain).toBe('async-app')
    expect(after.publishStatus).toBe('live')
    // `undefined`: the GET omits the field rather than sending null on success.
    expect(after.publishError).toBeUndefined()

    // AC 5: the publish lock is taken for the pipeline and released after it.
    const lockValues = lockPatches
    expect(lockValues.length).toBeGreaterThanOrEqual(2)
    expect(lockValues[0]).not.toBeNull()
    expect(lockValues[lockValues.length - 1]).toBeNull()
  })

  it('ends at failed with the step code, and GET reports publishError', async () => {
    seed('p1')
    configureError = new Error('knative said no')

    expect((await postPublish('p1', { subdomain: 'broken-app' })).status).toBe(202)
    await until(() => projects.get('p1')!.publishStatus === 'failed', 'failed')

    expect(projects.get('p1')!.publishError).toBe('configure_failed: knative said no')

    const state = await (await getState('p1')).json()
    expect(state.subdomain).toBeUndefined()
    expect(state.publishStatus).toBe('failed')
    // The code is what a client switches on; the reason is what a person reads.
    expect(state.publishError).toBe('configure_failed')
    expect(state.publishErrorMessage).toBe('knative said no')

    // AC 5: the failed pipeline released the subdomain claim, so the same name
    // can be published again as soon as the cause is fixed.
    configureError = null
    expect((await postPublish('p1', { subdomain: 'broken-app' })).status).toBe(202)
    await until(() => projects.get('p1')!.publishStatus === 'live', 'live after retry')
  })

  it('refuses a second publish while one is in flight with 409 publish_in_progress', async () => {
    seed('p1')
    let releaseUpload!: () => void
    uploadGate = new Promise<void>((r) => {
      releaseUpload = r
    })

    expect((await postPublish('p1', { subdomain: 'busy-app' })).status).toBe(202)
    await until(() => projects.get('p1')!.publishStatus === 'uploading', 'uploading')

    const second = await postPublish('p1', { subdomain: 'busy-app' })
    expect(second.status).toBe(409)
    expect((await second.json()).error.code).toBe('publish_in_progress')

    // The refused retry must not have started a second pipeline: one upload
    // step, and the accepted publish finishes on its own.
    releaseUpload()
    await until(() => projects.get('p1')!.publishStatus === 'live', 'live')
    expect(statusWrites.filter((w) => w.status === 'uploading')).toHaveLength(1)
    expect(statusWrites.filter((w) => w.status === 'configuring')).toHaveLength(1)
  })

  it('recovers a publish whose API pod died: stale in-flight reads as publish_interrupted', async () => {
    seed('p1')
    // An API restart mid-publish leaves `building` behind with nobody running it.
    const row = projects.get('p1')!
    row.publishStatus = 'building'
    // Older than the lease, whatever the lease currently is: it is derived from
    // the step budgets (max(10m, request budget + 30s)), so a hardcoded age
    // silently stops being stale the moment a budget grows — which is exactly
    // what raising the readiness timeout to 300s did.
    row.publishStatusAt = new Date(Date.now() - publishInFlightTtlMs() - 60_000)

    const state = await (await getState('p1')).json()
    expect(state.publishStatus).toBe('failed')
    expect(state.publishError).toBe('publish_interrupted')
    // AC 4: written back, so the panel and the next publish both see it.
    expect(projects.get('p1')!.publishStatus).toBe('failed')

    // …and a new publish is accepted instead of being blocked by the dead lease.
    expect((await postPublish('p1', { subdomain: 'recovered' })).status).toBe(202)
    await until(() => projects.get('p1')!.publishStatus === 'live', 'live')
    expect(projects.get('p1')!.publishedSubdomain).toBe('recovered')
  })

  it('keeps validation synchronous: a bad subdomain is still a 400, not a 202', async () => {
    seed('p1')
    const res = await postPublish('p1', { subdomain: 'Not A Subdomain!' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_subdomain')
    expect(statusWrites).toHaveLength(0)
  })

  it('refuses a password-gated publish with no password, and hands the name back', async () => {
    // AC 2's fourth synchronous refusal. It used to be the one path that both
    // refused and gave up the claim; `preparePublish` owns it now.
    seed('p1')
    const refused = await postPublish('p1', { subdomain: 'gated-app', accessLevel: 'password' })
    expect(refused.status).toBe(400)
    expect((await refused.json()).error.code).toBe('password_required')
    // Nothing was started: the lease was never taken.
    expect(statusWrites).toHaveLength(0)
    expect(projects.get('p1')!.publishStatus).toBe('idle')

    // The claim this call took was released on the way out, so the name is free.
    seed('p2')
    expect((await postPublish('p2', { subdomain: 'gated-app' })).status).toBe(202)
    await until(() => projects.get('p2')!.publishStatus === 'live', 'live')
    expect(projects.get('p2')!.publishedSubdomain).toBe('gated-app')
  })

  it('a refused retry keeps the claim the running publish holds', async () => {
    // The claim is per subdomain, and the 409 path used to release it — so a
    // double-tap on one project dropped the claim its own publish was holding,
    // and another project could then take the name and upload over the running
    // publish's files (the SHO-207 window the claim exists to close).
    seed('p1')
    let releaseUpload!: () => void
    uploadGate = new Promise<void>((r) => {
      releaseUpload = r
    })

    expect((await postPublish('p1', { subdomain: 'held-app' })).status).toBe(202)
    await until(() => projects.get('p1')!.publishStatus === 'uploading', 'uploading')

    const retry = await postPublish('p1', { subdomain: 'held-app' })
    expect(retry.status).toBe(409)
    expect((await retry.json()).error.code).toBe('publish_in_progress')

    // The name is still p1's: a different project is refused by the claim, not
    // merely by the DB check (which cannot see an uncommitted subdomain).
    seed('p2')
    const other = await postPublish('p2', { subdomain: 'held-app' })
    expect(other.status).toBe(409)
    expect((await other.json()).error.code).toBe('subdomain_taken')

    releaseUpload()
    await until(() => projects.get('p1')!.publishStatus === 'live', 'live')
    expect(projects.get('p1')!.publishedSubdomain).toBe('held-app')
  })
})
