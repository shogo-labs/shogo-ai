// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Auto routing floor (#1082): a `floorTier` keeps a turn off the economy tier
 * unless the session ceiling is economy.
 */
import { describe, expect, test } from 'bun:test'
import { buildAutoTierMap, selectModelForSpawn, type SpawnClassificationInput } from '../model-router'

const tiers = { economy: 'claude-haiku-4-5', standard: 'claude-sonnet-4-6', premium: 'claude-opus-4-6' }

const shortFix: SpawnClassificationInput = {
  prompt: 'fix the max tokens bug in the RAG config',
  subagentType: 'main-agent',
  toolNames: [],
  contextTokens: 2000,
}

describe('model router floorTier', () => {
  test('a short "fix" prompt classifies as simple and routes to economy without a floor', () => {
    const d = selectModelForSpawn(shortFix, { ceilingModel: tiers.premium, availableModels: tiers })
    expect(d.classifiedTier).toBe('simple')
    expect(d.selectedModel).toBe(tiers.economy)
  })

  test("floorTier 'standard' bumps economy to standard and says so", () => {
    const base = selectModelForSpawn(shortFix, { ceilingModel: tiers.premium, availableModels: tiers })
    const d = selectModelForSpawn(shortFix, { ceilingModel: tiers.premium, availableModels: tiers, floorTier: 'standard' })
    expect(d.selectedModel).toBe(tiers.standard)
    expect(d.reason).toBe(`${base.reason}+floor:standard`)
  })

  test('an economy ceiling always wins', () => {
    const d = selectModelForSpawn(shortFix, { ceilingModel: tiers.economy, availableModels: tiers, floorTier: 'standard' })
    expect(d.selectedModel).toBe(tiers.economy)
    expect(d.reason).not.toContain('+floor')
  })

  test('no effect when the decision is already standard or premium', () => {
    const complex: SpawnClassificationInput = {
      prompt: `Architect and implement a multi-service migration across the whole codebase, refactor the database layer, and design the new event pipeline. ${'Consider every subsystem carefully. '.repeat(20)}`,
      subagentType: 'main-agent',
      toolNames: [],
      contextTokens: 2000,
    }
    const without = selectModelForSpawn(complex, { ceilingModel: tiers.premium, availableModels: tiers })
    const withFloor = selectModelForSpawn(complex, { ceilingModel: tiers.premium, availableModels: tiers, floorTier: 'standard' })
    expect(without.selectedModel).not.toBe(tiers.economy)
    expect(withFloor).toMatchObject({ selectedModel: without.selectedModel, reason: without.reason })
  })

  test('no effect when floorTier is undefined', () => {
    const d = selectModelForSpawn(shortFix, { ceilingModel: tiers.premium, availableModels: tiers, floorTier: undefined })
    expect(d.selectedModel).toBe(tiers.economy)
  })

  test('the context-floor and high-precision paths stay at standard or above', () => {
    const big = { ...shortFix, contextTokens: 10_000_000 }
    const ctx = selectModelForSpawn(big, { ceilingModel: tiers.premium, availableModels: tiers, floorTier: 'standard' })
    expect(ctx.selectedModel).not.toBe(tiers.economy)
    const hp = selectModelForSpawn({ ...shortFix, toolNames: ['exec'] }, { ceilingModel: tiers.premium, availableModels: tiers, floorTier: 'standard' })
    expect(hp.selectedModel).not.toBe(tiers.economy)
  })

  test("end to end: a 'standard' floor lifts economy, no floor keeps it", () => {
    const plan = selectModelForSpawn(shortFix, { ceilingModel: tiers.premium, availableModels: tiers, floorTier: 'standard' })
    const agent = selectModelForSpawn(shortFix, { ceilingModel: tiers.premium, availableModels: tiers, floorTier: undefined })
    expect(plan.selectedModel).toBe(tiers.standard)
    expect(agent.selectedModel).toBe(tiers.economy)
  })

  test('end to end with the default Auto tier map', () => {
    const auto = buildAutoTierMap()
    const plan = selectModelForSpawn(shortFix, { ceilingModel: auto.premium, availableModels: auto, floorTier: 'standard' })
    expect(plan.selectedModel).toBe(auto.standard)
  })
})
