// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * How many project previews this host keeps warm — the single source of truth.
 *
 * The manager evicts down to this number, the boot prewarm warms no more than
 * it, and the cloud keep-warm controller pings exactly this many. It lives in
 * its own dependency-free module so all three can import it without pulling in
 * the heavy runtime manager (`workspace-keep-warm.ts` is loaded on cloud too).
 *
 * Kept at a fixed 3, a 128 GB desktop with a board of ~8 agents evicted an idle
 * preview on nearly every chat switch — 547 evictions and 598 fresh spawns in
 * ten days, the cold start landing on the user every time (SHO-606). Like the
 * background pool cap (SHO-143), this is a POLICY number: it says how many
 * previews may stay warm, not how many the RAM can carry. Actual memory is
 * bounded by the free-memory guard in `host-memory.ts`, which evicts idle
 * previews one at a time while the host is low.
 */

/** The desktop's host classification (`apps/desktop/src/runtime-memory.ts`). */
export type HostTier = 'low' | 'standard' | 'high'

/**
 * Policy numbers per tier. `high` starts at 32 GB / 8 cores — enough for 10
 * previews at ~1–1.5 GB each alongside background runtimes; on a 32 GB box the
 * memory guard is what actually trims the set, which is intended.
 */
export const PREVIEW_MAX_BY_TIER: Record<HostTier, number> = {
  low: 1,
  standard: 3,
  high: 10,
}

/** Used when no tier is set: cloud, metal and docker hosts keep today's 3. */
export const DEFAULT_PREVIEW_MAX = PREVIEW_MAX_BY_TIER.standard

export interface PreviewCapDecision {
  max: number
  /** Where `max` came from, for the one-line boot log. */
  source: 'env' | 'tier' | 'default'
  /** The tier that decided it (only when `source` is `tier`). */
  tier?: HostTier
}

function parseTier(raw: string | undefined): HostTier | null {
  return raw === 'low' || raw === 'standard' || raw === 'high' ? raw : null
}

/**
 * The warm-preview cap and its provenance. A positive-int
 * `WORKSPACE_PREVIEW_MAX` wins outright; otherwise `SHOGO_HOST_TIER` decides;
 * otherwise the unset default applies. Junk or non-positive values fall
 * through to the next source rather than disabling the cap.
 */
export function resolveWorkspacePreviewCap(
  env: Record<string, string | undefined> = process.env,
): PreviewCapDecision {
  const explicit = parseInt(env.WORKSPACE_PREVIEW_MAX || '', 10)
  if (Number.isFinite(explicit) && explicit > 0) return { max: explicit, source: 'env' }
  const tier = parseTier(env.SHOGO_HOST_TIER)
  if (tier) return { max: PREVIEW_MAX_BY_TIER[tier], source: 'tier', tier }
  return { max: DEFAULT_PREVIEW_MAX, source: 'default' }
}

/** The number alone — every reader that does not log its provenance. */
export function resolveWorkspacePreviewMax(
  env: Record<string, string | undefined> = process.env,
): number {
  return resolveWorkspacePreviewCap(env).max
}
