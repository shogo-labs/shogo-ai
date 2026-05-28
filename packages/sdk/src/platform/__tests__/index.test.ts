// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Full coverage for src/platform/index.ts (PlatformApi).
 *
 * Drives every public method via a fake HttpClient that records calls
 * and serves canned `{ data }` responses. For every method we test both:
 *   - happy path: server returned a payload, method returns it
 *   - fallback path: server returned undefined data, method returns
 *     the documented default (empty list / { ok:false } / {} etc.)
 *
 * Methods with no fallback (those that return `res.data!`) only need
 * a single happy-path assertion.
 */

import { describe, expect, test } from 'bun:test'

import {
  PlatformApi,
  type ApiKeyCreateResult,
  type ApiKeyInfo,
  type ApiKeyValidation,
  type CloudLoginStatus,
  type DeviceInfo,
  type FeatureFlagOverrides,
  type InstanceInfo,
  type PlatformConfig,
  type ShogoKeyConnectResult,
  type ShogoKeyStatus,
  type WorkspaceSummary,
} from '../index'

// ---------------------------------------------------------------------------
// Fake HttpClient — records calls + serves canned responses
// ---------------------------------------------------------------------------

interface Call {
  method: 'GET' | 'POST' | 'DELETE' | 'PUT'
  path: string
  query?: Record<string, string>
  body?: unknown
}

class FakeHttp {
  calls: Call[] = []
  private getResponses = new Map<string, unknown>()
  private postResponses = new Map<string, unknown>()
  private deleteResponses = new Map<string, unknown>()
  private requestResponses = new Map<string, unknown>()

  setGet(path: string, data: unknown) { this.getResponses.set(path, data) }
  setPost(path: string, data: unknown) { this.postResponses.set(path, data) }
  setDelete(path: string, data: unknown) { this.deleteResponses.set(path, data) }
  setRequest(method: string, path: string, data: unknown) {
    this.requestResponses.set(`${method} ${path}`, data)
  }

  async get<T>(path: string, query?: Record<string, string>) {
    this.calls.push({ method: 'GET', path, query })
    return { data: this.getResponses.get(path) as T | undefined }
  }
  async post<T>(path: string, body?: unknown) {
    this.calls.push({ method: 'POST', path, body })
    return { data: this.postResponses.get(path) as T | undefined }
  }
  async delete<T>(path: string) {
    this.calls.push({ method: 'DELETE', path })
    return { data: this.deleteResponses.get(path) as T | undefined }
  }
  async request<T>(path: string, opts: { method: string; body?: unknown }) {
    const m = opts.method.toUpperCase() as Call['method']
    this.calls.push({ method: m, path, body: opts.body })
    return { data: this.requestResponses.get(`${opts.method} ${path}`) as T | undefined }
  }
}

function mkApi(): { api: PlatformApi; http: FakeHttp } {
  const http = new FakeHttp()
  // PlatformApi expects an HttpClient — duck-typed cast through unknown
  const api = new PlatformApi(http as unknown as ConstructorParameters<typeof PlatformApi>[0])
  return { api, http }
}

// ---------------------------------------------------------------------------
// Platform Config
// ---------------------------------------------------------------------------

describe('PlatformApi.getConfig', () => {
  test('returns server-provided PlatformConfig', async () => {
    const { api, http } = mkApi()
    const expected: PlatformConfig = {
      localMode: true,
      features: {
        billing: false, admin: false, oauth: true, analytics: false,
        publishing: false, marketplace: true, ezMode: false, phoneChannel: false,
      },
    }
    http.setGet('/api/config', expected)
    expect(await api.getConfig()).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// API Keys
// ---------------------------------------------------------------------------

describe('PlatformApi.listApiKeys', () => {
  test('happy: returns res.data.keys', async () => {
    const { api, http } = mkApi()
    const keys: ApiKeyInfo[] = [{
      id: 'k1', name: 'A', keyPrefix: 'shogo_', lastUsedAt: null, expiresAt: null,
      createdAt: 'now', userId: 'u', user: { name: 'A', email: 'a@a' },
    }]
    http.setGet('/api/api-keys', { keys })
    expect(await api.listApiKeys('ws-1')).toEqual(keys)
    expect(http.calls[0]).toMatchObject({
      method: 'GET', path: '/api/api-keys', query: { workspaceId: 'ws-1' },
    })
  })

  test('opts.kind appended to query', async () => {
    const { api, http } = mkApi()
    http.setGet('/api/api-keys', { keys: [] })
    await api.listApiKeys('ws-1', { kind: 'device' })
    expect(http.calls[0]!.query).toEqual({ workspaceId: 'ws-1', kind: 'device' })
  })

  test('fallback: returns [] when data.keys missing', async () => {
    const { api } = mkApi() // no response set
    expect(await api.listApiKeys('ws-1')).toEqual([])
  })
})

describe('PlatformApi.createApiKey', () => {
  test('returns res.data', async () => {
    const { api, http } = mkApi()
    const created: ApiKeyCreateResult = {
      id: 'k1', name: 'X', key: 'shogo_sk_x', keyPrefix: 'shogo_sk_',
      workspaceId: 'ws', expiresAt: null, createdAt: 'now',
    }
    http.setPost('/api/api-keys', created)
    expect(await api.createApiKey('X', 'ws')).toEqual(created)
    expect(http.calls[0]!.body).toEqual({ name: 'X', workspaceId: 'ws' })
  })
})

describe('PlatformApi.createDeviceApiKey', () => {
  test('posts device fields + workspace, returns data', async () => {
    const { api, http } = mkApi()
    const device: DeviceInfo = { id: 'd1', name: 'Laptop', platform: 'darwin', appVersion: '1.0' }
    const created: ApiKeyCreateResult = {
      id: 'k', name: 'd1', key: 'shogo_sk_dev', keyPrefix: 'shogo_sk_',
      workspaceId: 'ws', expiresAt: null, createdAt: 'now',
    }
    http.setPost('/api/api-keys/device', created)
    const r = await api.createDeviceApiKey(device, { workspaceId: 'ws' })
    expect(r).toEqual(created)
    expect(http.calls[0]!.body).toEqual({
      workspaceId: 'ws',
      deviceId: 'd1', deviceName: 'Laptop',
      devicePlatform: 'darwin', deviceAppVersion: '1.0',
    })
  })

  test('opts omitted: workspaceId undefined', async () => {
    const { api, http } = mkApi()
    http.setPost('/api/api-keys/device', { id: 'k', name: '', key: '', keyPrefix: '', workspaceId: '', expiresAt: null, createdAt: '' })
    await api.createDeviceApiKey({ id: 'd', name: 'n', platform: 'p', appVersion: 'v' })
    expect((http.calls[0]!.body as { workspaceId: unknown }).workspaceId).toBeUndefined()
  })
})

describe('PlatformApi.revokeApiKey', () => {
  test('DELETEs /api/api-keys/:id', async () => {
    const { api, http } = mkApi()
    await api.revokeApiKey('k-42')
    expect(http.calls[0]).toEqual({ method: 'DELETE', path: '/api/api-keys/k-42' })
  })
})

describe('PlatformApi.validateApiKey', () => {
  test('posts key, returns data', async () => {
    const { api, http } = mkApi()
    const v: ApiKeyValidation = { valid: true, kind: 'device' }
    http.setPost('/api/api-keys/validate', v)
    expect(await api.validateApiKey('shogo_sk_x')).toEqual(v)
    expect(http.calls[0]!.body).toEqual({ key: 'shogo_sk_x' })
  })
})

// ---------------------------------------------------------------------------
// Local: Shogo Cloud key
// ---------------------------------------------------------------------------

describe('PlatformApi.getShogoKeyStatus', () => {
  test('happy: returns data', async () => {
    const { api, http } = mkApi()
    const s: ShogoKeyStatus = { connected: true, keyMask: 'shogo_sk_***' }
    http.setGet('/api/local/shogo-key', s)
    expect(await api.getShogoKeyStatus()).toEqual(s)
  })
  test('fallback: { connected: false } when data missing', async () => {
    const { api } = mkApi()
    expect(await api.getShogoKeyStatus()).toEqual({ connected: false })
  })
})

describe('PlatformApi.connectShogoKey', () => {
  test('PUTs key + returns data', async () => {
    const { api, http } = mkApi()
    const r: ShogoKeyConnectResult = { ok: true, workspace: { name: 'Acme' } }
    http.setRequest('PUT', '/api/local/shogo-key', r)
    expect(await api.connectShogoKey('shogo_sk_a')).toEqual(r)
    expect(http.calls[0]).toMatchObject({
      method: 'PUT', path: '/api/local/shogo-key',
      body: { key: 'shogo_sk_a' },
    })
  })
  test('fallback: { ok: false } when data missing', async () => {
    const { api } = mkApi()
    expect(await api.connectShogoKey('x')).toEqual({ ok: false })
  })
})

describe('PlatformApi.disconnectShogoKey', () => {
  test('DELETEs /api/local/shogo-key', async () => {
    const { api, http } = mkApi()
    await api.disconnectShogoKey()
    expect(http.calls[0]).toEqual({ method: 'DELETE', path: '/api/local/shogo-key' })
  })
})

// ---------------------------------------------------------------------------
// Cloud Login
// ---------------------------------------------------------------------------

describe('PlatformApi.listMyWorkspaces', () => {
  test('happy: returns data.items', async () => {
    const { api, http } = mkApi()
    const items: WorkspaceSummary[] = [{ id: '1', name: 'Acme', slug: 'acme' }]
    http.setGet('/api/workspaces', { items })
    expect(await api.listMyWorkspaces()).toEqual(items)
  })
  test('fallback: [] when items missing', async () => {
    const { api } = mkApi()
    expect(await api.listMyWorkspaces()).toEqual([])
  })
})

describe('PlatformApi.cloudLoginStatus', () => {
  test('happy: returns data', async () => {
    const { api, http } = mkApi()
    const s: CloudLoginStatus = { signedIn: true, email: 'a@a' }
    http.setGet('/api/local/cloud-login/status', s)
    expect(await api.cloudLoginStatus()).toEqual(s)
  })
  test('fallback: { signedIn: false } when data missing', async () => {
    const { api } = mkApi()
    expect(await api.cloudLoginStatus()).toEqual({ signedIn: false })
  })
})

describe('PlatformApi.signOutCloud', () => {
  test('happy: returns data', async () => {
    const { api, http } = mkApi()
    http.setPost('/api/local/cloud-login/signout', { ok: true })
    expect(await api.signOutCloud()).toEqual({ ok: true })
  })
  test('fallback: { ok: false } when data missing', async () => {
    const { api } = mkApi()
    expect(await api.signOutCloud()).toEqual({ ok: false })
  })
})

describe('PlatformApi.heartbeatCloudLogin', () => {
  test('with appVersion: body includes deviceAppVersion', async () => {
    const { api, http } = mkApi()
    http.setPost('/api/local/cloud-login/heartbeat', { ok: true })
    await api.heartbeatCloudLogin('2.0.0')
    expect(http.calls[0]!.body).toEqual({ deviceAppVersion: '2.0.0' })
  })
  test('without appVersion: body is {}', async () => {
    const { api, http } = mkApi()
    http.setPost('/api/local/cloud-login/heartbeat', { ok: true })
    await api.heartbeatCloudLogin()
    expect(http.calls[0]!.body).toEqual({})
  })
  test('fallback: { ok: false } when data missing', async () => {
    const { api } = mkApi()
    expect(await api.heartbeatCloudLogin()).toEqual({ ok: false })
  })
})

// ---------------------------------------------------------------------------
// LLM Config + Provider Keys + Models
// ---------------------------------------------------------------------------

describe('PlatformApi.getLlmConfig', () => {
  test('happy: returns data.config', async () => {
    const { api, http } = mkApi()
    http.setGet('/api/local/llm-config', { config: { AI_MODE: 'local' } })
    expect(await api.getLlmConfig()).toEqual({ AI_MODE: 'local' })
  })
  test('fallback: {} when data missing', async () => {
    const { api } = mkApi()
    expect(await api.getLlmConfig()).toEqual({})
  })
})

describe('PlatformApi.putLlmConfig', () => {
  test('PUTs config payload', async () => {
    const { api, http } = mkApi()
    await api.putLlmConfig({ AI_MODE: 'cloud', LOCAL_LLM_BASE_URL: null })
    expect(http.calls[0]).toMatchObject({
      method: 'PUT', path: '/api/local/llm-config',
      body: { AI_MODE: 'cloud', LOCAL_LLM_BASE_URL: null },
    })
  })
})

describe('PlatformApi.getProviderKeyMasks', () => {
  test('happy: returns data.keys', async () => {
    const { api, http } = mkApi()
    http.setGet('/api/local/api-keys', { keys: { anthropic: 'sk-ant-***' } })
    expect(await api.getProviderKeyMasks()).toEqual({ anthropic: 'sk-ant-***' })
  })
  test('fallback: {} when data missing', async () => {
    const { api } = mkApi()
    expect(await api.getProviderKeyMasks()).toEqual({})
  })
})

describe('PlatformApi.putProviderKeys', () => {
  test('PUTs provided keys', async () => {
    const { api, http } = mkApi()
    await api.putProviderKeys({ anthropicApiKey: 'sk-ant-x' })
    expect(http.calls[0]).toMatchObject({
      method: 'PUT', path: '/api/local/api-keys',
      body: { anthropicApiKey: 'sk-ant-x' },
    })
  })
})

describe('PlatformApi.getLocalModels', () => {
  test('happy: returns data', async () => {
    const { api, http } = mkApi()
    const r = { ok: true, models: [{ id: 'm1', name: 'Model 1' }] }
    http.setGet('/api/local/models', r)
    expect(await api.getLocalModels('http://localhost:11434')).toEqual(r)
    expect(http.calls[0]!.query).toEqual({ baseUrl: 'http://localhost:11434' })
  })
  test('fallback: { ok:false, models:[] } when data missing', async () => {
    const { api } = mkApi()
    expect(await api.getLocalModels('http://x')).toEqual({ ok: false, models: [] })
  })
})

// ---------------------------------------------------------------------------
// Admin: agent model defaults + feature flags
// ---------------------------------------------------------------------------

describe('PlatformApi.getAgentModelDefaults', () => {
  test('happy: returns data', async () => {
    const { api, http } = mkApi()
    const d = { basic: 'claude-haiku', advanced: 'claude-sonnet', defaultMode: 'basic' }
    http.setGet('/api/admin/settings/agent-models', d)
    expect(await api.getAgentModelDefaults()).toEqual(d)
  })
  test('fallback: all-null when data missing', async () => {
    const { api } = mkApi()
    expect(await api.getAgentModelDefaults()).toEqual({
      basic: null, advanced: null, defaultMode: null,
    })
  })
})

describe('PlatformApi.putAgentModelDefaults', () => {
  test('PUTs overrides body', async () => {
    const { api, http } = mkApi()
    await api.putAgentModelDefaults({ basic: 'm', advanced: null })
    expect(http.calls[0]).toMatchObject({
      method: 'PUT', path: '/api/admin/settings/agent-models',
      body: { basic: 'm', advanced: null },
    })
  })
})

describe('PlatformApi.getFeatureFlags', () => {
  test('happy: returns data', async () => {
    const { api, http } = mkApi()
    const f: FeatureFlagOverrides = { marketplace: true, ezMode: null, phoneChannel: false }
    http.setGet('/api/admin/settings/features', f)
    expect(await api.getFeatureFlags()).toEqual(f)
  })
  test('fallback: all-null when data missing', async () => {
    const { api } = mkApi()
    expect(await api.getFeatureFlags()).toEqual({
      marketplace: null, ezMode: null, phoneChannel: null,
    })
  })
})

describe('PlatformApi.putFeatureFlags', () => {
  test('happy: returns data', async () => {
    const { api, http } = mkApi()
    const r = { ok: true, flags: { marketplace: true, ezMode: null, phoneChannel: null } as FeatureFlagOverrides }
    http.setRequest('PUT', '/api/admin/settings/features', r)
    expect(await api.putFeatureFlags({ marketplace: true })).toEqual(r)
    expect(http.calls[0]!.body).toEqual({ marketplace: true })
  })
  test('fallback: { ok:false, flags:all-null } when data missing', async () => {
    const { api } = mkApi()
    expect(await api.putFeatureFlags({})).toEqual({
      ok: false,
      flags: { marketplace: null, ezMode: null, phoneChannel: null },
    })
  })
})

// ---------------------------------------------------------------------------
// Instance
// ---------------------------------------------------------------------------

describe('PlatformApi.getInstanceInfo', () => {
  test('returns data', async () => {
    const { api, http } = mkApi()
    const info: InstanceInfo = {
      name: 'mac', hostname: 'host', os: 'darwin', arch: 'arm64',
      tunnelConnected: true, cloudUrl: 'https://cloud', workspaceName: 'Acme',
    }
    http.setGet('/api/local/instance-info', info)
    expect(await api.getInstanceInfo()).toEqual(info)
  })
})

describe('PlatformApi.updateInstanceName', () => {
  test('happy: returns data', async () => {
    const { api, http } = mkApi()
    http.setRequest('PUT', '/api/local/instance-name', { ok: true, name: 'newname' })
    expect(await api.updateInstanceName('newname')).toEqual({ ok: true, name: 'newname' })
    expect(http.calls[0]!.body).toEqual({ name: 'newname' })
  })
  test('fallback: { ok: false } when data missing', async () => {
    const { api } = mkApi()
    expect(await api.updateInstanceName('x')).toEqual({ ok: false })
  })
})
