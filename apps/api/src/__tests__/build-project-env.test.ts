// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for src/lib/runtime/build-project-env.ts — the shared env-var
 * builder used by both the K8s WarmPoolController and the desktop
 * VMWarmPoolController. Pulls together prisma, model-catalog,
 * agent-runtime templates, ai-proxy-token, runtime-token, and project
 * user context — every one of those is mocked below.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

// ─── Mocks (must run BEFORE the dynamic import) ────────────────────────────

const findUniqueProjectMock = mock(async (_: any): Promise<any> => null)
mock.module('../lib/prisma', () => ({
  prisma: { project: { findUnique: findUniqueProjectMock } },
  SubscriptionStatus: {
    active: 'active',
    past_due: 'past_due',
    canceled: 'canceled',
    incomplete: 'incomplete',
    incomplete_expired: 'incomplete_expired',
    trialing: 'trialing',
    unpaid: 'unpaid',
    paused: 'paused',
  },
  BillingInterval: { monthly: 'monthly', annual: 'annual' },
}))

const generateProxyTokenMock = mock(
  async (_pid: string, _wsId: string | null, _uid: string, _ttl: number) => 'proxy-token-stub'
)
mock.module('../lib/ai-proxy-token', () => ({ generateProxyToken: generateProxyTokenMock }))

const deriveRuntimeTokenMock = mock((_pid: string) => 'runtime-token-stub')
const deriveWebhookTokenMock = mock((_pid: string) => 'webhook-token-stub')
mock.module('../lib/runtime-token', () => ({
  deriveRuntimeToken: deriveRuntimeTokenMock,
  deriveWebhookToken: deriveWebhookTokenMock,
}))

const getProjectOwnerUserIdMock = mock(async (_pid: string) => 'owner-user-id')
mock.module('../lib/project-user-context', () => ({
  getProjectOwnerUserId: getProjectOwnerUserIdMock,
}))

const getAgentModeOverridesMock = mock(() => ({}) as { basic?: string; advanced?: string })
const getAutoTierOverridesMock = mock(
  () => ({}) as { economy?: string; standard?: string; premium?: string },
)
// Real-enough provider inference for the env builder: custom for mimo-*, else openai/anthropic.
const inferProviderFromModelMock = mock((id: string, fallback = 'custom') => {
  if (id.startsWith('gpt')) return 'openai'
  if (id.startsWith('claude')) return 'anthropic'
  if (id.startsWith('mimo')) return 'custom'
  return fallback
})
mock.module('@shogo/model-catalog', () => ({
  getAgentModeOverrides: getAgentModeOverridesMock,
  getAutoTierOverrides: getAutoTierOverridesMock,
  inferProviderFromModel: inferProviderFromModelMock,
}))

// Public-model alias registry: only `hoshi-1.0` resolves, to its backing id.
const resolvePublicModelSyncMock = mock((publicId: string) =>
  publicId === 'hoshi-1.0'
    ? { publicId, displayName: 'Hoshi 1.0', backingModelId: 'mimo-v2.5', enabled: true }
    : null,
)
mock.module('../services/public-models.service', () => ({
  resolvePublicModelSync: resolvePublicModelSyncMock,
}))

const getAgentTemplateByIdMock = mock((_id: string) => null as { techStack?: string } | null)
mock.module('@shogo/agent-runtime/src/agent-templates', () => ({
  getAgentTemplateById: getAgentTemplateByIdMock,
}))

// Pure string-formatter in prod; mocked here to avoid loading the heavy
// Knative/k8s client module (and to make the derived URL deterministic).
const getPreviewUrlMock = mock((projectId: string) => `https://${projectId}.preview.staging.shogo.ai`)
mock.module('../lib/knative-project-manager', () => ({
  getPreviewUrl: getPreviewUrlMock,
}))

const { buildProjectEnv } = await import('../lib/runtime/build-project-env')

// ─── lifecycle ─────────────────────────────────────────────────────────────

const SAVED_ENV: Record<string, string | undefined> = {}
const ENV_KEYS = [
  'SYSTEM_NAMESPACE',
  'API_PORT',
  'API_HOST',
  'S3_WORKSPACES_BUCKET',
  'S3_REGION',
  'S3_ENDPOINT',
  'S3_FORCE_PATH_STYLE',
  'SHOGO_VOICE_MODE',
  'SHOGO_DEMO_VOICE',
  'SHOGO_MOCK_CAPTURE_DIR',
] as const

beforeEach(() => {
  for (const k of ENV_KEYS) {
    SAVED_ENV[k] = process.env[k]
    delete process.env[k]
  }
  findUniqueProjectMock.mockReset()
  findUniqueProjectMock.mockImplementation(async () => null)
  generateProxyTokenMock.mockReset()
  generateProxyTokenMock.mockImplementation(async () => 'proxy-token-stub')
  deriveRuntimeTokenMock.mockReset()
  deriveRuntimeTokenMock.mockImplementation(() => 'runtime-token-stub')
  deriveWebhookTokenMock.mockReset()
  deriveWebhookTokenMock.mockImplementation(() => 'webhook-token-stub')
  getProjectOwnerUserIdMock.mockReset()
  getProjectOwnerUserIdMock.mockImplementation(async () => 'owner-user-id')
  getAgentModeOverridesMock.mockReset()
  getAgentModeOverridesMock.mockImplementation(() => ({}))
  getAutoTierOverridesMock.mockReset()
  getAutoTierOverridesMock.mockImplementation(() => ({}))
  inferProviderFromModelMock.mockClear()
  resolvePublicModelSyncMock.mockClear()
  getAgentTemplateByIdMock.mockReset()
  getAgentTemplateByIdMock.mockImplementation(() => null)
  getPreviewUrlMock.mockReset()
  getPreviewUrlMock.mockImplementation(
    (projectId: string) => `https://${projectId}.preview.staging.shogo.ai`,
  )
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k]
    else process.env[k] = SAVED_ENV[k]
  }
})

// ─── core fields ──────────────────────────────────────────────────────────

describe('buildProjectEnv — always-present fields', () => {
  test('always sets PROJECT_ID', async () => {
    const env = await buildProjectEnv('proj-1')
    expect(env.PROJECT_ID).toBe('proj-1')
  })

  test('always sets RUNTIME_AUTH_SECRET and WEBHOOK_TOKEN from the derive helpers', async () => {
    deriveRuntimeTokenMock.mockImplementation((pid) => `r-${pid}`)
    deriveWebhookTokenMock.mockImplementation((pid) => `w-${pid}`)
    const env = await buildProjectEnv('proj-2')
    expect(env.RUNTIME_AUTH_SECRET).toBe('r-proj-2')
    expect(env.WEBHOOK_TOKEN).toBe('w-proj-2')
    expect(deriveRuntimeTokenMock).toHaveBeenCalledTimes(1)
    expect(deriveWebhookTokenMock).toHaveBeenCalledTimes(1)
  })
})

// ─── proxy URLs ────────────────────────────────────────────────────────────

describe('buildProjectEnv — proxy URLs', () => {
  test('uses in-cluster DNS when SYSTEM_NAMESPACE is set', async () => {
    process.env.SYSTEM_NAMESPACE = 'shogo-staging'
    const env = await buildProjectEnv('proj-3')
    const base = 'http://api.shogo-staging.svc.cluster.local'
    expect(env.AI_PROXY_URL).toBe(`${base}/api/ai/v1`)
    expect(env.ANTHROPIC_PROXY_URL).toBe(`${base}/api/ai/anthropic`)
    expect(env.OPENAI_PROXY_URL).toBe(`${base}/api/ai/v1`)
    expect(env.SHOGO_API_URL).toBe(base)
  })

  test('falls back to API_HOST/API_PORT when no SYSTEM_NAMESPACE', async () => {
    process.env.API_HOST = 'host.docker.internal'
    process.env.API_PORT = '7777'
    const env = await buildProjectEnv('proj-4')
    expect(env.AI_PROXY_URL).toBe('http://host.docker.internal:7777/api/ai/v1')
    expect(env.SHOGO_API_URL).toBe('http://host.docker.internal:7777')
  })

  test('default fallback is http://localhost:8002 when nothing is set', async () => {
    const env = await buildProjectEnv('proj-5')
    expect(env.AI_PROXY_URL).toBe('http://localhost:8002/api/ai/v1')
    expect(env.ANTHROPIC_PROXY_URL).toBe('http://localhost:8002/api/ai/anthropic')
    expect(env.OPENAI_PROXY_URL).toBe('http://localhost:8002/api/ai/v1')
    expect(env.SHOGO_API_URL).toBe('http://localhost:8002')
  })

  test('SYSTEM_NAMESPACE wins over API_HOST / API_PORT', async () => {
    process.env.SYSTEM_NAMESPACE = 'shogo-prod'
    process.env.API_HOST = 'should-be-ignored'
    process.env.API_PORT = '9999'
    const env = await buildProjectEnv('proj-6')
    expect(env.AI_PROXY_URL).toBe('http://api.shogo-prod.svc.cluster.local/api/ai/v1')
  })
})

// ─── PUBLIC_PREVIEW_URL (cloud preview link) ──────────────────────────────
//
// Pooled/warm pods learn their project env through this builder. Without
// PUBLIC_PREVIEW_URL the runtime falls back to a localhost link the user
// can't open (and the gateway's localhost→preview rewriter stays disabled),
// so it MUST be injected for cloud (k8s) — but never for desktop VMs, where
// localhost IS the URL the user opens.
describe('buildProjectEnv — PUBLIC_PREVIEW_URL', () => {
  test('injects the deterministic preview URL in k8s (SYSTEM_NAMESPACE set)', async () => {
    process.env.SYSTEM_NAMESPACE = 'shogo-staging'
    const env = await buildProjectEnv('proj-pp')
    expect(env.PUBLIC_PREVIEW_URL).toBe('https://proj-pp.preview.staging.shogo.ai')
    expect(getPreviewUrlMock).toHaveBeenCalledWith('proj-pp')
  })

  test('omits PUBLIC_PREVIEW_URL off-cluster (desktop VM / local — no SYSTEM_NAMESPACE)', async () => {
    const env = await buildProjectEnv('proj-pp-local')
    expect(env.PUBLIC_PREVIEW_URL).toBeUndefined()
    expect(getPreviewUrlMock).not.toHaveBeenCalled()
  })

  test('swallows a getPreviewUrl failure without blocking the rest of the env build', async () => {
    process.env.SYSTEM_NAMESPACE = 'shogo-staging'
    getPreviewUrlMock.mockImplementation(() => {
      throw new Error('preview config missing')
    })
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    const env = await buildProjectEnv('proj-pp-fail')
    expect(env.PUBLIC_PREVIEW_URL).toBeUndefined()
    expect(env.PROJECT_ID).toBe('proj-pp-fail')
    expect(env.RUNTIME_AUTH_SECRET).toBe('runtime-token-stub')
    errorSpy.mockRestore()
  })
})

// ─── project-derived fields (DB hit) ──────────────────────────────────────

describe('buildProjectEnv — project-derived fields', () => {
  test('omits WORKSPACE_ID / AGENT_NAME (and never sets TEMPLATE_ID) when the project row is missing', async () => {
    findUniqueProjectMock.mockImplementation(async () => null)
    const env = await buildProjectEnv('proj-missing')
    expect(env.WORKSPACE_ID).toBeUndefined()
    // TEMPLATE_ID was removed from the env contract by the marketplace
    // consolidation (build-project-env.ts:48) — assert it stays unset
    // on every path.
    expect(env.TEMPLATE_ID).toBeUndefined()
    expect(env.AGENT_NAME).toBeUndefined()
    expect(env.AI_PROXY_TOKEN).toBeUndefined() // proxy token only set on hit
  })

  test('sets WORKSPACE_ID and AGENT_NAME when present on the row (TEMPLATE_ID is intentionally not exported)', async () => {
    findUniqueProjectMock.mockImplementation(async () => ({
      workspaceId: 'ws-1',
      templateId: 'tmpl-next',
      name: 'My Agent',
      settings: null,
      workspace: null,
    }))
    const env = await buildProjectEnv('proj-set')
    expect(env.WORKSPACE_ID).toBe('ws-1')
    expect(env.AGENT_NAME).toBe('My Agent')
    // Confirm the legacy TEMPLATE_ID env stays unset even when the
    // project row still has a templateId column.
    expect(env.TEMPLATE_ID).toBeUndefined()
  })

  test('defaults COMPOSIO_USER_SCOPE to "workspace" when scope is null', async () => {
    findUniqueProjectMock.mockImplementation(async () => ({
      workspaceId: 'ws-1',
      workspace: { composioScope: null },
    }))
    const env = await buildProjectEnv('proj-cs')
    expect(env.COMPOSIO_USER_SCOPE).toBe('workspace')
  })

  test('respects scope="project" when set on the workspace', async () => {
    findUniqueProjectMock.mockImplementation(async () => ({
      workspaceId: 'ws-1',
      workspace: { composioScope: 'project' },
    }))
    const env = await buildProjectEnv('proj-cs-p')
    expect(env.COMPOSIO_USER_SCOPE).toBe('project')
  })

  test('falls back to "workspace" for any non-{project, workspace} scope value', async () => {
    findUniqueProjectMock.mockImplementation(async () => ({
      workspaceId: 'ws-1',
      workspace: { composioScope: 'rogue-value' },
    }))
    const env = await buildProjectEnv('proj-cs-bad')
    expect(env.COMPOSIO_USER_SCOPE).toBe('workspace')
  })

  test('sets MOUNT_WORKSPACE=false when settings.mountWorkspace is false', async () => {
    findUniqueProjectMock.mockImplementation(async () => ({
      workspaceId: 'ws-1',
      settings: { mountWorkspace: false },
    }))
    const env = await buildProjectEnv('proj-no-mount')
    expect(env.MOUNT_WORKSPACE).toBe('false')
  })

  test('omits MOUNT_WORKSPACE when settings.mountWorkspace is true (the default)', async () => {
    findUniqueProjectMock.mockImplementation(async () => ({
      workspaceId: 'ws-1',
      settings: { mountWorkspace: true },
    }))
    const env = await buildProjectEnv('proj-mount')
    expect(env.MOUNT_WORKSPACE).toBeUndefined()
  })

  test('prefers settings.techStackId over template lookup', async () => {
    findUniqueProjectMock.mockImplementation(async () => ({
      workspaceId: 'ws-1',
      templateId: 'tmpl-x',
      settings: { techStackId: 'expo-router' },
    }))
    getAgentTemplateByIdMock.mockImplementation(() => ({ techStack: 'next-15' }))
    const env = await buildProjectEnv('proj-ts-settings')
    expect(env.TECH_STACK_ID).toBe('expo-router')
    expect(getAgentTemplateByIdMock).not.toHaveBeenCalled() // settings won, no template lookup
  })

  test('omits TECH_STACK_ID (and never falls back to template.techStack) when settings has no techStackId', async () => {
    // Marketplace consolidation removed the template→techStack fallback
    // (build-project-env.ts:75–84). The env now relies exclusively on
    // settings.techStackId; assert that no template lookup happens and
    // TECH_STACK_ID stays unset when settings is empty.
    findUniqueProjectMock.mockImplementation(async () => ({
      workspaceId: 'ws-1',
      templateId: 'tmpl-y',
      settings: {},
    }))
    getAgentTemplateByIdMock.mockImplementation(() => ({ techStack: 'next-15' }))
    const env = await buildProjectEnv('proj-ts-template')
    expect(env.TECH_STACK_ID).toBeUndefined()
    expect(getAgentTemplateByIdMock).not.toHaveBeenCalled()
  })

  test('injects SHOGO_CLOUD_SYNC_MODE for an explicit "s3" project (pod default is git_only)', async () => {
    findUniqueProjectMock.mockImplementation(async () => ({
      workspaceId: 'ws-1',
      cloudSyncMode: 's3',
    }))
    const env = await buildProjectEnv('proj-sync-default')
    expect(env.SHOGO_CLOUD_SYNC_MODE).toBe('s3')
  })

  test('injects SHOGO_CLOUD_SYNC_MODE when cloudSyncMode is "dual_shadow"', async () => {
    findUniqueProjectMock.mockImplementation(async () => ({
      workspaceId: 'ws-1',
      cloudSyncMode: 'dual_shadow',
    }))
    const env = await buildProjectEnv('proj-sync-dual')
    expect(env.SHOGO_CLOUD_SYNC_MODE).toBe('dual_shadow')
  })

  test('injects SHOGO_CLOUD_SYNC_MODE when cloudSyncMode is "git_only"', async () => {
    findUniqueProjectMock.mockImplementation(async () => ({
      workspaceId: 'ws-1',
      cloudSyncMode: 'git_only',
    }))
    const env = await buildProjectEnv('proj-sync-git-only')
    expect(env.SHOGO_CLOUD_SYNC_MODE).toBe('git_only')
  })

  test('omits TECH_STACK_ID when neither settings nor template has one', async () => {
    findUniqueProjectMock.mockImplementation(async () => ({
      workspaceId: 'ws-1',
      templateId: 'tmpl-z',
      settings: {},
    }))
    getAgentTemplateByIdMock.mockImplementation(() => null)
    const env = await buildProjectEnv('proj-no-ts')
    expect(env.TECH_STACK_ID).toBeUndefined()
  })

  test('mints AI_PROXY_TOKEN with the resolved owner userId and 7-day TTL', async () => {
    findUniqueProjectMock.mockImplementation(async () => ({
      workspaceId: 'ws-owner-1',
      settings: {},
    }))
    getProjectOwnerUserIdMock.mockImplementation(async () => 'owner-x')
    generateProxyTokenMock.mockImplementation(async (pid, wsId, uid, ttl) =>
      `tok|${pid}|${wsId}|${uid}|${ttl}`
    )
    const env = await buildProjectEnv('proj-token')
    expect(env.AI_PROXY_TOKEN).toBe(
      `tok|proj-token|ws-owner-1|owner-x|${7 * 24 * 60 * 60 * 1000}`
    )
  })

  test('catches proxy-token errors without blocking the rest of the env build', async () => {
    findUniqueProjectMock.mockImplementation(async () => ({
      workspaceId: 'ws-err',
      settings: {},
    }))
    generateProxyTokenMock.mockImplementation(async () => {
      throw new Error('signing key missing')
    })
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})

    const env = await buildProjectEnv('proj-token-fail')
    expect(env.PROJECT_ID).toBe('proj-token-fail')
    expect(env.RUNTIME_AUTH_SECRET).toBe('runtime-token-stub') // later steps still run
    expect(env.AI_PROXY_TOKEN).toBeUndefined()
    expect(errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('signing key missing')
    errorSpy.mockRestore()
  })
})

// ─── model overrides ──────────────────────────────────────────────────────

describe('buildProjectEnv — agent model overrides', () => {
  test('omits AGENT_BASIC_MODEL / AGENT_ADVANCED_MODEL when the catalog returns empty', async () => {
    getAgentModeOverridesMock.mockImplementation(() => ({}))
    const env = await buildProjectEnv('proj-mo-empty')
    expect(env.AGENT_BASIC_MODEL).toBeUndefined()
    expect(env.AGENT_ADVANCED_MODEL).toBeUndefined()
  })

  test('sets only AGENT_BASIC_MODEL when the catalog has only basic', async () => {
    getAgentModeOverridesMock.mockImplementation(() => ({ basic: 'claude-haiku-4-5' }))
    const env = await buildProjectEnv('proj-mo-basic')
    expect(env.AGENT_BASIC_MODEL).toBe('claude-haiku-4-5')
    expect(env.AGENT_ADVANCED_MODEL).toBeUndefined()
  })

  test('sets both when both are configured', async () => {
    getAgentModeOverridesMock.mockImplementation(() => ({
      basic: 'claude-haiku-4-5',
      advanced: 'claude-sonnet-4-5',
    }))
    const env = await buildProjectEnv('proj-mo-both')
    expect(env.AGENT_BASIC_MODEL).toBe('claude-haiku-4-5')
    expect(env.AGENT_ADVANCED_MODEL).toBe('claude-sonnet-4-5')
  })
})

// ─── auto-mode tier overrides ─────────────────────────────────────────────

describe('buildProjectEnv — auto tier overrides', () => {
  test('omits AGENT_AUTO_TIER_MAP when no tiers are configured', async () => {
    getAutoTierOverridesMock.mockImplementation(() => ({}))
    const env = await buildProjectEnv('proj-auto-empty')
    expect(env.AGENT_AUTO_TIER_MAP).toBeUndefined()
  })

  test('resolves a public alias (hoshi-1.0) to its backing id + provider for all tiers', async () => {
    getAutoTierOverridesMock.mockImplementation(() => ({
      economy: 'hoshi-1.0',
      standard: 'hoshi-1.0',
      premium: 'hoshi-1.0',
    }))
    const env = await buildProjectEnv('proj-auto-hoshi')
    expect(env.AGENT_AUTO_TIER_MAP).toBeDefined()
    expect(JSON.parse(env.AGENT_AUTO_TIER_MAP!)).toEqual({
      economy: { id: 'mimo-v2.5', provider: 'custom' },
      standard: { id: 'mimo-v2.5', provider: 'custom' },
      premium: { id: 'mimo-v2.5', provider: 'custom' },
    })
  })

  test('passes a non-alias id through unchanged with an inferred provider', async () => {
    getAutoTierOverridesMock.mockImplementation(() => ({ premium: 'claude-opus-4-7' }))
    const env = await buildProjectEnv('proj-auto-passthrough')
    expect(JSON.parse(env.AGENT_AUTO_TIER_MAP!)).toEqual({
      premium: { id: 'claude-opus-4-7', provider: 'anthropic' },
    })
  })
})

// ─── S3 config ────────────────────────────────────────────────────────────

describe('buildProjectEnv — S3 config', () => {
  test('omits the entire S3 block when S3_WORKSPACES_BUCKET is unset', async () => {
    const env = await buildProjectEnv('proj-no-s3')
    expect(env.S3_WORKSPACES_BUCKET).toBeUndefined()
    expect(env.S3_REGION).toBeUndefined()
    expect(env.S3_WATCH_ENABLED).toBeUndefined()
    expect(env.S3_SYNC_INTERVAL).toBeUndefined()
  })

  test('emits the full S3 block with us-east-1 default region', async () => {
    process.env.S3_WORKSPACES_BUCKET = 'my-bucket'
    const env = await buildProjectEnv('proj-s3')
    expect(env.S3_WORKSPACES_BUCKET).toBe('my-bucket')
    expect(env.S3_REGION).toBe('us-east-1')
    expect(env.S3_WATCH_ENABLED).toBe('true')
    expect(env.S3_SYNC_INTERVAL).toBe('30000')
  })

  test('honors a custom S3_REGION', async () => {
    process.env.S3_WORKSPACES_BUCKET = 'b'
    process.env.S3_REGION = 'eu-west-2'
    const env = await buildProjectEnv('proj-s3-eu')
    expect(env.S3_REGION).toBe('eu-west-2')
  })

  test('forwards S3_ENDPOINT when set', async () => {
    process.env.S3_WORKSPACES_BUCKET = 'b'
    process.env.S3_ENDPOINT = 'http://minio:9000'
    const env = await buildProjectEnv('proj-s3-ep')
    expect(env.S3_ENDPOINT).toBe('http://minio:9000')
  })

  test('forwards S3_FORCE_PATH_STYLE only when the value is exactly "true"', async () => {
    process.env.S3_WORKSPACES_BUCKET = 'b'
    process.env.S3_FORCE_PATH_STYLE = 'true'
    let env = await buildProjectEnv('proj-s3-fps-1')
    expect(env.S3_FORCE_PATH_STYLE).toBe('true')

    process.env.S3_FORCE_PATH_STYLE = '1' // non-"true" string → omitted
    env = await buildProjectEnv('proj-s3-fps-2')
    expect(env.S3_FORCE_PATH_STYLE).toBeUndefined()
  })
})

// ─── voice / capture overrides ────────────────────────────────────────────

describe('buildProjectEnv — voice + capture overrides', () => {
  test('forwards SHOGO_VOICE_MODE when set', async () => {
    process.env.SHOGO_VOICE_MODE = 'mock'
    const env = await buildProjectEnv('proj-voice')
    expect(env.SHOGO_VOICE_MODE).toBe('mock')
  })

  test('SHOGO_DEMO_VOICE acts as an alias when SHOGO_VOICE_MODE is unset', async () => {
    process.env.SHOGO_DEMO_VOICE = 'mock'
    const env = await buildProjectEnv('proj-demo-voice')
    expect(env.SHOGO_VOICE_MODE).toBe('mock')
  })

  test('SHOGO_VOICE_MODE wins over SHOGO_DEMO_VOICE', async () => {
    process.env.SHOGO_VOICE_MODE = 'real'
    process.env.SHOGO_DEMO_VOICE = 'mock'
    const env = await buildProjectEnv('proj-voice-win')
    expect(env.SHOGO_VOICE_MODE).toBe('real')
  })

  test('omits SHOGO_VOICE_MODE when neither env var is set', async () => {
    const env = await buildProjectEnv('proj-voice-none')
    expect(env.SHOGO_VOICE_MODE).toBeUndefined()
  })

  test('forwards SHOGO_MOCK_CAPTURE_DIR when set', async () => {
    process.env.SHOGO_MOCK_CAPTURE_DIR = '/captures/run-1'
    const env = await buildProjectEnv('proj-capture')
    expect(env.SHOGO_MOCK_CAPTURE_DIR).toBe('/captures/run-1')
  })

  test('omits SHOGO_MOCK_CAPTURE_DIR when unset', async () => {
    const env = await buildProjectEnv('proj-no-capture')
    expect(env.SHOGO_MOCK_CAPTURE_DIR).toBeUndefined()
  })
})

// ─── return shape ─────────────────────────────────────────────────────────

describe('buildProjectEnv — return shape', () => {
  test('returns a plain Record<string,string> (no nested objects, no nulls)', async () => {
    process.env.S3_WORKSPACES_BUCKET = 'b'
    findUniqueProjectMock.mockImplementation(async () => ({
      workspaceId: 'ws-1',
      name: 'Agent',
      settings: {},
    }))
    const env = await buildProjectEnv('proj-shape')
    for (const [k, v] of Object.entries(env)) {
      expect(typeof k).toBe('string')
      expect(typeof v).toBe('string')
    }
  })
})
