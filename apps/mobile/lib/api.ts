import { Platform } from 'react-native'
import type { HttpClient } from '@shogo-ai/sdk'

export const API_URL = Platform.select({
  web: 'http://localhost:8002',
  ios: 'http://localhost:8002',
  android: 'http://192.168.1.132:8002',
  default: 'http://localhost:8002',
})

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

export const api = {
  async createCheckoutSession(http: HttpClient, params: CheckoutParams) {
    const res = await http.post<{ url?: string }>('/api/billing/checkout', params)
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
}
