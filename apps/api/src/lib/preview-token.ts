// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Preview Token Generation & Validation
 * 
 * Creates short-lived JWT tokens for authenticating preview iframe requests.
 * Uses HMAC-SHA256 signing with the BETTER_AUTH_SECRET.
 * 
 * Token format: base64url(header).base64url(payload).base64url(signature)
 * 
 * Payload includes:
 * - projectId: The project being previewed
 * - userId: The user requesting the preview
 * - iat: Issued at timestamp
 * - exp: Expiration timestamp (1 hour by default)
 */

// Secret for signing tokens - uses same secret as better-auth
const getPreviewSecret = (): string => {
  const secret = process.env.BETTER_AUTH_SECRET || process.env.PREVIEW_TOKEN_SECRET
  if (secret) return secret

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[PreviewToken] FATAL: No signing secret configured in production. ' +
      'Set BETTER_AUTH_SECRET or PREVIEW_TOKEN_SECRET.'
    )
  }

  console.warn('[PreviewToken] WARNING: No signing secret set, using development-only fallback')
  return 'shogo-dev-only-preview-secret'
}

// Token expiry time (1 hour)
const TOKEN_EXPIRY_MS = 60 * 60 * 1000

/**
 * Base64url encode a string
 */
function base64urlEncode(data: string | ArrayBuffer): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
  const base64 = btoa(String.fromCharCode(...bytes))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Base64url decode a string
 */
function base64urlDecode(str: string): string {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4)
  return atob(padded)
}

/**
 * Preview token payload
 */
export interface PreviewTokenPayload {
  projectId: string
  userId?: string
  iat: number
  exp: number
}

/**
 * Generate a preview token for a project
 */
export async function generatePreviewToken(
  projectId: string,
  userId?: string,
  expiryMs: number = TOKEN_EXPIRY_MS
): Promise<string> {
  const secret = getPreviewSecret()
  
  // Header
  const header = {
    alg: 'HS256',
    typ: 'JWT',
  }
  
  // Payload
  const now = Date.now()
  const payload: PreviewTokenPayload = {
    projectId,
    userId,
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + expiryMs) / 1000),
  }
  
  // Encode header and payload
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
  
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signingInput)
  )
  
  const encodedSignature = base64urlEncode(signature)
  
  return `${signingInput}.${encodedSignature}`
}

/**
 * Verify and decode a preview token
 * Returns the payload if valid, null if invalid or expired
 */
export async function verifyPreviewToken(token: string): Promise<PreviewTokenPayload | null> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) {
      console.log('[PreviewToken] Invalid token format: expected 3 parts')
      return null
    }
    
    const [encodedHeader, encodedPayload, encodedSignature] = parts
    const signingInput = `${encodedHeader}.${encodedPayload}`
    const secret = getPreviewSecret()
    
    // Verify signature
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    )
    
    // Decode the signature
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
      console.log('[PreviewToken] Invalid signature')
      return null
    }
    
    // Decode payload
    const payload: PreviewTokenPayload = JSON.parse(base64urlDecode(encodedPayload))
    
    // Check expiration
    const now = Math.floor(Date.now() / 1000)
    if (payload.exp < now) {
      console.log('[PreviewToken] Token expired')
      return null
    }
    
    return payload
  } catch (error) {
    console.error('[PreviewToken] Error verifying token:', error)
    return null
  }
}

/**
 * Extract project ID from a preview token without full verification
 * Used for quick routing decisions (full verification should still be done)
 */
export function extractProjectIdFromToken(token: string): string | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    
    const payload: PreviewTokenPayload = JSON.parse(base64urlDecode(parts[1]))
    return payload.projectId || null
  } catch {
    return null
  }
}
