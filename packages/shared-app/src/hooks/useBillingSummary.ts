// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useBillingSummary (shared)
 *
 * The billing page's summary card and payment banner read from
 * `GET /api/billing/summary` (SHO-451): plan, seats, period, next invoice, card
 * on file and any payment problem, in one call.
 *
 * A local/desktop install has no Stripe of its own — it reaches the linked
 * cloud workspace through the local bridge, so `localMode` swaps the path
 * rather than the shape. Both answer the same JSON.
 */

import { useCallback, useEffect, useState } from "react"
import { useSDKHttp } from "../domain"

export interface BillingSummaryPaymentMethod {
  brand: string
  last4: string
  expMonth: number
  expYear: number
}

export interface BillingSummaryNextInvoice {
  amountUsd: number
  currency: string
  /** ISO timestamp of the next charge, or null when none is scheduled. */
  date: string | null
}

export interface BillingSummaryPastDue {
  reason: "subscription_past_due" | "overage_unpaid"
  amountUsd: number
  invoiceUrl: string | null
}

export interface BillingSummary {
  planId: string
  planSource: "subscription" | "grant" | "free"
  status: string | null
  seats: number
  billingInterval: "monthly" | "annual" | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  trialEndsAt: string | null
  nextInvoice: BillingSummaryNextInvoice | null
  paymentMethod: BillingSummaryPaymentMethod | null
  pastDue: BillingSummaryPastDue | null
}

/** Base path for the billing action routes (change plan, cancel, resume). */
export function billingApiBase(localMode: boolean): string {
  return localMode ? "/api/local/cloud-billing" : "/api/billing"
}

/** Path of the summary endpoint. The local bridge names it differently. */
export function billingSummaryPath(localMode: boolean): string {
  return localMode ? "/api/local/cloud-billing/billing-summary" : "/api/billing/summary"
}

export interface UseBillingSummaryOptions {
  /** Read the linked cloud workspace through the local bridge (desktop). */
  localMode?: boolean
}

export interface BillingSummaryState {
  summary: BillingSummary | null
  isLoading: boolean
  /** The server's own message, so the page can say why it is empty. */
  error: string | null
  refetch: () => void
}

export function useBillingSummary(
  workspaceId: string | undefined,
  options?: UseBillingSummaryOptions,
): BillingSummaryState {
  const localMode = options?.localMode ?? false
  const http = useSDKHttp()
  const [summary, setSummary] = useState<BillingSummary | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refetchCounter, setRefetchCounter] = useState(0)

  const refetch = useCallback(() => setRefetchCounter((c) => c + 1), [])

  useEffect(() => {
    if (!workspaceId) {
      setSummary(null)
      setIsLoading(false)
      return
    }
    let cancelled = false
    setIsLoading(true)
    setError(null)
    const path = localMode
      ? billingSummaryPath(true)
      : `${billingSummaryPath(false)}?workspaceId=${encodeURIComponent(workspaceId)}`
    http
      .get<BillingSummary & { ok?: boolean; error?: { code?: string; message?: string } }>(path)
      .then((res) => {
        if (cancelled) return
        const data = (res as any)?.data ?? res
        if (data?.error) {
          setError(data.error.message ?? data.error.code ?? "Could not load billing")
          setSummary(null)
          return
        }
        if (data && typeof data.planId === "string") {
          setSummary({
            planId: data.planId,
            planSource: data.planSource ?? "free",
            status: data.status ?? null,
            seats: data.seats ?? 1,
            billingInterval: data.billingInterval ?? null,
            currentPeriodEnd: data.currentPeriodEnd ?? null,
            cancelAtPeriodEnd: Boolean(data.cancelAtPeriodEnd),
            trialEndsAt: data.trialEndsAt ?? null,
            nextInvoice: data.nextInvoice ?? null,
            paymentMethod: data.paymentMethod ?? null,
            pastDue: data.pastDue ?? null,
          })
        }
      })
      .catch((err: any) => {
        if (cancelled) return
        setError(err?.message ?? "Could not load billing")
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, localMode, http, refetchCounter])

  return { summary, isLoading, error, refetch }
}
