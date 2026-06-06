// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Resolve admin-configured Auto-mode tier overrides into the
 * `AGENT_AUTO_TIER_MAP` env var consumed by the agent runtime gateway.
 *
 * Admin stores a raw model id per tier (`getAutoTierOverrides()`), which may be
 * a public `/v1` alias such as `hoshi-1.0`. The gateway and AI proxy cannot
 * resolve public aliases, so we resolve each alias to its backing model id here
 * (server-side, where the public-model snapshot lives) and pair it with a
 * provider hint. The serialized shape matches the gateway's parser:
 *
 *   { economy?: { id, provider? }, standard?: {...}, premium?: {...} }
 */
import { getAutoTierOverrides, inferProviderFromModel } from '@shogo/model-catalog'
import { resolvePublicModelSync } from '../../services/public-models.service'

interface AutoTierEntry {
  id: string
  provider?: string
}

/**
 * Build the `AGENT_AUTO_TIER_MAP` JSON string from the in-memory admin
 * overrides, resolving public aliases to backing model ids. Returns undefined
 * when no tiers are configured (so callers omit the env var and the gateway
 * keeps its hardcoded defaults).
 */
export function buildAutoTierMapEnv(): string | undefined {
  const overrides = getAutoTierOverrides()
  const out: Record<'economy' | 'standard' | 'premium', AutoTierEntry> = {} as any
  let any = false

  for (const tier of ['economy', 'standard', 'premium'] as const) {
    const raw = overrides[tier]?.trim()
    if (!raw) continue
    // Resolve a public alias (e.g. `hoshi-1.0`) to its internal backing id so
    // the runtime/AI proxy can route it; non-aliases pass through unchanged.
    const alias = resolvePublicModelSync(raw)
    const id = alias?.backingModelId?.trim() || raw
    out[tier] = { id, provider: inferProviderFromModel(id, 'custom') }
    any = true
  }

  return any ? JSON.stringify(out) : undefined
}
