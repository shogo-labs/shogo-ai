// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * RBAC enforcement mode.
 *
 *   off     new denials are ignored (legacy membership-only behavior)
 *   shadow  new denials are logged but the request proceeds when the
 *           caller would have been allowed before RBAC (any workspace role)
 *   on      new denials are enforced
 *
 * Resolution: `RBAC_ENFORCE` env var, then the `rbac_enforce` platform
 * setting (admin-editable, cached), then `shadow`.
 *
 * Only decisions that tighten pre-RBAC behavior go through the mode. Checks
 * that replaced an existing role check, the guest-isolation fix, and
 * Restricted project visibility are always enforced.
 */

import { prisma } from '../prisma'

export type RbacMode = 'off' | 'shadow' | 'on'

export const RBAC_MODE_SETTING_KEY = 'rbac_enforce'
const DEFAULT_MODE: RbacMode = 'shadow'
const CACHE_TTL_MS = 30_000

let cached: { mode: RbacMode; at: number } | null = null
let override: RbacMode | null = null

export function parseRbacMode(value: unknown): RbacMode | null {
  return value === 'off' || value === 'shadow' || value === 'on' ? value : null
}

export async function getRbacMode(): Promise<RbacMode> {
  if (override) return override
  const fromEnv = parseRbacMode(process.env.RBAC_ENFORCE)
  if (fromEnv) return fromEnv
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.mode
  let mode = DEFAULT_MODE
  try {
    const row = (await prisma.platformSetting.findUnique({
      where: { key: RBAC_MODE_SETTING_KEY },
    })) as { value: string } | null
    mode = parseRbacMode(row?.value) ?? DEFAULT_MODE
  } catch (err) {
    console.warn('[rbac] could not read enforcement mode, using last value:', (err as Error).message)
    mode = cached?.mode ?? DEFAULT_MODE
  }
  cached = { mode, at: Date.now() }
  return mode
}

/** Drop the cached platform-setting value (call after an admin write). */
export function invalidateRbacMode(): void {
  cached = null
}

/** Test hook: pin the mode regardless of env / settings. Pass null to clear. */
export function _setRbacModeForTests(mode: RbacMode | null): void {
  override = mode
  cached = null
}
