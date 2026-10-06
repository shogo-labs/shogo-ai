// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// buildWorkspaceEnv resolves agent model defaults via
// resolveAgentModelEnv() -> agent-model-defaults.ts's
// isModelAccessibleForWorkspace(), which calls
// billingService.hasAdvancedModelAccess(). Unlike every other prisma-backed
// lookup in build-workspace-env.ts, this call has no test-injection seam and
// isn't wrapped in a try/catch, so without this mock the real service falls
// through to a live prisma.workspace.findUnique() lookup that has no
// reachable Postgres in test/CI, throwing an unhandled ECONNREFUSED that
// fails every test in this file that calls buildWorkspaceEnv().
mock.module('../../../services/billing.service', () => ({
  hasAdvancedModelAccess: async () => true,
}))

import { setDockerClassOverride } from '../../runtime-class-setting'
import { setWorkspaceBudgetOverride } from '../../workspace-compute-budget'
import { buildWorkspaceEnv } from '../build-workspace-env'

const seams = {
  _loadWorkspace: async () => ({ name: 'My WS', composioScope: 'workspace' }),
  _getProjectOwnerUserId: async () => 'owner-1',
  _getWorkspaceOwnerUserId: async () => 'ws-owner-1',
  _generateProxyToken: async (projectId: string) => `tok-${projectId}`,
  _loadProjects: async (ids: string[]) =>
    ids.map((id) => ({ id, name: id === 'p1' ? 'alpha-api' : id === 'p2' ? 'beta-web' : null })),
}

describe('buildWorkspaceEnv', () => {
  it('emits the workspace markers and project catalog', async () => {
    const env = await buildWorkspaceEnv('ws-1', ['p1', 'p2'], seams as any)
    expect(env.WORKSPACE_ID).toBe('ws-1')
    expect(env.WORKSPACE_RUNTIME).toBe('true')
    expect(env.WORKSPACE_KIND).toBe('team')
    expect(env.WORKSPACE_PROJECT_IDS).toBe('p1,p2')
    expect(env.AGENT_NAME).toBe('My WS')

    const catalog = JSON.parse(env.WORKSPACE_PROJECTS)
    expect(catalog).toEqual([
      { id: 'p1', name: 'alpha-api' },
      { id: 'p2', name: 'beta-web' },
    ])
  })

  it('emits the personal workspace kind and profile name', async () => {
    const env = await buildWorkspaceEnv('ws-personal', [], {
      ...seams,
      _loadWorkspace: async () => ({
        name: 'User Personal',
        kind: 'personal',
        profileName: 'Shogo',
        composioScope: 'workspace',
      }),
    } as any)

    expect(env.WORKSPACE_KIND).toBe('personal')
    expect(env.AGENT_NAME).toBe('Shogo')
  })

  it('mints a per-project token map and a back-compat default token', async () => {
    const env = await buildWorkspaceEnv('ws-1', ['p1', 'p2'], seams as any)
    const tokens = JSON.parse(env.AI_PROXY_TOKENS)
    expect(tokens).toEqual({ p1: 'tok-p1', p2: 'tok-p2' })
    expect(env.AI_PROXY_TOKEN).toBe('tok-p1') // first attached project
  })

  it('falls back to the id when a project has no name', async () => {
    const env = await buildWorkspaceEnv('ws-1', ['p3'], seams as any)
    expect(JSON.parse(env.WORKSPACE_PROJECTS)).toEqual([{ id: 'p3', name: 'p3' }])
  })

  it('ships each member tech stack as WORKSPACE_TECH_STACKS, never a root TECH_STACK_ID', async () => {
    const env = await buildWorkspaceEnv('ws-1', ['p1', 'p2', 'p3'], {
      ...seams,
      _loadProjects: async (ids: string[]) =>
        ids.map((id) => ({
          id,
          name: id,
          // Settings arrive as JSON, sometimes double-encoded as a string.
          settings:
            id === 'p1'
              ? { techStackId: 'expo-app' }
              : id === 'p2'
                ? JSON.stringify({ techStackId: 'react-app' })
                : null,
        })),
    } as any)
    expect(JSON.parse(env.WORKSPACE_TECH_STACKS)).toEqual({ p1: 'expo-app', p2: 'react-app' })
    expect(env.TECH_STACK_ID).toBeUndefined()
  })

  it('requests a docker VM when a member is docker-compose, the gate is on, and the workspace is large enough', async () => {
    setDockerClassOverride(true)
    try {
      const env = await buildWorkspaceEnv('ws-1', ['p1'], {
        ...seams,
        _loadWorkspace: async () => ({ name: 'My WS', composioScope: 'workspace', instanceSize: 'large' }),
        _loadProjects: async (ids: string[]) =>
          ids.map((id) => ({ id, name: id, settings: { techStackId: 'docker-compose' } })),
      } as any)
      expect(env.SHOGO_RUNTIME_CLASS).toBe('docker')
    } finally {
      setDockerClassOverride(null)
    }
  })

  it('keeps a docker-compose workspace on a standard VM when the compute tier is too small', async () => {
    setDockerClassOverride(true)
    try {
      const env = await buildWorkspaceEnv('ws-1', ['p1'], {
        ...seams,
        _loadWorkspace: async () => ({ name: 'My WS', composioScope: 'workspace', instanceSize: 'micro' }),
        _loadProjects: async (ids: string[]) =>
          ids.map((id) => ({ id, name: id, settings: { techStackId: 'docker-compose' } })),
      } as any)
      expect(env.SHOGO_RUNTIME_CLASS).toBeUndefined()
    } finally {
      setDockerClassOverride(null)
    }
  })

  it('allowlists the union of member exposed ports in SHOGO_EXPOSED_PORTS', async () => {
    const env = await buildWorkspaceEnv('ws-1', ['p1', 'p2'], {
      ...seams,
      _loadProjects: async (ids: string[]) =>
        ids.map((id) => ({
          id,
          name: id,
          settings:
            id === 'p1'
              ? {
                  techStackId: 'docker-compose',
                  exposedPorts: { '3001': { source: 'project', protocol: 'http' } },
                }
              : { techStackId: 'react-app' },
        })),
    } as any)
    expect(env.SHOGO_EXPOSED_PORTS).toBe('3001,5432,8000')
  })

  it('sizes the metal VM from the tier and the members\' stacks', async () => {
    setDockerClassOverride(true)
    try {
      const docker = await buildWorkspaceEnv('ws-1', ['p1'], {
        ...seams,
        forMetal: true,
        _loadWorkspace: async () => ({ name: 'My WS', composioScope: 'workspace', instanceSize: 'xlarge' }),
        _loadProjects: async (ids: string[]) =>
          ids.map((id) => ({ id, name: id, settings: { techStackId: 'docker-compose' } })),
      } as any)
      expect(docker.SHOGO_VM_VCPUS).toBe('8')
      expect(docker.SHOGO_VM_MEM_MIB).toBe('16384')

      const standard = await buildWorkspaceEnv('ws-1', ['p1'], {
        ...seams,
        forMetal: true,
        _loadWorkspace: async () => ({ name: 'My WS', composioScope: 'workspace', instanceSize: 'micro' }),
        _loadProjects: async (ids: string[]) =>
          ids.map((id) => ({ id, name: id, settings: { techStackId: 'react-app' } })),
      } as any)
      expect(standard.SHOGO_VM_VCPUS).toBe('1')
      expect(standard.SHOGO_VM_MEM_MIB).toBe('2048')
    } finally {
      setDockerClassOverride(null)
    }
  })

  it('keeps paid workspace runtimes warm only with the workspace budget on', async () => {
    const opts = {
      ...seams,
      forMetal: true,
      _loadWorkspace: async () => ({ name: 'My WS', composioScope: 'workspace', instanceSize: 'large' }),
      _loadProjects: async (ids: string[]) => ids.map((id) => ({ id, name: id, settings: { techStackId: 'react-app' } })),
    } as any
    expect((await buildWorkspaceEnv('ws-1', ['p1'], opts)).SHOGO_ALWAYS_ON).toBeUndefined()
    setWorkspaceBudgetOverride(true)
    try {
      expect((await buildWorkspaceEnv('ws-1', ['p1'], opts)).SHOGO_ALWAYS_ON).toBe('1')
      const micro = { ...opts, _loadWorkspace: async () => ({ name: 'My WS', instanceSize: 'micro' }) }
      expect((await buildWorkspaceEnv('ws-1', ['p1'], micro)).SHOGO_ALWAYS_ON).toBeUndefined()
    } finally {
      setWorkspaceBudgetOverride(null)
    }
  })

  it('omits SHOGO_EXPOSED_PORTS when no member declares ports', async () => {
    const env = await buildWorkspaceEnv('ws-1', ['p1'], {
      ...seams,
      _loadProjects: async (ids: string[]) =>
        ids.map((id) => ({ id, name: id, settings: { techStackId: 'react-app' } })),
    } as any)
    expect(env.SHOGO_EXPOSED_PORTS).toBeUndefined()
  })

  it('omits WORKSPACE_TECH_STACKS when no member has a tech stack', async () => {
    const env = await buildWorkspaceEnv('ws-1', ['p1', 'p2'], seams as any)
    expect(env.WORKSPACE_TECH_STACKS).toBeUndefined()
  })

  it('forMetal marks durability host-mediated (guests hold no S3 creds)', async () => {
    const metal = await buildWorkspaceEnv('ws-1', ['p1'], { ...seams, forMetal: true } as any)
    expect(metal.SHOGO_DURABILITY_HOST_MEDIATED).toBe('1')
    const k8s = await buildWorkspaceEnv('ws-1', ['p1'], seams as any)
    expect(k8s.SHOGO_DURABILITY_HOST_MEDIATED).toBeUndefined()
  })

  it('handles a workspace with no attached projects', async () => {
    const env = await buildWorkspaceEnv('ws-1', [], seams as any)
    expect(env.WORKSPACE_PROJECT_IDS).toBe('')
    expect(JSON.parse(env.WORKSPACE_PROJECTS)).toEqual([])
    expect(env.AI_PROXY_TOKENS).toBe('{}')
  })

  describe('workspace-level fallback AI_PROXY_TOKEN (no attached projects)', () => {
    // Regression coverage for the staging incident where a brand-new
    // personal companion (zero attached projects) got AI_PROXY_URL set but
    // no AI_PROXY_TOKEN, and the agent-runtime's configureAIProxy() threw,
    // failing metal /pool/assign and surfacing as a generic "Something went
    // wrong" for every message.
    it('mints a workspace-sentinel token when there are no attached projects', async () => {
      const env = await buildWorkspaceEnv('ws-1', [], seams as any)
      expect(env.AI_PROXY_TOKEN).toBe('tok-workspace')
    })

    it('uses the workspace owner lookup (not the project owner lookup) for the fallback token', async () => {
      const seenArgs: unknown[][] = []
      const env = await buildWorkspaceEnv('ws-1', [], {
        ...seams,
        _generateProxyToken: async (...args: unknown[]) => {
          seenArgs.push(args)
          return 'fallback-tok'
        },
      } as any)
      expect(env.AI_PROXY_TOKEN).toBe('fallback-tok')
      expect(seenArgs).toEqual([['workspace', 'ws-1', 'ws-owner-1', 7 * 24 * 60 * 60 * 1000]])
    })

    it('the real getWorkspaceOwnerUserId lookup never throws — it falls back to \'system\' internally (see project-user-context.ts), so this fallback mint only fails on a broken generate() itself', async () => {
      const env = await buildWorkspaceEnv('ws-1', [], {
        ...seams,
        _getWorkspaceOwnerUserId: async () => 'system',
      } as any)
      expect(env.AI_PROXY_TOKEN).toBe('tok-workspace')
    })

    it('does NOT mint a workspace-sentinel token when a project token is already set', async () => {
      const env = await buildWorkspaceEnv('ws-1', ['p1'], seams as any)
      expect(env.AI_PROXY_TOKEN).toBe('tok-p1')
    })
  })

  it('requires a workspaceId', async () => {
    await expect(buildWorkspaceEnv('', [], seams as any)).rejects.toThrow(/workspaceId is required/)
  })

  describe('proxy URLs + telemetry parity with buildProjectEnv', () => {
    const ENV_KEYS = [
      'SYSTEM_NAMESPACE',
      'SHOGO_PUBLIC_API_URL',
      'APP_URL',
      'API_HOST',
      'API_PORT',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'SIGNOZ_INGESTION_KEY',
      'BETTER_AUTH_URL',
    ] as const
    const saved: Record<string, string | undefined> = {}

    beforeEach(() => {
      for (const k of ENV_KEYS) {
        saved[k] = process.env[k]
        delete process.env[k]
      }
    })
    afterEach(() => {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    })

    it('derives TOOLS_PROXY_URL from in-cluster DNS on k8s', async () => {
      process.env.SYSTEM_NAMESPACE = 'shogo-prod'
      const env = await buildWorkspaceEnv('ws-1', ['p1'], seams as any)
      const base = 'http://api.shogo-prod.svc.cluster.local'
      expect(env.AI_PROXY_URL).toBe(`${base}/api/ai/v1`)
      expect(env.TOOLS_PROXY_URL).toBe(`${base}/api/tools`)
    })

    it('forMetal pins the proxy + tools URLs to the PUBLIC API base', async () => {
      process.env.SYSTEM_NAMESPACE = 'shogo-prod'
      process.env.SHOGO_PUBLIC_API_URL = 'https://studio.shogo.ai'
      const env = await buildWorkspaceEnv('ws-1', ['p1'], { ...seams, forMetal: true } as any)
      expect(env.AI_PROXY_URL).toBe('https://studio.shogo.ai/api/ai/v1')
      expect(env.TOOLS_PROXY_URL).toBe('https://studio.shogo.ai/api/tools')
      expect(env.SHOGO_API_URL).toBe('https://studio.shogo.ai')
    })

    it('forwards OTEL telemetry vars and public URLs when set', async () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://ingest.us.signoz.cloud:443'
      process.env.SIGNOZ_INGESTION_KEY = 'ingest-key-123'
      process.env.BETTER_AUTH_URL = 'https://studio.shogo.ai'
      process.env.SHOGO_PUBLIC_API_URL = 'https://studio.shogo.ai'
      const env = await buildWorkspaceEnv('ws-1', ['p1'], seams as any)
      expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://ingest.us.signoz.cloud:443')
      expect(env.OTEL_SERVICE_NAME).toBe('shogo-runtime')
      expect(env.SIGNOZ_INGESTION_KEY).toBe('ingest-key-123')
      expect(env.BETTER_AUTH_URL).toBe('https://studio.shogo.ai')
      expect(env.SHOGO_PUBLIC_API_URL).toBe('https://studio.shogo.ai')
    })

    it('omits OTEL vars entirely when the endpoint is unset', async () => {
      process.env.SIGNOZ_INGESTION_KEY = 'orphan-key'
      const env = await buildWorkspaceEnv('ws-1', ['p1'], seams as any)
      expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined()
      expect(env.OTEL_SERVICE_NAME).toBeUndefined()
      expect(env.SIGNOZ_INGESTION_KEY).toBeUndefined()
    })
  })

  describe('per-project DB provisioning (WORKSPACE_DATABASE_URLS)', () => {
    it('omits the DB map by default (local/desktop → per-subfolder sqlite)', async () => {
      const env = await buildWorkspaceEnv('ws-1', ['p1', 'p2'], seams as any)
      expect(env.WORKSPACE_DATABASE_URLS).toBeUndefined()
    })

    it('builds a per-project DB map when a provisioning seam is supplied', async () => {
      const provisioned: string[] = []
      const env = await buildWorkspaceEnv('ws-1', ['p1', 'p2'], {
        ...seams,
        _provisionProjectDatabase: async (projectId: string, workspaceId: string) => {
          provisioned.push(`${workspaceId}/${projectId}`)
          return `postgres://pg/${projectId}`
        },
      } as any)
      expect(JSON.parse(env.WORKSPACE_DATABASE_URLS)).toEqual({
        p1: 'postgres://pg/p1',
        p2: 'postgres://pg/p2',
      })
      expect(provisioned).toEqual(['ws-1/p1', 'ws-1/p2'])
    })

    it('skips projects whose provisioning returns null (they keep sqlite)', async () => {
      const env = await buildWorkspaceEnv('ws-1', ['p1', 'p2'], {
        ...seams,
        _provisionProjectDatabase: async (projectId: string) =>
          projectId === 'p1' ? 'postgres://pg/p1' : null,
      } as any)
      expect(JSON.parse(env.WORKSPACE_DATABASE_URLS)).toEqual({ p1: 'postgres://pg/p1' })
    })

    it('isolates provisioning failures and omits the map when none succeed', async () => {
      const env = await buildWorkspaceEnv('ws-1', ['p1', 'p2'], {
        ...seams,
        _provisionProjectDatabase: async () => {
          throw new Error('CNPG unavailable')
        },
      } as any)
      expect(env.WORKSPACE_DATABASE_URLS).toBeUndefined()
    })
  })

  // Contract between this builder and the guest: the runtime only rewrites
  // localhost links / serves public preview URLs when these vars are present,
  // and its own tests set them by hand — so the producer side must be pinned
  // here against the real consumers (staging e2e agent-localhost-publish).
  describe('public preview URLs (cloud anchored runtime)', () => {
    const previewSeams = {
      ...seams,
      _getPreviewUrl: (id: string) => `https://${id}.preview.staging.shogo.ai`,
    }
    let savedNs: string | undefined

    beforeEach(() => {
      savedNs = process.env.SYSTEM_NAMESPACE
      process.env.SYSTEM_NAMESPACE = 'shogo-staging-system'
    })
    afterEach(() => {
      if (savedNs === undefined) delete process.env.SYSTEM_NAMESPACE
      else process.env.SYSTEM_NAMESPACE = savedNs
    })

    it('sets PUBLIC_PREVIEW_URL to the anchor preview origin and maps every member under /p/<id>/', async () => {
      const env = await buildWorkspaceEnv('ws-1', ['anchor', 'p2'], {
        ...previewSeams,
        forMetal: true,
        anchorProjectId: 'anchor',
      } as any)
      expect(env.PUBLIC_PREVIEW_URL).toBe('https://anchor.preview.staging.shogo.ai')
      expect(JSON.parse(env.WORKSPACE_PREVIEW_URLS)).toEqual({
        anchor: 'https://anchor.preview.staging.shogo.ai/p/anchor/',
        p2: 'https://anchor.preview.staging.shogo.ai/p/p2/',
      })
    })

    it('includes the anchor even when the caller omits it from the member list', async () => {
      const env = await buildWorkspaceEnv('ws-1', ['p2'], {
        ...previewSeams,
        anchorProjectId: 'anchor',
      } as any)
      expect(Object.keys(JSON.parse(env.WORKSPACE_PREVIEW_URLS))).toEqual(['anchor', 'p2'])
    })

    it('is consumed by the guest: the runtime parses the map and rewrites a leaked localhost link', async () => {
      const { parseWorkspacePreviewUrls } = await import(
        '../../../../../../packages/agent-runtime/src/workspace-runtime-mode'
      )
      const { rewriteLocalhostLinks } = await import(
        '../../../../../../packages/agent-runtime/src/preview-link-rewrite'
      )
      const env = await buildWorkspaceEnv('ws-1', ['anchor'], {
        ...previewSeams,
        forMetal: true,
        anchorProjectId: 'anchor',
      } as any)

      expect(parseWorkspacePreviewUrls(env as any)).toEqual({
        anchor: 'https://anchor.preview.staging.shogo.ai/p/anchor/',
      })
      const leaked = 'Preview URL: http://localhost:8080/p/anchor/'
      expect(rewriteLocalhostLinks(leaked, env.PUBLIC_PREVIEW_URL)).toBe(
        'Preview URL: https://anchor.preview.staging.shogo.ai/p/anchor/',
      )
    })

    it('leaves both unset off-cluster (desktop: localhost is the real URL)', async () => {
      delete process.env.SYSTEM_NAMESPACE
      const env = await buildWorkspaceEnv('ws-1', ['anchor'], {
        ...previewSeams,
        anchorProjectId: 'anchor',
      } as any)
      expect(env.PUBLIC_PREVIEW_URL).toBeUndefined()
      expect(env.WORKSPACE_PREVIEW_URLS).toBeUndefined()
    })

    it('leaves both unset for a workspace-session runtime with no anchor', async () => {
      const env = await buildWorkspaceEnv('ws-1', ['p1'], previewSeams as any)
      expect(env.PUBLIC_PREVIEW_URL).toBeUndefined()
      expect(env.WORKSPACE_PREVIEW_URLS).toBeUndefined()
    })
  })
})
