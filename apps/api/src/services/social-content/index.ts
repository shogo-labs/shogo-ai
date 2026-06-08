// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Factory + token resolution for the content-CPM data provider.
 *
 * Provider selection: the super-admin-controlled `PlatformSetting`
 * `affiliate.content.provider` (default `ensembledata`). The `official`
 * value wires the (currently skeleton) IG Graph / TikTok Display provider.
 * (Canonical key list lives in affiliate-content-settings.service.ts; the
 * key string is duplicated here to keep this module free of a settings-service
 * import, which would create an import cycle.)
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

export const ENSEMBLEDATA_SETTING_KEY = 'provider-key.ensembledata'
const PROVIDER_SETTING_KEY = 'affiliate.content.provider'
const CACHE_TTL_MS = 60_000

let cached: { provider: SocialContentProvider; loadedAt: number } | null = null

/** Provider id from the DB setting, defaulting to the unofficial EnsembleData path. */
export async function getConfiguredProviderName(): Promise<string> {
  try {
    const row = (await prisma.platformSetting.findUnique({
      where: { key: PROVIDER_SETTING_KEY },
      select: { value: true },
    })) as { value: string } | null
    const v = (row?.value || '').trim().toLowerCase()
    if (v) return v
  } catch (err) {
    console.error('[social-content] provider setting lookup failed; defaulting to ensembledata:', (err as Error).message)
  }
  return 'ensembledata'
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

  const name = await getConfiguredProviderName()
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
    throw new SocialProviderError('not_configured', `Unknown affiliate.content.provider setting: "${name}"`)
  }

  cached = { provider, loadedAt: Date.now() }
  return provider
}

/** Drop the memoized provider (e.g. after an admin rotates the token). */
export function invalidateSocialContentProvider(): void {
  cached = null
}
