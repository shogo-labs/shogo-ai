// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-536 §B/§C — a publish is all-or-nothing, and a deployment row is `ready`
// only when the revision it names is.
//
// Two bugs, one pipeline. All three publish paths (production, staging,
// `/republish`) uploaded the new static files to S3 and purged the cache before
// `configurePublishedService` had a chance to fail, so a failed configure left
// the new frontend serving over an old or dead server. And every publish
// recorded its deployment as `ready` the moment the ksvc was created — the
// card's app carried a `ready` row while revisions 00006/00007 had died with
// ExitCode137.
//
// These cases drive the real `publishProject`, `deployToStaging` and
// `/republish` pipeline against an in-memory Project/PublishedEnvironment table
// and a fake substrate/S3, so what is asserted is the behaviour that matters:
// no upload when configure fails, and a deployment row that follows the
// revision.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
process.env.PUBLISH_BUCKET = 'test-publish-bucket'
process.env.CLOUDFLARE_API_TOKEN = 'cf-token'
process.env.CLOUDFLARE_PUBLISH_ZONE_ID = 'cf-zone'
delete process.env.SHOGO_LOCAL_MODE
delete process.env.PROJECTS_DB_ADMIN_URL
delete process.env.PUBLISH_DATA_BUCKET
delete process.env.PUBLISH_BUILD_REGISTRY

type ProjectRow = {
  id: string
  workspaceId: string
  publishedSubdomain: string | null
  publishedAt: Date | null
  publishStatus: string
  publishError: string | null
  publishStatusAt: Date | null
  publishedCommitSha: string | null
  publishedAlwaysOn: boolean
  accessLevel: string
  sitePasswordHash: string | null
}

let projectRow: ProjectRow
const envRows: Record<string, any> = {}
const deploymentRows: any[] = []
let deploymentSeq = 0

const prismaApi = {
  project: {
    findUnique: async ({ where }: any) => {
      if (where.id && projectRow && projectRow.id === where.id) return { ...projectRow }
      if (where.publishedSubdomain) {
        return projectRow?.publishedSubdomain === where.publishedSubdomain ? { id: projectRow.id } : null
      }
      return null
    },
    update: async ({ where, data }: any) => {
      if (!projectRow || projectRow.id !== where.id) throw new Error(`no project ${where.id}`)
      Object.assign(projectRow, data)
      return { ...projectRow }
    },
  },
  publishedEnvironment: {
    findUnique: async ({ where }: any) => {
      if (where.projectId_name) {
        const { projectId, name } = where.projectId_name
        return Object.values(envRows).find((e) => e.projectId === projectId && e.name === name) ?? null
      }
      if (where.id) return Object.values(envRows).find((e) => e.id === where.id) ?? null
      return null
    },
    create: async ({ data }: any) => {
      const row = {
        id: `penv_${Object.keys(envRows).length + 1}`,
        minReplicas: 0,
        maxReplicas: 1,
        size: 's',
        currentDeploymentId: null,
        publishStatus: 'idle',
        publishError: null,
        ...data,
      }
      envRows[row.id] = row
      return { ...row }
    },
    update: async ({ where, data }: any) => {
      const row = Object.values(envRows).find((e) => e.id === where.id)
      if (!row) throw new Error(`no environment ${where.id}`)
      Object.assign(row, data)
      return { ...row }
    },
  },
  publishedDeployment: {
    create: async ({ data }: any) => {
      const row = { id: `pdep_${++deploymentSeq}`, createdAt: new Date(), ...data }
      deploymentRows.push(row)
      return { ...row }
    },
    update: async ({ where, data }: any) => {
      const row = deploymentRows.find((d) => d.id === where.id)
      if (!row) throw new Error(`no deployment ${where.id}`)
      Object.assign(row, data)
      return { ...row }
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0
      for (const row of deploymentRows) {
        if (row.environmentId !== where.environmentId) continue
        if (where.id?.not && row.id === where.id.not) continue
        if (where.status && row.status !== where.status) continue
        Object.assign(row, data)
        count++
      }
      return { count }
    },
    findUnique: async ({ where }: any) => deploymentRows.find((d) => d.id === where.id) ?? null,
  },
  customDomain: { findMany: async () => [] },
}

const s3Puts: Array<{ key: string; size: number }> = []
mock.module('../../lib/prisma', () => ({ prisma: prismaApi, SubscriptionStatus: {}, BillingInterval: {} }))
mock.module('../../lib/publish-storage', () => ({
  PUBLISH_BUCKET: 'test-publish-bucket',
  PUBLISH_DATA_BUCKET: null,
  publishS3Client: {
    send: async (cmd: any) => {
      const input = cmd?.input ?? {}
      if (input.Key) s3Puts.push({ key: input.Key, size: input.Body?.length ?? 0 })
      return {}
    },
  },
  deletePublishedStaticBundle: async () => {},
  deletePublishedDataArchive: async () => {},
}))

const substrateCalls: Array<{ projectId: string; opts: any }> = []
let substratePublish: (projectId: string, opts: any) => Promise<any>
mock.module('../../lib/substrate/router', () => ({
  unpublishProjectEverywhere: async () => {},
  getPublishSubstrate: async () => ({
    kind: 'knative',
    publish: async (projectId: string, opts: any) => {
      substrateCalls.push({ projectId, opts })
      return substratePublish(projectId, opts)
    },
    setPublishedAlwaysOn: async () => {},
  }),
}))

const podUrl = 'http://pod.invalid'
mock.module('../../lib/knative-project-manager', () => ({
  getProjectPodUrl: async () => podUrl,
  mergePatchKnativeService: async () => {},
  getKnativeProjectManager: () => ({}),
}))
mock.module('../../lib/project-runtime-token', () => ({ deriveProjectRuntimeToken: async () => 'rt-test' }))
mock.module('../../services/billing.service', () => ({
  canPublishSubdomain: async () => true,
  canEnableAlwaysOn: async () => ({ allowed: true, planAllows: true, allowance: 1, used: 0 }),
  getAlwaysOnAllowanceForWorkspace: async () => 1,
  countAlwaysOnUsed: async () => 0,
}))
mock.module('../../services/publish-git.service', () => ({
  flushGitSync: async () => ({ sha: 'sha-1' }),
  deletePublishPointer: async () => {},
  syncProjectToGit: async () => {},
}))
mock.module('../../services/checkpoint.service', () => ({ recordCheckpointForCommit: async () => {} }))
mock.module('../../services/conversation-activity', () => ({ recordProjectPublished: async () => {} }))
mock.module('../../services/published-environments.service', () => ({
  ensureProductionEnvironment: async (projectId: string, subdomain: string) => {
    const key = `${projectId}:production`
    if (!envRows[key]) {
      envRows[key] = {
        id: `penv_${Object.keys(envRows).length + 1}`,
        projectId,
        name: 'production',
        subdomain,
        minReplicas: 0,
        maxReplicas: 1,
        size: 's',
        currentDeploymentId: null,
        publishStatus: 'idle',
        publishError: null,
      }
    }
    return envRows[key]
  },
  getEnvironment: async (projectId: string, name: string) => envRows[`${projectId}:${name}`] ?? null,
  createStagingEnvironment: async (projectId: string) => {
    const key = `${projectId}:staging`
    if (!envRows[key]) {
      envRows[key] = {
        id: `penv_${Object.keys(envRows).length + 1}`,
        projectId,
        name: 'staging',
        subdomain: 'my-app--staging',
        minReplicas: 0,
        maxReplicas: 1,
        size: 's',
        currentDeploymentId: null,
        publishStatus: 'idle',
        publishError: null,
      }
    }
    return { ok: true, value: envRows[key] }
  },
  scaleSettingsOf: () => ({ minReplicas: 0, maxReplicas: 1, size: 's' }),
}))
mock.module('../../services/published-ops.service', () => ({
  setEnvironmentPublishStatus: async (environmentId: string, status: string, error?: string | null) => {
    const row = Object.values(envRows).find((e) => e.id === environmentId)
    if (!row) throw new Error(`no environment ${environmentId}`)
    row.publishStatus = status
    row.publishError = error ?? null
  },
  resolvePublishedImageRef: () => 'img-default',
}))

const purges: string[] = []
const realFetch = globalThis.fetch
function stubPodFetch() {
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    if (url.includes('/agent/server-info')) {
      return new Response(JSON.stringify({ serverBacked: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('/agent/publish-build')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (url.includes('/agent/dist-files')) {
      return new Response(
        JSON.stringify([{ path: 'index.html', content: Buffer.from('<html>live</html>').toString('base64') }]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.includes('purge_cache')) {
      purges.push(url)
      return new Response('{}', { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as any
}

const { publishProject, deployToStaging, publishRoutes } = await import('../publish')
const republish = publishRoutes()

beforeEach(() => {
  for (const key of Object.keys(envRows)) delete envRows[key]
  deploymentRows.length = 0
  deploymentSeq = 0
  s3Puts.length = 0
  substrateCalls.length = 0
  purges.length = 0
  projectRow = {
    id: 'p1',
    workspaceId: 'ws-a',
    publishedSubdomain: 'my-app',
    publishedAt: new Date('2026-11-20T00:00:00Z'),
    publishStatus: 'live',
    publishError: null,
    publishStatusAt: null,
    publishedCommitSha: 'sha-new',
    publishedAlwaysOn: false,
    accessLevel: 'anyone',
    sitePasswordHash: null,
  }
  // The environment a publish supersedes: it already serves a `ready` deploy.
  envRows['p1:production'] = {
    id: 'penv_prod',
    projectId: 'p1',
    name: 'production',
    subdomain: 'my-app',
    minReplicas: 0,
    maxReplicas: 1,
    size: 's',
    currentDeploymentId: 'pdep_previous',
    publishStatus: 'live',
    publishError: null,
  }
  deploymentRows.push({
    id: 'pdep_previous',
    environmentId: 'penv_prod',
    commitSha: 'sha-old',
    imageRef: 'img@sha256:old',
    status: 'ready',
  })
  substratePublish = async (_projectId, opts) => ({
    serverBacked: opts.serverBacked,
    substrate: 'knative',
    url: 'http://published-p1.shogo-staging-workspaces.svc.cluster.local',
    revisionName: 'published-p1-00007',
    imageRef: 'img@sha256:new',
    awaitReady: async () => ({ ready: true }),
  })
  stubPodFetch()
})

afterEach(() => {
  globalThis.fetch = realFetch
  mock.restore()
})

const productionEnv = () => Object.values(envRows).find((e) => e.name === 'production')!
const newDeployment = () => deploymentRows[deploymentRows.length - 1]

describe('a server-backed publish configures before it goes live (SHO-536 §B)', () => {
  it('uploads nothing and purges nothing when configure fails', async () => {
    substratePublish = async () => {
      throw new Error('image build refused: base image pull denied')
    }

    const result = await publishProject('p1', { subdomain: 'my-app' })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('configure_failed')
    expect(result.message).toContain('image build refused')
    // The previous bundle is still what the domain serves.
    expect(s3Puts).toEqual([])
    expect(purges).toEqual([])
    expect(projectRow.publishStatus).toBe('failed')
  })

  it('leaves the previous deployment current when the revision never becomes Ready', async () => {
    substratePublish = async (_projectId, opts) => ({
      serverBacked: opts.serverBacked,
      substrate: 'knative',
      url: 'http://published-p1.svc.cluster.local',
      revisionName: 'published-p1-00007',
      imageRef: 'img@sha256:new',
      awaitReady: async () => ({
        ready: false as const,
        reason: 'published-p1-00007 exited with ExitCode137 (OOMKilled)',
      }),
    })

    const result = await publishProject('p1', { subdomain: 'my-app' })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('revision_not_ready')
    expect(result.status).toBe(503)
    // §B: the new files never replaced the live ones.
    expect(s3Puts).toEqual([])
    expect(purges).toEqual([])
    // §C: the row says what happened, the previous deployment is still current.
    expect(newDeployment().status).toBe('failed')
    expect(newDeployment().revisionName).toBe('published-p1-00007')
    expect(productionEnv().currentDeploymentId).toBe('pdep_previous')
    expect(productionEnv().publishStatus).toBe('failed')
    expect(productionEnv().publishError).toContain('revision_not_ready')
    expect(productionEnv().publishError).toContain('ExitCode137')
  })

  it('records the deployment ready only once the revision answers', async () => {
    const order: string[] = []
    substratePublish = async (_projectId, opts) => ({
      serverBacked: opts.serverBacked,
      substrate: 'knative',
      url: 'http://published-p1.svc.cluster.local',
      revisionName: 'published-p1-00008',
      imageRef: 'img@sha256:new',
      awaitReady: async () => {
        order.push('awaitReady')
        return { ready: true as const }
      },
    })

    const result = await publishProject('p1', { subdomain: 'my-app' })

    expect(result.ok).toBe(true)
    // Configure (and its readiness wait) ran before the upload.
    expect(order).toEqual(['awaitReady'])
    expect(s3Puts.map((p) => p.key)).toEqual(['my-app/index.html'])
    expect(newDeployment().status).toBe('ready')
    expect(newDeployment().revisionName).toBe('published-p1-00008')
    expect(productionEnv().currentDeploymentId).toBe(newDeployment().id)
    // The deployment this one replaced is superseded, not left claiming ready.
    expect(deploymentRows.find((d) => d.id === 'pdep_previous')!.status).toBe('superseded')
  })

  it('keeps the upload-first order for a static publish', async () => {
    const events: string[] = []
    substratePublish = async (_projectId, opts) => {
      events.push('configure')
      if (s3Puts.length > 0) events.push(`saw-upload(${s3Puts.length})`)
      return { serverBacked: opts.serverBacked, substrate: 'knative', url: 'http://static.svc' }
    }

    const files = new Map([['index.html', Buffer.from('<html>static</html>')]])
    const result = await publishProject('p1', { subdomain: 'my-app' }, {
      kind: 'uploaded',
      files,
      serverBacked: false,
    })

    expect(result.ok).toBe(true)
    expect(events).toEqual(['configure', 'saw-upload(1)'])
    expect(newDeployment().status).toBe('ready')
  })
})

describe('staging and /republish keep the same order (SHO-536 §B)', () => {
  it('staging uploads nothing when configure fails', async () => {
    substratePublish = async () => {
      throw new Error('revision failed to start')
    }

    const result = await deployToStaging('p1')

    expect(result.ok).toBe(false)
    expect(s3Puts).toEqual([])
    expect(purges).toEqual([])
    const staging = Object.values(envRows).find((e) => e.name === 'staging')!
    expect(staging.publishStatus).toBe('failed')
    expect(staging.publishError).toContain('revision failed to start')
  })

  it('/republish uploads nothing when configure fails, and says so', async () => {
    substratePublish = async () => {
      throw new Error('ksvc patch refused')
    }

    const res = await republish.request('/projects/p1/republish', { method: 'POST' })

    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('configure_failed')
    expect(body.error.message).toContain('ksvc patch refused')
    expect(s3Puts).toEqual([])
    expect(purges).toEqual([])
    expect(projectRow.publishStatus).toBe('failed')
  })
})
