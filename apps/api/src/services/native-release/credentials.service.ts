// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The customer's Apple / Google / Expo credentials, encrypted at rest.
 *
 * Four kinds, one row each per workspace:
 *
 *   `asc_api_key`          App Store Connect API key — the .p8, its key id, its
 *                          issuer id and the Apple team id, as one JSON blob.
 *   `play_service_account` the Google Play service-account JSON.
 *   `android_keystore`     the Android upload keystore (.jks/.keystore) plus its
 *                          store password, key alias and key password.
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

export const CREDENTIAL_KINDS = [
  'asc_api_key',
  'play_service_account',
  'android_keystore',
  'expo_token',
] as const
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number]

export interface AscApiKey {
  keyP8: string
  keyId: string
  issuerId: string
  teamId: string
}

export interface AndroidKeystore {
  /** base64 of the .jks / .keystore file, without a `data:` prefix. */
  keystoreBase64: string
  keystorePassword: string
  keyAlias: string
  keyPassword: string
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

/** The container magics a Java keystore file can start with. */
const JKS_MAGIC = 0xfeedfeed
const JCEKS_MAGIC = 0xcececece

/**
 * A keystore is a binary file, and the only thing we can check about it without
 * a Java keytool in the process is its container magic: JKS, JCEKS, or the DER
 * `SEQUENCE` head of a PKCS#12 (.p12/.pfx) export. That is enough to reject the
 * three ways this goes wrong in practice — a pasted file path, an unencoded
 * binary, and the wrong file entirely — at save time rather than at release
 * time, when it would cost a build.
 */
function decodeKeystore(base64: string): Buffer {
  const cleaned = base64.replace(/^data:[^;]*;base64,/, '').replace(/\s+/g, '')
  if (!cleaned) {
    throw new NativeReleaseError(
      400,
      'keystore_incomplete',
      'Upload the keystore file itself (.jks or .keystore), not its path.',
    )
  }
  const bytes = Buffer.from(cleaned, 'base64')
  if (bytes.length < 64 || bytes.toString('base64').replace(/=+$/, '') !== cleaned.replace(/=+$/, '')) {
    throw new NativeReleaseError(
      400,
      'keystore_invalid',
      'That is not a base64-encoded keystore. Upload the .jks/.keystore file so it is sent as base64.',
    )
  }
  const head = bytes.readUInt32BE(0)
  const isJks = head === JKS_MAGIC || head === JCEKS_MAGIC
  // PKCS#12 is DER: `SEQUENCE`, long-form length. Anything else is not a keystore.
  const isPkcs12 = bytes[0] === 0x30 && (bytes[1] === 0x82 || bytes[1] === 0x81)
  if (!isJks && !isPkcs12) {
    throw new NativeReleaseError(
      400,
      'keystore_invalid',
      'That file is not a JKS/JCEKS or PKCS#12 keystore. Upload the .jks or .keystore you sign your Android releases with.',
    )
  }
  return bytes
}

/**
 * Normalise and check an uploaded keystore.
 *
 * `keystoreBase64` is the file; the other three fields are what Gradle needs to
 * use it, and none of them can be guessed. The key password is required
 * separately even when it equals the store password — Play rejects a release
 * whose signing config is missing either one, and defaulting one to the other
 * is how a correct file still fails to upload.
 */
export function parseAndroidKeystore(payload: Record<string, unknown>): AndroidKeystore {
  const keystoreBase64 = String(payload.keystoreBase64 ?? '').trim()
  const keystorePassword = String(payload.keystorePassword ?? '')
  const keyAlias = String(payload.keyAlias ?? '').trim()
  const keyPassword = String(payload.keyPassword ?? '')

  decodeKeystore(keystoreBase64)

  const missing = [
    ['keystorePassword', keystorePassword],
    ['keyAlias', keyAlias],
    ['keyPassword', keyPassword],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name)
  if (missing.length > 0) {
    throw new NativeReleaseError(
      400,
      'keystore_incomplete',
      `The upload keystore is missing ${missing.join(', ')} — Gradle needs all three to sign a release.`,
    )
  }

  return {
    keystoreBase64: keystoreBase64.replace(/^data:[^;]*;base64,/, '').replace(/\s+/g, ''),
    keystorePassword,
    keyAlias,
    keyPassword,
  }
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
    case 'android_keystore':
      return maskSecret(parseAndroidKeystore(payload as Record<string, unknown>).keyAlias)
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

/**
 * The workspace's Android upload keystore, or null when it has none.
 *
 * Kept because it is the one piece of signing material that cannot be re-issued
 * by us. EAS generates and holds a keystore per project for a *new* app, but an app
 * that already shipped somewhere else must sign with the identical key or Play
 * rejects the upload, and a user who has lost their copy has lost the listing. So
 * the workspace keeps its own encrypted copy, and `exportAndroidKeystore` hands it
 * back — never in a release log, never in the generated `eas.json`.
 */
export async function readAndroidKeystore(workspaceId: string): Promise<AndroidKeystore | null> {
  const payload = await readCredential<Record<string, unknown>>(workspaceId, 'android_keystore')
  return payload ? parseAndroidKeystore(payload) : null
}

/**
 * The plaintext keystore, for the owner's download. This is the one read that
 * returns signing material to a browser, so it is deliberately POST-only and
 * `no-store` at the route: a GET would put the response in proxy and access logs.
 */
export async function exportAndroidKeystore(workspaceId: string): Promise<AndroidKeystore | null> {
  return readAndroidKeystore(workspaceId)
}
