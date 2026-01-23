/**
 * BetterAuth Domain
 *
 * Auto-generated from Prisma schema by @shogo/state-api
 * Regenerate with: bun run generate:domain
 */

import { scope } from "arktype"

export const BetterAuthScope = scope({
  User: {
    id: "string.uuid",
    "name?": "string",
    email: "string",
    "emailVerified?": "boolean",
    "image?": "string",
    "createdAt?": "number",
    "updatedAt?": "number",
  },

  Session: {
    id: "string.uuid",
    token: "string",
    expiresAt: "number",
    "ipAddress?": "string",
    "userAgent?": "string",
    "createdAt?": "number",
    "updatedAt?": "number",
    user: "User",
  },

  Account: {
    id: "string.uuid",
    accountId: "string",
    providerId: "string",
    "accessToken?": "string",
    "refreshToken?": "string",
    "accessTokenExpiresAt?": "number",
    "refreshTokenExpiresAt?": "number",
    "scope?": "string",
    "idToken?": "string",
    "password?": "string",
    "createdAt?": "number",
    "updatedAt?": "number",
    user: "User",
  },

  Verification: {
    id: "string.uuid",
    identifier: "string",
    value: "string",
    expiresAt: "number",
    "createdAt?": "number",
    "updatedAt?": "number",
  },

})
