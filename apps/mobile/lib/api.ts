// SPDX-License-Identifier: MIT
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

/** An assignable admin permission scope (mirror of apps/api/src/lib/admin-scopes.ts). */
export interface AdminScopeDef {
  id: string
  label: string
  description: string
}

/** A marketplace creator's admin stats: marketplace metrics + platform spend. */
export interface AdminCreatorStat {
  userId: string
  displayName: string
  name: string | null
  email: string
  creatorTier: string
  reputationScore: number
  verified: boolean
  totalAgentsPublished: number
  totalInstalls: number
  averageAgentRating: number
  totalVersionsShipped: number
  followerCount: number
  totalEarningsUsd: number
  pendingPayoutUsd: number
  totalPaidOutUsd: number
  spendUsd: number
}

/** A creator's published marketplace listing, summarized for the profile view. */
export interface AdminCreatorListing {
  id: string
  title: string
  slug: string
  status: string
  pricingModel: string
  installCount: number
  averageRating: number
  reviewCount: number
  currentVersion: string
  publishedAt: string | null
}

/** Affiliate-program 360 for a creator who also enrolled as an affiliate. */
export type ContentProgramStatus = 'none' | 'pending' | 'approved' | 'rejected'

export interface AdminCreatorAffiliate {
  /** Affiliate row id — needed for admin content-approval + payout actions. */
  id: string
  code: string
  status: string
  commissionRateBps: number | null
  contentCpmCents: number | null
  /** Per-creator per-video lifetime earnings cap in cents (null = no/platform cap). */
  contentPerVideoCapCents: number | null
  totalEarningsUsd: number
  pendingPayoutUsd: number
  totalPaidOutUsd: number
  /** Approved, unpaid commissions an admin can release right now, in USD. */
  payableUsd: number
  /** Stripe Connect payout state: not_setup | pending_verification | verified. */
  payoutStatus: string
  /** Video-creator (content CPM) program application gate. */
  contentProgramStatus: ContentProgramStatus
  contentAppliedAt: string | null
  contentReviewedAt: string | null
  contentReviewedBy: string | null
  contentRejectionReason: string | null
  referralCount: number
  downlineCount: number
  referralEarningsUsd: number
  contentEarningsUsd: number
  /** Connected Instagram / TikTok handles for the content-CPM program. */
  socialAccounts: AdminCreatorSocialAccount[]
}

/** A connected social handle on a creator's affiliate (content-CPM). */
export interface AdminCreatorSocialAccount {
  id: string
  platform: string
  handle: string
  verificationStatus: string
  verifiedAt: string | null
  lastPolledAt: string | null
  lastError: string | null
  createdAt: string
}

/** A creator/affiliate owed an approved-but-unpaid balance (admin queue). */
export interface AdminAffiliateOwed {
  affiliateId: string
  userId: string
  code: string
  email: string | null
  name: string | null
  payoutStatus: string
  /** True when Stripe Connect is set up + verified (payout can execute now). */
  payoutReady: boolean
  owedCents: number
}

/** Full per-creator profile returned by GET /api/admin/creators/:userId. */
export interface AdminCreatorDetail extends AdminCreatorStat {
  bio: string | null
  avatarUrl: string | null
  websiteUrl: string | null
  createdAt: string
  badges: { badgeType: string; earnedAt: string }[]
  listings: AdminCreatorListing[]
  affiliate: AdminCreatorAffiliate | null
}

export interface CheckoutParams {
  workspaceId: string
  planId: string
  /** Seat count. Basic = 1, Pro/Business >= 1. Defaults to 1 when omitted. */
  seats?: number
  billingInterval: 'monthly' | 'annual'
  userEmail?: string
  referralId?: string
  successUrl?: string
  cancelUrl?: string
}

export interface WorkspaceCheckoutParams {
  workspaceName: string
  planId: string
  seats?: number
  billingInterval: 'monthly' | 'annual'
  userId: string
  userEmail?: string
  referralId?: string
  successUrl?: string
  cancelUrl?: string
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

/** A sanitized Stripe invoice row returned by `GET /api/billing/invoices`. */
export interface BillingInvoice {
  id: string
  number: string | null
  status: string | null
  /** Decimal dollars (Stripe cents / 100). */
  total: number
  amountPaid: number
  amountDue: number
  currency: string
  /** Epoch milliseconds, or null. */
  created: number | null
  periodStart: number | null
  periodEnd: number | null
  hostedInvoiceUrl: string | null
  invoicePdf: string | null
  description: string | null
  lines: { description: string | null; amount: number }[]
}

/** One DNS record a user must add to point a custom domain at their app. */
export interface CustomDomainInstruction {
  type: 'CNAME' | 'TXT'
  name: string
  value: string
  purpose: 'routing' | 'ssl-validation' | 'ownership-verification'
}

/** Coarse, user-facing provisioning stage (mirrors the API's `CustomDomainStage`). */
export type CustomDomainStage =
  | 'awaiting_dns'
  | 'validating'
  | 'issuing'
  | 'active'
  | 'failed'
  | 'stalled'

/** Per-record SSL DV validation status for the panel's ✓/… ticks. */
export interface CustomDomainValidationRecord {
  name: string
  value: string
  /** `pending` | `processing` | `active` | ... */
  status: string
}

/** Server-side DNS verdict for the customer's routing + DCV records. */
export interface CustomDomainDnsCheck {
  cname: 'ok' | 'wrong' | 'missing'
  txt: 'ok' | 'partial' | 'missing'
  ok: boolean
  cnameTarget?: string
  txtFound: number
  txtExpected: number
  checkedAt: number
}

export interface CustomDomain {
  id: string
  hostname: string
  status: 'pending' | 'verifying' | 'active' | 'failed'
  sslStatus?: string
  error?: string
  verifiedAt?: number
  /** DNS records still required (returned on add + verify). */
  instructions?: CustomDomainInstruction[]
  /** Links an apex domain to its `www` companion (undefined for standalone). */
  groupId?: string
  /** True when this is the canonical hostname of its group; the other
   *  variant 308-redirects to it. Standalone domains are always primary. */
  primary?: boolean
  /** Hostname visitors are redirected to (the group's primary). Equals
   *  `hostname` for a standalone/primary domain. */
  canonicalHostname?: string
  /** Coarse lifecycle stage for the status timeline. */
  stage?: CustomDomainStage
  /** Human-readable explanation of what's happening right now. */
  message?: string
  /** Per-record SSL DV validation state (drives green/amber ticks). */
  validation?: CustomDomainValidationRecord[]
  /** Latest server-side DNS check (CNAME + `_acme-challenge` TXT). */
  dns?: CustomDomainDnsCheck
  /** Issuing CA slug (`google` | `lets_encrypt` | `ssl_com`). */
  certAuthority?: string
  /** Friendly CA name for display (e.g. "SSL.com"). */
  certAuthorityLabel?: string
  /** When the domain was first added (epoch ms). */
  createdAt?: number
  /** When status was last reconciled with Cloudflare (epoch ms). */
  lastCheckedAt?: number
  /** When issuance was last re-triggered (epoch ms). */
  lastRetriggerAt?: number
  /** How many times issuance has been re-triggered. */
  retriggerCount?: number
  /** Server-computed: is the manual "Retrigger" button currently allowed? */
  canRetrigger?: boolean
  /** ms the user must wait before a (re)trigger is allowed (cooldown / age). */
  retriggerCooldownMs?: number
}

export interface CustomDomainsResponse {
  /** Whether Cloudflare for SaaS is configured on this deployment. */
  enabled: boolean
  /** CNAME target the user points their domain at (when enabled). */
  fallbackOrigin?: string
  domains: CustomDomain[]
}

/** Content-sync state for a cloud-linked project (header pill). Mirrors
 *  `CloudSyncStatus` in `apps/api/src/lib/runtime/cloud-content-sync.ts`. */
export type CloudSyncState =
  | 'idle'
  | 'pulling'
  | 'watching'
  | 'pushing'
  | 'error'
  | 'offline'

export interface CloudSyncStatusDTO {
  projectId: string
  state: CloudSyncState
  mode?: 'git' | 'files'
  lastError?: string
  lastPushAt?: number
  lastPushCommit?: string
  conflictWarning?: string
  updatedAt: number
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
    const res = await http.get<{ ok?: boolean; plans?: Record<string, { planId: string; status: string | null; source?: 'subscription' | 'grant' | 'free' }> }>(
      `/api/billing/workspace-plan?workspaceIds=${workspaceIds.join(',')}`
    )
    return res.data?.plans ?? {}
  },

  async verifyCheckout(http: HttpClient, sessionId: string) {
    const res = await http.post<{ ok?: boolean; workspaceId?: string; planId?: string; seats?: number }>('/api/billing/verify-checkout', { sessionId })
    return res.data
  },

  async verifyAppleReceipt(http: HttpClient, params: {
    workspaceId: string
    productId: string
    transactionId: string
    transactionReceipt: string
    appAccountToken?: string
  }) {
    const res = await http.post<{ ok?: boolean; planId?: string; expiresAt?: string }>('/api/billing/ios/verify-receipt', params)
    return res.data
  },

  async createPortalSession(http: HttpClient, workspaceId: string, returnUrl?: string) {
    const res = await http.post<{ url?: string }>(
      `/api/billing/portal?workspaceId=${encodeURIComponent(workspaceId)}`,
      returnUrl ? { returnUrl } : {},
    )
    return res.data
  },

  /** GET /api/billing/invoices — recent Stripe invoices for the workspace. */
  async listInvoices(http: HttpClient, workspaceId: string, limit = 12) {
    const res = await http.get<{ ok?: boolean; invoices?: BillingInvoice[] }>(
      `/api/billing/invoices?workspaceId=${encodeURIComponent(workspaceId)}&limit=${limit}`,
    )
    return res.data?.invoices ?? []
  },

  /** GET /api/notifications/unread-count — unread inbox count for the bell badge. */
  async getUnreadNotificationCount(http: HttpClient) {
    const res = await http.get<{ ok?: boolean; count?: number }>('/api/notifications/unread-count')
    return res.data?.count ?? 0
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

  /**
   * Build the absolute CSV download URL for a workspace's usage event log.
   * Filters mirror `analytics/usage-log` (period, userId, model). The route
   * sets `content-disposition: attachment` so the browser downloads it.
   */
  getUsageLogCsvUrl(
    workspaceId: string,
    params: { period?: string; userId?: string; model?: string; limit?: number } = {},
  ): string {
    const qs = new URLSearchParams()
    if (params.period) qs.set('period', params.period)
    if (params.userId) qs.set('userId', params.userId)
    if (params.model) qs.set('model', params.model)
    if (params.limit) qs.set('limit', String(params.limit))
    const suffix = qs.toString()
    return `${API_URL}/api/workspaces/${workspaceId}/analytics/usage-log.csv${suffix ? `?${suffix}` : ''}`
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

  // ─── Sub-Agent Model Overrides (Phase 1: boss concern #2) ────
  // Lets the user override which model a built-in sub-agent uses, so the
  // optimizer's recommendations are actually applicable in one click.

  async listSubagentOverrides(
    http: HttpClient,
    workspaceId: string,
  ) {
    return await this.getWorkspaceCostAnalytics<Array<{
      id: string
      workspaceId: string
      projectId: string | null
      agentType: string
      model: string
      provider: string | null
      updatedBy: string | null
      createdAt: string
      updatedAt: string
    }>>(http, workspaceId, 'subagent-overrides')
  },

  async upsertSubagentOverride(
    http: HttpClient,
    workspaceId: string,
    body: {
      agentType: string
      model: string
      provider?: string | null
      projectId?: string | null
    },
  ) {
    const res = await http.post<{ data: any }>(
      `/api/workspaces/${workspaceId}/cost-analytics/subagent-overrides`,
      body,
    )
    return (res.data as any).data ?? res.data
  },

  async deleteSubagentOverride(
    http: HttpClient,
    workspaceId: string,
    agentType: string,
    projectId?: string | null,
  ) {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
    await http.delete(
      `/api/workspaces/${workspaceId}/cost-analytics/subagent-overrides/${encodeURIComponent(agentType)}${qs}`,
    )
  },

  // ─── Agent Eval Sets (Phase 2: custom sub-agent recommendations) ────
  // Workspace-authored examples that let custom agent types get eval-backed
  // cost recommendations instead of relying on built-in eval suites only.

  async listAgentEvalSets(
    http: HttpClient,
    workspaceId: string,
    params?: { agentType?: string; projectId?: string | null; enabled?: boolean },
  ) {
    const query: Record<string, string> = {}
    if (params?.agentType) query.agentType = params.agentType
    if (params?.projectId !== undefined && params.projectId !== null) query.projectId = params.projectId
    if (params?.enabled !== undefined) query.enabled = String(params.enabled)
    return await this.getWorkspaceCostAnalytics<Array<{
      id: string
      workspaceId: string
      projectId: string | null
      agentType: string
      name: string
      description: string | null
      examples: unknown
      enabled: boolean
      createdBy: string | null
      createdAt: string
      updatedAt: string
    }>>(http, workspaceId, 'agent-eval-sets', query)
  },

  async upsertAgentEvalSet(
    http: HttpClient,
    workspaceId: string,
    body: {
      id?: string
      agentType: string
      name: string
      description?: string | null
      examples: unknown[]
      enabled?: boolean
      projectId?: string | null
    },
  ) {
    const res = await http.post<{ data: any }>(
      `/api/workspaces/${workspaceId}/cost-analytics/agent-eval-sets`,
      body,
    )
    return (res.data as any).data ?? res.data
  },

  async deleteAgentEvalSet(
    http: HttpClient,
    workspaceId: string,
    id: string,
  ) {
    await http.delete(
      `/api/workspaces/${workspaceId}/cost-analytics/agent-eval-sets/${encodeURIComponent(id)}`,
    )
  },

  // ─── Optimizer in Action (Phase 3.3) ─────────────────────────
  // Single-shot dataset for the report surface: which overrides have been
  // applied, what the before/after cost & quality looked like, eval pass-rates
  // per (agent, model), and any active shadow A/Bs. The "show this to the
  // boss" view leans on this endpoint.

  async getOptimizerInActionReport(
    http: HttpClient,
    workspaceId: string,
  ) {
    return await this.getWorkspaceCostAnalytics<{
      workspaceId: string
      generatedAt: string
      overrides: Array<{
        id: string
        agentType: string
        projectId: string | null
        fromModel: string | null
        toModel: string
        appliedAt: string
        updatedBy: string | null
        avgCostBefore: number | null
        avgCostAfter: number | null
        qualitySuccessBefore: number | null
        qualitySuccessAfter: number | null
        runsBefore: number
        runsAfter: number
      }>
      evalScores: Array<{
        agentType: string
        model: string
        suite: string
        passRate: number
        totalCases: number
        capturedAt: string
      }>
      experiments: Array<{
        id: string
        name: string
        agentType: string
        modelA: string
        modelB: string
        status: string
        expectedEndAt: string | null
        runsA: number
        runsB: number
        verdict: 'inconclusive' | 'A' | 'B' | 'tie'
        reasons: string[]
      }>
      monthlySavingsUSD: number
    }>(http, workspaceId, 'optimizer-in-action')
  },

  // ─── Publish ─────────────────────────────────────────────

  async getPublishState(http: HttpClient, projectId: string) {
    const res = await http.get<{
      subdomain?: string
      publishedAt?: number
      accessLevel?: string
      publishedCommitSha?: string
      publishedTag?: string
    }>(
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

  // Rebuild + re-upload the current commit to the same subdomain (and re-tag
  // HEAD as the new live commit). Used by the "Publish latest changes" action.
  async republishProject(http: HttpClient, projectId: string) {
    const res = await http.post<{ url: string; subdomain: string; publishedAt: number }>(
      `/api/projects/${projectId}/republish`,
    )
    return res.data
  },

  // ─── Custom domains (Cloudflare for SaaS) ────────────────

  async getCustomDomains(http: HttpClient, projectId: string) {
    const res = await http.get<CustomDomainsResponse>(`/api/projects/${projectId}/domains`)
    return res.data
  },

  /** Add a domain. Returns the whole group: the typed hostname plus its
   *  auto-created apex/www companion when applicable. */
  async addCustomDomain(http: HttpClient, projectId: string, hostname: string) {
    const res = await http.post<{ domains: CustomDomain[] }>(`/api/projects/${projectId}/domains`, { hostname })
    return res.data.domains
  },

  /** Re-check the whole apex/www group's DNS + SSL status. */
  async verifyCustomDomain(http: HttpClient, projectId: string, domainId: string) {
    const res = await http.post<{ domains: CustomDomain[] }>(`/api/projects/${projectId}/domains/${domainId}/verify`)
    return res.data.domains
  },

  /** Manually re-trigger DV validation / cert issuance for a stalled domain
   *  (DNS correct, past ~30m). Gated server-side; throws on 409/429/502 with
   *  a friendly message. Returns the updated group. */
  async retriggerCustomDomain(http: HttpClient, projectId: string, domainId: string) {
    const res = await http.post<{ domains: CustomDomain[] }>(`/api/projects/${projectId}/domains/${domainId}/retrigger`)
    return res.data.domains
  },

  /** Make this hostname the canonical (primary) one for its group; the
   *  other variant redirects to it. Returns the updated group. */
  async setPrimaryDomain(http: HttpClient, projectId: string, domainId: string) {
    const res = await http.patch<{ domains: CustomDomain[] }>(`/api/projects/${projectId}/domains/${domainId}/primary`)
    return res.data.domains
  },

  /** Remove a domain (and its apex/www companion). Returns removed ids. */
  async removeCustomDomain(http: HttpClient, projectId: string, domainId: string) {
    const res = await http.delete<{ success: boolean; removedIds: string[] }>(`/api/projects/${projectId}/domains/${domainId}`)
    return res.data?.removedIds ?? []
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

  /**
   * Workspace-scope variant — only valid when the workspace's
   * `composioScope === 'workspace'` (returns 400 otherwise). Used by
   * the Settings → Integrations panel where there's no specific
   * project context.
   */
  async getWorkspaceIntegrationConnections(http: HttpClient, workspaceId: string) {
    const res = await http.get<{ data: Array<{ id: string; toolkit?: string; status: string; statusReason?: string | null; createdAt?: string; accountIdentifier?: string | null }> }>(
      '/api/integrations/connections',
      { workspaceId },
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

  /** Workspace-scope variant of `connectIntegration`. */
  async connectWorkspaceIntegration(http: HttpClient, toolkit: string, workspaceId: string, callbackUrl: string) {
    const res = await http.post<{ data?: { redirectUrl?: string } }>(
      '/api/integrations/connect',
      { toolkit, workspaceId, callbackUrl },
    )
    return res.data
  },

  /**
   * List every Composio toolkit available to this account. Powers the
   * "browse all" picker on the Integrations settings tab.
   */
  async getIntegrationProviders(http: HttpClient) {
    const res = await http.get<{ data: Array<{ toolkit: string; name: string; whiteLabeled?: boolean; available?: boolean }>; enabled?: boolean }>(
      '/api/integrations/providers',
    )
    const data = res.data?.data
    return {
      providers: Array.isArray(data) ? data : [],
      enabled: res.data?.enabled !== false,
    }
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

  /**
   * Per-member USD usage for the People settings table.
   *
   * Returns the current-month spend split into the three buckets the new
   * Members UI shows (Included / Free / On-Demand) plus the legacy
   * `monthly` (sum of all three) and `total` (all-time) figures.
   */
  async getMemberUsageStats(
    http: HttpClient,
    workspaceId: string,
  ): Promise<{
    monthly: Record<string, number>
    total: Record<string, number>
    included: Record<string, number>
    free: Record<string, number>
    onDemand: Record<string, number>
  }> {
    const res = await http.get<{
      ok: boolean
      data?: {
        monthly: Record<string, number>
        total: Record<string, number>
        included?: Record<string, number>
        free?: Record<string, number>
        onDemand?: Record<string, number>
      }
    }>(`/api/workspaces/${workspaceId}/analytics/member-usage`)
    const data = res.data?.data
    return {
      monthly: data?.monthly ?? {},
      total: data?.total ?? {},
      included: data?.included ?? {},
      free: data?.free ?? {},
      onDemand: data?.onDemand ?? {},
    }
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

  // ─── Runtime Prewarm ────────────────────────────────────────

  /**
   * Best-effort: ask the API to start warming a runtime pod for this
   * project. The server returns 202 immediately and resolves the warm
   * pool / cold start in the background. Safe to call repeatedly —
   * concurrent calls are deduped server-side via `pendingPodRequests`.
   */
  async prewarmProjectRuntime(http: HttpClient, projectId: string): Promise<void> {
    try {
      await http.post(`/api/projects/${encodeURIComponent(projectId)}/runtime/prewarm`, {})
    } catch (err) {
      // Prewarm is purely an optimization — never surface failures to
      // the UI. The next `getProjectPodUrl()` call from the project
      // page will still resolve a pod (cold-start path).
      console.warn('[api.prewarmProjectRuntime] best-effort prewarm failed:', err)
    }
  },

  // ─── Workspace-scoped chat sessions ─────────────────────────
  // The workspace-aware sibling of per-project chat: a workspace session
  // (contextType='workspace') with a set of attached projects, chatting
  // against the merged-root runtime. See routes/workspace-chat.ts.

  /**
   * Create a workspace-scoped chat session, optionally pre-attaching
   * projects. Returns the session id + the resolved attachments.
   */
  async createWorkspaceSession(
    http: HttpClient,
    workspaceId: string,
    opts: {
      name?: string
      inferredName?: string
      attachProjectIds?: string[]
      attachMode?: 'readwrite' | 'readonly'
    } = {},
  ): Promise<{ id: string; workspaceId: string; attached: Array<{ id: string; projectId: string; attachMode: string }> }> {
    const res = await http.post<{ session: { id: string; workspaceId: string; attached: Array<{ id: string; projectId: string; attachMode: string }> } }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`,
      opts,
    )
    if (!res.data?.session) throw new Error('createWorkspaceSession: no session returned')
    return res.data.session
  },

  /** Attach a project to an existing workspace session. */
  async attachProject(
    http: HttpClient,
    workspaceId: string,
    sessionId: string,
    projectId: string,
    attachMode: 'readwrite' | 'readonly' = 'readwrite',
  ): Promise<{ id: string; projectId: string; attachMode: string }> {
    const res = await http.post<{ attached: { id: string; projectId: string; attachMode: string } }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/projects`,
      { projectId, attachMode },
    )
    if (!res.data?.attached) throw new Error('attachProject: no attachment returned')
    return res.data.attached
  },

  /**
   * Best-effort: warm the merged-root workspace runtime. Mirrors
   * prewarmProjectRuntime. Pass the workspace session id (and/or explicit
   * attach project ids) so the runtime mounts the right subfolders.
   */
  async prewarmWorkspaceRuntime(
    http: HttpClient,
    workspaceId: string,
    opts: { sessionId?: string; attachProjectIds?: string[] } = {},
  ): Promise<void> {
    try {
      await http.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/runtime/prewarm`, opts)
    } catch (err) {
      // Prewarm is an optimization only; the first chat turn still resolves
      // (or cold-starts) the runtime.
      console.warn('[api.prewarmWorkspaceRuntime] best-effort prewarm failed:', err)
    }
  },

  // ─── Local "external folder" projects (Shogo Desktop only) ─────────────
  /**
   * Create an external (VS Code-style) project from a set of host
   * folders. Returns either the new project, an existing project that
   * was rebound (if the primary already had `.shogo/project.json`), or
   * a `needsGitRootChoice` response when the picked folder is inside a
   * git repo whose root the user hasn't confirmed yet.
   *
   * Callers should pass `acceptedGitRoot: true` to re-call with the
   * repo root once the user picks "Use repo root", or
   * `acceptedGitRoot: false` to keep the original subfolder.
   */
  async createLocalFolderProject(
    http: HttpClient,
    body: {
      paths: string[]
      name?: string
      workspaceId?: string
      acceptedGitRoot?: boolean
    },
  ): Promise<
    | { project: unknown; rebound?: boolean; warning?: string; message?: string }
    | { needsGitRootChoice: true; gitRoot: string; picked: string }
    | { error: string; code?: string; message?: string }
  > {
    const res = await http.post<any>('/api/local/projects/from-folders', body)
    // HttpClient surfaces JSON for 2xx and the body for 4xx via res.error?
    // To keep the contract simple we return the raw body — callers
    // distinguish on shape (needsGitRootChoice / project / error).
    return (res.data ?? res.error ?? {}) as any
  },

  /**
   * List recent external projects (folder-linked) for the "Open
   * Recent…" picker on the home screen.
   */
  async listRecentLocalFolderProjects(http: HttpClient): Promise<
    { id: string; name: string; projectFolders: { path: string; isPrimary: boolean }[] }[]
  > {
    try {
      const res = await http.get<{ projects: any[] }>('/api/local/projects/recent')
      return Array.isArray(res.data?.projects) ? res.data!.projects : []
    } catch {
      return []
    }
  },

  /**
   * Server-side directory listing for the in-app folder picker. Only
   * mounted in `SHOGO_LOCAL_MODE=true`; same validation gauntlet as
   * `createLocalFolderProject` (must be under `$HOME`, not a system
   * root, must exist, etc.) so anything the picker shows can also be
   * passed straight into `paths` on create.
   *
   * Returns the raw API body on success and `{ error }` on failure so
   * the modal can render a tasteful empty state without try/catch
   * noise at the call site.
   */
  async browseLocalFolder(
    http: HttpClient,
    opts: { path?: string; includeFiles?: boolean } = {},
  ): Promise<
    | {
        path: string
        parent: string | null
        home: string
        entries: Array<{ name: string; isDirectory: boolean; isSymlink: boolean; hidden: boolean }>
        truncated?: boolean
      }
    | { error: string; code?: string }
  > {
    const params = new URLSearchParams()
    if (opts.path) params.set('path', opts.path)
    if (opts.includeFiles) params.set('includeFiles', 'true')
    const qs = params.toString()
    try {
      const res = await http.get<any>(`/api/local/projects/fs/browse${qs ? `?${qs}` : ''}`)
      if (res.data && typeof res.data.path === 'string') return res.data
      const errBody = (res.error ?? res.data ?? {}) as { error?: string; code?: string }
      return {
        error: typeof errBody.error === 'string' ? errBody.error : 'Browse failed',
        code: typeof errBody.code === 'string' ? errBody.code : undefined,
      }
    } catch (err: any) {
      return { error: err?.message ?? 'Browse failed' }
    }
  },

  /**
   * List the cloud projects the connected `SHOGO_API_KEY` can see, each
   * tagged with whether it's already linked locally. Desktop-only (the
   * `/api/local/cloud-projects` route is mounted only in
   * `SHOGO_LOCAL_MODE`). Returns a signed-out empty shape on any failure
   * so the picker degrades cleanly (mirrors
   * `listRecentLocalFolderProjects`).
   */
  async listCloudProjects(http: HttpClient): Promise<{
    signedIn: boolean
    projects: Array<{
      id: string
      name?: string
      cloudLinked?: boolean
      updatedAt?: string | null
      thumbnailUrl?: string | null
    }>
    linked: string[]
  }> {
    try {
      const res = await http.get<{
        signedIn?: boolean
        projects?: Array<{ id: string; name?: string; cloudLinked?: boolean; updatedAt?: string | null; thumbnailUrl?: string | null }>
        linked?: string[]
      }>('/api/local/cloud-projects')
      const d = res.data ?? {}
      return {
        signedIn: !!d.signedIn,
        projects: Array.isArray(d.projects) ? d.projects : [],
        linked: Array.isArray(d.linked) ? d.linked : [],
      }
    } catch {
      return { signedIn: false, projects: [], linked: [] }
    }
  },

  /**
   * Link + open a cloud project locally — creates/flags a local `Project`
   * keyed by the cloud project id. The runtime adapter then auto-pulls the
   * workspace files and starts the push-back watcher on the next start.
   * Throws on failure so the caller can surface it.
   */
  async openCloudProject(
    http: HttpClient,
    cloudProjectId: string,
    name?: string,
  ): Promise<{
    project: { id: string; name?: string }
    cloudLinked: boolean
    created: boolean
  }> {
    const res = await http.post<any>(
      `/api/local/cloud-projects/${encodeURIComponent(cloudProjectId)}/open`,
      name ? { name } : {},
    )
    return (res.data ?? {}) as any
  },

  /**
   * Current content-sync status for a cloud-linked project (drives the
   * header sync pill). Returns `null` on any failure so the pill can
   * silently hide. `cloudLinked: false` means the project isn't synced.
   */
  async getCloudSyncStatus(
    http: HttpClient,
    projectId: string,
  ): Promise<{ cloudLinked: boolean; status: CloudSyncStatusDTO } | null> {
    try {
      const res = await http.get<{ cloudLinked?: boolean; status?: CloudSyncStatusDTO }>(
        `/api/local/cloud-projects/${encodeURIComponent(projectId)}/sync-status`,
      )
      const d = res.data ?? {}
      if (!d.status) return null
      return { cloudLinked: !!d.cloudLinked, status: d.status }
    } catch {
      return null
    }
  },

  /**
   * Fetch a project with its persistent attachments (the anchor merged-root
   * runtime mounts these). Returns `{ project, attachments }`.
   */
  async getLocalProjectWithAttachments(
    http: HttpClient,
    projectId: string,
  ): Promise<{
    project: any | null
    attachments: Array<{
      id: string
      attachedProjectId: string
      attachedProjectName: string | null
      attachMode: 'readwrite' | 'readonly'
    }>
  }> {
    try {
      const res = await http.get<any>(`/api/local/projects/${encodeURIComponent(projectId)}`)
      return {
        project: res.data?.project ?? null,
        attachments: Array.isArray(res.data?.attachments) ? res.data!.attachments : [],
      }
    } catch {
      return { project: null, attachments: [] }
    }
  },

  /**
   * Attach another Shogo project (same workspace) to this anchor project so
   * its files mount into the anchor merged-root runtime. `attachMode`
   * defaults to `readwrite`; `readonly` mounts it write-protected.
   */
  async attachProjectToProject(
    http: HttpClient,
    projectId: string,
    attachedProjectId: string,
    attachMode: 'readwrite' | 'readonly' = 'readwrite',
  ): Promise<{ attachment?: any; error?: string }> {
    try {
      const res = await http.post<any>(
        `/api/local/projects/${encodeURIComponent(projectId)}/attachments`,
        { attachedProjectId, attachMode },
      )
      if (res.data?.attachment) return { attachment: res.data.attachment }
      const errBody = (res.error ?? res.data ?? {}) as { error?: string; message?: string }
      return { error: errBody.message ?? errBody.error ?? 'Failed to attach project' }
    } catch (err: any) {
      return { error: err?.message ?? 'Failed to attach project' }
    }
  },

  /** Detach a previously-attached project. No-op if it wasn't attached. */
  async detachProjectFromProject(
    http: HttpClient,
    projectId: string,
    attachedProjectId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      await http.delete(
        `/api/local/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(attachedProjectId)}`,
      )
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Failed to detach project' }
    }
  },

  /** Add a linked local folder to a project (managed or external). */
  async addProjectFolder(
    http: HttpClient,
    projectId: string,
    path: string,
  ): Promise<{ folder?: any; error?: string }> {
    try {
      const res = await http.post<any>(
        `/api/local/projects/${encodeURIComponent(projectId)}/folders`,
        { path },
      )
      if (res.data?.folder) return { folder: res.data.folder }
      const errBody = (res.error ?? res.data ?? {}) as { error?: string }
      return { error: errBody.error ?? 'Failed to add folder' }
    } catch (err: any) {
      return { error: err?.message ?? 'Failed to add folder' }
    }
  },

  /** Remove a linked local folder. */
  async removeProjectFolder(
    http: HttpClient,
    projectId: string,
    folderId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      await http.delete(
        `/api/local/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}`,
      )
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Failed to remove folder' }
    }
  },

  /**
   * Get (or create) the project-pinned workspace chat session. Routing the
   * project's chat through this session boots the anchor merged-root runtime.
   */
  /**
   * Mint an ADDITIONAL workspace chat session for a project — used by
   * "+ new chat" under the workspace-runtime model so a project can hold many
   * chats, each one a workspace session on the project's merged-root runtime.
   */
  async createProjectWorkspaceSession(
    http: HttpClient,
    projectId: string,
    opts: { name?: string; inferredName?: string } = {},
  ): Promise<{ session?: { id: string; workspaceId: string }; error?: string }> {
    try {
      const res = await http.post<any>(
        `/api/local/projects/${encodeURIComponent(projectId)}/workspace-sessions`,
        opts,
      )
      if (res.data?.session) return { session: res.data.session }
      const errBody = (res.error ?? res.data ?? {}) as { error?: string; message?: string }
      return { error: errBody.message ?? errBody.error ?? 'Failed to create workspace session' }
    } catch (err: any) {
      return { error: err?.message ?? 'Failed to create workspace session' }
    }
  },

  async getProjectWorkspaceSession(
    http: HttpClient,
    projectId: string,
  ): Promise<{ session?: { id: string; workspaceId: string }; attachments?: any[]; error?: string }> {
    try {
      const res = await http.post<any>(
        `/api/local/projects/${encodeURIComponent(projectId)}/workspace-session`,
        {},
      )
      if (res.data?.session) return { session: res.data.session, attachments: res.data.attachments ?? [] }
      const errBody = (res.error ?? res.data ?? {}) as { error?: string; message?: string }
      return { error: errBody.message ?? errBody.error ?? 'Failed to open workspace session' }
    } catch (err: any) {
      return { error: err?.message ?? 'Failed to open workspace session' }
    }
  },

  /**
   * Poll the readiness of a project's anchor merged-root runtime. `generation`
   * bumps on every fresh boot (e.g. a read-only attach that needs a
   * READONLY_ROOTS restart), and `ready` means the runtime answered a health
   * probe. Used to clear the Folders panel's "Restarting context…" indicator
   * on real readiness rather than a fixed timer.
   */
  async getWorkspaceRuntimeStatus(
    http: HttpClient,
    projectId: string,
  ): Promise<{ running: boolean; ready: boolean; generation: number }> {
    try {
      const res = await http.get<{ running?: boolean; ready?: boolean; generation?: number }>(
        `/api/local/projects/${encodeURIComponent(projectId)}/workspace-runtime-status`,
      )
      const d = res.data ?? {}
      return {
        running: !!d.running,
        ready: !!d.ready,
        generation: typeof d.generation === 'number' ? d.generation : 0,
      }
    } catch {
      return { running: false, ready: false, generation: 0 }
    }
  },

  /**
   * Toggle a project's `trustLevel`. Wired to the TrustPrompt modal.
   * Returns the updated project on success.
   */
  async setLocalFolderProjectTrust(
    http: HttpClient,
    projectId: string,
    trusted: boolean,
  ): Promise<{ project?: any; error?: string }> {
    try {
      const res = await http.post<{ project: any }>(
        `/api/local/projects/${encodeURIComponent(projectId)}/trust`,
        { trusted },
      )
      return { project: res.data?.project }
    } catch (err: any) {
      return { error: err?.message ?? 'Failed to update trust' }
    }
  },

  // ─── Tech stacks / app templates ──────────────────────────

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
    const res = await http.get<{ ok: boolean; data?: { role?: string; adminScopes?: string[]; onboardingCompleted?: boolean } }>('/api/me')
    return res.data
  },

  // ─── Admin: scoped access ─────────────────────────────────

  /** The catalog of assignable admin scopes (super_admin only). */
  async getAdminScopeCatalog(http: HttpClient) {
    const res = await http.get<{ ok: boolean; data?: AdminScopeDef[] }>('/api/admin/admin-scopes')
    return res.data?.data ?? []
  },

  /** Set a user's granular admin scopes (super_admin only). */
  async setUserAdminAccess(http: HttpClient, userId: string, scopes: string[]) {
    const res = await http.patch<{
      ok: boolean
      data?: { id: string; role: string; adminScopes: string[] }
    }>(`/api/admin/users/${encodeURIComponent(userId)}/admin-access`, { scopes })
    return res.data?.data ?? null
  },

  /** Marketplace creators with marketplace metrics + per-creator platform spend. */
  async getAdminCreators(http: HttpClient) {
    const res = await http.get<{ ok: boolean; data?: AdminCreatorStat[] }>('/api/admin/creators')
    return res.data?.data ?? []
  },

  /** Full per-creator profile: stats + published listings + affiliate 360. */
  async getAdminCreatorDetail(http: HttpClient, userId: string) {
    const res = await http.get<{ ok: boolean; data?: AdminCreatorDetail }>(
      `/api/admin/creators/${encodeURIComponent(userId)}`,
    )
    return res.data?.data ?? null
  },

  /**
   * Approve or reject a creator's video-creator (content CPM) program
   * application. Approval is the gate for both earning and payout of content
   * commissions. On approve, pass `contentCpmCents` to set the per-creator CPM
   * (cents per 1,000 views) and/or `contentPerVideoCapCents` to set the
   * per-creator per-video lifetime earnings cap (cents); null clears either
   * override (platform default). Super-admin only.
   */
  async reviewContentApplication(
    http: HttpClient,
    affiliateId: string,
    action: 'approve' | 'reject',
    reason?: string,
    contentCpmCents?: number | null,
    contentPerVideoCapCents?: number | null,
  ) {
    const res = await http.post<{ ok: boolean; affiliate?: any; error?: any }>(
      `/api/admin/affiliates/${encodeURIComponent(affiliateId)}/content-application`,
      {
        action,
        reason,
        ...(contentCpmCents !== undefined ? { contentCpmCents } : {}),
        ...(contentPerVideoCapCents !== undefined ? { contentPerVideoCapCents } : {}),
      },
    )
    return res.data
  },

  /**
   * Affiliates/creators with approved, unpaid commissions an admin can
   * release. Powers the admin payout queue. Super-admin only.
   */
  async getAffiliatePayoutsOwed(http: HttpClient) {
    const res = await http.get<{ items?: AdminAffiliateOwed[] }>(
      '/api/admin/affiliates/payouts/owed',
    )
    return res.data?.items ?? []
  },

  /**
   * Manually release a single affiliate's approved, unpaid commissions via
   * Stripe Connect. Payouts are never automatic — this is the only trigger.
   * Super-admin only. Throws a `ShogoError` on failure so callers can map
   * `.status`/`.code` to a friendly message.
   */
  async payoutAffiliate(http: HttpClient, affiliateId: string) {
    const res = await http.post<{ ok: boolean; paidCents?: number; payoutId?: string }>(
      `/api/admin/affiliates/${encodeURIComponent(affiliateId)}/payout`,
      {},
    )
    return res.data
  },

  async completeOnboarding(http: HttpClient) {
    const res = await http.post<{ ok: boolean }>('/api/onboarding/complete')
    return res.data
  },

  // ─── License keys ─────────────────────────────────────────

  /**
   * Redeem a single-use license key against a workspace. The current
   * user must be a member of the workspace. Throws a `ShogoError` on
   * failure (404 invalid, 410 expired, 409 already redeemed, 403 not a
   * member) so callers can map `.status` to a friendly message.
   */
  async redeemLicenseKey(http: HttpClient, workspaceId: string, code: string) {
    const res = await http.post<{
      ok: boolean
      data?: { planId: string; grantId: string; expiresAt: string | null }
    }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/redeem-license`, { code })
    return res.data?.data ?? null
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

  getProjectExportUrl(projectId: string): string {
    return `${API_URL}/api/projects/${projectId}/export`
  },

  async exportProjectBlob(
    projectId: string,
    opts?: {
      includeChats?: boolean
      /** When set, the archive is ZipCrypto-encrypted with this password. */
      password?: string
      authCookie?: string | null
    },
  ): Promise<{ blob: Blob; filename: string }> {
    const url = api.getProjectExportUrl(projectId)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (opts?.authCookie) headers['Cookie'] = opts.authCookie

    // POST (not GET) so the password rides in the request body, never the URL.
    const res = await fetch(url, {
      method: 'POST',
      credentials: Platform.OS === 'web' ? 'include' : 'omit',
      headers,
      body: JSON.stringify({
        includeChats: opts?.includeChats !== false,
        ...(opts?.password ? { password: opts.password } : {}),
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(text || `Export failed with status ${res.status}`)
    }

    const disposition = res.headers.get('content-disposition') || ''
    const match = disposition.match(/filename="?([^"]+)"?/)
    const filename = match?.[1] || 'project.shogo'

    const blob = await res.blob()
    return { blob, filename }
  },

  async importProject(
    params: { file: Blob; workspaceId: string; filename?: string; includeChats?: boolean },
    authCookie?: string | null,
  ): Promise<{ id: string; name: string; description?: string | null } | null> {
    const formData = new FormData()
    formData.append('file', params.file, params.filename || 'project.shogo')
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
      /** Unlocks a ZipCrypto password-protected archive. */
      password?: string
      /** Defaults to true; set false to skip bun install / generate / etc. */
      runBootstrap?: boolean
    },
    onProgress: (ev: ProjectImportProgress) => void,
  ): Promise<ImportDoneResult> {
    const filename = params.filename || 'project.shogo'
    const opts = {
      file: params.file,
      workspaceId: params.workspaceId,
      includeChats: params.includeChats,
      password: params.password || '',
      runBootstrap: params.runBootstrap !== false,
      filename,
    }

    if (Platform.OS === 'web' && typeof XMLHttpRequest !== 'undefined') {
      return await importViaXhr(opts, onProgress)
    }
    return await importViaFetchSSE(opts, onProgress)
  },
}

// ─── Project import — streaming helpers ────────────────────────

export interface RequiredCredential {
  channel: string
  field: string
  label: string
}

export interface ImportDoneResult {
  id: string
  name: string
  description?: string | null
  stats?: {
    filesWritten: number
    filesSkipped: number
    chatsImported: number
    chatsSkipped: number
  }
  requiredCredentials?: RequiredCredential[]
  warnings?: string[]
  secretsAutoFilled?: boolean
}

export type ProjectImportProgress =
  | { phase: 'upload'; loaded: number; total: number }
  | { phase: 'parse' }
  | { phase: 'createProject' }
  | { phase: 'writeFiles'; done: number; total: number }
  | { phase: 'importChats'; done: number; total: number }
  | {
      phase: 'syncToS3'
      status: 'running' | 'ok' | 'failed' | 'skipped'
      bytes?: number
      durationMs?: number
      message?: string
    }
  | {
      phase: 'done'
      project: { id: string; name: string; description?: string | null }
      stats: {
        filesWritten: number
        filesSkipped: number
        chatsImported: number
        chatsSkipped: number
      }
      requiredCredentials?: RequiredCredential[]
      warnings?: string[]
      secretsAutoFilled?: boolean
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
    done?: ImportDoneResult
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
      state.done = {
        id: parsed.project.id,
        name: parsed.project.name,
        description: parsed.project.description,
        stats: parsed.stats,
        requiredCredentials: parsed.requiredCredentials || [],
        warnings: parsed.warnings || [],
        secretsAutoFilled: !!parsed.secretsAutoFilled,
      }
      onProgress({
        phase: 'done',
        project: parsed.project,
        stats: parsed.stats,
        requiredCredentials: parsed.requiredCredentials || [],
        warnings: parsed.warnings || [],
        secretsAutoFilled: !!parsed.secretsAutoFilled,
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

interface ImportHelperOpts {
  file: Blob
  workspaceId: string
  includeChats: boolean
  password: string
  runBootstrap: boolean
  filename: string
}

function buildImportFormData(opts: ImportHelperOpts): FormData {
  const fd = new FormData()
  fd.append('file', opts.file, opts.filename)
  fd.append('workspaceId', opts.workspaceId)
  fd.append('includeChats', opts.includeChats ? 'true' : 'false')
  if (opts.password) fd.append('password', opts.password)
  if (!opts.runBootstrap) fd.append('runBootstrap', 'false')
  return fd
}

async function importViaFetchSSE(
  opts: ImportHelperOpts,
  onProgress: (ev: ProjectImportProgress) => void,
): Promise<ImportDoneResult> {
  const res = await fetch(`${API_URL}/api/projects/import`, {
    method: 'POST',
    body: buildImportFormData(opts),
    credentials: Platform.OS === 'web' ? 'include' : 'omit',
    headers: { Accept: 'text/event-stream' },
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `Import failed with status ${res.status}`)
  }

  const state: { done?: ImportDoneResult; fatal?: string } = {}
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
  opts: ImportHelperOpts,
  onProgress: (ev: ProjectImportProgress) => void,
): Promise<ImportDoneResult> {
  return await new Promise((resolve, reject) => {
    const formData = buildImportFormData(opts)

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
      onProgress({ phase: 'upload', loaded: opts.file.size, total: opts.file.size })
    }

    const state: { done?: ImportDoneResult; fatal?: string } = {}
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

/**
 * Per-listing onboarding messages keyed by listing slug. Slugs match the
 * legacy template ids 1:1 after the templates → marketplace migration,
 * so existing entries continue to fire for users installing the same
 * agents from the marketplace.
 */
const LISTING_ONBOARDING_MESSAGES: Record<string, string> = {
  'equity-research-terminal':
    'The "Equity Research Terminal" agent has been installed. Start by asking me for the stock, sector, or watchlist I want analyzed, plus my time horizon and risk tolerance. Explain that you can run stock screening, DCF valuation, competitive landscape, and earnings-note workflows, and that you will only use sourced or user-provided market data.',
  'portfolio-risk-desk':
    'The "Portfolio Risk Desk" agent has been installed. Start portfolio discovery: ask me for my holdings with approximate weights, total portfolio value, time horizon, risk tolerance, account type, and my biggest concern. Explain that you can assess concentration, stress tests, correlations, liquidity, and rebalance ideas, but will not give trade instructions without confirmation.',
  'technical-quant-lab':
    'The "Technical Quant Lab" agent has been installed. Ask me for the ticker, current position if any, timeframe, and whether I want a technical setup, quant pattern scan, options-signal review, or trade-plan draft. Make clear that signals are hypotheses and must be backed by current/user-provided data.',
  'dividend-income-builder':
    'The "Dividend Income Builder" agent has been installed. Ask me for my investment amount, monthly income goal, account type, tax bracket if relevant, risk tolerance, and preferred sectors. Explain that you can build dividend candidate lists, safety checks, income projections, and DRIP scenarios from sourced or user-provided data.',
  'macro-market-briefing':
    'The "Macro Market Briefing" agent has been installed. Ask me for my current holdings or sectors, geographic focus, time horizon, and biggest macro concern. Explain that you can brief rates, inflation, Fed policy, GDP, USD, employment, global risks, sector rotation, and portfolio impact using cited sources.',
}

export function getOnboardingMessage(listingTitle: string, listingSlug?: string): string {
  if (listingSlug && LISTING_ONBOARDING_MESSAGES[listingSlug]) {
    return LISTING_ONBOARDING_MESSAGES[listingSlug]
  }
  return `The "${listingTitle}" agent has been installed. Give me a short summary of what's ready and how to customize it or connect tools. Be concise — a few bullet points max, no walls of text.`
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
    sdkGuideEnabled?: boolean
    integrationsEnabled?: boolean
    channelsEnabled?: boolean
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
