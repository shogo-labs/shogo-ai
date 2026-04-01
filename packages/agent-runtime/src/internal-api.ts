// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { existsSync, readFileSync } from 'fs'

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'

export function deriveApiUrl(): string | null {
  if (process.env.SHOGO_API_URL) return process.env.SHOGO_API_URL
  if (process.env.API_URL) return process.env.API_URL
  const proxyUrl = process.env.AI_PROXY_URL
  if (proxyUrl) {
    try {
      const url = new URL(proxyUrl)
      return `${url.protocol}//${url.host}`
    } catch { /* invalid URL */ }
  }
  const systemNs = process.env.SYSTEM_NAMESPACE || 'shogo-system'
  return `http://api.${systemNs}.svc.cluster.local`
}

/**
 * Public-facing API URL for URLs that end up in browser-facing contexts
 * (e.g. webchat widget embed snippets). Prefers BETTER_AUTH_URL which is the
 * publicly routable origin, falling back to deriveApiUrl() for local dev.
 */
export function derivePublicApiUrl(): string | null {
  if (process.env.BETTER_AUTH_URL) return process.env.BETTER_AUTH_URL
  return deriveApiUrl()
}

export function getInternalHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  try {
    if (existsSync(SA_TOKEN_PATH)) {
      headers['Authorization'] = `Bearer ${readFileSync(SA_TOKEN_PATH, 'utf-8').trim()}`
    }
  } catch { /* not in K8s */ }
  return headers
}
