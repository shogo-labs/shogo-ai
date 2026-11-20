// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-481 acceptance (runtime half) — the body the API stamps, routed.
 *
 * `WIRE_AUTO_TIERS` and `ENV_AUTO_TIER_MAP` below are byte-identical to what
 * `apps/api/src/__tests__/qa-sho481-auto-cloud-tiers.acceptance.test.ts`
 * asserts a cloud-connected desktop serialises (prod: all three Auto tiers are
 * `4fa677d1…`, Hoshi 2.0). This side feeds them through the gateway's real
 * `parseTurnAutoTiers` → `mergeAutoTierOverrides` → `buildAutoTierMap` →
 * `selectModelForSpawn` chain and asserts a COMPLEX prompt lands on Hoshi, not
 * `claude-sonnet-4-6`.
 *
 * The second case is the control: with the old local-defaults map (premium =
 * Sonnet) the same chain does select Sonnet — which is the `[Auto] → Sonnet
 * 4.6 (COMPLEX…)` the card measured, and why the map's source had to change.
 *
 *   bun test packages/agent-runtime/src/__tests__/qa-sho481-auto-cloud-tiers.acceptance.test.ts
 */
import { describe, expect, test } from 'bun:test'
import { mergeAutoTierOverrides, parseTurnAutoTiers } from '../gateway'
import { autoTierIds, autoTierProviderHints, buildAutoTierMap, selectModelForSpawn } from '../model-router'

const HOSHI_ID = '4fa677d1-9f70-4c4b-9a52-5f0d1c9b6f31'
const SONNET = 'claude-sonnet-4-6'

/** `JSON.stringify(run.autoTiers)` as asserted on the API side (SHO-481). */
const WIRE_AUTO_TIERS =
  `{"economy":{"id":"${HOSHI_ID}","provider":"custom"},` +
  `"standard":{"id":"${HOSHI_ID}","provider":"custom"},` +
  `"premium":{"id":"${HOSHI_ID}","provider":"custom"}}`

/** `AGENT_AUTO_TIER_MAP` for the same turn. */
const ENV_AUTO_TIER_MAP = WIRE_AUTO_TIERS

/** A prompt the router classifies COMPLEX — the tier that went to Sonnet. */
const COMPLEX_PROMPT =
  `Why does this regress, and can we refactor the resolver so the cloud map wins ` +
  `on every surface, including the ones that only read an env var? ${'context '.repeat(70)}`

/** The gateway's Auto block for one turn, without the surrounding I/O. */
function route(bodyAutoTiers: unknown, envMap: string | undefined) {
  const override = mergeAutoTierOverrides(
    parseTurnAutoTiers(bodyAutoTiers),
    parseTurnAutoTiers(envMap ? JSON.parse(envMap) : undefined),
  )
  const tiers = buildAutoTierMap(autoTierIds(override))
  const decision = selectModelForSpawn(
    { prompt: COMPLEX_PROMPT, subagentType: 'main-agent', toolNames: [], contextTokens: 8000 },
    { ceilingModel: tiers.premium, availableModels: tiers },
  )
  return { tiers, decision, hints: autoTierProviderHints(override) }
}

describe('SHO-481 — the desktop Auto turn routes on the cloud map', () => {
  test('a COMPLEX prompt goes to the cloud Hoshi id, not Sonnet', () => {
    const { tiers, decision, hints } = route(JSON.parse(WIRE_AUTO_TIERS), ENV_AUTO_TIER_MAP)

    expect(decision.classifiedTier).toBe('complex')
    expect(tiers.premium).toBe(HOSHI_ID)
    expect(tiers.economy).toBe(HOSHI_ID)
    expect(tiers.standard).toBe(HOSHI_ID)
    expect(decision.selectedModel).toBe(HOSHI_ID)
    expect(decision.selectedModel).not.toBe(SONNET)
    expect(hints[HOSHI_ID]).toBe('custom')
  })

  test('ids-only per-turn tiers inherit the provider from the env map', () => {
    const { hints, decision } = route(
      { economy: HOSHI_ID, standard: HOSHI_ID, premium: HOSHI_ID },
      ENV_AUTO_TIER_MAP,
    )

    expect(hints[HOSHI_ID]).toBe('custom')
    expect(decision.selectedModel).toBe(HOSHI_ID)
  })

  test('control: the old local-defaults map is what selected Sonnet', () => {
    const localDefaults = {
      economy: { id: 'gpt-5.4-nano', provider: 'openai' },
      standard: { id: 'claude-haiku-4-5-20251001', provider: 'anthropic' },
      premium: { id: SONNET, provider: 'anthropic' },
    }

    const { decision } = route(localDefaults, JSON.stringify(localDefaults))

    expect(decision.classifiedTier).toBe('complex')
    expect(decision.selectedModel).toBe(SONNET)
  })
})
