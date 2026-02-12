/**
 * User Client Functions
 * 
 * Custom user functions that aren't standard CRUD - like getCurrentUser.
 * Uses fetch to call the REST API (no server-side imports needed).
 * The basic CRUD operations are in ../generated/server-functions.ts
 */

import type { UserType } from '../generated/types'

// Re-export the type for convenience
export type { UserType }

/** Get the API base URL */
function getApiBase(): string {
  if (typeof window !== 'undefined') {
    return window.location.origin
  }
  return process.env.API_URL || 'http://localhost:3001'
}

/**
 * Get current user - finds the first user (demo app simplicity)
 * In a real app, this would use session/auth
 */
export async function getCurrentUser(): Promise<UserType | null> {
  try {
    const url = `${getApiBase()}/api/users?limit=1`
    const response = await fetch(url)
    if (!response.ok) return null
    const json = await response.json()
    const items = json.items || []
    return items.length > 0 ? (items[0] as UserType) : null
  } catch {
    return null
  }
}

/**
 * Create user - custom because we need to check for existing
 */
export async function createUser(args: { data: { email: string; name?: string } }): Promise<UserType> {
  const url = `${getApiBase()}/api/users`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args.data),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: { message: response.statusText } }))
    throw new Error(err.error?.message || 'Failed to create user')
  }
  const json = await response.json()
  return json.data as UserType
}
