// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * App Store Connect and Google Play, called by us.
 *
 * The reason this module exists at all is `expo/eas-cli#4623`: `@expo/apple-utils`
 * signs the App Store Connect JWT with a lifetime of exactly 1200 s, Apple's hard
 * maximum, so any positive clock skew (≥ 1 s, routine in a container) makes the
 * token "1201 s" and Apple answers 401. Every published `eas-cli` through 27.4.1
 * carries that constant, so there is no version to pin.
 *
 * We sign our own instead, at `ASC_JWT_TTL_SECONDS` (1140 s), which leaves a
 * minute of slack in both directions. `createAscJwt` is the only place a token is
 * minted, and its `exp - iat` is asserted by a unit test — that assertion is the
 * regression guard for the whole bug class.
 *
 * No `eas-cli` and no `@expo/apple-utils` runs anywhere in this process.
 */

import { createSign } from 'node:crypto'
import { NativeReleaseError } from './client'
import type { AscApiKey } from './credentials.service'
import { googleAccessToken, probePlayPackage, type PlayKey } from './play'

export const ASC_API_BASE = 'https://api.appstoreconnect.apple.com'
/**
 * 1140 s, not 1200: Apple rejects a token whose lifetime exceeds 1200 s, and a
 * 1200 s token is rejected the moment our clock is a second ahead of theirs.
 */
export const ASC_JWT_TTL_SECONDS = 1140
const ASC_AUDIENCE = 'appstoreconnect-v1'

function base64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Mint an App Store Connect JWT.
 *
 * ES256 over the .p8: header `{ alg: 'ES256', kid, typ: 'JWT' }`, claims
 * `{ iss: issuerId, iat, exp, aud: 'appstoreconnect-v1' }`. Apple expects the
 * raw `r||s` signature, which is what `dsaEncoding: 'ieee-p1363'` produces — the
 * DER default is a silent 401.
 */
export function createAscJwt(
  key: Pick<AscApiKey, 'keyP8' | 'keyId' | 'issuerId'>,
  opts: { now?: number; ttlSeconds?: number } = {},
): string {
  const ttl = Math.min(opts.ttlSeconds ?? ASC_JWT_TTL_SECONDS, ASC_JWT_TTL_SECONDS)
  const iat = Math.floor((opts.now ?? Date.now()) / 1000)
  const exp = iat + ttl

  const header = base64url(JSON.stringify({ alg: 'ES256', kid: key.keyId, typ: 'JWT' }))
  const claims = base64url(JSON.stringify({ iss: key.issuerId, iat, exp, aud: ASC_AUDIENCE }))
  const signingInput = `${header}.${claims}`

  const signer = createSign('SHA256')
  signer.update(signingInput)
  signer.end()
  const signature = signer.sign({ key: key.keyP8, dsaEncoding: 'ieee-p1363' })

  return `${signingInput}.${base64url(signature)}`
}

/** The lifetime of a minted token, for the guard test and for logging. */
export function ascJwtLifetimeSeconds(token: string): number {
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8')) as {
    iat: number
    exp: number
  }
  return claims.exp - claims.iat
}

async function ascFetch(
  jwt: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${ASC_API_BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${jwt}`,
      'content-type': 'application/json',
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}

/**
 * Validate a key at save time by listing the team's apps. A key that cannot do
 * this cannot submit a build either, so there is no point storing it.
 */
export async function validateAscKey(
  key: AscApiKey,
  fetchImpl: typeof ascFetch = ascFetch,
): Promise<void> {
  const jwt = createAscJwt(key)
  const { status, json } = await fetchImpl(jwt, '/v1/apps?limit=1')
  if (status === 401 || status === 403) {
    throw new NativeReleaseError(
      400,
      'asc_key_rejected',
      'Apple rejected that key. Check the key id, the issuer id and the team id, and that the key has App Manager access.',
    )
  }
  if (status !== 200) {
    throw new NativeReleaseError(502, 'asc_unreachable', `App Store Connect answered ${status}.`, {
      detail: json?.errors?.[0]?.detail,
    })
  }
}

/** Find the App Store Connect app record for a bundle id, for `ascAppIdentifier`. */
export async function findAscAppId(key: AscApiKey, bundleId: string): Promise<string | null> {
  const jwt = createAscJwt(key)
  const { status, json } = await ascFetch(
    jwt,
    `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`,
  )
  // A rejected key is not "no app record": 401 means the key was revoked or
  // mistyped, and 403 means its role cannot list apps. Reporting either as
  // "create the app in App Store Connect" sends the user to do work that will not
  // fix anything.
  if (status === 401 || status === 403) {
    throw new NativeReleaseError(
      412,
      'asc_key_rejected',
      `App Store Connect rejected the API key (${status}). Re-upload it in Project → App stores — the key may have been revoked, or its role lacks App Manager access.`,
      { next_action: 'connect_asc', status },
    )
  }
  if (status !== 200) return null
  return json?.data?.[0]?.id ?? null
}

/**
 * Validate a Play service account at save time: mint an access token from its
 * private key, open an edit, delete it. An edit is the cheapest write that
 * proves the account has release permission on some app.
 */
export async function validatePlayKey(
  credentialsJson: string,
  opts: { packageName?: string; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  let parsed: { client_email?: string; private_key?: string }
  try {
    parsed = JSON.parse(credentialsJson)
  } catch {
    throw new NativeReleaseError(400, 'play_key_invalid', 'The Play service-account file is not valid JSON.')
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new NativeReleaseError(
      400,
      'play_key_invalid',
      'That JSON is not a Google service-account key (client_email and private_key are missing).',
    )
  }
  const key: PlayKey = { json: credentialsJson, clientEmail: parsed.client_email }

  let accessToken: string
  try {
    accessToken = await googleAccessToken(key, { fetchImpl: opts.fetchImpl })
  } catch {
    throw new NativeReleaseError(
      400,
      'play_key_rejected',
      'Google rejected that service account. Make sure it is granted release access in Play Console.',
    )
  }

  if (!opts.packageName) return

  const probe = await probePlayPackage(key, opts.packageName, {
    fetchImpl: opts.fetchImpl,
    accessToken,
  })
  if (!probe.ok) {
    throw new NativeReleaseError(
      400,
      probe.code === 'play_package_not_found' ? 'play_package_missing' : 'play_package_rejected',
      'That service account cannot publish to this Android package. Check the package name and its Play Console permissions.',
      { play: probe.code },
    )
  }
}
