// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared gate for the hosted e2e backdoor (`/api/internal/e2e/*`).
 *
 * Used by the internal routes and by the signup risk scorer. A request that
 * presents the secret is treated as an automated test signup: it is
 * allowlisted in risk scoring and exempt from the signup domain blocklist.
 *
 * The gate is closed in production unless `SHOGO_E2E_BOOTSTRAP_ENABLED=1` is
 * set, so the secret alone cannot bypass risk controls on the live platform.
 */

import { timingSafeEqual } from 'node:crypto'

export const E2E_BOOTSTRAP_HEADER = 'x-e2e-bootstrap-secret'

export function e2eBootstrapEnabled(): boolean {
  const prod = process.env.NODE_ENV === 'production'
  const override = process.env.SHOGO_E2E_BOOTSTRAP_ENABLED === '1'
  return !prod || override
}

export function e2eBootstrapSecretMatches(header: string | null | undefined): boolean {
  const expected = process.env.SHOGO_E2E_BOOTSTRAP_SECRET
  if (!expected || !header) return false
  const a = Buffer.from(header)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** True only when the backdoor is enabled AND the request carries the secret. */
export function isE2eBootstrapRequest(header: string | null | undefined): boolean {
  return e2eBootstrapEnabled() && e2eBootstrapSecretMatches(header)
}
