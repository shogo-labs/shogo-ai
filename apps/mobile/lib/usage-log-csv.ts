// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The usage-log CSV download URL (SHO-108, folds SHO-91).
 *
 * The download is a plain URL — the browser or `Linking` fetches it, so it
 * cannot go through the remote interceptor that routes everything else. It
 * therefore has to learn the same base the JSON analytics call gets: the
 * machine's relay while one of its own workspaces is open, this app's API
 * otherwise. Otherwise the tab shows the machine's numbers and the CSV hands
 * back the cloud workspace's.
 */

import { API_URL } from './api-url'
import { useActiveInstance } from '../contexts/active-instance'

export interface UsageLogCsvParams {
  period?: string
  userId?: string
  model?: string
  limit?: number
}

/** Where a machine workspace's API lives: `/api/machines/<id>/w/<localId>`. */
export interface UsageLogCsvMachine {
  relayBaseUrl: string
  localWorkspaceId: string
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
  /** Set while one of a paired computer's own workspaces is in view. */
  machine?: UsageLogCsvMachine | null
}): string {
  const params = input.params ?? {}
  // The machine's database knows its own workspace id, never the cloud one the
  // UI happens to hold — the relay path already carries it, and the path segment
  // must match.
  if (input.machine) {
    return `${input.machine.relayBaseUrl.replace(/\/+$/, '')}${usageLogCsvPath(input.machine.localWorkspaceId, params)}`
  }
  return `${input.apiUrl ?? API_URL ?? ''}${usageLogCsvPath(input.workspaceId, params)}`
}

/** The relay base of the machine workspace in view, or `null`. */
export function useUsageLogCsvMachine(): UsageLogCsvMachine | null {
  const { instance, remoteAgentBaseUrl } = useActiveInstance()
  if (instance?.source !== 'machine') return null
  if (!instance.localWorkspaceId || !remoteAgentBaseUrl) return null
  return { relayBaseUrl: remoteAgentBaseUrl, localWorkspaceId: instance.localWorkspaceId }
}

/**
 * The CSV URL for the workspace in view: the machine's while its workspace is
 * open, this app's otherwise.
 */
export function useUsageLogCsvUrl(workspaceId: string | null | undefined, params: UsageLogCsvParams = {}): string {
  const machine = useUsageLogCsvMachine()
  return usageLogCsvUrl({ workspaceId: workspaceId ?? '', params, machine })
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

/**
 * What one person sent, as a download. Same base rules as the usage log: a
 * paired computer's workspace exports from that machine, everything else from
 * this app's API.
 */
export function memberMessagesCsvUrl(input: {
  workspaceId: string
  userId: string
  params?: MemberMessagesCsvParams
  apiUrl?: string
  machine?: UsageLogCsvMachine | null
}): string {
  const params = input.params ?? {}
  if (input.machine) {
    return `${input.machine.relayBaseUrl.replace(/\/+$/, '')}${memberMessagesCsvPath(input.machine.localWorkspaceId, input.userId, params)}`
  }
  return `${input.apiUrl ?? API_URL ?? ''}${memberMessagesCsvPath(input.workspaceId, input.userId, params)}`
}
