// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The usage-log CSV download URL (SHO-108, folds SHO-91).
 *
 * The download is a plain URL — the browser or `Linking` fetches it. Every
 * workspace, including one hosted on a paired desktop (SHO-285), exports from
 * this app's API.
 */

import { API_URL } from './api-url'

export interface UsageLogCsvParams {
  period?: string
  userId?: string
  model?: string
  limit?: number
}

export function usageLogCsvPath(workspaceId: string, params: UsageLogCsvParams = {}): string {
  const qs = new URLSearchParams()
  if (params.period) qs.set('period', params.period)
  if (params.userId) qs.set('userId', params.userId)
  if (params.model) qs.set('model', params.model)
  if (params.limit) qs.set('limit', String(params.limit))
  const suffix = qs.toString()
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/analytics/usage-log.csv${suffix ? `?${suffix}` : ''}`
}

export function usageLogCsvUrl(input: {
  workspaceId: string
  params?: UsageLogCsvParams
  apiUrl?: string
}): string {
  const params = input.params ?? {}
  return `${input.apiUrl ?? API_URL ?? ''}${usageLogCsvPath(input.workspaceId, params)}`
}

/** The CSV URL for the workspace in view. */
export function useUsageLogCsvUrl(workspaceId: string | null | undefined, params: UsageLogCsvParams = {}): string {
  return usageLogCsvUrl({ workspaceId: workspaceId ?? '', params })
}

// ============================================================================
// Per-member message export (SHO-199)
// ============================================================================

export interface MemberMessagesCsvParams {
  /** ISO start of the window. Omitted = all time. */
  since?: string
  until?: string
  audience?: 'person' | 'agent' | 'mixed' | 'channel'
}

export function memberMessagesCsvPath(
  workspaceId: string,
  userId: string,
  params: MemberMessagesCsvParams = {},
): string {
  const qs = new URLSearchParams({ user: userId })
  if (params.since) qs.set('since', params.since)
  if (params.until) qs.set('until', params.until)
  if (params.audience) qs.set('audience', params.audience)
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/member-activity/messages.csv?${qs.toString()}`
}

/** What one person sent, as a download from this app's API. */
export function memberMessagesCsvUrl(input: {
  workspaceId: string
  userId: string
  params?: MemberMessagesCsvParams
  apiUrl?: string
}): string {
  const params = input.params ?? {}
  return `${input.apiUrl ?? API_URL ?? ''}${memberMessagesCsvPath(input.workspaceId, input.userId, params)}`
}
