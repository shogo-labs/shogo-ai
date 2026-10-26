// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Guards the adaptive-thinking allowlist against the drift behind the
 * 2026-08-16 (Opus 5) and 2026-10-15 (Haiku 5.5) incidents: a model shipped
 * in the catalog but missing from one copy of the allowlist kept the legacy
 * `thinking.type: "enabled"` block, and Anthropic 400'd every turn.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { MODEL_CATALOG, type ModelEntry } from '../models'
import { ADAPTIVE_THINKING_MODEL_MARKERS, supportsAdaptiveThinking } from '../thinking'

const anthropic = (Object.values(MODEL_CATALOG) as ModelEntry[]).filter((m) => m.provider === 'anthropic')

/**
 * Markers in the installed (patched) pi-ai `supportsAdaptiveThinking` — the
 * function isn't exported, so read it from the module source the runtime loads.
 */
function piAiMarkers(): string[] {
  const source = readFileSync(Bun.resolveSync('@mariozechner/pi-ai/anthropic', import.meta.dir), 'utf8')
  const body = source.match(/function supportsAdaptiveThinking\([^)]*\)\s*\{([\s\S]*?)\n\}/)?.[1]
  expect(body).toBeDefined()
  return [...body!.matchAll(/\.includes\("([^"]+)"\)/g)].map((match) => match[1])
}

describe('adaptive thinking allowlist', () => {
  test('every Anthropic catalog entry declares thinkingApi', () => {
    const missing = anthropic.filter((m) => !m.thinkingApi).map((m) => m.id)
    expect(missing).toEqual([])
  })

  test("each entry's thinkingApi matches supportsAdaptiveThinking(apiModel)", () => {
    for (const m of anthropic) {
      expect({ id: m.id, adaptive: supportsAdaptiveThinking(m.apiModel) }).toEqual({
        id: m.id,
        adaptive: m.thinkingApi === 'adaptive',
      })
    }
  })

  // Fails until patches/@mariozechner%2Fpi-ai@0.73.1.patch is updated (then `bun install`).
  test('pi-ai patched allowlist matches ADAPTIVE_THINKING_MODEL_MARKERS', () => {
    expect(piAiMarkers().sort()).toEqual([...ADAPTIVE_THINKING_MODEL_MARKERS].sort())
  })

  test('matches dated and DB-only upstream names, not older generations', () => {
    expect(supportsAdaptiveThinking('claude-opus-4-8')).toBe(true)
    expect(supportsAdaptiveThinking('claude-haiku-5-5-20261007')).toBe(true)
    expect(supportsAdaptiveThinking('claude-haiku-4-5-20251001')).toBe(false)
    expect(supportsAdaptiveThinking('claude-sonnet-4-5-20250929')).toBe(false)
  })
})
