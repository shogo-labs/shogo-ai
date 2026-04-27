// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import Constants from 'expo-constants'
import { Platform } from 'react-native'
import { HttpClient } from '@shogo-ai/sdk'

const API_PORT = process.env.EXPO_PUBLIC_API_PORT ?? '8002'

/** LAN host of the machine running Metro (same host as the API in local dev). */
function inferDevMachineHost(): string | undefined {
  const go = (Constants as { expoGoConfig?: { debuggerHost?: string } }).expoGoConfig
  const raw = go?.debuggerHost ?? Constants.expoConfig?.hostUri
  if (!raw || typeof raw !== 'string') return undefined
  const cleaned = raw.replace(/^exp:\/\//i, '').replace(/^https?:\/\//i, '')
  const host = cleaned.split(':')[0]?.trim()
  if (!host || host === 'localhost' || host === '127.0.0.1') return undefined
  return host
}

function nativeApiUrlWithoutEnv(): string {
  const lan = inferDevMachineHost()
  if (lan) return `http://${lan}:${API_PORT}`
  // Android emulator: host loopback. iOS simulator: localhost reaches the Mac.
  if (Platform.OS === 'android') return `http://10.0.2.2:${API_PORT}`
  return `http://localhost:${API_PORT}`
}

export const API_URL = (() => {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const desktop = (window as any).shogoDesktop as { apiUrl?: string } | undefined
    if (desktop?.apiUrl) return desktop.apiUrl

    const envUrl = process.env.EXPO_PUBLIC_API_URL
    if (envUrl) return envUrl
    const origin = window.location.origin
    if (!origin.includes('localhost')) return origin
    return `http://localhost:${API_PORT}`
  }

  const envUrl = process.env.EXPO_PUBLIC_API_URL
  if (envUrl) return envUrl

  return nativeApiUrlWithoutEnv()
})()

/**
 * Create a standalone HttpClient for contexts where the SDK domain
 * provider is not mounted (e.g. onboarding). Prefer `useDomainHttp()`
 * when inside the app shell.
 */
export function createHttpClient(baseUrl?: string): HttpClient {
  return new HttpClient({
    baseUrl: baseUrl ?? API_URL!,
    credentials: Platform.OS === 'web' ? 'include' : 'omit',
  })
}

// ─── Backend API helpers ────────────────────────────────────
// For domain CRUD (projects, chat sessions, etc.) use `useDomainActions()`.
// This `api` object is for non-domain endpoints (billing, analytics, etc.)
// that aren't covered by the domain stores. They use the SDK HttpClient
// available via `useDomainHttp()`.

export interface CheckoutParams {
  workspaceId: string
  planId: string
  billingInterval: 'monthly' | 'annual'
  userEmail?: string
  referralId?: string
}

export interface WorkspaceCheckoutParams {
  workspaceName: string
  planId: string
  billingInterval: 'monthly' | 'annual'
  userId: string
  userEmail?: string
  referralId?: string
}

export interface RegionalCurrencyInfo {
  code: string
  symbol: string
  name: string
  symbolPosition: 'prefix' | 'suffix'
  decimalPlaces: number
}

export interface RegionalPricingResponse {
  country: string
  currency: RegionalCurrencyInfo
  rate: number
  plans: Record<string, { monthly: number; annual: number }>
}

function throwIfBetterAuthErrorPayload(data: unknown): void {
  if (!data || typeof data !== 'object') return
  const err = (data as { error?: { message?: unknown } | null }).error
  if (err && typeof err === 'object' && err !== null && 'message' in err && err.message) {
    throw new Error(String(err.message))
  }
}

export const api = {
  /** POST /api/users/me/attribution (after signup; session cookie / token via HttpClient). */
  async postSignupAttribution(http: HttpClient, body: Record<string, unknown>) {
    await http.post('/api/users/me/attribution', body)
  },

  /** Better Auth: POST .../api/auth/request-password-reset */
  async authRequestPasswordReset(http: HttpClient, params: { email: string; redirectTo: string }) {
    const res = await http.authRequest<unknown>('/request-password-reset', {
      method: 'POST',
      body: params,
    })
    throwIfBetterAuthErrorPayload(res.data)
  },

  /** Better Auth: POST .../api/auth/reset-password */
  async authResetPassword(http: HttpClient, params: { newPassword: string; token: string }) {
    const res = await http.authRequest<unknown>('/reset-password', {
      method: 'POST',
      body: params,
    })
    throwIfBetterAuthErrorPayload(res.data)
  },

  async createCheckoutSession(http: HttpClient, params: CheckoutParams) {
    const res = await http.post<{ url?: string }>('/api/billing/checkout', params)
    return res.data
  },

  async createWorkspaceCheckout(http: HttpClient, params: WorkspaceCheckoutParams) {
    const res = await http.post<{ url?: string }>('/api/billing/workspace-checkout', params)
    return res.data
  },

  async getWorkspacePlans(http: HttpClient, workspaceIds: string[]) {
    const res = await http.get<{ ok?: boolean; plans?: Record<string, { planId: string; status: string | null }> }>(
      `/api/billing/workspace-plan?workspaceIds=${workspaceIds.join(',')}`
    )
    return res.data?.plans ?? {}
  },

  async verifyCheckout(http: HttpClient, sessionId: string) {
    const res = await http.post<{ ok?: boolean; workspaceId?: string; planId?: string }>('/api/billing/verify-checkout', { sessionId })
    return res.data
  },

  async createPortalSession(http: HttpClient, workspaceId: string, returnUrl?: string) {
    const res = await http.post<{ url?: string }>(
      `/api/billing/portal?workspaceId=${encodeURIComponent(workspaceId)}`,
      returnUrl ? { returnUrl } : {},
    )
    return res.data
  },

  async setUsageBasedPricing(
    http: HttpClient,
    workspaceId: string,
    params: { enabled: boolean; hardLimitUsd: number | null },
  ) {
    const res = await http.post<{
      ok: boolean
      overageEnabled?: boolean
      overageHardLimitUsd?: number | null
    }>(`/api/billing/usage-based-pricing`, {
      workspaceId,
      overageEnabled: params.enabled,
      overageHardLimitUsd: params.hardLimitUsd,
    })
    return res.data
  },

  async getRegionalPricing(http: HttpClient) {
    const res = await http.get<RegionalPricingResponse>('/api/billing/regional-pricing')
    return res.data
  },

  async createInstanceCheckout(http: HttpClient, params: {
    workspaceId: string
    instanceSize: string
    billingInterval: string
    successUrl?: string
    cancelUrl?: string
  }) {
    const res = await http.post<{ url?: string }>('/api/billing/instance-checkout', params)
    return res.data
  },

  async createInstancePortal(http: HttpClient, workspaceId: string, returnUrl?: string) {
    const res = await http.post<{ url?: string }>(
      `/api/billing/instance-portal?workspaceId=${encodeURIComponent(workspaceId)}`,
      returnUrl ? { returnUrl } : {},
    )
    return res.data
  },

  async getWorkspaceInstance(http: HttpClient, workspaceId: string) {
    const res = await http.get<any>(`/api/workspaces/${workspaceId}/instance`)
    return res.data
  },

  async getWorkspaceStorage(http: HttpClient, workspaceId: string) {
    const res = await http.get<any>(`/api/workspaces/${workspaceId}/storage`)
    return res.data
  },

  async getWorkspaceMetrics(http: HttpClient, workspaceId: string, period = '24h') {
    const res = await http.get<any>(`/api/workspaces/${workspaceId}/metrics`, { period })
    return res.data
  },

  async getProjectAnalytics<T>(
    http: HttpClient,
    projectId: string,
    endpoint: string,
    period: string,
  ): Promise<T> {
    const res = await http.get<{ data: T }>(
      `/api/projects/${projectId}/analytics/${endpoint}`,
      { period },
    )
    return (res.data as any).data ?? res.data
  },

  async getWorkspaceAnalytics<T>(
    http: HttpClient,
    workspaceId: string,
    endpoint: string,
    params?: Record<string, string>,
  ): Promise<T> {
    const res = await http.get<{ data: T }>(
      `/api/workspaces/${workspaceId}/analytics/${endpoint}`,
      params,
    )
    return (res.data as any).data ?? res.data
  },

  async getMyAnalytics<T>(
    http: HttpClient,
    endpoint: string,
    params?: Record<string, string>,
  ): Promise<T> {
    const res = await http.get<{ data: T }>(
      `/api/me/analytics/${endpoint}`,
      params,
    )
    return (res.data as any).data ?? res.data
  },

  // ─── Cost Analytics ───────────────────────────────────────

  async getWorkspaceCostAnalytics<T>(
    http: HttpClient,
    workspaceId: string,
    endpoint: string,
    params?: Record<string, string>,
  ): Promise<T> {
    const res = await http.get<{ data: T }>(
      `/api/workspaces/${workspaceId}/cost-analytics/${endpoint}`,
      params,
    )
    return (res.data as any).data ?? res.data
  },

  async postWorkspaceCostAnalytics<T>(
    http: HttpClient,
    workspaceId: string,
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const res = await http.post<{ data: T }>(
      `/api/workspaces/${workspaceId}/cost-analytics/${endpoint}`,
      body,
    )
    return (res.data as any).data ?? res.data
  },

  // ─── Publish ─────────────────────────────────────────────

  async getPublishState(http: HttpClient, projectId: string) {
    const res = await http.get<{ subdomain?: string; publishedAt?: number; accessLevel?: string }>(
      `/api/projects/${projectId}/publish`,
    )
    return res.data
  },

  async checkSubdomain(http: HttpClient, subdomain: string) {
    const res = await http.get<{ available: boolean; reason?: string }>(
      `/api/subdomains/${encodeURIComponent(subdomain)}/check`,
    )
    return res.data
  },

  async publishProject(http: HttpClient, projectId: string, subdomain: string, accessLevel: string) {
    const res = await http.post<{ subdomain: string; publishedAt: number }>(
      `/api/projects/${projectId}/publish`,
      { subdomain, accessLevel },
    )
    return res.data
  },

  async unpublishProject(http: HttpClient, projectId: string) {
    await http.post(`/api/projects/${projectId}/unpublish`)
  },

  // ─── Integrations ────────────────────────────────────────

  async getIntegrationConnections(http: HttpClient, projectId: string) {
    const res = await http.get<{ data: Array<{ id: string; toolkit?: string; status: string; statusReason?: string | null; createdAt?: string; accountIdentifier?: string | null }> }>(
      '/api/integrations/connections',
      { projectId },
    )
    const data = res.data?.data
    return Array.isArray(data) ? data : []
  },

  async connectIntegration(http: HttpClient, toolkit: string, projectId: string, callbackUrl: string) {
    const res = await http.post<{ data?: { redirectUrl?: string } }>(
      '/api/integrations/connect',
      { toolkit, projectId, callbackUrl },
    )
    return res.data
  },

  async getIntegrationStatus(http: HttpClient, toolkit: string, projectId: string) {
    const res = await http.get<{ data?: { connectionId?: string } }>(
      `/api/integrations/status/${toolkit}`,
      { projectId },
    )
    return res.data
  },

  async disconnectIntegration(http: HttpClient, connectionId: string) {
    await http.delete(`/api/integrations/connections/${connectionId}`)
  },

  async getIntegrationStatuses(
    http: HttpClient,
    toolkits: string[],
    projectId: string,
  ): Promise<Record<string, { connected: boolean; connectionId?: string }>> {
    const results = await Promise.allSettled(
      toolkits.map((tk) => this.getIntegrationStatus(http, tk, projectId)),
    )
    return Object.fromEntries(
      toolkits.map((tk, i) => {
        const r = results[i]
        if (r.status === 'fulfilled') {
          const data = (r.value as any)?.data
          const connected =
            data?.connected === true ||
            data?.status === 'ACTIVE'
          return [tk, { connected, connectionId: data?.connectionId }]
        }
        return [tk, { connected: false }]
      }),
    )
  },

  // ─── Thumbnails ──────────────────────────────────────────

  // Uses fetch directly because the SDK HttpClient JSON-serializes all bodies;
  // binary blob uploads require raw fetch.
  async uploadThumbnail(blob: Blob, projectId: string) {
    const res = await fetch(`${API_URL}/api/projects/${projectId}/thumbnail`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      credentials: 'include',
      body: blob,
    })
    return res.json() as Promise<{ ok: boolean; thumbnailUrl?: string }>
  },

  async captureThumbnail(http: HttpClient, projectId: string, url?: string) {
    const res = await http.post<{ ok: boolean; thumbnailUrl?: string }>(
      `/api/projects/${projectId}/thumbnail/capture`,
      url ? { url } : undefined,
    )
    return res.data
  },

  async getThumbnail(http: HttpClient, projectId: string) {
    const res = await http.get<{ ok: boolean; thumbnailUrl?: string }>(
      `/api/projects/${projectId}/thumbnail`,
    )
    return res.data
  },

  // ─── Workspace ─────────────────────────────────────────

  async leaveWorkspace(http: HttpClient, workspaceId: string) {
    const res = await http.post<{ ok: boolean }>(`/api/workspaces/${workspaceId}/leave`)
    return res.data
  },

  // ─── Members ──────────────────────────────────────────

  async getWorkspaceMembers(http: HttpClient, workspaceId: string) {
    const res = await http.get<{ ok: boolean; items?: Array<{ user?: { id: string; name?: string; email?: string } }> }>(
      `/api/members?workspaceId=${workspaceId}`,
    )
    const items = res.data?.items
    return Array.isArray(items) ? items : []
  },

  async getMemberUsageStats(http: HttpClient, workspaceId: string): Promise<{ monthly: Record<string, number>; total: Record<string, number> }> {
    const res = await http.get<{ ok: boolean; data?: { monthly: Record<string, number>; total: Record<string, number> } }>(
      `/api/workspaces/${workspaceId}/analytics/member-usage`,
    )
    return res.data?.data ?? { monthly: {}, total: {} }
  },

  // ─── Invitations ──────────────────────────────────────

  async getReceivedInvitations(http: HttpClient, email: string) {
    const res = await http.get<{ ok: boolean; items?: any[] }>(
      `/api/invitations?email=${encodeURIComponent(email)}`,
    )
    const items = res.data?.items
    return (Array.isArray(items) ? items : []).filter((i: any) => i.status === 'pending')
  },

  // ─── Account ──────────────────────────────────────────

  async deleteAccount(http: HttpClient, userId: string) {
    const res = await http.delete<{ ok: boolean }>(`/api/users/${userId}`)
    return res.data
  },

  async getMyActivity(http: HttpClient) {
    const res = await http.get<{
      ok: boolean
      data: {
        totalMessages: number
        dailyAverage: number
        daysActive: number
        daysInPeriod: number
        currentStreak: number
        dailyCounts: Record<string, number>
      }
    }>('/api/me/activity')
    return res.data?.data ?? { totalMessages: 0, dailyAverage: 0, daysActive: 0, daysInPeriod: 365, currentStreak: 0, dailyCounts: {} }
  },

  // ─── Project Naming ────────────────────────────────────────

  async generateProjectName(http: HttpClient, prompt: string, workspaceId?: string) {
    const res = await http.post<{ name: string; description: string }>(
      '/api/generate-project-name',
      { prompt, workspaceId },
    )
    return res.data ?? { name: '', description: '' }
  },

  // ─── Templates ─────────────────────────────────────────────

  async getAgentTemplates(http: HttpClient) {
    const res = await http.get<{ templates: AgentTemplateSummary[] }>('/api/agent-templates')
    const templates = res.data?.templates
    return Array.isArray(templates) ? templates : []
  },

  async getTechStacks(http: HttpClient) {
    const res = await http.get<{ stacks: TechStackSummary[] }>('/api/tech-stacks')
    const stacks = res.data?.stacks
    return Array.isArray(stacks) ? stacks : []
  },

  async getAppTemplates(http: HttpClient) {
    const res = await http.get<{ templates: AppTemplateSummary[] }>('/api/templates')
    const templates = res.data?.templates
    return Array.isArray(templates) ? templates : []
  },

  // ─── Eval Outputs ─────────────────────────────────────────

  async getEvalOutputs(http: HttpClient) {
    const res = await http.get<{ runs: EvalOutputRun[] }>('/api/eval-outputs')
    const runs = res.data?.runs
    return Array.isArray(runs) ? runs : []
  },

  async importEvalAsProject(
    http: HttpClient,
    params: { evalOutputPath: string; workspaceId: string; userId: string; name?: string },
  ) {
    const res = await http.post<{ project: { id: string; name: string; description: string } }>(
      '/api/eval-outputs/import',
      params,
    )
    return res.data?.project ?? null
  },

  // ─── Admin ───────────────────────────────────────────────

  async getMe(http: HttpClient) {
    const res = await http.get<{ ok: boolean; data?: { role?: string; onboardingCompleted?: boolean } }>('/api/me')
    return res.data
  },

  async completeOnboarding(http: HttpClient) {
    const res = await http.post<{ ok: boolean }>('/api/onboarding/complete')
    return res.data
  },

  // ─── Local Security Preferences ───────────────────────────

  async getSecurityPrefs(http: HttpClient) {
    const res = await http.get<SecurityPrefs>('/api/local/security-prefs')
    return res.data ?? { mode: 'full_autonomy' as const, approvalTimeoutSeconds: 60 }
  },

  async saveSecurityPrefs(http: HttpClient, prefs: SecurityPrefs) {
    const res = await http.post<{ ok: boolean }>('/api/local/security-prefs', prefs)
    return res.data
  },

  async sendPermissionResponse(
    http: HttpClient,
    projectId: string,
    response: { id: string; decision: 'allow_once' | 'always_allow' | 'deny'; pattern?: string },
  ) {
    const res = await http.post<{ ok: boolean }>(
      `/api/projects/${projectId}/permission-response`,
      response,
    )
    return res.data
  },

  // ─── Project Export/Import ──────────────────────────────────

  getProjectExportUrl(projectId: string, opts?: { includeChats?: boolean }): string {
    const qs = opts?.includeChats === false ? '?includeChats=false' : ''
    return `${API_URL}/api/projects/${projectId}/export${qs}`
  },

  async exportProjectBlob(
    projectId: string,
    opts?: { includeChats?: boolean; authCookie?: string | null },
  ): Promise<{ blob: Blob; filename: string }> {
    const url = api.getProjectExportUrl(projectId, opts)
    const headers: Record<string, string> = {}
    if (opts?.authCookie) headers['Cookie'] = opts.authCookie

    const res = await fetch(url, {
      credentials: Platform.OS === 'web' ? 'include' : 'omit',
      headers,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(text || `Export failed with status ${res.status}`)
    }

    const disposition = res.headers.get('content-disposition') || ''
    const match = disposition.match(/filename="?([^"]+)"?/)
    const filename = match?.[1] || 'project.shogo-project'

    const blob = await res.blob()
    return { blob, filename }
  },

  async importProject(
    params: { file: Blob; workspaceId: string; filename?: string; includeChats?: boolean },
    authCookie?: string | null,
  ): Promise<{ id: string; name: string; description?: string | null } | null> {
    const formData = new FormData()
    formData.append('file', params.file, params.filename || 'project.shogo-project')
    formData.append('workspaceId', params.workspaceId)
    formData.append('includeChats', params.includeChats === false ? 'false' : 'true')

    const headers: Record<string, string> = {}
    if (authCookie) headers['Cookie'] = authCookie

    const res = await fetch(`${API_URL}/api/projects/import`, {
      method: 'POST',
      body: formData,
      credentials: Platform.OS === 'web' ? 'include' : 'omit',
      headers,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(text || `Import failed with status ${res.status}`)
    }

    const data = (await res.json()) as { project: { id: string; name: string; description?: string | null } }
    return data.project ?? null
  },

  /**
   * Streaming import with per-phase progress. Uses SSE (`Accept: text/event-stream`)
   * so the UI can render upload -> parse -> createProject -> writeFiles -> importChats
   * -> done, plus a live list of non-fatal per-file / per-chat errors.
   *
   * Upload progress (phase `upload`) is emitted only on web via XHR since
   * `fetch` does not expose upload progress. On native, upload is treated as
   * an indeterminate phase (no `upload` events are fired), then the SSE body
   * carries the server-side phases.
   */
  async importProjectStream(
    params: {
      file: Blob
      workspaceId: string
      filename?: string
      includeChats: boolean
    },
    onProgress: (ev: ProjectImportProgress) => void,
  ): Promise<{ id: string; name: string; description?: string | null }> {
    const filename = params.filename || 'project.shogo-project'

    if (Platform.OS === 'web' && typeof XMLHttpRequest !== 'undefined') {
      // Use XHR so we can surface upload progress alongside the streamed SSE body.
      return await importViaXhr(
        params.file,
        params.workspaceId,
        params.includeChats,
        filename,
        onProgress,
      )
    }

    // Native / non-web: plain fetch + SSE reader, no upload progress.
    return await importViaFetchSSE(
      params.file,
      params.workspaceId,
      params.includeChats,
      filename,
      onProgress,
    )
  },
}

// ─── Project import — streaming helpers ────────────────────────

export type ProjectImportProgress =
  | { phase: 'upload'; loaded: number; total: number }
  | { phase: 'parse' }
  | { phase: 'createProject' }
  | { phase: 'writeFiles'; done: number; total: number }
  | { phase: 'importChats'; done: number; total: number }
  | {
      phase: 'done'
      project: { id: string; name: string; description?: string | null }
      stats: {
        filesWritten: number
        filesSkipped: number
        chatsImported: number
        chatsSkipped: number
      }
    }
  | { phase: 'error'; message: string; fatal: boolean }

/**
 * Parse an SSE text stream into discrete events. Handles multi-chunk events
 * where a single SSE frame spans multiple `read()` results.
 */
function createSSEParser(onEvent: (event: string, data: string) => void) {
  let buffer = ''
  return (chunk: string) => {
    buffer += chunk
    // SSE frames are separated by a blank line (`\n\n`).
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      let event = 'message'
      const dataLines: string[] = []
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
      }
      if (dataLines.length > 0) onEvent(event, dataLines.join('\n'))
    }
  }
}

function handleSSEEvent(
  event: string,
  data: string,
  onProgress: (ev: ProjectImportProgress) => void,
  state: {
    done?: { id: string; name: string; description?: string | null }
    fatal?: string
  },
) {
  try {
    const parsed = JSON.parse(data)
    if (event === 'progress') {
      onProgress(parsed as ProjectImportProgress)
    } else if (event === 'error') {
      onProgress({
        phase: 'error',
        message: parsed.message || 'Unknown error',
        fatal: false,
      })
    } else if (event === 'done') {
      state.done = parsed.project
      onProgress({
        phase: 'done',
        project: parsed.project,
        stats: parsed.stats,
      })
    } else if (event === 'fatal') {
      state.fatal = parsed.message || 'Import failed'
      onProgress({
        phase: 'error',
        message: state.fatal!,
        fatal: true,
      })
    }
  } catch {
    // Drop malformed frames — keep the stream alive.
  }
}

async function importViaFetchSSE(
  file: Blob,
  workspaceId: string,
  includeChats: boolean,
  filename: string,
  onProgress: (ev: ProjectImportProgress) => void,
): Promise<{ id: string; name: string; description?: string | null }> {
  const formData = new FormData()
  formData.append('file', file, filename)
  formData.append('workspaceId', workspaceId)
  formData.append('includeChats', includeChats ? 'true' : 'false')

  const res = await fetch(`${API_URL}/api/projects/import`, {
    method: 'POST',
    body: formData,
    credentials: Platform.OS === 'web' ? 'include' : 'omit',
    headers: { Accept: 'text/event-stream' },
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `Import failed with status ${res.status}`)
  }

  const state: {
    done?: { id: string; name: string; description?: string | null }
    fatal?: string
  } = {}
  const parser = createSSEParser((event, data) =>
    handleSSEEvent(event, data, onProgress, state),
  )

  const reader = res.body?.getReader()
  if (!reader) {
    // Server didn't stream — fall back to reading the whole body as text.
    const text = await res.text()
    parser(text)
  } else {
    const decoder = new TextDecoder()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) parser(decoder.decode(value, { stream: true }))
    }
  }

  if (state.fatal) throw new Error(state.fatal)
  if (!state.done) throw new Error('Import finished without a `done` event')
  return state.done
}

async function importViaXhr(
  file: Blob,
  workspaceId: string,
  includeChats: boolean,
  filename: string,
  onProgress: (ev: ProjectImportProgress) => void,
): Promise<{ id: string; name: string; description?: string | null }> {
  return await new Promise((resolve, reject) => {
    const formData = new FormData()
    formData.append('file', file, filename)
    formData.append('workspaceId', workspaceId)
    formData.append('includeChats', includeChats ? 'true' : 'false')

    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_URL}/api/projects/import`, true)
    xhr.setRequestHeader('Accept', 'text/event-stream')
    xhr.withCredentials = true
    xhr.responseType = 'text'

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) {
        onProgress({ phase: 'upload', loaded: ev.loaded, total: ev.total })
      }
    }
    xhr.upload.onload = () => {
      onProgress({ phase: 'upload', loaded: file.size, total: file.size })
    }

    const state: {
      done?: { id: string; name: string; description?: string | null }
      fatal?: string
    } = {}
    const parser = createSSEParser((event, data) =>
      handleSSEEvent(event, data, onProgress, state),
    )

    let processed = 0
    xhr.onprogress = () => {
      // responseText grows as SSE frames arrive.
      const text = xhr.responseText
      if (text.length > processed) {
        parser(text.slice(processed))
        processed = text.length
      }
    }

    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(xhr.responseText || `Import failed with status ${xhr.status}`))
        return
      }
      const text = xhr.responseText
      if (text.length > processed) {
        parser(text.slice(processed))
        processed = text.length
      }
      if (state.fatal) reject(new Error(state.fatal))
      else if (!state.done) reject(new Error('Import finished without a `done` event'))
      else resolve(state.done)
    }
    xhr.onerror = () => reject(new Error('Network error during import'))
    xhr.ontimeout = () => reject(new Error('Import timed out'))

    xhr.send(formData)
  })
}

export interface SecurityPrefs {
  mode: 'strict' | 'balanced' | 'full_autonomy'
  overrides?: {
    shellCommands?: { allow?: string[]; deny?: string[] }
    fileAccess?: { allow?: string[]; deny?: string[] }
    network?: { allowedDomains?: string[] }
    mcpTools?: { autoApprove?: string[] }
  }
  approvalTimeoutSeconds?: number
}

export function getOnboardingMessage(templateName: string): string {
  return `The "${templateName}" template has been installed. Give me a short summary of what's ready and how to customize it or connect tools. Be concise — a few bullet points max, no walls of text.`
}

export interface AgentTemplateSummary {
  id: string
  name: string
  description: string
  category: string
  icon: string
  tags: string[]
  settings: Record<string, unknown> & {
    heartbeatInterval?: number
    heartbeatEnabled?: boolean
    modelProvider?: string
    modelName?: string
    webEnabled?: boolean
    browserEnabled?: boolean
    shellEnabled?: boolean
    imageGenEnabled?: boolean
    memoryEnabled?: boolean
    quickActionsEnabled?: boolean
  }
  skills: string[]
  integrations?: Array<{
    categoryId: string
    description: string
    required?: boolean
  }>
  techStack?: string
}

export interface TechStackSummary {
  id: string
  name: string
  description: string
  tags: string[]
  runtime?: {
    devServer?: string
    buildCommand?: string
    templateApiPort?: number
  }
  capabilities?: {
    webEnabled?: boolean
    browserEnabled?: boolean
    shellEnabled?: boolean
    heartbeatEnabled?: boolean
    imageGenEnabled?: boolean
    memoryEnabled?: boolean
    quickActionsEnabled?: boolean
  }
}

export interface AppTemplateSummary {
  name: string
  description: string
  complexity: 'beginner' | 'intermediate' | 'advanced'
  features: string[]
  models: string[]
  tags: string[]
  useCases: string[]
  techStack: {
    database: string
    orm?: string
    frontend: string
    router?: string
    sdk?: string
    backend?: string
    [key: string]: string | undefined
  }
}

export interface EvalOutputEntry {
  id: string
  name: string
  description: string
  icon: string
  passed: boolean
  score: { earned: number; max: number; percentage: number }
  tags: string[]
  path: string
}

export interface EvalOutputRun {
  track: string
  timestamp: string
  dirName: string
  entries: EvalOutputEntry[]
}
