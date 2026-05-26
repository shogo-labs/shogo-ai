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
    body: { termsAccepted: boolean; parentCode?: string | null; code?: string | null },
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

  async submitPayoutDetails(http: HttpClient, body: Record<string, unknown>) {
    const res = await http.post<any>('/api/affiliates/me/stripe-connect/details', body)
    return res.data
  },
}

/**
 * Builds a shareable referral link for the marketing site.
 * Mirrors the Cloudflare Pages Function at shogo-website/functions/r/[code].ts.
 */
export function buildReferralLink(code: string, baseUrl = 'https://shogo.ai'): string {
  return `${baseUrl.replace(/\/$/, '')}/r/${encodeURIComponent(code)}`
}
