// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Named constants for the daily abuse check (SHO-459).
 * Keep these next to signup-risk-config.ts so both policy files
 * are visible in one place.
 */

/** Auto-ban only when severity meets or exceeds this. */
export const ABUSE_AUTO_BAN_SEVERITY = 80

/** Minimum number of distinct turn ids the evidence must cover to auto-ban. */
export const ABUSE_AUTO_BAN_MIN_TURNS = 2

/** Store a flag (not auto-ban) when severity meets or exceeds this. */
export const ABUSE_FLAG_SEVERITY = 40

/** Maximum candidates considered per daily run (highest score first). */
export const ABUSE_CANDIDATE_CAP = 200

/** Minimum free accounts sharing a property to form a cluster. */
export const ABUSE_CLUSTER_MIN_SIZE = 5

/** Cluster membership window: accounts created within this many hours of each other. */
export const ABUSE_CLUSTER_WINDOW_HOURS = 48

/** Maximum turns included in a single judge call per candidate. */
export const ABUSE_JUDGE_MAX_TURNS = 60

/** How many days back the judge looks for turns on each candidate (rolling window). */
export const ABUSE_JUDGE_WINDOW_DAYS = 7

/** Tail chars of assistantText included in each turn for the judge. */
export const ABUSE_JUDGE_ASSISTANT_TAIL = 1_500

/** Stored evidence quote limit per turn. */
export const ABUSE_EVIDENCE_QUOTE_LIMIT = 300

export type AbuseCategory =
  | 'offensive_third_party'
  | 'account_farming'
  | 'credit_relay'
  | 'license_circumvention'
  | 'fraud'

export type AbuseConfidence = 'low' | 'medium' | 'high'
export type AbuseFlagStatus = 'flagged' | 'banned' | 'cleared'
