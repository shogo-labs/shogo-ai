/**
 * BetterAuth Schema
 *
 * ArkType scope defining the core entities for better-auth integration:
 * - User: User accounts
 * - Session: Authentication sessions
 * - Account: OAuth/social provider accounts
 * - Verification: Email/phone verification tokens
 *
 * Based on better-auth's database schema:
 * https://www.better-auth.com/docs/concepts/database
 */

import { scope } from "arktype"

// ============================================================
// BETTERAUTH SCHEMA (ArkType)
// ============================================================

export const BetterAuthSchema = scope({
  /**
   * User entity - Core user account
   * Maps to better-auth's "user" table
   */
  User: {
    id: "string",
    name: "string",
    email: "string",
    emailVerified: "boolean",
    "image?": "string",
    createdAt: "string",
    updatedAt: "string",
  },

  /**
   * Session entity - Authentication session
   * Maps to better-auth's "session" table
   */
  Session: {
    id: "string",
    userId: "User", // Reference to User
    token: "string",
    expiresAt: "string",
    ipAddress: "string",
    userAgent: "string",
    createdAt: "string",
    updatedAt: "string",
  },

  /**
   * Account entity - OAuth/social provider account
   * Maps to better-auth's "account" table
   */
  Account: {
    id: "string",
    userId: "User", // Reference to User
    accountId: "string",
    providerId: "string",
    "accessToken?": "string",
    "refreshToken?": "string",
    "accessTokenExpiresAt?": "string",
    "refreshTokenExpiresAt?": "string",
    "scope?": "string",
    "idToken?": "string",
    createdAt: "string",
    updatedAt: "string",
  },

  /**
   * Verification entity - Email/phone verification tokens
   * Maps to better-auth's "verification" table
   */
  Verification: {
    id: "string",
    identifier: "string",
    value: "string",
    expiresAt: "string",
    createdAt: "string",
    updatedAt: "string",
  },
})
