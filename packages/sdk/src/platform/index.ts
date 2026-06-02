// SPDX-License-Identifier: MIT
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
    marketplace: boolean
    ezMode: boolean
    phoneChannel: boolean
  }
}

/** Super-admin feature flag overrides. `null` means "use platform default". */
export interface FeatureFlagOverrides {
  marketplace: boolean | null
  ezMode: boolean | null
  phoneChannel: boolean | null
}

/** Partial feature flag patch; omit a key to leave it unchanged; `null` to reset to default. */
export type FeatureFlagPatch = Partial<{
  marketplace: boolean | null
  ezMode: boolean | null
  phoneChannel: boolean | null
}>

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
  userCode?: string
  authUrl: string
  /** Suggested poll cadence in ms (clamp to >=1s on the client). */
  pollIntervalMs?: number
  expiresInMs: number
  /** Resolved cloud URL the SDK reached. Useful for surface-level UI hints. */
  cloudUrl?: string
}

export interface CloudLoginPoll {
  ok: boolean
  status: 'pending' | 'approved' | 'denied' | 'expired'
  /** Present iff status === 'approved'. The minted shogo_sk_* device key. */
  key?: string
  email?: string | null
  workspace?: string | null
  deviceId?: string
  error?: string
}

/** Minimal workspace fields surfaced by the bridge picker and admin switcher. */
export interface WorkspaceSummary {
  id: string
  name: string
  slug: string
}

export interface CloudLoginStatus {
  signedIn: boolean
  cloudUrl?: string
  email?: string | null
  workspace?: { id?: string; name?: string; slug?: string } | null
  deviceId?: string | null
  keyPrefix?: string
  /** True when the cloud has rejected the stored API key (revoked / expired).
   * The user remains signed in locally; the UI should show a warning banner
   * prompting them to sign out and sign in again. */
  cloudKeyRejected?: boolean
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

/** First-class BYOK providers exposed via `/api/local/api-keys`.
 *
 * Adding a provider here is the only client-side change needed to surface
 * it in the admin UI; the matching env-var entry and routing live in the
 * API server. Order is the rendering order in the admin form. */
// Providers offered in the primary BYOK setup. Trimmed to the majors we can
// discover live + fully route today (OpenAI, Anthropic). OpenRouter and Google
// left the primary setup with the per-provider discovery redesign; Google chat
// routing is still deferred (see provider-key model setup plan).
export const BYOK_PROVIDERS = [
  { id: 'anthropic',  name: 'Anthropic',  envKey: 'ANTHROPIC_API_KEY',  signupUrl: 'https://console.anthropic.com/' },
  { id: 'openai',     name: 'OpenAI',     envKey: 'OPENAI_API_KEY',     signupUrl: 'https://platform.openai.com/api-keys' },
] as const

export type BYOKProviderId = typeof BYOK_PROVIDERS[number]['id']

export interface LlmConfig {
  AI_MODE?: string
  LOCAL_LLM_BASE_URL?: string
  LOCAL_LLM_BASIC_MODEL?: string
  LOCAL_LLM_ADVANCED_MODEL?: string
  LOCAL_EMBEDDING_MODEL?: string
  LOCAL_EMBEDDING_DIMENSIONS?: string
  [key: string]: string | undefined
}

/** A single OpenRouter model entry surfaced to user-facing pickers. */
export interface VisibleOpenRouterModel {
  /** ID in our catalog convention, e.g. `openrouter:anthropic/claude-3.5-sonnet`. */
  id: string
  displayName: string
  contextLength?: number
  tier?: 'economy' | 'standard' | 'premium'
  /** Per-token rates in USD captured from OpenRouter at allowlist time.
   *  Lets the UI show real $/M-token figures and the eval cost calc
   *  report actual (not Sonnet-fallback) dollar costs. */
  pricing?: {
    promptPerToken?: number
    completionPerToken?: number
    cacheReadPerToken?: number
    cacheWritePerToken?: number
  }
}

/** A catalog model entry fully resolved by the serving API, carrying the
 *  metadata a picker needs to render it without a local catalog lookup.
 *
 *  This is what lets a cloud-connected desktop render models its bundled
 *  `MODEL_CATALOG` may not know about: the connected cloud resolves its own
 *  catalog and ships the display fields over the wire. */
export interface VisibleCatalogModel {
  id: string
  provider: string
  displayName: string
  shortDisplayName?: string
  tier: 'economy' | 'standard' | 'premium'
  /** Model family for color-coding/labelling (e.g. `opus`, `gpt`, `other`).
   *  Optional for back-compat with API servers that predate this field;
   *  lets clients label purely-DB-defined models they don't bundle. */
  family?: string
  /** Max output tokens, shipped so clients can size requests for DB-only
   *  models absent from their bundled catalog. */
  maxOutputTokens?: number
  /** Admin-controlled position in the user-facing picker (ascending). */
  sortOrder?: number
  /** Short blurb shown in the picker info panel. */
  description?: string
  /** Total context window in tokens (distinct from maxOutputTokens). */
  contextWindow?: number
  /** Reasoning effort applied when the model runs (drives thinkingLevel). */
  reasoningEffort?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
}

/** Admin-curated allowlist of models that surface in the user picker.
 *
 * - `catalogIds === null` means "show all current-generation catalog models"
 *   (the default — admin hasn't configured a curated list yet).
 * - `catalogIds === []` shows zero catalog models (only the OpenRouter ones).
 * - `openrouterModels` is always an explicit additive list.
 */
export interface VisibleModelsConfig {
  catalogIds: string[] | null
  openrouterModels: VisibleOpenRouterModel[]
}

/** Resolved view returned by `GET /api/platform/visible-models`.
 *
 * Extends the stored {@link VisibleModelsConfig} with `catalogModels`: the
 * allowlist resolved against the serving API's own catalog. Pickers should
 * prefer `catalogModels` when present (it reflects the connected cloud's
 * catalog) and fall back to filtering the bundled catalog by `catalogIds`
 * for older payloads that omit it. */
export interface ResolvedVisibleModels {
  catalogIds: string[] | null
  openrouterModels: VisibleOpenRouterModel[]
  /** Resolved catalog models for the allowlist. Optional for back-compat
   *  with API servers that predate this field. */
  catalogModels?: VisibleCatalogModel[]
}

// ===========================================================================
// DB-defined model catalog (super-admin managed). Lets new models, including
// custom OpenAI-compatible providers (e.g. MiMo), be added without a release.
// ===========================================================================

/** A custom OpenAI/Anthropic-compatible provider (e.g. MiMo / xiaomimimo).
 *  The API key is write-only: reads return only {@link apiKeyMask}. */
export interface ModelProvider {
  id: string
  label: string
  baseUrl: string
  protocol: 'openai' | 'anthropic'
  authStyle: 'bearer' | 'api-key-header'
  enabled: boolean
  /** Recognizable mask of the stored key (e.g. `sk-s…3xaa`), never the key. */
  apiKeyMask: string
  /** False when the stored key can't be decrypted (missing/rotated master key). */
  keyDecryptable: boolean
  createdAt: string
  updatedAt: string
  updatedBy: string | null
}

/** Create/update payload for a {@link ModelProvider}. `apiKey` is plaintext and
 *  encrypted server-side; omit it on update to keep the existing key. */
export interface ModelProviderInput {
  label?: string
  baseUrl?: string
  protocol?: 'openai' | 'anthropic'
  authStyle?: 'bearer' | 'api-key-header'
  apiKey?: string
  enabled?: boolean
}

/** A DB-defined model row (mirrors the static catalog shape + per-token pricing). */
export interface ModelDefinition {
  id: string
  provider: string
  providerId: string | null
  apiModel: string
  displayName: string
  shortDisplayName: string
  tier: 'economy' | 'standard' | 'premium'
  family: 'opus' | 'sonnet' | 'haiku' | 'gpt' | 'other'
  generation: 'current' | 'legacy'
  maxOutputTokens: number
  enabled: boolean
  sortOrder: number | null
  aliases: string[]
  capabilities: Record<string, unknown> | null
  /** Short blurb shown in the picker info panel. */
  description: string | null
  /** Total context window in tokens (distinct from maxOutputTokens). */
  contextWindow: number | null
  /** Reasoning effort applied when the model runs (drives thinkingLevel). */
  reasoningEffort: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null
  inputPerMillion: number
  cachedInputPerMillion: number
  cacheWritePerMillion: number
  outputPerMillion: number
  createdAt: string
  updatedAt: string
  updatedBy: string | null
}

/** A model discovered live from a provider's catalog, enriched with
 *  LiteLLM-resolved per-token pricing (per million tokens) so the admin can
 *  preview the rate before adding it. */
export interface DiscoveredProviderModel {
  id: string
  displayName: string
  contextLength?: number
  inputPerMillion?: number
  cachedInputPerMillion?: number
  cacheWritePerMillion?: number
  outputPerMillion?: number
}

/** Create/update payload for a {@link ModelDefinition}. */
export interface ModelDefinitionInput {
  id?: string
  provider?: string
  providerId?: string | null
  apiModel?: string
  displayName?: string
  shortDisplayName?: string
  tier?: 'economy' | 'standard' | 'premium'
  family?: 'opus' | 'sonnet' | 'haiku' | 'gpt' | 'other'
  generation?: 'current' | 'legacy'
  maxOutputTokens?: number
  enabled?: boolean
  sortOrder?: number | null
  aliases?: string[]
  capabilities?: Record<string, unknown> | null
  description?: string | null
  contextWindow?: number | null
  reasoningEffort?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null
  inputPerMillion?: number
  cachedInputPerMillion?: number
  cacheWritePerMillion?: number
  outputPerMillion?: number
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
   * Validates the key against the cloud before saving. The cloud endpoint
   * is determined by the API server's `SHOGO_CLOUD_URL` env var and cannot
   * be overridden by callers.
   */
  async connectShogoKey(key: string): Promise<ShogoKeyConnectResult> {
    const res = await this.http.request<ShogoKeyConnectResult>(
      '/api/local/shogo-key',
      { method: 'PUT', body: { key } },
    )
    return res.data ?? { ok: false }
  }

  /** Disconnect the Shogo Cloud API key (local mode). */
  async disconnectShogoKey(): Promise<void> {
    await this.http.delete('/api/local/shogo-key')
  }

  // ===========================================================================
  // Cloud Login (poll-based device flow)
  // ===========================================================================
  //
  // The interactive sign-in flow is no longer driven through the SDK
  // because both real consumers — Shogo Desktop and the Shogo CLI worker —
  // need to talk to *both* the cloud and a local persistence layer, which
  // doesn't fit cleanly behind a single `this.http` base URL. Use the
  // dedicated implementations instead:
  //
  //   - Desktop: apps/desktop/src/main.ts → runCloudSignIn()
  //   - CLI:    packages/shogo-worker/src/lib/cloud-login.ts → runCloudLogin()
  //
  // Both drive the cloud `/api/cli/login/{start,poll,approve}` endpoints
  // directly (no protocol handler / no localhost listener) and then PUT
  // the minted key into `/api/local/shogo-key` (which validates the key
  // against cloud, writes localConfig, and restarts the instance tunnel).
  //
  // The `connectShogoKey` / `disconnectShogoKey` / `cloudLoginStatus` /
  // `signOutCloud` / `heartbeatCloudLogin` helpers below remain for the
  // CLI / headless / API-key paste paths and for the local-mode session
  // status the Settings UI needs.

  /** List workspaces the signed-in cloud user is a member of.
   * Used by the device-login bridge page (apps/mobile/app/auth/cli-link.tsx,
   * shared between desktop and CLI) to render a workspace picker when
   * the user has more than one membership. Requires an authenticated
   * cloud session (cookie); returns an empty list if unauthenticated. */
  async listMyWorkspaces(): Promise<WorkspaceSummary[]> {
    const res = await this.http.get<{ ok?: boolean; items?: WorkspaceSummary[] }>(
      '/api/workspaces',
    )
    return res.data?.items ?? []
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

  /** Get masked provider API keys keyed by provider id (e.g. `anthropic`,
   * `openai`, `google`, `openrouter`). Missing entries mean no key is set. */
  async getProviderKeyMasks(): Promise<Record<string, string>> {
    const res = await this.http.get<{ keys: Record<string, string> }>('/api/local/api-keys')
    return res.data?.keys ?? {}
  }

  /**
   * Save provider API keys. Pass a map keyed by provider id (`anthropic`,
   * `openai`, `google`, `openrouter`) — only provided entries are updated.
   * Pass `''` or `null` to clear a stored key.
   *
   * Legacy camelCase fields (`anthropicApiKey`, `openaiApiKey`,
   * `googleApiKey`) are still accepted for backwards-compatibility.
   */
  async putProviderKeys(
    keys: Record<string, string | null | undefined>,
  ): Promise<void> {
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

  /** Live catalog from OpenRouter (`/api/v1/models`). Requires an
   * `OPENROUTER_API_KEY` to be configured for user-specific pricing,
   * but works unauthenticated too. */
  async getOpenRouterModels(): Promise<{
    ok: boolean
    models: Array<{
      id: string
      name: string
      description?: string
      contextLength?: number
      /** Per-token rates in USD. `cacheRead` / `cacheWrite` are populated
       *  for models that surface cache pricing on OpenRouter (currently
       *  Anthropic-on-OpenRouter and a few others). Missing fields stay
       *  undefined rather than 0 so callers can distinguish "free" from
       *  "unknown" — billing-side code should treat undefined as 0. */
      pricing?: {
        prompt?: number
        completion?: number
        cacheRead?: number
        cacheWrite?: number
      }
    }>
    error?: string
  }> {
    const res = await this.http.get<{
      ok: boolean
      models: Array<{
        id: string
        name: string
        description?: string
        contextLength?: number
        pricing?: { prompt?: number; completion?: number; cacheRead?: number; cacheWrite?: number }
      }>
      error?: string
    }>('/api/local/openrouter/models')
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

  /** Get the admin-configured model used to generate chat/project titles.
   *  Returns `{ model: null }` when unset (platform default applies). */
  async getTitleGenerationModel(): Promise<{ model: string | null }> {
    const res = await this.http.get<{ model: string | null }>(
      '/api/admin/settings/title-generation-model',
    )
    return res.data ?? { model: null }
  }

  /** Set the model used to generate chat/project titles. Pass null/empty to
   *  reset to the platform default (Haiku). */
  async putTitleGenerationModel(model: string | null): Promise<void> {
    await this.http.request('/api/admin/settings/title-generation-model', {
      method: 'PUT',
      body: { model },
    })
  }

  // ===========================================================================
  // Admin: Visible Models (catalog allowlist + curated OpenRouter models)
  // ===========================================================================

  /** Read the admin-configured visible-models config (allowlist + OR extras). */
  async getVisibleModelsConfig(): Promise<VisibleModelsConfig> {
    const res = await this.http.get<VisibleModelsConfig>(
      '/api/admin/settings/visible-models',
    )
    return res.data ?? { catalogIds: null, openrouterModels: [] }
  }

  /** Replace the visible-models config. Pass `catalogIds: null` to revert
   * to "show all catalog models". */
  async putVisibleModelsConfig(config: VisibleModelsConfig): Promise<void> {
    await this.http.request('/api/admin/settings/visible-models', {
      method: 'PUT',
      body: config,
    })
  }

  /** Public read of the resolved visible-models config — this is the seam
   * user-facing chat input pickers should use to render their model list. */
  async getVisibleModels(): Promise<ResolvedVisibleModels> {
    const res = await this.http.get<ResolvedVisibleModels>(
      '/api/platform/visible-models',
    )
    return res.data ?? { catalogIds: null, openrouterModels: [] }
  }

  // ===========================================================================
  // Admin: DB-defined model catalog (custom providers + models)
  // ===========================================================================

  /** List custom model providers. Keys are returned masked, never in plaintext. */
  async listModelProviders(): Promise<ModelProvider[]> {
    const res = await this.http.get<{ providers: ModelProvider[] }>('/api/admin/settings/model-providers')
    return res.data?.providers ?? []
  }

  /** Create a custom model provider. `apiKey` is required and stored encrypted. */
  async createModelProvider(input: ModelProviderInput): Promise<ModelProvider> {
    const res = await this.http.request<{ ok: boolean; provider: ModelProvider }>(
      '/api/admin/settings/model-providers',
      { method: 'POST', body: input },
    )
    return res.data!.provider
  }

  /** Update a custom model provider. Omit `apiKey` to keep the existing key. */
  async updateModelProvider(id: string, input: ModelProviderInput): Promise<ModelProvider> {
    const res = await this.http.request<{ ok: boolean; provider: ModelProvider }>(
      `/api/admin/settings/model-providers/${encodeURIComponent(id)}`,
      { method: 'PUT', body: input },
    )
    return res.data!.provider
  }

  /** Delete a custom model provider. Linked models have their providerId nulled. */
  async deleteModelProvider(id: string): Promise<void> {
    await this.http.request(`/api/admin/settings/model-providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  /** List DB-defined models. */
  async listModels(): Promise<ModelDefinition[]> {
    const res = await this.http.get<{ models: ModelDefinition[] }>('/api/admin/settings/models')
    return res.data?.models ?? []
  }

  /** Create a DB-defined model. */
  async createModel(input: ModelDefinitionInput): Promise<ModelDefinition> {
    const res = await this.http.request<{ ok: boolean; model: ModelDefinition }>(
      '/api/admin/settings/models',
      { method: 'POST', body: input },
    )
    return res.data!.model
  }

  /** Update a DB-defined model. */
  async updateModel(id: string, input: ModelDefinitionInput): Promise<ModelDefinition> {
    const res = await this.http.request<{ ok: boolean; model: ModelDefinition }>(
      `/api/admin/settings/models/${encodeURIComponent(id)}`,
      { method: 'PUT', body: input },
    )
    return res.data!.model
  }

  /** Delete a DB-defined model. */
  async deleteModel(id: string): Promise<void> {
    await this.http.request(`/api/admin/settings/models/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  // ===========================================================================
  // Admin: Native provider keys + live model discovery
  // ===========================================================================

  /** Read masked native provider keys (anthropic / openai / google /
   * openrouter), with how each is configured (`db` = admin-entered & encrypted,
   * `env` = server env var). Keys are never returned in plaintext. */
  async getAdminProviderKeyMasks(): Promise<
    Record<string, { configured: boolean; mask: string; source: 'db' | 'env' | null }>
  > {
    const res = await this.http.get<{
      keys: Record<string, { configured: boolean; mask: string; source: 'db' | 'env' | null }>
    }>('/api/admin/settings/provider-keys')
    return res.data?.keys ?? {}
  }

  /** Store native provider keys (encrypted at rest). Pass a map keyed by
   * provider id; `''`/`null` clears a stored key (env fallback then applies). */
  async putAdminProviderKeys(
    keys: Record<string, string | null | undefined>,
  ): Promise<Record<string, { configured: boolean; mask: string; source: 'db' | 'env' | null }>> {
    const res = await this.http.request<{
      ok: boolean
      keys: Record<string, { configured: boolean; mask: string; source: 'db' | 'env' | null }>
    }>('/api/admin/settings/provider-keys', { method: 'PUT', body: keys })
    return res.data?.keys ?? {}
  }

  /** Live model list from a native provider (anthropic / openai / openrouter),
   * discovered with the configured key. OpenRouter's catalog is public, so it
   * lists even without a key. */
  async getProviderModels(
    provider: 'anthropic' | 'openai' | 'openrouter',
  ): Promise<{ ok: boolean; models: DiscoveredProviderModel[]; error?: string }> {
    const res = await this.http.get<{
      ok: boolean
      models: DiscoveredProviderModel[]
      error?: string
    }>(`/api/admin/settings/providers/${encodeURIComponent(provider)}/models`)
    return res.data ?? { ok: false, models: [] }
  }

  /** Persist which discovered provider models are enabled. Each entry upserts a
   * DB model row (enable) or flips it disabled (enable: false). */
  async setProviderModelsEnabled(
    provider: 'anthropic' | 'openai',
    models: Array<{ id: string; displayName?: string; contextWindow?: number; enabled: boolean }>,
  ): Promise<void> {
    await this.http.request(
      `/api/admin/settings/providers/${encodeURIComponent(provider)}/models/enable`,
      { method: 'POST', body: { models } },
    )
  }

  // ===========================================================================
  // Admin: Model pricing (LiteLLM-sourced)
  // ===========================================================================

  /** When token prices were last refreshed from LiteLLM, and whether the
   * daily TTL has elapsed. */
  async getPricingStatus(): Promise<{ refreshedAt: string | null; stale: boolean }> {
    const res = await this.http.get<{ refreshedAt: string | null; stale: boolean }>(
      '/api/admin/settings/pricing/status',
    )
    return res.data ?? { refreshedAt: null, stale: true }
  }

  /** Refresh per-token pricing + context window on DB models from LiteLLM.
   * `force` refreshes regardless of TTL; otherwise it no-ops when still fresh. */
  async refreshModelPricing(
    force = false,
  ): Promise<{ ok: boolean; refreshedAt: string | null; updated: number; total: number; skipped?: boolean; error?: string }> {
    const res = await this.http.request<{
      ok: boolean
      refreshedAt: string | null
      updated: number
      total: number
      skipped?: boolean
      error?: string
    }>('/api/admin/settings/pricing/refresh', { method: 'POST', body: { force } })
    return res.data ?? { ok: false, refreshedAt: null, updated: 0, total: 0 }
  }

  // ===========================================================================
  // Admin: Feature Flags
  // ===========================================================================

  /** Read super-admin feature flag overrides. `null` means "use platform default". */
  async getFeatureFlags(): Promise<FeatureFlagOverrides> {
    const res = await this.http.get<FeatureFlagOverrides>('/api/admin/settings/features')
    return res.data ?? { marketplace: null, ezMode: null, phoneChannel: null }
  }

  /** Update feature flag overrides. Pass `null` for a flag to reset to platform default. */
  async putFeatureFlags(patch: FeatureFlagPatch): Promise<{ ok: boolean; flags: FeatureFlagOverrides }> {
    const res = await this.http.request<{ ok: boolean; flags: FeatureFlagOverrides }>(
      '/api/admin/settings/features',
      { method: 'PUT', body: patch },
    )
    return res.data ?? { ok: false, flags: { marketplace: null, ezMode: null, phoneChannel: null } }
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
