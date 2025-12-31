/**
 * BetterAuth Service Types
 *
 * Pure type definitions for the BetterAuth authentication layer.
 * NO runtime imports - interface contract only.
 *
 * These types align with BetterAuth's data model:
 * - User: Core user identity
 * - Session: Authentication session with device info
 * - Account: OAuth provider connections
 */

import type { IAuthService } from "../auth/types"

/**
 * BetterAuth user with extended profile fields
 */
export interface BetterAuthUser {
  /** Unique user identifier */
  id: string
  /** User's email address */
  email: string
  /** User's display name */
  name: string
  /** Profile image URL (nullable) */
  image: string | null
  /** Whether the email has been verified */
  emailVerified: boolean
  /** ISO timestamp of user creation */
  createdAt: string
  /** ISO timestamp of last update */
  updatedAt: string
}

/**
 * BetterAuth session with device tracking
 */
export interface BetterAuthSession {
  /** Unique session identifier */
  id: string
  /** Session token (JWT or opaque) */
  token: string
  /** Reference to the user */
  userId: string
  /** ISO timestamp when session expires */
  expiresAt: string
  /** Client IP address (nullable) */
  ipAddress: string | null
  /** Client user agent string (nullable) */
  userAgent: string | null
  /** ISO timestamp of session creation */
  createdAt: string
  /** ISO timestamp of last session update */
  updatedAt: string
}

/**
 * BetterAuth account for OAuth provider connections
 */
export interface BetterAuthAccount {
  /** Unique account identifier */
  id: string
  /** Reference to the user */
  userId: string
  /** Provider-specific account ID (e.g., Google user ID) */
  accountId: string
  /** OAuth provider identifier (e.g., "google", "github") */
  providerId: string
  /** OAuth access token (nullable) */
  accessToken: string | null
  /** OAuth refresh token (nullable) */
  refreshToken: string | null
  /** ISO timestamp when access token expires (nullable) */
  accessTokenExpiresAt: string | null
  /** ISO timestamp when refresh token expires (nullable) */
  refreshTokenExpiresAt: string | null
  /** OAuth scope granted (nullable) */
  scope: string | null
  /** ISO timestamp of account creation */
  createdAt: string
  /** ISO timestamp of last update */
  updatedAt: string
}

/**
 * BetterAuth service interface - extends base auth with social providers
 *
 * Adds Google OAuth support on top of the base IAuthService contract.
 * Implementations should handle the OAuth flow appropriately for their
 * environment (e.g., redirect-based for web, custom scheme for mobile).
 */
export interface IBetterAuthService extends IAuthService {
  /**
   * Initiate Google OAuth sign-in flow
   *
   * For browser environments, this typically redirects to Google.
   * For other environments, may return a URL or use a custom flow.
   */
  signInWithGoogle(): Promise<void>

  /**
   * Get the Google OAuth sign-in URL
   *
   * Returns the URL to redirect users to for Google authentication.
   * Useful when the caller wants to control the redirect behavior.
   */
  getGoogleSignInUrl(): string
}
