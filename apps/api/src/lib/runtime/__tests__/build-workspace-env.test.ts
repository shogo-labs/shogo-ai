// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildWorkspaceEnv } from '../build-workspace-env'

const seams = {
  _loadWorkspace: async () => ({ name: 'My WS', composioScope: 'workspace' }),
  _getProjectOwnerUserId: async () => 'owner-1',
  _generateProxyToken: async (projectId: string) => `tok-${projectId}`,
  _loadProjects: async (ids: string[]) =>
    ids.map((id) => ({ id, name: id === 'p1' ? 'alpha-api' : id === 'p2' ? 'beta-web' : null })),
}

describe('buildWorkspaceEnv', () => {
  it('emits the workspace markers and project catalog', async () => {
    const env = await buildWorkspaceEnv('ws-1', ['p1', 'p2'], seams as any)
    expect(env.WORKSPACE_ID).toBe('ws-1')
    expect(env.WORKSPACE_RUNTIME).toBe('true')
    expect(env.WORKSPACE_PROJECT_IDS).toBe('p1,p2')
    expect(env.AGENT_NAME).toBe('My WS')

    const catalog = JSON.parse(env.WORKSPACE_PROJECTS)
    expect(catalog).toEqual([
      { id: 'p1', name: 'alpha-api' },
      { id: 'p2', name: 'beta-web' },
    ])
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

  it('handles a workspace with no attached projects', async () => {
    const env = await buildWorkspaceEnv('ws-1', [], seams as any)
    expect(env.WORKSPACE_PROJECT_IDS).toBe('')
    expect(JSON.parse(env.WORKSPACE_PROJECTS)).toEqual([])
    expect(env.AI_PROXY_TOKENS).toBe('{}')
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
})
