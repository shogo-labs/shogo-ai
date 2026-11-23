// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure policy function for the daily abuse check (SHO-459).
 * No database access — everything is unit-testable with no mocks.
 */

import {
  ABUSE_AUTO_BAN_SEVERITY,
  ABUSE_AUTO_BAN_MIN_TURNS,
  ABUSE_FLAG_SEVERITY,
  type AbuseConfidence,
} from '../../config/abuse-config'
import type { JudgeVerdict } from './judge'

export type PolicyDecision = 'ban' | 'flag' | 'none'

export interface PolicyInput {
  verdict: JudgeVerdict
  /** True when the account still has no active/trialing/past_due subscription at decision time. */
  isFreeAccount: boolean
}

/**
 * Decide what to do with a single judge verdict.
 *
 * Auto-ban only when ALL of:
 *   - still free at decision time
 *   - severity ≥ ABUSE_AUTO_BAN_SEVERITY
 *   - confidence = 'high'
 *   - evidence covers ≥ ABUSE_AUTO_BAN_MIN_TURNS distinct turnIds
 *
 * Flag when severity ≥ ABUSE_FLAG_SEVERITY (paid accounts included).
 * Everything else: none.
 */
export function applyPolicy(input: PolicyInput): PolicyDecision {
  const { verdict, isFreeAccount } = input
  if (verdict.severity < ABUSE_FLAG_SEVERITY) return 'none'
  if (
    isFreeAccount &&
    verdict.severity >= ABUSE_AUTO_BAN_SEVERITY &&
    verdict.confidence === 'high' &&
    verdict.turnIds.length >= ABUSE_AUTO_BAN_MIN_TURNS
  ) {
    return 'ban'
  }
  return 'flag'
}
