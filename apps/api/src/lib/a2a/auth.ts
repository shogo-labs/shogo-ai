// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A2A bearer-key auth: mint / verify / revoke `shogo_a2a_<keyId>.<secret>`
 * tokens, one per project.
 *
 * Shape mirrors Odin's `odin_a2a_<key_id>.<secret>` (see
 * `alignment-project-server/services/a2a/auth.py`), but the secret is
 * hashed with the repo's existing SHA-256 `hashApiKey()`
 * (`lib/api-keys-mint.ts`) instead of Odin's bcrypt, for consistency with
 * `shogo_sk_*` keys elsewhere in this codebase. The secret is 32 random
 * bytes of entropy, so a fast hash is fine here (unlike a user-chosen
 * password, there's no offline-guessing risk to mitigate with a slow KDF).
 *
 * The `keyId` half is NOT secret — it's a lookup key, persisted plaintext
 * in `A2aApiKey.keyId` (unique-indexed) so verification is a single
 * `findUnique` rather than a table scan comparing hashes. Only the
 * `secret` half is hashed.
 *
 * Every verification failure — malformed token, unknown keyId, revoked,
 * expired, wrong project, hash mismatch — must be indistinguishable to
 * the caller (uniform 401 + `WWW-Authenticate: Bearer`), so a probing
 * client can't use error shape/timing to enumerate projects or valid
 * keyIds. `verifyA2aApiKey` returns a single `{ ok: false }` shape for
 * all of these; the route layer is responsible for not leaking more.
 */

import crypto from 'crypto'
import { hashApiKey } from '../api-keys-mint'
import { prisma } from '../prisma'

/** Public prefix on every minted A2A key, before `<keyId>.<secret>`. */
export const SHOGO_A2A_KEY_PREFIX = 'shogo_a2a_'

/** Random bytes (hex-encoded) making up the lookup-key half. Not secret. */
const KEY_ID_RANDOM_BYTES = 12

/** Random bytes (hex-encoded) making up the secret half. Hashed at rest. */
const SECRET_RANDOM_BYTES = 32

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export interface MintA2aKeyArgs {
  projectId: string
  workspaceId: string
  createdBy: string
  /** Defaults to `'A2A key'` if blank. Truncated to 120 chars. */
  name?: string
  /** Optional absolute expiry. */
  expiresAt?: Date | null
}

export interface MintedA2aKey {
  /** The bearer token — hand to the caller exactly once. */
  fullKey: string
  id: string
  keyId: string
  name: string
  projectId: string
  createdAt: Date
  expiresAt: Date | null
}

/**
 * Mint a new `shogo_a2a_*` key for a project. Does not dedupe against
 * existing keys — unlike device keys, a project can (and typically will)
 * hand out several named A2A keys to different external callers, and
 * revoking one must not touch the others.
 */
export async function mintA2aApiKey(args: MintA2aKeyArgs): Promise<MintedA2aKey> {
  const keyId = randomHex(KEY_ID_RANDOM_BYTES)
  const secret = randomHex(SECRET_RANDOM_BYTES)
  const fullKey = `${SHOGO_A2A_KEY_PREFIX}${keyId}.${secret}`
  const hashedSecret = await hashApiKey(secret)
  const name = args.name?.slice(0, 120) || 'A2A key'

  const row = await prisma.a2aApiKey.create({
    data: {
      name,
      keyId,
      hashedSecret,
      projectId: args.projectId,
      workspaceId: args.workspaceId,
      createdBy: args.createdBy,
      expiresAt: args.expiresAt ?? null,
    },
  })

  return {
    fullKey,
    id: row.id,
    keyId: row.keyId,
    name: row.name,
    projectId: row.projectId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  }
}

export interface A2aKeyListItem {
  id: string
  name: string
  keyId: string
  projectId: string
  createdAt: Date
  lastUsedAt: Date | null
  expiresAt: Date | null
  revokedAt: Date | null
}

/** List keys for a project, newest first. Never returns `hashedSecret`. */
export async function listA2aApiKeys(projectId: string): Promise<A2aKeyListItem[]> {
  const rows = await prisma.a2aApiKey.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
  })
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    keyId: r.keyId,
    projectId: r.projectId,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
  }))
}

/**
 * Revoke a key. Scoped to `projectId` so one project can't revoke
 * another's key by guessing/enumerating ids — callers must have already
 * passed `authorizeProject` for `projectId` before calling this.
 *
 * Returns `false` (rather than throwing) when the id doesn't exist or
 * belongs to a different project, so the route can 404 uniformly.
 */
export async function revokeA2aApiKey(args: { id: string; projectId: string }): Promise<boolean> {
  const result = await prisma.a2aApiKey.updateMany({
    where: { id: args.id, projectId: args.projectId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  return result.count > 0
}

export interface VerifiedA2aKey {
  id: string
  keyId: string
  projectId: string
  workspaceId: string
}

export type VerifyA2aKeyResult =
  | { ok: true; key: VerifiedA2aKey }
  | { ok: false }

/**
 * Parse a `shogo_a2a_<keyId>.<secret>` token and verify it's valid for
 * `projectId`. Every rejection path returns the same `{ ok: false }` —
 * do not branch on the reason in caller-visible responses.
 *
 * Fires a best-effort (non-blocking) `lastUsedAt` bump on success —
 * mirrors `resolveApiKey`'s pattern for `shogo_sk_*` keys — so a slow/
 * failed write never delays the A2A call it's authenticating.
 */
export async function verifyA2aApiKey(
  bearerToken: string,
  projectId: string,
): Promise<VerifyA2aKeyResult> {
  if (!bearerToken.startsWith(SHOGO_A2A_KEY_PREFIX)) return { ok: false }

  const rest = bearerToken.slice(SHOGO_A2A_KEY_PREFIX.length)
  const dot = rest.indexOf('.')
  if (dot <= 0 || dot === rest.length - 1) return { ok: false }

  const keyId = rest.slice(0, dot)
  const secret = rest.slice(dot + 1)

  let row: {
    id: string
    keyId: string
    hashedSecret: string
    projectId: string
    workspaceId: string
    revokedAt: Date | null
    expiresAt: Date | null
  } | null = null
  try {
    row = await prisma.a2aApiKey.findUnique({ where: { keyId } })
  } catch {
    return { ok: false }
  }
  if (!row) return { ok: false }
  if (row.revokedAt) return { ok: false }
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return { ok: false }
  if (row.projectId !== projectId) return { ok: false }

  const presentedHash = await hashApiKey(secret)
  if (!timingSafeEqualHex(presentedHash, row.hashedSecret)) return { ok: false }

  // Best-effort, fire-and-forget — never block or fail the request on this.
  prisma.a2aApiKey
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {})

  return {
    ok: true,
    key: {
      id: row.id,
      keyId: row.keyId,
      projectId: row.projectId,
      workspaceId: row.workspaceId,
    },
  }
}

/**
 * Timing-safe compare of two equal-shape hex strings (both are SHA-256
 * hex digests, so always 64 chars — but guard the length anyway since
 * `crypto.timingSafeEqual` throws on mismatched buffer lengths rather
 * than returning `false`, which would otherwise turn a corrupt DB row
 * into a 500 instead of a clean auth rejection).
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex')
  const bufB = Buffer.from(b, 'hex')
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}
