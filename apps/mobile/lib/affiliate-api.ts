// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Mobile-side wrappers for the native MLM affiliate routes mounted at
 * /api/affiliates/* in apps/api/src/routes/affiliates.ts.
 *
 * All endpoints short-circuit on the SHOGO_AFFILIATES_NATIVE server flag,
 * so an unflipped backend returns 503 — callers should treat that as
 * "feature not yet available" rather than an error.
 */
import type { HttpClient } from '@shogo-ai/sdk'

export type AffiliateStatus = 'active' | 'paused' | 'archived'
export type CommissionStatus =
  | 'pending'
  | 'approved'
  | 'paid'
  | 'refunded'
  | 'clawed_back'

export interface AffiliateSummary {
  affiliate: {
    id: string
    code: string
    status: AffiliateStatus
    depth: number
    pendingPayoutCents: number
    lifetimePayoutCents: number
    stripeCustomAccountId: string | null
    payoutStatus: string | null
    parentAffiliateId: string | null
  }
  pendingPayoutCents: number
  lifetimePayoutCents: number
  commissionsLast30d: number
  clicksLast30d: number
  signupsLast30d: number
}

export interface AffiliateCommissionRow {
  id: string
  amountCents: number
  currency: string
  level: number
  status: CommissionStatus
  createdAt: string
  stripeInvoiceId: string | null
}

export interface AffiliatePayoutRow {
  id: string
  amountCents: number
  currency: string
  status: string
  createdAt: string
  paidAt: string | null
  stripeTransferId: string | null
  stripePayoutId: string | null
}

export interface AffiliateDownlineNode {
  id: string
  code: string
  depth: number
  level: number
  displayName: string | null
  createdAt: string
}

export type SocialPlatform = 'instagram' | 'tiktok'
export type SocialVerificationStatus = 'pending' | 'verified' | 'rejected'

export interface AffiliateSocialAccount {
  id: string
  platform: SocialPlatform
  handle: string
  verificationStatus: SocialVerificationStatus
  verificationCode: string
  providerUserId: string | null
  verifiedAt: string | null
  lastPolledAt: string | null
  lastError: string | null
  createdAt: string
}

export interface AffiliateContentPost {
  id: string
  platform: SocialPlatform
  providerPostId: string
  url: string | null
  caption: string | null
  postedAt: string | null
  lastViews: number
  paidViews: number
  lastLikes: number
  lastComments: number
  lastShares: number
  lastPolledAt: string | null
}

export type ContentProgramStatus = 'none' | 'pending' | 'approved' | 'rejected'

export interface AffiliateContentSummary {
  accounts: AffiliateSocialAccount[]
  posts: AffiliateContentPost[]
  totals: {
    posts: number
    lifetimeViews: number
    paidViews: number
    pendingCents: number
    approvedCents: number
    paidCents: number
  }
  cpmCents: { instagram: number; tiktok: number }
  /**
   * Resolved per-video lifetime earnings cap (cents); null = uncapped. A video
   * stops earning once its cumulative content commissions reach this amount.
   * Optional for older backends that predate the cap.
   */
  perVideoCapCents?: number | null
  /**
   * Video-creator program application gate. Earning AND payout of content
   * commissions require `approved`. Defaults to `none` for older backends.
   */
  programStatus: ContentProgramStatus
  appliedAt: string | null
  rejectionReason: string | null
}

export interface ContentAnalyticsTotals {
  views: number
  engagement: number
  likes: number
  comments: number
  shares: number
  posts: number
}

export interface ContentAnalyticsPoint {
  /** UTC day, `YYYY-MM-DD`. */
  date: string
  views: number
  likes: number
  comments: number
  shares: number
  engagement: number
}

export interface ContentAnalyticsVideo {
  id: string
  platform: SocialPlatform
  handle: string
  url: string | null
  caption: string | null
  postedAt: string | null
  views: number
  likes: number
  comments: number
  shares: number
  engagement: number
  /** Views gained within the selected window. */
  periodViews: number
  lastPolledAt: string | null
}

export interface ContentAnalytics {
  range: { from: string; to: string }
  totals: ContentAnalyticsTotals
  previousTotals: ContentAnalyticsTotals
  deltaPct: {
    views: number | null
    engagement: number | null
    likes: number | null
    comments: number | null
    shares: number | null
    posts: number | null
  }
  daily: ContentAnalyticsPoint[]
  videos: ContentAnalyticsVideo[]
}

export const affiliateApi = {
  async me(http: HttpClient): Promise<
    | { enrolled: false }
    | ({ enrolled: true } & AffiliateSummary)
  > {
    const res = await http.get<any>('/api/affiliates/me')
    return res.data ?? { enrolled: false }
  },

  async enroll(
    http: HttpClient,
    body: { termsAccepted: boolean; code?: string | null },
  ) {
    const res = await http.post<{ ok: boolean; affiliate?: any; error?: any }>(
      '/api/affiliates/enroll',
      body,
    )
    return res.data
  },

  async listCommissions(
    http: HttpClient,
    opts?: { status?: CommissionStatus; limit?: number; cursor?: string },
  ): Promise<{ commissions: AffiliateCommissionRow[]; nextCursor: string | null }> {
    const qs = new URLSearchParams()
    if (opts?.status) qs.set('status', opts.status)
    if (opts?.limit) qs.set('limit', String(opts.limit))
    if (opts?.cursor) qs.set('cursor', opts.cursor)
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    const res = await http.get<any>(`/api/affiliates/me/commissions${suffix}`)
    return res.data ?? { commissions: [], nextCursor: null }
  },

  async listPayouts(http: HttpClient): Promise<{ payouts: AffiliatePayoutRow[] }> {
    const res = await http.get<any>('/api/affiliates/me/payouts')
    return res.data ?? { payouts: [] }
  },

  async getDownline(
    http: HttpClient,
    opts?: { level?: 'all' },
  ): Promise<{ downline: AffiliateDownlineNode[] }> {
    const suffix = opts?.level === 'all' ? '?level=all' : ''
    const res = await http.get<any>(`/api/affiliates/me/downline${suffix}`)
    return res.data ?? { downline: [] }
  },

  async onboardStripeConnect(http: HttpClient): Promise<{ onboardUrl: string }> {
    const res = await http.post<any>('/api/affiliates/me/stripe-connect/onboard', {})
    return res.data ?? { onboardUrl: '' }
  },

  async getConnectStatus(
    http: HttpClient,
  ): Promise<{ payoutStatus: string | null; onboarded: boolean }> {
    const res = await http.get<any>('/api/affiliates/me/stripe-connect/status')
    return res.data ?? { payoutStatus: null, onboarded: false }
  },

  // --- Content-CPM: social handles + view dashboard ------------------------

  async listSocialAccounts(http: HttpClient): Promise<{ accounts: AffiliateSocialAccount[] }> {
    const res = await http.get<any>('/api/affiliates/me/social-accounts')
    return res.data ?? { accounts: [] }
  },

  async addSocialAccount(
    http: HttpClient,
    body: { platform: SocialPlatform; handle: string },
  ): Promise<{ ok: boolean; account?: AffiliateSocialAccount; error?: any }> {
    const res = await http.post<any>('/api/affiliates/me/social-accounts', body)
    return res.data
  },

  async verifySocialAccount(
    http: HttpClient,
    id: string,
  ): Promise<{ ok: boolean; verified?: boolean; account?: AffiliateSocialAccount; error?: any }> {
    const res = await http.post<any>(`/api/affiliates/me/social-accounts/${encodeURIComponent(id)}/verify`, {})
    return res.data
  },

  async removeSocialAccount(http: HttpClient, id: string): Promise<{ ok: boolean }> {
    const res = await http.delete<any>(`/api/affiliates/me/social-accounts/${encodeURIComponent(id)}`)
    return res.data ?? { ok: false }
  },

  async getContent(http: HttpClient): Promise<AffiliateContentSummary> {
    const res = await http.get<any>('/api/affiliates/me/content')
    return (
      res.data ?? {
        accounts: [],
        posts: [],
        totals: { posts: 0, lifetimeViews: 0, paidViews: 0, pendingCents: 0, approvedCents: 0, paidCents: 0 },
        cpmCents: { instagram: 0, tiktok: 0 },
        perVideoCapCents: null,
        programStatus: 'none',
        appliedAt: null,
        rejectionReason: null,
      }
    )
  },

  /**
   * Per-video stats + a daily performance time series for the caller's
   * connected content. Optional `from`/`to` (ISO) bound the window;
   * defaults to the last 7 days server-side.
   */
  async getContentAnalytics(
    http: HttpClient,
    opts?: { from?: string; to?: string },
  ): Promise<ContentAnalytics | null> {
    const qs = new URLSearchParams()
    if (opts?.from) qs.set('from', opts.from)
    if (opts?.to) qs.set('to', opts.to)
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    const res = await http.get<any>(`/api/affiliates/me/content/analytics${suffix}`)
    return res.data?.analytics ?? null
  },

  /**
   * Apply to the video-creator (content CPM) program. Requires at least one
   * connected + verified social handle. Returns the new program status
   * (`pending` on success) or an error (e.g. `no_verified_account`).
   */
  async applyContentProgram(
    http: HttpClient,
  ): Promise<{ ok: boolean; programStatus?: ContentProgramStatus; error?: any }> {
    const res = await http.post<any>('/api/affiliates/me/content/apply', {})
    return res.data ?? { ok: false }
  },
}

/**
 * Origin the Studio web app is served from, per environment. Mirrors
 * openWebAppSession.ts so referral links resolve against the same app
 * that hosts the in-app `/r/[code]` route — and stay within the current
 * environment (a staging build emits a staging link, not production).
 */
const REFERRAL_BASE_URL = process.env.EXPO_PUBLIC_WEB_URL ?? 'https://studio.shogo.ai'

/**
 * Builds a shareable referral link. Defaults to the current
 * environment's web origin so staging links never point at production;
 * the `/r/<code>` route (apps/mobile/app/r/[code].tsx) sets the
 * attribution cookies and redirects to sign-up.
 */
export function buildReferralLink(code: string, baseUrl = REFERRAL_BASE_URL): string {
  return `${baseUrl.replace(/\/$/, '')}/r/${encodeURIComponent(code)}`
}
