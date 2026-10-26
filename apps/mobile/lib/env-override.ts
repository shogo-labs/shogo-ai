// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Runtime API backend override for native builds (Production / Staging /
 * Custom URL), set from the hidden environment picker in Settings.
 *
 * `API_URL` is resolved once at import time, so the override is read
 * synchronously here and a change only takes effect after a JS reload.
 */
import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { getRuntimeApiUrl } from './runtime-env'

export type EnvPreset = 'production' | 'staging'
export type EnvOverrideKind = EnvPreset | 'custom'
export type ActiveEnvKey = 'default' | EnvOverrideKind

export interface EnvOverride {
  env: EnvOverrideKind
  url: string
}

export const ENV_PRESETS: Record<EnvPreset, { label: string; url: string }> = {
  production: { label: 'Production', url: 'https://studio.shogo.ai' },
  staging: { label: 'Staging', url: 'https://studio.staging.shogo.ai' },
}

// SecureStore keys must match /^[A-Za-z0-9._-]+$/ on native.
export const ENV_OVERRIDE_STORAGE_KEY = 'shogo_env_override'

/** Returns a normalized http(s) origin-ish URL, or null if invalid. */
export function normalizeOverrideUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!parsed.host) return null
  return trimmed.replace(/\/+$/, '')
}

export function parseEnvOverride(raw: string | null | undefined): EnvOverride | null {
  if (!raw) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const { env, url } = value as { env?: unknown; url?: unknown }
  if (env === 'production' || env === 'staging') {
    return { env, url: ENV_PRESETS[env].url }
  }
  if (env === 'custom' && typeof url === 'string') {
    const normalized = normalizeOverrideUrl(url)
    return normalized ? { env, url: normalized } : null
  }
  return null
}

/**
 * Env key used to namespace auth storage. An override that points at the
 * build's own default URL is treated as `default` so it shares the session.
 */
export function resolveActiveEnvKey(
  override: EnvOverride | null,
  buildDefaultUrl: string | undefined,
): ActiveEnvKey {
  if (!override) return 'default'
  if (buildDefaultUrl && normalizeOverrideUrl(buildDefaultUrl) === override.url) return 'default'
  return override.env
}

/** `default` must stay exactly `shogo` so existing sessions survive. */
export function authStoragePrefixFor(envKey: ActiveEnvKey): string {
  return envKey === 'default' ? 'shogo' : `shogo_${envKey}`
}

let cached: { value: EnvOverride | null } | null = null

export function getEnvOverride(): EnvOverride | null {
  if (cached) return cached.value
  let value: EnvOverride | null = null
  if (Platform.OS !== 'web') {
    try {
      value = parseEnvOverride(SecureStore.getItem(ENV_OVERRIDE_STORAGE_KEY))
    } catch {
      value = null
    }
  }
  cached = { value }
  return value
}

/** Persists the override; takes effect after a JS reload (see `env-switch.ts`). */
export async function setEnvOverride(override: EnvOverride | null): Promise<void> {
  if (Platform.OS === 'web') return
  if (override) {
    await SecureStore.setItemAsync(ENV_OVERRIDE_STORAGE_KEY, JSON.stringify(override))
  } else {
    await SecureStore.deleteItemAsync(ENV_OVERRIDE_STORAGE_KEY)
  }
}

export function getActiveEnvKey(): ActiveEnvKey {
  return resolveActiveEnvKey(getEnvOverride(), getRuntimeApiUrl())
}

/**
 * Environment tag for Sentry/PostHog. Overrides map to the same
 * `<env>_app` names the EAS profiles use, so a prod binary on staging
 * reports as `staging_app`.
 */
export function telemetryEnvFor(envKey: ActiveEnvKey, buildEnv: string): string {
  return envKey === 'default' ? buildEnv : `${envKey}_app`
}

/** Short label for UI badges, or null when on the build default. */
export function getActiveEnvLabel(): string | null {
  const override = getEnvOverride()
  const key = getActiveEnvKey()
  if (!override || key === 'default') return null
  if (override.env === 'custom') {
    try {
      return new URL(override.url).host
    } catch {
      return 'Custom'
    }
  }
  return ENV_PRESETS[override.env].label
}
