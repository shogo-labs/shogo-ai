// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Who submits to Google Play, and what the user has to do about it.
 *
 * Google has one property Apple does not: a service account can be granted
 * release permission **on a specific app by its owner**. So Shogo can own a
 * single publisher account and never ask a customer for a JSON key — the user
 * invites `SHOGO_PLAY_PUBLISHER_SA`'s email in Play Console and is done. That
 * key lives only in the cloud API process (k8s Secret, the same treatment as
 * `EXPO_ACCOUNT_TOKEN`) and is passed to Expo inline in the submission input, so
 * it is never stored in Expo's credential vault either.
 *
 * A workspace-uploaded `play_service_account` stays as the BYOK override: apps
 * that already have their own publisher account keep it.
 *
 * Apple has no equivalent — an ASC API key cannot be granted to a third party —
 * so `asc_api_key` remains user-provided. That asymmetry is why this module is
 * Play-only.
 */

import { readFileSync } from 'node:fs'
import { createSign } from 'node:crypto'

export const PLAY_PUBLISHER_ENV = 'SHOGO_PLAY_PUBLISHER_SA'
export const PLAY_PUBLISHER_FILE_ENV = 'SHOGO_PLAY_PUBLISHER_SA_FILE'
export const PLAY_SCOPE = 'https://www.googleapis.com/auth/androidpublisher'

export interface PlayKey {
  json: string
  clientEmail: string
}

/** What the user has to fix, when the publisher account cannot reach their app. */
export type PlayRefusal =
  /** The service account has not been invited to this app in Play Console. */
  | 'play_not_invited'
  /** Play has never seen this package: the first upload must be done by hand. */
  | 'play_package_not_found'
  | 'play_error'

export interface PlayProbe {
  ok: boolean
  code?: PlayRefusal
  message?: string
}

function parseKey(json: string): PlayKey {
  const parsed = JSON.parse(json) as { client_email?: string; private_key?: string }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('not a Google service-account key (client_email and private_key are missing)')
  }
  return { json, clientEmail: parsed.client_email }
}

/**
 * The Shogo-owned publisher account, from the process environment.
 *
 * Either the JSON itself (`SHOGO_PLAY_PUBLISHER_SA`) or a mounted file
 * (`SHOGO_PLAY_PUBLISHER_SA_FILE`) — k8s Secrets are usually mounted as files,
 * and a reviewer should be able to read the deployment manifest to see which one
 * this deployment uses. Unset means "not configured": the release path then
 * falls back to the workspace's own key, or says so.
 */
export function shogoPlayPublisherKey(env: NodeJS.ProcessEnv = process.env): PlayKey | null {
  const inline = env[PLAY_PUBLISHER_ENV]?.trim()
  if (inline) {
    try {
      return parseKey(inline)
    } catch {
      return null
    }
  }
  const path = env[PLAY_PUBLISHER_FILE_ENV]?.trim()
  if (!path) return null
  try {
    return parseKey(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** The email a user invites in Play Console → Users and permissions. */
export function playPublisherEmail(env: NodeJS.ProcessEnv = process.env): string | null {
  return shogoPlayPublisherKey(env)?.clientEmail ?? null
}

/**
 * The key a submission should use: the workspace's own if it uploaded one,
 * otherwise Shogo's publisher account.
 *
 * Order matters. A workspace that connected its own service account has
 * explicitly taken ownership of publishing, and billing is unaffected (there is
 * no Play charge) — so its key wins.
 */
export async function resolvePlayCredentials(
  workspaceId: string,
  opts: {
    readByokKey?: (workspaceId: string) => Promise<string | null>
    env?: NodeJS.ProcessEnv
  } = {},
): Promise<{ key: PlayKey; source: 'workspace' | 'shogo' } | null> {
  const byok = opts.readByokKey ? await opts.readByokKey(workspaceId) : null
  if (byok) {
    try {
      return { key: parseKey(byok), source: 'workspace' }
    } catch {
      // A stored key that no longer parses is not a reason to stop publishing:
      // fall through to Shogo's, which is validated by its own parse below.
    }
  }
  const shogo = shogoPlayPublisherKey(opts.env)
  return shogo ? { key: shogo, source: 'shogo' } : null
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Mint a Google access token from a service-account key.
 *
 * Hand-rolled RS256 over `node:crypto` for the same reason the ASC JWT is: a
 * one-line library dependency would pull an auth stack into the API process for
 * a single grant, and the claim set is fixed. The lifetime is 1 h, which is
 * Google's own ceiling for this grant — unlike the ASC token, there is no
 * clock-skew trap here.
 */
export async function googleAccessToken(
  key: PlayKey,
  opts: { fetchImpl?: typeof fetch; scope?: string } = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const parsed = JSON.parse(key.json) as { token_uri?: string; private_key: string }
  const tokenUri = parsed.token_uri ?? 'https://oauth2.googleapis.com/token'
  const iat = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64url(
    JSON.stringify({
      iss: key.clientEmail,
      scope: opts.scope ?? PLAY_SCOPE,
      aud: tokenUri,
      iat,
      exp: iat + 3600,
    }),
  )
  const signer = createSign('SHA256')
  signer.update(`${header}.${claims}`)
  signer.end()
  const assertion = `${header}.${claims}.${base64url(signer.sign(parsed.private_key))}`

  const res = await fetchImpl(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(20_000),
  })
  const body = (await res.json().catch(() => ({}))) as { access_token?: string }
  if (!res.ok || !body.access_token) {
    throw new Error(`google_token_rejected: ${res.status}`)
  }
  return body.access_token
}

/**
 * Can this account open a Play edit on this package?
 *
 * An edit is the cheapest write that proves release permission, and Play's two
 * refusals are the two things a user has to do by hand — so they are separated
 * rather than collapsed into "it failed": a 404 means Play has never seen the
 * package (App Store-style "create the app record" step, done by a first upload
 * in Play Console), while 401/403 means the account simply was not invited.
 */
export async function probePlayPackage(
  key: PlayKey,
  packageName: string,
  opts: { fetchImpl?: typeof fetch; accessToken?: string } = {},
): Promise<PlayProbe> {
  const fetchImpl = opts.fetchImpl ?? fetch
  let token: string
  try {
    token = opts.accessToken ?? (await googleAccessToken(key, { fetchImpl }))
  } catch (err) {
    return { ok: false, code: 'play_error', message: String((err as Error)?.message ?? err) }
  }

  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/edits`
  const res = await fetchImpl(base, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(20_000),
  })
  const body = (await res.json().catch(() => ({}))) as {
    id?: string
    error?: { code?: number; message?: string }
  }

  if (!res.ok || !body.id) {
    const status = body.error?.code ?? res.status
    const message = body.error?.message ?? `Play answered ${res.status}`
    const code: PlayRefusal = status === 404 ? 'play_package_not_found' : status === 401 || status === 403 ? 'play_not_invited' : 'play_error'
    return { ok: false, code, message }
  }

  await fetchImpl(`${base}/${body.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  }).catch(() => undefined)

  return { ok: true }
}

/**
 * The message when there is no publisher account to invite.
 *
 * This is the live byok case: `NATIVE_RELEASE_MODE=byok` means the Shogo publisher
 * service account may not be configured at all, and "invite the Shogo publisher
 * account" is then an instruction nobody can follow. The user's own key in
 * Project → App stores is the only path, so say that.
 */
export function playMissingAccountMessage(opts: { packageName?: string } = {}): string {
  return `Connect a Google Play service account in Project → App stores (Play Console → Setup → API access → create a service account, download its JSON key, then grant it "Release apps to testing tracks" on ${opts.packageName ?? 'this app'}). No publisher account is configured for Shogo, so this release has nothing to submit with.`
}

/** The message a user gets for each refusal, in the words of the two manual steps. */
export function playRefusalMessage(code: PlayRefusal, opts: { email?: string | null; packageName?: string }): string {
  const email = opts.email ?? 'the Shogo publisher account'
  if (code === 'play_not_invited') {
    return `In Google Play Console → Users and permissions, invite ${email} and grant "Release apps to testing tracks" on this app.`
  }
  if (code === 'play_package_not_found') {
    return `Play has never seen ${opts.packageName ?? 'this package'}. Upload one build by hand in Play Console once (this release's build is available to download), and Google will create the app record.`
  }
  return 'Google Play refused the submission.'
}
