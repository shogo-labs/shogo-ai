// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The workspace root's `.env*` files, sealed at rest (SHO-384).
 *
 * A cloud `ws:` runtime cold-boots its root from `git archive HEAD` — the
 * durable repo — which by design never carries `.env`, `.env.local` or
 * `.env.*`. On metal the encrypted home archive keeps them (SHO-382); a pod has
 * no host in front of it and no object-store credentials under `git_only`, so
 * the API is the one place that can hold them.
 *
 * Shape of the contract:
 *
 *   - **One blob per runtime key** (`ws:<workspaceId>` or `ws:proj:<anchor>`).
 *     The key is what the metal home archive already uses as `HOME_STATE_ID`, so
 *     the two substrates name the same runtime the same way.
 *   - **The API does the encryption.** A pod never holds a key: it hands the
 *     payload over an authenticated in-cluster request and gets plaintext back
 *     on the next boot. The key is derived from `SECRETS_ENCRYPTION_KEY` per
 *     runtime (`deriveProjectKey`), and the runtime key is bound in as
 *     associated data — so a blob copied onto another runtime's row fails the
 *     auth tag instead of restoring someone else's tokens.
 *   - **The row is opaque.** Only the ciphertext, its fingerprint and a byte
 *     count are stored; nothing about a file name or a value is queryable.
 *   - **A write is a no-op when nothing changed.** The payload's tag is stored
 *     beside it, so a runtime that polls without having edited a `.env` costs
 *     one row read instead of an encrypt and a rewrite.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { deriveProjectKey, isSecretCryptoConfigured } from '../secret-crypto'
import {
  WORKSPACE_ROOT_SECRETS_MAX_PAYLOAD_BYTES,
  validateWorkspaceRootSecrets,
  workspaceSecretsTag,
  type WorkspaceRootSecrets,
} from '@shogo/shared-runtime/workspace-root-secrets'

/** HKDF purpose label for the workspace-root secret key. Bump with the format. */
export const WORKSPACE_ROOT_SECRETS_KEY_PURPOSE = 'workspace-root-secrets:v1'

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16
const VERSION = 'v1'
/** JSON overhead on top of the decoded file bytes. */
const PAYLOAD_SLACK_BYTES = 32 * 1024
/** Stored plaintext ceiling: a full payload plus its envelope. */
export const WORKSPACE_ROOT_SECRETS_MAX_STORED_BYTES = WORKSPACE_ROOT_SECRETS_MAX_PAYLOAD_BYTES + PAYLOAD_SLACK_BYTES

export class RootSecretsTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RootSecretsTooLargeError'
  }
}

export class RootSecretsDecryptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RootSecretsDecryptError'
  }
}

function keyFor(runtimeKey: string): Buffer {
  return deriveProjectKey(WORKSPACE_ROOT_SECRETS_KEY_PURPOSE, runtimeKey)
}

/** Header + runtime key: neither the format nor the owning runtime can be swapped. */
function aad(runtimeKey: string): Buffer {
  return Buffer.from(`${VERSION}:workspace-root-secrets:${runtimeKey}`, 'utf8')
}

/** Seal a validated payload. Returns `v1:<iv>:<tag>:<ciphertext>`, all base64. */
export function sealRootSecrets(runtimeKey: string, secrets: WorkspaceRootSecrets): string {
  if (!runtimeKey) throw new Error('sealRootSecrets requires a runtimeKey')
  const plaintext = Buffer.from(JSON.stringify(secrets), 'utf8')
  if (plaintext.byteLength > WORKSPACE_ROOT_SECRETS_MAX_STORED_BYTES) {
    throw new RootSecretsTooLargeError(`workspace secrets are ${plaintext.byteLength} bytes, over the limit`)
  }
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, keyFor(runtimeKey), iv)
  cipher.setAAD(aad(runtimeKey))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':')
}

/** Inverse of {@link sealRootSecrets}. Throws {@link RootSecretsDecryptError} on any mismatch. */
export function openRootSecrets(runtimeKey: string, blob: string): WorkspaceRootSecrets {
  const parts = blob.split(':')
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new RootSecretsDecryptError('not a workspace-root secrets blob')
  }
  const iv = Buffer.from(parts[1]!, 'base64')
  const tag = Buffer.from(parts[2]!, 'base64')
  const ciphertext = Buffer.from(parts[3]!, 'base64')
  if (iv.byteLength !== IV_BYTES || tag.byteLength !== TAG_BYTES) {
    throw new RootSecretsDecryptError('workspace-root secrets blob has a malformed header')
  }
  try {
    const decipher = createDecipheriv(ALGO, keyFor(runtimeKey), iv)
    decipher.setAAD(aad(runtimeKey))
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return JSON.parse(plaintext.toString('utf8')) as WorkspaceRootSecrets
  } catch (err: any) {
    if (err instanceof RootSecretsDecryptError) throw err
    throw new RootSecretsDecryptError(
      'workspace-root secrets failed authentication (wrong runtime, wrong key, or tampered)',
    )
  }
}

export interface StoredRootSecrets {
  tag: string
  secrets: WorkspaceRootSecrets
  updatedAt: Date
}

/**
 * The stored payload for one runtime, or null when it has never exported (or
 * when this deployment cannot encrypt at all — a pod must then boot without a
 * store rather than fail its boot).
 */
export async function readRootSecrets(runtimeKey: string): Promise<StoredRootSecrets | null> {
  if (!runtimeKey || !isSecretCryptoConfigured()) return null
  const { prisma } = await import('../prisma')
  const row = await prisma.workspaceRootSecret.findUnique({ where: { runtimeKey } })
  if (!row) return null
  return { tag: row.tag, secrets: openRootSecrets(runtimeKey, row.ciphertext), updatedAt: row.updatedAt }
}

export interface WriteRootSecretsResult {
  stored: boolean
  tag: string
}

/**
 * Store a runtime's payload. A payload whose tag matches what is already stored
 * is left alone (`stored: false`), so a poll with nothing to do writes nothing.
 *
 * The payload is validated here rather than trusted: a compromised runtime can
 * only ever name `.env*` files, and only under slots the reader will map to
 * roots it already knows.
 */
export async function writeRootSecrets(
  scope: { runtimeKey: string; workspaceId: string },
  payload: unknown,
): Promise<WriteRootSecretsResult> {
  const { runtimeKey, workspaceId } = scope
  if (!runtimeKey) throw new Error('writeRootSecrets requires a runtimeKey')
  if (!workspaceId) throw new Error('writeRootSecrets requires a workspaceId')
  const invalid = validateWorkspaceRootSecrets(payload)
  if (invalid) throw new Error(invalid)
  const secrets = payload as WorkspaceRootSecrets
  const tag = workspaceSecretsTag(secrets)

  const { prisma } = await import('../prisma')
  const existing = await prisma.workspaceRootSecret.findUnique({
    where: { runtimeKey },
    select: { tag: true },
  })
  if (existing?.tag === tag) return { stored: false, tag }

  const ciphertext = sealRootSecrets(runtimeKey, secrets)
  const size = Buffer.byteLength(JSON.stringify(secrets), 'utf8')
  await prisma.workspaceRootSecret.upsert({
    where: { runtimeKey },
    create: { runtimeKey, workspaceId, tag, ciphertext, size },
    update: { workspaceId, tag, ciphertext, size },
  })
  return { stored: true, tag }
}

/**
 * There is deliberately no `deleteRootSecrets(runtimeKey)` here. The row
 * carries its `workspaceId` and cascades, so workspace delete drops it on every
 * path (CRUD route, admin route, desktop local route, a workspace merge)
 * without a call site to remember. A runtime that stops is not a reason to
 * delete its blob — that is exactly what the next cold boot restores from.
 */
