// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Platform API
 *
 * Typed client for Shogo platform endpoints: API key management,
 * local instance configuration, and platform feature flags.
 *
 * Cloud endpoints (require authenticated session):
 *   - API key CRUD for Shogo Local → Cloud authentication
 *
 * Local endpoints (local mode only, /api/local/*):
 *   - Shogo Cloud API key connection
 *   - LLM provider configuration
 *   - Provider API key storage
 *
 * Universal:
 *   - Platform config / feature flags
 */

import type { HttpClient } from '../http/client.js'
import type { ShogoResponse } from '../types.js'

// =============================================================================
// Types
// =============================================================================

export interface PlatformConfig {
  localMode: boolean
  needsSetup?: boolean
  shogoKeyConnected?: boolean
  configLoaded?: boolean
  features: {
    billing: boolean
    admin: boolean
    oauth: boolean
    analytics: boolean
    publishing: boolean
  }
}

/** API keys come in two flavours:
 * - "user": manually created via the Keys UI or the SHOGO_API_KEY env var.
 * - "device": minted automatically when a Shogo desktop install signs in to
 *   Shogo Cloud. Carries device metadata so the cloud UI can surface it as a
 *   managed device session. Revoking a device key effectively signs the
 *   device out on its next proxy call. */
export type ApiKeyKind = 'user' | 'device'

export interface ApiKeyInfo {
  id: string
  name: string
  keyPrefix: string
  lastUsedAt: string | null
  expiresAt: string | null
  createdAt: string
  userId: string
  kind?: ApiKeyKind
  deviceId?: string | null
  deviceName?: string | null
  devicePlatform?: string | null
  deviceAppVersion?: string | null
  lastSeenAt?: string | null
  user: { name: string | null; email: string }
}

export interface ApiKeyCreateResult {
  id: string
  name: string
  /** Full plaintext key — shown only once at creation. */
  key: string
  keyPrefix: string
  workspaceId: string
  expiresAt: string | null
  createdAt: string
  kind?: ApiKeyKind
  deviceId?: string | null
  deviceName?: string | null
  devicePlatform?: string | null
  deviceAppVersion?: string | null
  workspace?: { id: string; name: string; slug: string } | null
}

export interface DeviceInfo {
  id: string
  name: string
  platform: string
  appVersion: string
}

export interface ApiKeyValidation {
  valid: boolean
  error?: string
  workspace?: { id: string; name: string; slug: string }
  user?: { id: string; name: string; email?: string }
  kind?: ApiKeyKind
  deviceId?: string | null
  deviceName?: string | null
}

export interface CloudLoginStart {
  ok: boolean
  state: string
  authUrl: string
  cloudUrl: string
  expiresInMs: number
}

export interface CloudLoginStatus {
  signedIn: boolean
  cloudUrl?: string
  email?: string | null
  workspace?: { id?: string; name?: string; slug?: string } | null
  deviceId?: string | null
  keyPrefix?: string
}

export interface ShogoKeyStatus {
  connected: boolean
  keyMask?: string
  cloudUrl?: string
  workspace?: { id: string; name: string; slug: string } | null
}

export interface ShogoKeyConnectResult {
  ok: boolean
  error?: string
  workspace?: { name: string }
}

export interface LlmConfig {
  AI_MODE?: string
  LOCAL_LLM_BASE_URL?: string
  LOCAL_LLM_BASIC_MODEL?: string
  LOCAL_LLM_ADVANCED_MODEL?: string
  LOCAL_EMBEDDING_MODEL?: string
  LOCAL_EMBEDDING_DIMENSIONS?: string
  [key: string]: string | undefined
}

export interface InstanceInfo {
  name: string
  hostname: string
  os: string
  arch: string
  tunnelConnected: boolean
  cloudUrl: string
  workspaceName: string | null
}

// =============================================================================
// PlatformApi
// =============================================================================

/**
 * Typed client for Shogo platform management endpoints.
 *
 * @example
 * ```ts
 * import { PlatformApi, HttpClient } from '@shogo-ai/sdk'
 *
 * const http = new HttpClient({ baseUrl: 'http://localhost:8002', credentials: 'include' })
 * const platform = new PlatformApi(http)
 *
 * // Cloud: manage API keys
 * const keys = await platform.listApiKeys('workspace-id')
 * const created = await platform.createApiKey('My Laptop', 'workspace-id')
 *
 * // Local: connect Shogo Cloud
 * await platform.connectShogoKey('shogo_sk_...')
 * const status = await platform.getShogoKeyStatus()
 * ```
 */
export class PlatformApi {
  constructor(private http: HttpClient) {}

  // ===========================================================================
  // Platform Config
  // ===========================================================================

  /** Fetch platform configuration and feature flags. */
  async getConfig(): Promise<PlatformConfig> {
    const res = await this.http.get<PlatformConfig>('/api/config')
    return res.data!
  }

  // ===========================================================================
  // Cloud API Keys (manage keys for Shogo Local → Cloud auth)
  // ===========================================================================

  /** List active API keys for a workspace. Pass `kind: 'device'` to fetch
   * device-session keys for the Devices UI, or `kind: 'user'` for manually
   * created keys. Omit to list both. */
  async listApiKeys(workspaceId: string, opts?: { kind?: ApiKeyKind }): Promise<ApiKeyInfo[]> {
    const query: Record<string, string> = { workspaceId }
    if (opts?.kind) query.kind = opts.kind
    const res = await this.http.get<{ keys: ApiKeyInfo[] }>(
      '/api/api-keys',
      query,
    )
    return res.data?.keys ?? []
  }

  /** Create a new "user" API key. Returns the full plaintext key (shown only once). */
  async createApiKey(name: string, workspaceId: string): Promise<ApiKeyCreateResult> {
    const res = await this.http.post<ApiKeyCreateResult>(
      '/api/api-keys',
      { name, workspaceId },
    )
    return res.data!
  }

  /** Mint a device-session API key for the current user's device. Cloud API
   * deduplicates by (workspaceId, deviceId) — previous device keys for the
   * same machine are revoked automatically. */
  async createDeviceApiKey(
    device: DeviceInfo,
    opts?: { workspaceId?: string },
  ): Promise<ApiKeyCreateResult> {
    const res = await this.http.post<ApiKeyCreateResult>(
      '/api/api-keys/device',
      {
        workspaceId: opts?.workspaceId,
        deviceId: device.id,
        deviceName: device.name,
        devicePlatform: device.platform,
        deviceAppVersion: device.appVersion,
      },
    )
    return res.data!
  }

  /** Revoke (soft-delete) an API key by ID. For device keys this is the
   * "sign out of device" operation. */
  async revokeApiKey(id: string): Promise<void> {
    await this.http.delete(`/api/api-keys/${id}`)
  }

  /** Validate an API key without requiring a session. */
  async validateApiKey(key: string): Promise<ApiKeyValidation> {
    const res = await this.http.post<ApiKeyValidation>(
      '/api/api-keys/validate',
      { key },
    )
    return res.data!
  }

  // ===========================================================================
  // Local: Shogo Cloud API Key
  // ===========================================================================

  /** Get the current Shogo Cloud key connection status (local mode). */
  async getShogoKeyStatus(): Promise<ShogoKeyStatus> {
    const res = await this.http.get<ShogoKeyStatus>('/api/local/shogo-key')
    return res.data ?? { connected: false }
  }

  /**
   * Connect a Shogo Cloud API key (local mode).
   * Validates the key against the cloud before saving.
   */
  async connectShogoKey(key: string, cloudUrl?: string): Promise<ShogoKeyConnectResult> {
    const res = await this.http.request<ShogoKeyConnectResult>(
      '/api/local/shogo-key',
      { method: 'PUT', body: { key, ...(cloudUrl ? { cloudUrl } : {}) } },
    )
    return res.data ?? { ok: false }
  }

  /** Disconnect the Shogo Cloud API key (local mode). */
  async disconnectShogoKey(): Promise<void> {
    await this.http.delete('/api/local/shogo-key')
  }

  /** Update the Shogo Cloud URL for an existing connection (re-validates the stored key). */
  async updateShogoCloudUrl(cloudUrl: string): Promise<ShogoKeyConnectResult> {
    const res = await this.http.request<ShogoKeyConnectResult>(
      '/api/local/shogo-key',
      { method: 'PATCH', body: { cloudUrl } },
    )
    return res.data ?? { ok: false }
  }

  // ===========================================================================
  // Local: Cloud Login (replacement for the manual connectShogoKey paste flow)
  // ===========================================================================
  //
  // The desktop "Sign in to Shogo Cloud" button uses startCloudLogin to get
  // an authUrl it hands to the system browser. The browser eventually
  // redirects to shogo://auth-callback which Electron main catches and
  // completes via POST /api/local/cloud-login/complete (no separate SDK
  // method — that step is driven by the Electron IPC layer).
  //
  // The legacy connectShogoKey / disconnectShogoKey methods above remain for
  // CLI / headless contexts that paste a raw shogo_sk_ key.

  /** Start a cloud login flow. Opens the returned authUrl in the system
   * browser to complete sign-in. */
  async startCloudLogin(device: DeviceInfo): Promise<CloudLoginStart> {
    const res = await this.http.post<CloudLoginStart>(
      '/api/local/cloud-login/start',
      {
        deviceId: device.id,
        deviceName: device.name,
        devicePlatform: device.platform,
        deviceAppVersion: device.appVersion,
      },
    )
    return res.data!
  }

  /** Read the current local-mode cloud login status. */
  async cloudLoginStatus(): Promise<CloudLoginStatus> {
    const res = await this.http.get<CloudLoginStatus>('/api/local/cloud-login/status')
    return res.data ?? { signedIn: false }
  }

  /** Sign out of Shogo Cloud on this device. Wipes the local key and best-
   * effort notifies cloud. */
  async signOutCloud(): Promise<{ ok: boolean; error?: string }> {
    const res = await this.http.post<{ ok: boolean; error?: string }>(
      '/api/local/cloud-login/signout',
      {},
    )
    return res.data ?? { ok: false }
  }

  /** Ping cloud with the stored key to refresh this device's lastSeenAt. */
  async heartbeatCloudLogin(deviceAppVersion?: string): Promise<{ ok: boolean; revoked?: boolean; error?: string }> {
    const res = await this.http.post<{ ok: boolean; revoked?: boolean; error?: string }>(
      '/api/local/cloud-login/heartbeat',
      deviceAppVersion ? { deviceAppVersion } : {},
    )
    return res.data ?? { ok: false }
  }

  // ===========================================================================
  // Local: LLM Configuration
  // ===========================================================================

  /** Get the local LLM provider configuration. */
  async getLlmConfig(): Promise<LlmConfig> {
    const res = await this.http.get<{ config: LlmConfig }>('/api/local/llm-config')
    return res.data?.config ?? {}
  }

  /** Update the local LLM provider configuration. */
  async putLlmConfig(config: Record<string, string | null>): Promise<void> {
    await this.http.request('/api/local/llm-config', { method: 'PUT', body: config })
  }

  // ===========================================================================
  // Local: Provider API Keys
  // ===========================================================================

  /** Get masked provider API keys (e.g. Anthropic, OpenAI). */
  async getProviderKeyMasks(): Promise<Record<string, string>> {
    const res = await this.http.get<{ keys: Record<string, string> }>('/api/local/api-keys')
    return res.data?.keys ?? {}
  }

  /** Save provider API keys. Only provided keys are updated. */
  async putProviderKeys(keys: { anthropicApiKey?: string; openaiApiKey?: string; googleApiKey?: string }): Promise<void> {
    await this.http.request('/api/local/api-keys', { method: 'PUT', body: keys })
  }

  // ===========================================================================
  // Local: Models Discovery
  // ===========================================================================

  /** List models available from a local LLM provider. */
  async getLocalModels(baseUrl: string): Promise<{ ok: boolean; models: Array<{ id: string; name: string }>; error?: string }> {
    const res = await this.http.get<{ ok: boolean; models: Array<{ id: string; name: string }>; error?: string }>(
      '/api/local/models',
      { baseUrl },
    )
    return res.data ?? { ok: false, models: [] }
  }

  // ===========================================================================
  // Admin: Agent Model Defaults
  // ===========================================================================

  /** Get admin-configured overrides for basic/advanced agent mode models and default mode. */
  async getAgentModelDefaults(): Promise<{ basic: string | null; advanced: string | null; defaultMode: string | null }> {
    const res = await this.http.get<{ basic: string | null; advanced: string | null; defaultMode: string | null }>(
      '/api/admin/settings/agent-models',
    )
    return res.data ?? { basic: null, advanced: null, defaultMode: null }
  }

  /** Set which models the basic/advanced agent modes resolve to and the default mode. Pass null to reset to platform default. */
  async putAgentModelDefaults(overrides: { basic?: string | null; advanced?: string | null; defaultMode?: string | null }): Promise<void> {
    await this.http.request('/api/admin/settings/agent-models', { method: 'PUT', body: overrides })
  }

  // ===========================================================================
  // Local: Instance Info
  // ===========================================================================

  /** Get local instance registration info (machine name, tunnel status, etc.) */
  async getInstanceInfo(): Promise<InstanceInfo> {
    const res = await this.http.get<InstanceInfo>('/api/local/instance-info')
    return res.data!
  }

  /** Update the local instance display name. Restarts the tunnel to re-register. */
  async updateInstanceName(name: string): Promise<{ ok: boolean; name?: string }> {
    const res = await this.http.request<{ ok: boolean; name?: string }>(
      '/api/local/instance-name',
      { method: 'PUT', body: { name } },
    )
    return res.data ?? { ok: false }
  }
}
