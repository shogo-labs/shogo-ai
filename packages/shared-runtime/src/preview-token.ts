// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Preview Token Validation for Project Runtime
 * 
 * Validates JWT tokens for authenticating preview iframe requests.
 * Uses HMAC-SHA256 verification with the BETTER_AUTH_SECRET.
 * 
 * This is a copy of the API's preview-token logic, adapted for the runtime.
 */

// Secret for verifying tokens - uses same secret as API server
const getPreviewSecret = (): string => {
  const secret = process.env.BETTER_AUTH_SECRET || process.env.PREVIEW_TOKEN_SECRET
  if (!secret) {
    throw new Error(
      '[PreviewToken] FATAL: No signing secret configured. ' +
      'Set BETTER_AUTH_SECRET or PREVIEW_TOKEN_SECRET.'
    )
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[PreviewToken] Missing signing secret. Set BETTER_AUTH_SECRET or PREVIEW_TOKEN_SECRET.'
    )
  }

  console.warn('[PreviewToken] WARNING: No signing secret set, using development-only fallback')
  return 'shogo-dev-only-preview-secret'
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

/**
 * Middleware helper to validate preview tokens
 * Returns the validated payload or throws an error
 */
export async function validatePreviewAccess(
  token: string | null | undefined,
  expectedProjectId: string
): Promise<PreviewTokenPayload> {
  if (!token) {
    throw new Error('Missing preview token')
  }
  
  const payload = await verifyPreviewToken(token)
  if (!payload) {
    throw new Error('Invalid or expired preview token')
  }
  
  if (payload.projectId !== expectedProjectId) {
    throw new Error('Token project ID mismatch')
  }
  
  return payload
}
