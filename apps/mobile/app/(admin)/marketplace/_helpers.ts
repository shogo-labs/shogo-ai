// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared helpers for the (admin)/marketplace/* pages: fetch wrappers,
 * money + relative-time formatting, and the canonical listing-status
 * pill colors so all four pages stay visually consistent.
 *
 * Mirrors the lightweight pattern used by (admin)/grants/*: small
 * fetch helpers colocated with the screens rather than a typed client
 * in lib/api.ts. We can promote these later if more admin pages start
 * sharing this surface.
 */

import { API_URL } from '../../../lib/api'

export const ADMIN_API_BASE = `${API_URL}/api/admin`
export const ADMIN_MARKETPLACE_BASE = `${API_URL}/api/admin/marketplace`

export async function fetchAdminJson<T>(
  path: string,
  params?: Record<string, string>,
  base: string = ADMIN_MARKETPLACE_BASE,
): Promise<T | null> {
  const qs = params ? '?' + new URLSearchParams(params).toString() : ''
  try {
    const res = await fetch(`${base}${path}${qs}`, { credentials: 'include' })
    if (!res.ok) return null
    const json = await res.json()
    return (json.data ?? json) as T
  } catch {
    return null
  }
}

export interface AdminWriteResult<T> {
  ok: boolean
  data?: T
  error?: string
}

export async function postAdmin<T>(
  path: string,
  body: unknown,
  method: 'POST' | 'PATCH' | 'DELETE' = 'POST',
  base: string = ADMIN_MARKETPLACE_BASE,
): Promise<AdminWriteResult<T>> {
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: method === 'DELETE' || body === undefined ? undefined : JSON.stringify(body),
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) {
      return { ok: false, error: json?.error?.message ?? `HTTP ${res.status}` }
    }
    return { ok: true, data: (json?.data ?? json) as T }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'request failed'
    return { ok: false, error: msg }
  }
}

export function formatCents(cents: number | null | undefined): string {
  if (cents == null) return '—'
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const dollars = Math.floor(abs / 100)
  const remainder = abs % 100
  return `${sign}$${dollars.toLocaleString()}.${remainder.toString().padStart(2, '0')}`
}

export function formatRelative(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const diffMs = now.getTime() - d.getTime()
  const sec = Math.round(diffMs / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 30) return `${day}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export type ListingStatus =
  | 'draft'
  | 'in_review'
  | 'pending_review'
  | 'published'
  | 'suspended'
  | 'archived'
  | 'rejected'

export const ALL_LISTING_STATUSES: readonly ListingStatus[] = [
  'draft',
  'in_review',
  'pending_review',
  'published',
  'suspended',
  'archived',
  'rejected',
] as const

// Mirrors the creator-side palette in
// apps/mobile/app/(app)/marketplace/creator/listing/[id].tsx so admins
// see the same color vocabulary creators do.
export const STATUS_PILL: Record<ListingStatus, { bg: string; dot: string; label: string }> = {
  draft: {
    bg: 'bg-yellow-100 dark:bg-yellow-900/30',
    dot: 'bg-yellow-500',
    label: 'Draft',
  },
  in_review: {
    bg: 'bg-yellow-100 dark:bg-yellow-900/30',
    dot: 'bg-yellow-500',
    label: 'In review',
  },
  pending_review: {
    bg: 'bg-blue-100 dark:bg-blue-900/30',
    dot: 'bg-blue-500',
    label: 'Pending review',
  },
  published: {
    bg: 'bg-green-100 dark:bg-green-900/30',
    dot: 'bg-green-500',
    label: 'Published',
  },
  suspended: {
    bg: 'bg-muted',
    dot: 'bg-muted-foreground',
    label: 'Suspended',
  },
  archived: {
    bg: 'bg-red-100 dark:bg-red-900/30',
    dot: 'bg-red-500',
    label: 'Archived',
  },
  rejected: {
    bg: 'bg-red-100 dark:bg-red-900/30',
    dot: 'bg-red-500',
    label: 'Rejected',
  },
}

export type AuditSeverity = 'secret' | 'non_generic' | 'info'

export interface AuditFinding {
  severity: AuditSeverity
  file: string
  line?: number
  snippet?: string
  reason: string
  suggestion?: string
}

export type AuditStatus = 'none' | 'pending' | 'passed' | 'flagged' | 'errored'

export const AUDIT_PILL: Record<AuditStatus, { bg: string; label: string }> = {
  none: { bg: 'bg-muted', label: 'Not audited' },
  pending: { bg: 'bg-blue-100 dark:bg-blue-900/30', label: 'Auditing' },
  passed: { bg: 'bg-green-100 dark:bg-green-900/30', label: 'Passed' },
  flagged: { bg: 'bg-yellow-100 dark:bg-yellow-900/30', label: 'Flagged' },
  errored: { bg: 'bg-red-100 dark:bg-red-900/30', label: 'Audit error' },
}

export interface FindingCounts {
  secret: number
  non_generic: number
  info: number
  total: number
}

export function countFindings(findings: AuditFinding[] | null | undefined): FindingCounts {
  const counts: FindingCounts = { secret: 0, non_generic: 0, info: 0, total: 0 }
  if (!Array.isArray(findings)) return counts
  for (const f of findings) {
    if (f && (f.severity === 'secret' || f.severity === 'non_generic' || f.severity === 'info')) {
      counts[f.severity]++
      counts.total++
    }
  }
  return counts
}

// Phase 7 admin actions allow these direct status patches via
// PATCH /listings/:id/status. Other transitions use the dedicated
// approve / reject endpoints.
export const ADMIN_STATUS_PATCHES: readonly Exclude<ListingStatus, 'draft' | 'in_review' | 'pending_review'>[] = [
  'published',
  'suspended',
  'archived',
  'rejected',
] as const
