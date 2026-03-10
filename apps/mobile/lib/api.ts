// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform } from 'react-native'
import { HttpClient } from '@shogo-ai/sdk'

export const API_URL = (() => {
  const envUrl = process.env.EXPO_PUBLIC_API_URL

  // Empty string means "same origin" (Docker/nginx proxy builds set EXPO_PUBLIC_API_URL="")
  if (envUrl === '' && Platform.OS === 'web' && typeof window !== 'undefined') {
    return window.location.origin
  }

  // On web dev, ignore the env var (it's a LAN IP meant for physical mobile devices)
  // and always use localhost so the browser can reach the API.
  if (Platform.OS === 'web') {
    return 'http://localhost:8002'
  }

  if (envUrl) return envUrl

  return Platform.select({
    ios: 'http://192.168.1.132:8002',
    android: 'http://192.168.1.132:8002',
    default: 'http://localhost:8002',
  })!
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
}

export interface WorkspaceCheckoutParams {
  workspaceName: string
  planId: string
  billingInterval: 'monthly' | 'annual'
  userId: string
  userEmail?: string
}

export const api = {
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
    const res = await http.get<{ data: Array<{ toolkit?: string; status: string }> }>(
      '/api/integrations/connections',
      { projectId },
    )
    return res.data.data ?? []
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
    return res.data?.items ?? []
  },

  // ─── Invitations ──────────────────────────────────────

  async getReceivedInvitations(http: HttpClient, email: string) {
    const res = await http.get<{ ok: boolean; items?: any[] }>(
      `/api/invitations?email=${encodeURIComponent(email)}`,
    )
    return (res.data?.items ?? []).filter((i: any) => i.status === 'pending')
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

  // ─── Templates ─────────────────────────────────────────────

  async getAgentTemplates(http: HttpClient) {
    const res = await http.get<{ templates: AgentTemplateSummary[] }>('/api/agent-templates')
    return res.data?.templates ?? []
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
    return res.data ?? { mode: 'balanced' as const, approvalTimeoutSeconds: 60 }
  },

  async saveSecurityPrefs(http: HttpClient, prefs: SecurityPrefs) {
    const res = await http.post<{ ok: boolean }>('/api/local/security-prefs', prefs)
    return res.data
  },
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

export interface AgentTemplateSummary {
  id: string
  name: string
  description: string
  category: string
  icon: string
  tags: string[]
  settings: {
    heartbeatInterval: number
    heartbeatEnabled: boolean
    modelProvider: string
    modelName: string
  }
  skills: string[]
}
