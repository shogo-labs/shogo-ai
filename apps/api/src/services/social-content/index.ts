// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Factory + token resolution for the content-CPM data provider.
 *
 * Provider selection: `SHOGO_SOCIAL_CONTENT_PROVIDER` (default
 * `ensembledata`). The `official` value wires the (currently skeleton)
 * IG Graph / TikTok Display provider.
 *
 * Token resolution mirrors the native-provider-keys pattern
 * (provider-credentials.service.ts): an admin-stored, encrypted
 * `PlatformSetting` row `provider-key.ensembledata` wins, falling back
 * to the `ENSEMBLEDATA_API_TOKEN` env var for local/dev. We never log
 * the plaintext token.
 *
 * The resolved provider is memoized per-process with a short TTL so the
 * hourly poll doesn't hit the DB + decrypt on every account, while still
 * picking up an admin key rotation within a minute.
 */

import { prisma } from '../../lib/prisma'
import { decryptSecret } from '../../lib/secret-crypto'
import { EnsembleDataProvider } from './ensembledata-provider'
import { OfficialApiProvider } from './official-provider'
import { type SocialContentProvider, SocialProviderError } from './provider'

export * from './provider'

const ENSEMBLEDATA_SETTING_KEY = 'provider-key.ensembledata'
const CACHE_TTL_MS = 60_000

let cached: { provider: SocialContentProvider; loadedAt: number } | null = null

/** Provider id from env, defaulting to the unofficial EnsembleData path. */
export function getConfiguredProviderName(): string {
  return (process.env.SHOGO_SOCIAL_CONTENT_PROVIDER || 'ensembledata').trim().toLowerCase()
}

/**
 * Resolve the EnsembleData API token: encrypted PlatformSetting first,
 * then the `ENSEMBLEDATA_API_TOKEN` env var. Returns null when neither
 * is configured (callers raise `not_configured`).
 */
async function resolveEnsembleDataToken(): Promise<string | null> {
  try {
    const row = (await prisma.platformSetting.findUnique({
      where: { key: ENSEMBLEDATA_SETTING_KEY },
    })) as { value: string } | null
    if (row?.value) {
      try {
        return decryptSecret(row.value)
      } catch (err) {
        console.error('[social-content] failed to decrypt EnsembleData token; falling back to env:', (err as Error).message)
      }
    }
  } catch (err) {
    console.error('[social-content] PlatformSetting lookup failed; falling back to env:', (err as Error).message)
  }
  const envToken = process.env.ENSEMBLEDATA_API_TOKEN
  return envToken && envToken.trim() ? envToken.trim() : null
}

/**
 * Build (and memoize) the configured content provider. Throws
 * `SocialProviderError('not_configured')` when the selected provider has
 * no usable credentials.
 */
export async function getSocialContentProvider(opts: { force?: boolean } = {}): Promise<SocialContentProvider> {
  if (!opts.force && cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.provider
  }

  const name = getConfiguredProviderName()
  let provider: SocialContentProvider

  if (name === 'official') {
    provider = new OfficialApiProvider()
  } else if (name === 'ensembledata') {
    const token = await resolveEnsembleDataToken()
    if (!token) {
      throw new SocialProviderError(
        'not_configured',
        'EnsembleData token missing. Set PlatformSetting provider-key.ensembledata ' +
          'or the ENSEMBLEDATA_API_TOKEN env var.',
      )
    }
    provider = new EnsembleDataProvider({
      token,
      baseUrl: process.env.ENSEMBLEDATA_BASE_URL || undefined,
    })
  } else {
    throw new SocialProviderError('not_configured', `Unknown SHOGO_SOCIAL_CONTENT_PROVIDER: "${name}"`)
  }

  cached = { provider, loadedAt: Date.now() }
  return provider
}

/** Drop the memoized provider (e.g. after an admin rotates the token). */
export function invalidateSocialContentProvider(): void {
  cached = null
}
