// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared API-key minting primitives.
 *
 * Both the cookie-authed `/api-keys/device` route (`routes/api-keys.ts`)
 * and the device-code login `/cli/login/approve` route (`routes/cli-auth.ts`)
 * mint device-tagged keys that must be byte-identical in shape:
 *
 *   - Same `shogo_sk_` prefix + 32 random bytes hex-encoded.
 *   - Same SHA-256 hash strategy for the persisted `keyHash` column.
 *   - Same prefix-prefix length stored in `keyPrefix` (used as a key hint
 *     in the dashboard and for deduping search).
 *   - Same `prisma.$transaction` semantics: revoke any existing
 *     un-revoked device key for (workspaceId, deviceId) before creating
 *     the new row, so re-logins don't accumulate stale credentials.
 *
 * Before this module those constants and that transaction were copy-
 * pasted across both routes. Anything that changed (key length, prefix,
 * device-key dedupe rules, hashing) had to be edited in two places, and
 * the test suite already caught one drift between them.
 *
 * The `resolveApiKey` reverse lookup also lives in `routes/api-keys.ts`
 * because it has interesting fire-and-forget side effects on
 * `lastUsedAt` / `lastSeenAt`. That stays where it is — only the
 * minting half is shared here.
 */

import crypto from 'crypto'
import type { PrismaClient } from '@prisma/client'

/** Public prefix on every minted key. Matched against incoming Bearer
 * tokens to short-circuit obvious non-API-key inputs. */
export const SHOGO_API_KEY_PREFIX = 'shogo_sk_'

/** Random suffix length in BYTES (hex-encoded → 2× chars on the wire). */
export const SHOGO_API_KEY_RANDOM_BYTES = 32

/** Length of the `keyPrefix` slice persisted to the DB and shown in the
 * dashboard as a hint. Equal to `prefix + 8 hex chars` of the random
 * portion. */
export const SHOGO_API_KEY_PREFIX_DISPLAY_LENGTH =
  SHOGO_API_KEY_PREFIX.length + 8

/**
 * SHA-256 the raw bearer token to the value we persist in
 * `apiKey.keyHash`. Use this for both insert (mint) and lookup
 * (`findUnique({ where: { keyHash } })`).
 */
export async function hashApiKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Just the random hex suffix — caller concatenates with the prefix. */
function generateRawKeySuffix(): string {
  const bytes = crypto.getRandomValues(
    new Uint8Array(SHOGO_API_KEY_RANDOM_BYTES),
  )
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Generate a new prefixed key + its persistence triple in one shot.
 *
 * Returns:
 *   - `fullKey`   — the bearer token to hand to the user (one-time).
 *   - `keyHash`   — store in `apiKey.keyHash` (column is unique-indexed).
 *   - `keyPrefix` — store in `apiKey.keyPrefix` for dashboard hints.
 */
export async function generateApiKey(): Promise<{
  fullKey: string
  keyHash: string
  keyPrefix: string
}> {
  const fullKey = `${SHOGO_API_KEY_PREFIX}${generateRawKeySuffix()}`
  const keyHash = await hashApiKey(fullKey)
  const keyPrefix = fullKey.slice(0, SHOGO_API_KEY_PREFIX_DISPLAY_LENGTH)
  return { fullKey, keyHash, keyPrefix }
}

export interface MintDeviceKeyArgs {
  prisma: PrismaClient
  workspaceId: string
  userId: string
  deviceId: string
  /** Defaults to `'Shogo Device'` if blank. Truncated to 120 chars. */
  deviceName?: string
  /** e.g. "darwin-arm64". Truncated to 32 chars. */
  devicePlatform?: string
  /** e.g. "1.2.20". Truncated to 32 chars. */
  deviceAppVersion?: string
  /** Override the default-empty deviceName when both inputs are empty. */
  defaultDeviceName?: string
}

export interface MintedDeviceKey {
  /** The bearer token — hand to the user exactly once. */
  fullKey: string
  /** Resolved DB row (post-create). */
  apiKey: {
    id: string
    name: string
    workspaceId: string
    deviceId: string | null
    deviceName: string | null
    devicePlatform: string | null
    deviceAppVersion: string | null
    createdAt: Date
    kind: string
  }
  /** Convenience: the prefix slice that was persisted. */
  keyPrefix: string
}

/**
 * Mint a `kind = 'device'` API key inside a single transaction:
 *
 *   1. Soft-revoke (set `revokedAt = now()`) any prior un-revoked
 *      device key for (workspaceId, deviceId). This is the dedupe rule
 *      that lets a user sign in repeatedly from the same machine
 *      without growing infinite stale credentials in their workspace.
 *   2. Insert the new key with the supplied device metadata.
 *
 * We don't hard-delete the prior keys so audit/billing history stays
 * intact — `revokedAt IS NOT NULL` keys are filtered out of dashboard
 * listings but still join cleanly to historical usage rows.
 */
export async function mintDeviceApiKey(
  args: MintDeviceKeyArgs,
): Promise<MintedDeviceKey> {
  const { fullKey, keyHash, keyPrefix } = await generateApiKey()

  const deviceName =
    (args.deviceName?.slice(0, 120) || args.defaultDeviceName || 'Shogo Device')
  const devicePlatform = args.devicePlatform?.slice(0, 32)
  const deviceAppVersion = args.deviceAppVersion?.slice(0, 32)

  const apiKey = await args.prisma.$transaction(async (tx) => {
    await tx.apiKey.updateMany({
      where: {
        workspaceId: args.workspaceId,
        deviceId: args.deviceId,
        kind: 'device',
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    })
    return tx.apiKey.create({
      data: {
        name: deviceName,
        keyHash,
        keyPrefix,
        workspaceId: args.workspaceId,
        userId: args.userId,
        kind: 'device',
        deviceId: args.deviceId,
        deviceName,
        devicePlatform,
        deviceAppVersion,
        lastSeenAt: new Date(),
      },
    })
  })

  return { fullKey, apiKey, keyPrefix }
}
