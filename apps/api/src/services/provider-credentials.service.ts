// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Native-provider API key resolver.
 *
 * Resolves the API key for a first-party provider (Anthropic, OpenAI, Google,
 * OpenRouter) from two sources, in precedence order:
 *
 *   1. An admin-stored, encrypted key in the `PlatformSetting` table under the
 *      key `provider-key.<provider>` (cloud super-admin entry). Decrypted via
 *      apps/api/src/lib/secret-crypto.ts.
 *   2. The process environment variable for that provider (`ANTHROPIC_API_KEY`,
 *      etc). Cloud deployments inject these from k8s secrets; local/desktop
 *      BYOK mirrors saved keys into `process.env`, so the env fallback covers
 *      local mode unchanged.
 *
 * This is the single seam the AI proxy (`getProviderApiKey`) and the
 * visible-models gating (`isModelProviderConfigured`) read so a key entered in
 * either place gates routing and picker visibility consistently.
 *
 * Caching mirrors the model-registry service: an in-memory snapshot with a
 * short TTL plus explicit `invalidateProviderCredentials()` (called by the
 * provider-keys write route). Decrypted plaintext lives only inside this
 * module's cache and is never logged or returned by read APIs (reads return a
 * non-reversible mask).
 */

import { prisma } from '../lib/prisma'
import { decryptSecret, encryptSecret, maskSecret, isSecretCryptoConfigured } from '../lib/secret-crypto'

/** Native providers whose keys we resolve here. `custom` providers carry their
 *  own encrypted key on the `ModelProvider` row and are handled elsewhere. */
export const NATIVE_PROVIDER_ENV_KEY: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
}

export const SUPPORTED_NATIVE_PROVIDERS = Object.keys(NATIVE_PROVIDER_ENV_KEY)

/** PlatformSetting key prefix for admin-stored, encrypted native keys. */
const SETTING_PREFIX = 'provider-key.'

const CACHE_TTL_MS = 30_000

interface CredentialSnapshot {
  /** provider -> decrypted plaintext key from PlatformSetting (DB-stored). */
  keys: Map<string, string>
  loadedAt: number
}

let snapshot: CredentialSnapshot = { keys: new Map(), loadedAt: 0 }
let inflight: Promise<void> | null = null

export function isNativeProvider(provider: string): boolean {
  return provider in NATIVE_PROVIDER_ENV_KEY
}

function settingKey(provider: string): string {
  return `${SETTING_PREFIX}${provider}`
}

/**
 * Load the DB-stored encrypted keys and rebuild the snapshot. Resilient: any
 * DB or decryption failure leaves that provider absent from the DB layer (so
 * the env fallback still applies) rather than throwing.
 */
async function refresh(): Promise<void> {
  try {
    const rows = (await prisma.platformSetting.findMany({
      where: { key: { startsWith: SETTING_PREFIX } },
    })) as Array<{ key: string; value: string }>

    const keys = new Map<string, string>()
    for (const row of rows) {
      const provider = row.key.slice(SETTING_PREFIX.length)
      if (!isNativeProvider(provider)) continue
      if (!row.value) continue
      try {
        keys.set(provider, decryptSecret(row.value))
      } catch (err) {
        // Master key missing/rotated or blob corrupt: skip this provider so we
        // fall back to env rather than crashing or leaking.
        console.error(
          `[provider-credentials] failed to decrypt key for ${provider}:`,
          (err as Error).message,
        )
      }
    }

    snapshot = { keys, loadedAt: Date.now() }
  } catch (err) {
    snapshot = { ...snapshot, loadedAt: Date.now() }
    console.error('[provider-credentials] refresh failed, using env only:', (err as Error).message)
  }
}

function isStale(): boolean {
  return Date.now() - snapshot.loadedAt > CACHE_TTL_MS
}

function refreshIfStaleInBackground(): void {
  if (!isStale() || inflight) return
  inflight = refresh().finally(() => {
    inflight = null
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Await a fresh load. Call once at server startup to prime the cache. */
export async function primeProviderCredentials(): Promise<void> {
  await refresh()
}

/** Drop the cache and reload. Call from the provider-keys write route. */
export async function invalidateProviderCredentials(): Promise<void> {
  await refresh()
}

/**
 * Resolve the usable API key for a native provider: DB-stored (decrypted)
 * first, else the env var. Returns null when neither is configured.
 */
export function getNativeProviderApiKeySync(provider: string): string | null {
  refreshIfStaleInBackground()
  const dbKey = snapshot.keys.get(provider)
  if (dbKey) return dbKey
  const envKey = NATIVE_PROVIDER_ENV_KEY[provider]
  if (envKey && process.env[envKey]) return process.env[envKey] as string
  return null
}

export interface NativeProviderKeyInfo {
  configured: boolean
  /** Non-reversible display mask (e.g. `sk-a…3xaa`), or '' when unconfigured. */
  mask: string
  source: 'db' | 'env' | null
}

/** Describe how a native provider's key is configured, without leaking it. */
export function getNativeProviderKeyInfoSync(provider: string): NativeProviderKeyInfo {
  refreshIfStaleInBackground()
  const dbKey = snapshot.keys.get(provider)
  if (dbKey) return { configured: true, mask: maskSecret(dbKey), source: 'db' }
  const envKey = NATIVE_PROVIDER_ENV_KEY[provider]
  const envVal = envKey ? process.env[envKey] : undefined
  if (envVal) return { configured: true, mask: maskSecret(envVal), source: 'env' }
  return { configured: false, mask: '', source: null }
}

/**
 * Store (or clear) an admin-provided native provider key. Encrypts the
 * plaintext and upserts `PlatformSetting provider-key.<provider>`; passing
 * null/empty deletes the stored override (env fallback then applies). Refreshes
 * the cache before returning. Throws if `SECRETS_ENCRYPTION_KEY` is missing.
 */
export async function setNativeProviderKey(
  provider: string,
  plaintext: string | null,
  userId: string,
): Promise<void> {
  if (!isNativeProvider(provider)) throw new Error(`unsupported provider: ${provider}`)
  const key = settingKey(provider)

  if (!plaintext) {
    await prisma.platformSetting.deleteMany({ where: { key } })
    await refresh()
    return
  }

  if (!isSecretCryptoConfigured()) {
    throw new Error(
      'SECRETS_ENCRYPTION_KEY is not configured on this server; cannot store provider keys.',
    )
  }
  const value = encryptSecret(plaintext)
  await prisma.platformSetting.upsert({
    where: { key },
    create: { key, value, updatedBy: userId },
    update: { value, updatedBy: userId },
  })
  await refresh()
}
