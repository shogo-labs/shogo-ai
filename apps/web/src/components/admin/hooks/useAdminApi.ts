/**
 * useAdminApi - Hooks for fetching data from the admin API.
 */

import { useState, useEffect, useCallback } from 'react'
import type { AnalyticsPeriod } from '../analytics/PeriodSelector'

const API_BASE = '/api/admin'

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({ error: { message: res.statusText } }))
    throw new Error(errorBody.error?.message || `HTTP ${res.status}`)
  }
  return res.json()
}

interface ApiResponse<T> {
  ok: boolean
  data: T
}

/**
 * Generic hook for fetching admin data.
 */
export function useAdminFetch<T>(path: string, params?: Record<string, string>) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const queryString = params
    ? '?' + new URLSearchParams(params).toString()
    : ''

  const fullUrl = `${API_BASE}${path}${queryString}`

  const refetch = useCallback(() => {
    setLoading(true)
    setError(null)
    fetchJson<ApiResponse<T>>(fullUrl)
      .then((res) => {
        setData(res.data)
        setLoading(false)
      })
      .catch((err) => {
        setError(err.message)
        setLoading(false)
      })
  }, [fullUrl])

  useEffect(() => {
    refetch()
  }, [refetch])

  return { data, loading, error, refetch }
}

/**
 * Fetch overview stats.
 */
export function useOverviewStats() {
  return useAdminFetch<{
    totalUsers: number
    totalWorkspaces: number
    totalProjects: number
    totalChatSessions: number
    activeUsersLast30d: number
    newUsersLast30d: number
  }>('/analytics/overview')
}

/**
 * Fetch growth time series.
 */
export function useGrowthData(period: AnalyticsPeriod = '30d') {
  return useAdminFetch<Array<{ date: string; users: number; workspaces: number; projects: number }>>(
    '/analytics/growth',
    { period }
  )
}

/**
 * Fetch usage analytics.
 */
export function useUsageData(period: AnalyticsPeriod = '30d') {
  return useAdminFetch<{
    totalCreditsConsumed: number
    actionBreakdown: Array<{ action: string; _count: number }>
    topConsumers: Array<{ workspaceId: string; _sum: { creditsUsed: number | null } }>
  }>('/analytics/usage', { period })
}

/**
 * Fetch active users data.
 */
export function useActiveUsersData(period: AnalyticsPeriod = '30d') {
  return useAdminFetch<{ dau: number; wau: number; mau: number }>(
    '/analytics/active-users',
    { period }
  )
}

/**
 * Fetch users list with pagination/search.
 * Uses the auto-generated admin routes.
 */
export function useAdminUsers(params?: { page?: string; limit?: string; search?: string; role?: string }) {
  return useAdminFetch<{
    users: Array<{
      id: string
      name: string | null
      email: string
      role: string
      image: string | null
      emailVerified: boolean
      createdAt: string
      updatedAt: string
      _count: { sessions: number; accounts: number; members: number; notifications: number; starredProjects: number }
    }>
    total: number
    page: number
    limit: number
  }>('/users', params as Record<string, string>)
}

/**
 * Fetch single user details.
 * Uses the auto-generated admin route which includes relations.
 */
export function useAdminUser(userId: string) {
  return useAdminFetch<{
    id: string
    name: string | null
    email: string
    role: string
    image: string | null
    emailVerified: boolean
    createdAt: string
    updatedAt: string
    members: Array<{
      id: string
      role: string
      workspaceId: string
      userId: string
    }>
    sessions: Array<{
      id: string
      createdAt: string
      expiresAt: string
    }>
  }>(`/users/${userId}`)
}

/**
 * Fetch all workspaces (admin).
 * Uses the auto-generated admin routes.
 */
export function useAdminWorkspaces(params?: { page?: string; limit?: string; search?: string }) {
  return useAdminFetch<{
    workspaces: Array<{
      id: string
      name: string
      slug: string
      description: string | null
      createdAt: string
      updatedAt: string
      _count: { projects: number; members: number; billingAccounts: number; invitations: number; folders: number; subscriptions: number; creditLedgers: number; usageEvents: number; starredProjects: number }
    }>
    total: number
    page: number
    limit: number
  }>('/workspaces', params as Record<string, string>)
}

// =============================================================================
// Usage Log & Summary (AI proxy usage)
// =============================================================================

import type { UsageSummaryData, UsageLogData } from '../analytics/UsageTable'

/**
 * Fetch aggregated usage summary (by user + model).
 * Works with both admin and workspace-scoped base URLs.
 */
export function useUsageSummary(period: AnalyticsPeriod = '30d', basePath: string = API_BASE) {
  return useScopedFetch<UsageSummaryData>(`${basePath}/analytics/usage-summary`, { period })
}

/**
 * Fetch paginated usage event log.
 * Works with both admin and workspace-scoped base URLs.
 */
export function useUsageLog(
  period: AnalyticsPeriod = '30d',
  page: number = 1,
  basePath: string = API_BASE
) {
  return useScopedFetch<UsageLogData>(`${basePath}/analytics/usage-log`, {
    period,
    page: String(page),
    limit: '50',
  })
}

/**
 * Generic scoped fetch - like useAdminFetch but accepts a full URL base.
 */
function useScopedFetch<T>(fullPath: string, params?: Record<string, string>) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const queryString = params ? '?' + new URLSearchParams(params).toString() : ''
  const fullUrl = `${fullPath}${queryString}`

  const refetch = useCallback(() => {
    setLoading(true)
    setError(null)
    fetchJson<ApiResponse<T>>(fullUrl)
      .then((res) => {
        setData(res.data)
        setLoading(false)
      })
      .catch((err) => {
        setError(err.message)
        setLoading(false)
      })
  }, [fullUrl])

  useEffect(() => {
    refetch()
  }, [refetch])

  return { data, loading, error, refetch }
}

/**
 * Update a user (admin).
 */
export async function adminUpdateUser(
  userId: string,
  input: { name?: string; role?: string }
): Promise<{ ok: boolean; data?: any; error?: any }> {
  const res = await fetch(`${API_BASE}/users/${userId}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return res.json()
}

/**
 * Delete a user (admin).
 */
export async function adminDeleteUser(userId: string): Promise<{ ok: boolean; error?: any }> {
  const res = await fetch(`${API_BASE}/users/${userId}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  return res.json()
}
