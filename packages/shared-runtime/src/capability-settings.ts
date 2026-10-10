// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Capability toggles stored on `Project.settings` and mirrored into the
 * agent runtime's `config.json`.
 *
 * `Project.settings` is the source of truth. The runtime pulls these keys
 * and writes them into `config.json` as a last-known cache. Most toggles
 * are on unless explicitly false. `gitWorktreesEnabled` and
 * `socialMediaEnabled` are opt-in. `heartbeatEnabled` is the pre-split
 * name of `heartbeatToolsEnabled`.
 */

export const CAPABILITY_KEYS = [
  'canvasEnabled',
  'webEnabled',
  'browserEnabled',
  'shellEnabled',
  'heartbeatToolsEnabled',
  'imageGenEnabled',
  'memoryEnabled',
  'quickActionsEnabled',
  'sdkGuideEnabled',
  'integrationsEnabled',
  'channelsEnabled',
  'gitWorktreesEnabled',
  'socialMediaEnabled',
  'socialInstagramEnabled',
  'socialTiktokEnabled',
] as const

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number]

export type CapabilitySettings = Record<CapabilityKey, boolean>

/** Off unless the stored value is exactly `true`. */
const OPT_IN_KEYS = new Set<CapabilityKey>(['gitWorktreesEnabled', 'socialMediaEnabled'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `Project.settings` is sometimes stored as a JSON string (a jsonb string
 * scalar) rather than an object. Unwrap that before reading keys.
 */
function asSettingsObject(settings: unknown): Record<string, unknown> {
  let value = settings
  for (let depth = 0; typeof value === 'string' && depth < 5; depth++) {
    try {
      value = JSON.parse(value)
    } catch {
      return {}
    }
  }
  return isPlainObject(value) ? value : {}
}

/**
 * Resolve every capability toggle from a `Project.settings` value.
 * Missing, unparseable, or non-object values fall through to the defaults.
 */
export function normalizeCapabilitySettings(settings: unknown): CapabilitySettings {
  const raw = asSettingsObject(settings)
  const out = {} as CapabilitySettings
  for (const key of CAPABILITY_KEYS) {
    if (key === 'heartbeatToolsEnabled') {
      const value = raw.heartbeatToolsEnabled ?? raw.heartbeatEnabled
      out[key] = value !== false
      continue
    }
    out[key] = OPT_IN_KEYS.has(key) ? raw[key] === true : raw[key] !== false
  }
  return out
}

/**
 * Overlay the normalized capability toggles onto a `config.json` object.
 * Only `CAPABILITY_KEYS` change; everything else is preserved. Returns
 * `changed: false` when the cache already matches.
 */
export function mergeCapabilitySettingsIntoConfig(
  fileConfig: Record<string, unknown>,
  settings: unknown,
): { config: Record<string, unknown>; changed: boolean } {
  const caps = normalizeCapabilitySettings(settings)
  const next: Record<string, unknown> = { ...fileConfig }
  let changed = false
  for (const key of CAPABILITY_KEYS) {
    if (next[key] !== caps[key]) {
      next[key] = caps[key]
      changed = true
    }
  }
  return { config: next, changed }
}
