/**
 * Better Auth client configuration
 *
 * Configures the Better Auth client for React applications.
 * Uses the API_URL environment variable for the baseURL.
 */

import { createAuthClient } from "better-auth/react"

/**
 * Get the API URL for Better Auth.
 * In development, this uses the Vite proxy (/api).
 * In production, this should be set via VITE_API_URL environment variable.
 */
const getBaseURL = (): string => {
  // Check for explicit API URL configuration
  if (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_URL) {
    return import.meta.env.VITE_API_URL
  }

  // Default: use relative URL which goes through Vite proxy in dev
  // or same-origin in production
  return ""
}

/**
 * Better Auth client instance configured for this application.
 * Provides authentication methods and React hooks.
 *
 * Note: basePath must match the server route (/api/auth/*)
 */
export const authClient = createAuthClient({
  baseURL: getBaseURL(),
  basePath: "/api/auth",
})

// Export individual auth methods for convenience
export const { useSession, signIn, signUp, signOut } = authClient
