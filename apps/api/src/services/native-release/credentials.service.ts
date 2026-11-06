// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The customer's Apple / Google / Expo credentials, encrypted at rest.
 *
 * Three kinds, one row each per workspace:
 *
 *   `asc_api_key`          App Store Connect API key — the .p8, its key id, its
 *                          issuer id and the Apple team id, as one JSON blob.
 *   `play_service_account` the Google Play service-account JSON.
 *   `expo_token`           the BYOK `EXPO_TOKEN`, used only in `byok` mode.
 *
 * Two rules:
 *
 * 1. **Only the mask leaves this module.** Every read that a route can reach
 *    returns `maskedHint`; the plaintext is available only through
 *    `readCredential`, which is called by the release path that has to put the
 *    secret into a build job or a submission input.
 * 2. **Validation happens on save.** A key that cannot list Apple apps, or a
 *    service account that cannot open a Play edit, is rejected at the moment the
 *    user pastes it — not the first time they try to ship.
 */

import { prisma } from '../../lib/prisma'
import { decryptSecret, encryptSecret, maskSecret } from '../../lib/secret-crypto'
import { NativeReleaseError } from './client'

const db = prisma as any

export const CREDENTIAL_KINDS = ['asc_api_key', 'play_service_account', 'expo_token'] as const
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number]

export interface AscApiKey {
  keyP8: string
  keyId: string
  issuerId: string
  teamId: string
}

export interface CredentialSummary {
  kind: CredentialKind
  maskedHint: string
  validatedAt: string | null
}

function parseAsc(payload: Record<string, unknown>): AscApiKey {
  const keyP8 = String(payload.keyP8 ?? '')
  const keyId = String(payload.keyId ?? '')
  const issuerId = String(payload.issuerId ?? '')
  const teamId = String(payload.teamId ?? '')
  const missing = [
    ['keyP8', keyP8],
    ['keyId', keyId],
    ['issuerId', issuerId],
    ['teamId', teamId],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name)
  if (missing.length > 0) {
    throw new NativeReleaseError(
      400,
      'asc_key_incomplete',
      `The App Store Connect key is missing ${missing.join(', ')}.`,
    )
  }
  if (!keyP8.includes('BEGIN PRIVATE KEY')) {
    throw new NativeReleaseError(
      400,
      'asc_key_invalid',
      'Paste the whole .p8 file, including the BEGIN PRIVATE KEY lines.',
    )
  }
  return { keyP8, keyId, issuerId, teamId }
}

function parsePlay(payload: Record<string, unknown>): { json: string; clientEmail: string } {
  const raw = typeof payload.json === 'string' ? payload.json : JSON.stringify(payload)
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new NativeReleaseError(400, 'play_key_invalid', 'The Play service-account file is not valid JSON.')
  }
  if (!parsed?.client_email || !parsed?.private_key) {
    throw new NativeReleaseError(
      400,
      'play_key_invalid',
      'That JSON is not a Google service-account key (client_email and private_key are missing).',
    )
  }
  return { json: raw, clientEmail: String(parsed.client_email) }
}

/** The identifying field we mask, and what a summary row shows. */
function hintFor(kind: CredentialKind, payload: unknown): string {
  switch (kind) {
    case 'asc_api_key':
      return maskSecret(parseAsc(payload as Record<string, unknown>).keyId)
    case 'play_service_account':
      return maskSecret(parsePlay(payload as Record<string, unknown>).clientEmail)
    case 'expo_token': {
      const token = String((payload as Record<string, unknown>)?.token ?? '')
      if (!token) {
        throw new NativeReleaseError(400, 'expo_token_invalid', 'An Expo token is required.')
      }
      return maskSecret(token)
    }
  }
}

export async function listCredentials(workspaceId: string): Promise<CredentialSummary[]> {
  const rows = await db.nativeAppCredential.findMany({
    where: { workspaceId },
    orderBy: { kind: 'asc' },
  })
  return rows.map((row: any) => ({
    kind: row.kind as CredentialKind,
    maskedHint: row.maskedHint,
    validatedAt: row.validatedAt ? new Date(row.validatedAt).toISOString() : null,
  }))
}

/**
 * Store or replace a credential. `validate` runs first, so a bad key never
 * reaches the table — and the summary it returns is what the settings UI shows.
 */
export async function saveCredential(
  workspaceId: string,
  kind: CredentialKind,
  payload: Record<string, unknown>,
  validate: (kind: CredentialKind, payload: Record<string, unknown>) => Promise<void>,
): Promise<CredentialSummary> {
  if (!CREDENTIAL_KINDS.includes(kind)) {
    throw new NativeReleaseError(400, 'unknown_credential_kind', `Unknown credential kind "${kind}".`)
  }

  const maskedHint = hintFor(kind, payload)
  await validate(kind, payload)

  const row = await db.nativeAppCredential.upsert({
    where: { workspaceId_kind: { workspaceId, kind } },
    create: {
      workspaceId,
      kind,
      encryptedPayload: encryptSecret(JSON.stringify(payload)),
      maskedHint,
      validatedAt: new Date(),
    },
    update: {
      encryptedPayload: encryptSecret(JSON.stringify(payload)),
      maskedHint,
      validatedAt: new Date(),
    },
  })

  return {
    kind,
    maskedHint: row.maskedHint,
    validatedAt: new Date(row.validatedAt ?? Date.now()).toISOString(),
  }
}

export async function deleteCredential(workspaceId: string, kind: CredentialKind): Promise<void> {
  await db.nativeAppCredential.deleteMany({ where: { workspaceId, kind } })
}

/** The only plaintext read. Callers must be on the release path. */
export async function readCredential<T = Record<string, unknown>>(
  workspaceId: string,
  kind: CredentialKind,
): Promise<T | null> {
  const row = await db.nativeAppCredential.findUnique({
    where: { workspaceId_kind: { workspaceId, kind } },
  })
  if (!row) return null
  return JSON.parse(decryptSecret(row.encryptedPayload)) as T
}

export async function readAscKey(workspaceId: string): Promise<AscApiKey | null> {
  const payload = await readCredential<Record<string, unknown>>(workspaceId, 'asc_api_key')
  return payload ? parseAsc(payload) : null
}

export async function readPlayKey(workspaceId: string): Promise<string | null> {
  const payload = await readCredential<Record<string, unknown>>(workspaceId, 'play_service_account')
  return payload ? parsePlay(payload).json : null
}

export async function readByokExpoToken(workspaceId: string): Promise<string | null> {
  const payload = await readCredential<{ token?: string }>(workspaceId, 'expo_token')
  return payload?.token?.trim() || null
}
