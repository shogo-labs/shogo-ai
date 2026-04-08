// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Remote Control — LAN Discovery & Direct Connection
 *
 * Provides mDNS-based discovery of local Shogo instances on the same
 * network. When available, the mobile app can connect directly to the
 * desktop's local API instead of tunneling through the cloud.
 *
 * Discovery protocol: The desktop broadcasts a Zeroconf/Bonjour service
 * named `_shogo._tcp` on the local network. The metadata TXT record
 * contains { instanceId, protocolVersion, apiVersion }.
 *
 * This module attempts direct LAN health checks and falls back to the
 * cloud tunnel when direct connection fails.
 */

export interface LANInstance {
  instanceId: string
  hostname: string
  ip: string
  port: number
  protocolVersion: number
  apiVersion?: string
  discoveredAt: number
  /** API key or session token for authenticating LAN requests */
  authToken?: string
}

export type ConnectionMode = 'cloud' | 'lan' | 'hybrid'

const DISCOVERY_CACHE = new Map<string, LANInstance>()
const LAN_AUTH_TOKENS = new Map<string, string>()
const LAN_HEALTH_TIMEOUT_MS = 3_000

/**
 * Store an auth token for LAN connections to a specific instance.
 * This token is included as `x-api-key` header on direct LAN requests.
 */
export function setLANAuthToken(instanceId: string, token: string) {
  LAN_AUTH_TOKENS.set(instanceId, token)
}

/**
 * Get the stored auth token for LAN connections.
 */
export function getLANAuthToken(instanceId: string): string | null {
  return LAN_AUTH_TOKENS.get(instanceId) || null
}

/**
 * Remove an auth token.
 */
export function removeLANAuthToken(instanceId: string) {
  LAN_AUTH_TOKENS.delete(instanceId)
}

/**
 * Build authentication headers for a LAN request.
 */
export function getLANAuthHeaders(instanceId: string): Record<string, string> {
  const token = getLANAuthToken(instanceId)
  if (!token) return {}
  return { 'x-api-key': token }
}

/**
 * Register a discovered LAN instance (from mDNS or manual entry).
 */
export function registerLANInstance(instance: LANInstance) {
  DISCOVERY_CACHE.set(instance.instanceId, { ...instance, discoveredAt: Date.now() })
}

/**
 * Remove a LAN instance from the cache.
 */
export function removeLANInstance(instanceId: string) {
  DISCOVERY_CACHE.delete(instanceId)
}

/**
 * Get a cached LAN instance if available.
 */
export function getLANInstance(instanceId: string): LANInstance | null {
  return DISCOVERY_CACHE.get(instanceId) || null
}

/**
 * Get all cached LAN instances.
 */
export function getAllLANInstances(): LANInstance[] {
  return Array.from(DISCOVERY_CACHE.values())
}

/**
 * Build the base URL for a direct LAN connection.
 */
export function getLANBaseUrl(instance: LANInstance): string {
  return `http://${instance.ip}:${instance.port}`
}

/**
 * Check if a LAN instance is reachable by hitting its /health endpoint.
 * Includes auth headers if a token is stored.
 */
export async function checkLANHealth(instance: LANInstance): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), LAN_HEALTH_TIMEOUT_MS)

  try {
    const res = await fetch(`${getLANBaseUrl(instance)}/health`, {
      signal: controller.signal,
      headers: getLANAuthHeaders(instance.instanceId),
    })
    clearTimeout(timeout)
    return res.ok
  } catch {
    clearTimeout(timeout)
    return false
  }
}

/**
 * Determine the best connection mode for an instance.
 *
 * - If a LAN instance is cached and reachable → 'lan'
 * - If LAN is cached but unreachable → 'cloud' (fallback)
 * - If no LAN cached → 'cloud'
 */
export async function resolveConnectionMode(instanceId: string): Promise<{
  mode: ConnectionMode
  lanInstance: LANInstance | null
}> {
  const lanInstance = getLANInstance(instanceId)
  if (!lanInstance) {
    return { mode: 'cloud', lanInstance: null }
  }

  const reachable = await checkLANHealth(lanInstance)
  return {
    mode: reachable ? 'lan' : 'cloud',
    lanInstance: reachable ? lanInstance : null,
  }
}

/**
 * Make a request to a local instance, trying LAN first, falling back to cloud.
 */
export async function hybridFetch(
  instanceId: string,
  cloudUrl: string,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const { mode, lanInstance } = await resolveConnectionMode(instanceId)

  if (mode === 'lan' && lanInstance) {
    try {
      const authHeaders = getLANAuthHeaders(instanceId)
      const mergedHeaders = {
        ...(options.headers as Record<string, string> || {}),
        ...authHeaders,
      }
      const res = await fetch(`${getLANBaseUrl(lanInstance)}${path}`, {
        ...options,
        headers: mergedHeaders,
        signal: AbortSignal.timeout(5_000),
      })
      return res
    } catch {
      // LAN failed, fall through to cloud
    }
  }

  return fetch(cloudUrl, options)
}

/**
 * Clear the entire discovery cache.
 */
export function clearDiscoveryCache() {
  DISCOVERY_CACHE.clear()
}
