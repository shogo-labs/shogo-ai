// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AI Proxy Token Generation & Validation
 *
 * Creates and validates project-scoped JWT tokens for authenticating
 * AI proxy requests. These tokens:
 *
 * - Are signed with HMAC-SHA256 using AI_PROXY_SECRET (or BETTER_AUTH_SECRET)
 * - Contain projectId, workspaceId, and optional userId
 * - Have a configurable expiry (default 24 hours)
 * - Are used by project runtimes and SDK apps to call the AI proxy
 *
 * Token format: base64url(header).base64url(payload).base64url(signature)
 *
 * Usage:
 *   // Generate (API server side)
 *   const token = await generateProxyToken(projectId, workspaceId, userId)
 *
 *   // Validate (AI proxy middleware)
 *   const payload = await verifyProxyToken(token)
 *   if (!payload) { // unauthorized }
 */

// =============================================================================
// Configuration
// =============================================================================

/** Default token expiry: 24 hours */
const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000

/**
 * Get the signing secret for proxy tokens.
 * Falls back to BETTER_AUTH_SECRET for convenience in existing deployments.
 */
function getProxySecret(): string {
  const secret =
    process.env.AI_PROXY_SECRET ||
    process.env.BETTER_AUTH_SECRET ||
    process.env.PREVIEW_TOKEN_SECRET
  if (secret) return secret

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[AI Proxy Token] FATAL: No signing secret configured in production. ' +
      'Set AI_PROXY_SECRET, BETTER_AUTH_SECRET, or PREVIEW_TOKEN_SECRET.'
    )
  }

  console.warn('[AI Proxy Token] WARNING: No signing secret set, using development-only fallback')
  return 'shogo-dev-only-ai-proxy-secret'
}

// =============================================================================
// Types
// =============================================================================

/**
 * Payload embedded in proxy tokens.
 */
export interface ProxyTokenPayload {
  /** Project ID this token is scoped to */
  projectId: string
  /** Workspace ID for billing/analytics */
  workspaceId: string
  /** User who generated the token (optional) */
  userId?: string
  /** Token type identifier */
  type: 'ai-proxy'
  /** Issued at (unix seconds) */
  iat: number
  /** Expires at (unix seconds) */
  exp: number
}

// =============================================================================
// Encoding Helpers
// =============================================================================

function base64urlEncode(data: string | ArrayBuffer): string {
  const bytes =
    typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
  const base64 = btoa(String.fromCharCode(...bytes))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlDecode(str: string): string {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  return atob(padded)
}

// =============================================================================
// Token Generation
// =============================================================================

/**
 * Generate a project-scoped AI proxy token.
 *
 * @param projectId - Project this token authorizes
 * @param workspaceId - Workspace for billing context
 * @param userId - Optional user identity
 * @param expiryMs - Token lifetime in milliseconds (default: 24 hours)
 * @returns Signed JWT string
 */
export async function generateProxyToken(
  projectId: string,
  workspaceId: string,
  userId?: string,
  expiryMs: number = DEFAULT_EXPIRY_MS
): Promise<string> {
  const secret = getProxySecret()

  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Date.now()
  const payload: ProxyTokenPayload = {
    projectId,
    workspaceId,
    userId,
    type: 'ai-proxy',
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + expiryMs) / 1000),
  }

  const encodedHeader = base64urlEncode(JSON.stringify(header))
  const encodedPayload = base64urlEncode(JSON.stringify(payload))
  const signingInput = `${encodedHeader}.${encodedPayload}`

  // Sign with HMAC-SHA256
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput))

  return `${signingInput}.${base64urlEncode(signature)}`
}

// =============================================================================
// Token Verification
// =============================================================================

/**
 * Verify and decode an AI proxy token.
 *
 * @param token - JWT token string
 * @returns Decoded payload if valid, null if invalid/expired
 */
export async function verifyProxyToken(token: string): Promise<ProxyTokenPayload | null> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) {
      return null
    }

    const [encodedHeader, encodedPayload, encodedSignature] = parts
    const signingInput = `${encodedHeader}.${encodedPayload}`
    const secret = getProxySecret()

    // Verify signature
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    )

    const signatureStr = base64urlDecode(encodedSignature)
    const signatureBytes = new Uint8Array(signatureStr.length)
    for (let i = 0; i < signatureStr.length; i++) {
      signatureBytes[i] = signatureStr.charCodeAt(i)
    }

    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signatureBytes,
      new TextEncoder().encode(signingInput)
    )

    if (!valid) {
      console.log('[AI Proxy Token] Invalid signature')
      return null
    }

    // Decode payload
    const payload: ProxyTokenPayload = JSON.parse(base64urlDecode(encodedPayload))

    // Validate token type
    if (payload.type !== 'ai-proxy') {
      console.log('[AI Proxy Token] Invalid token type:', payload.type)
      return null
    }

    // Check expiration
    const now = Math.floor(Date.now() / 1000)
    if (payload.exp < now) {
      console.log('[AI Proxy Token] Token expired')
      return null
    }

    return payload
  } catch (error) {
    console.error('[AI Proxy Token] Verification error:', error)
    return null
  }
}

/**
 * Extract project ID from a proxy token without full verification.
 * Used for quick routing decisions; full verification should still be done separately.
 */
export function extractProjectIdFromProxyToken(token: string): string | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload: ProxyTokenPayload = JSON.parse(base64urlDecode(parts[1]))
    return payload.projectId || null
  } catch {
    return null
  }
}
