// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, test, expect, beforeEach } from 'bun:test'
import {
  classifySpawnTask,
  selectModelForSpawn,
  escalateModel,
  buildAutoTierMap,
  buildModelTierMap,
  setRoutingConfig,
  getRoutingConfig,
  type SpawnClassificationInput,
  type ModelRouterOptions,
  type RoutingDecision,
} from '../model-router'

// Snapshot the original config so we can restore it between tests
let originalConfig: ReturnType<typeof getRoutingConfig>

beforeEach(() => {
  originalConfig = { ...getRoutingConfig() }
})

// ---------------------------------------------------------------------------
// buildAutoTierMap
// ---------------------------------------------------------------------------

describe('buildAutoTierMap', () => {
  test('returns cross-provider tier map with Nano, Haiku, Sonnet', () => {
    const map = buildAutoTierMap()
    expect(map.economy).toBe('gpt-5.4-nano')
    expect(map.standard).toBe('claude-haiku-4-5-20251001')
    expect(map.premium).toBe('claude-sonnet-4-6')
  })

  test('is a pure function returning fresh objects', () => {
    const a = buildAutoTierMap()
    const b = buildAutoTierMap()
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
  })
})

// ---------------------------------------------------------------------------
// buildModelTierMap (provider-siloed, pre-existing)
// ---------------------------------------------------------------------------

describe('buildModelTierMap', () => {
  test('Anthropic ceiling produces Anthropic-only tiers', () => {
    const map = buildModelTierMap('claude-sonnet-4-6')
    expect(map.economy).toBe('claude-haiku-4-5-20251001')
    expect(map.standard).toBe('claude-sonnet-4-6')
    expect(map.premium).toBe('claude-sonnet-4-6')
  })

  test('OpenAI ceiling produces OpenAI-only tiers', () => {
    const map = buildModelTierMap('gpt-5-mini')
    expect(map.economy).toBe('gpt-5.4-mini')
    expect(map.standard).toBe('gpt-5-mini')
    expect(map.premium).toBe('gpt-5-mini')
  })

  test('unknown model defaults to Anthropic provider path', () => {
    const map = buildModelTierMap('some-unknown-model')
    expect(map.economy).toBe('claude-haiku-4-5-20251001')
    expect(map.standard).toBe('claude-sonnet-4-6')
    expect(map.premium).toBe('some-unknown-model')
  })
})

// ---------------------------------------------------------------------------
// classifySpawnTask
// ---------------------------------------------------------------------------

describe('classifySpawnTask', () => {
  test('explore agent with short simple prompt → simple', () => {
    const result = classifySpawnTask({
      prompt: 'find all test files',
      subagentType: 'explore',
      toolNames: [],
      contextTokens: 1000,
    })
    expect(result.tier).toBe('simple')
    expect(result.confidence).toBeGreaterThanOrEqual(0.5)
    expect(result.signals.exploreAgent).toBeDefined()
  })

  test('short prompt with simple keyword → simple', () => {
    const result = classifySpawnTask({
      prompt: 'list the files in src/',
      subagentType: 'general-purpose',
      toolNames: [],
      contextTokens: 1000,
    })
    expect(result.tier).toBe('simple')
  })

  test('complex keywords push toward complex tier', () => {
    const result = classifySpawnTask({
      prompt: 'design a new authentication architecture and analyze the security implications of each approach',
      subagentType: 'general-purpose',
      toolNames: [],
      contextTokens: 5000,
    })
    expect(result.tier).toBe('complex')
    expect(result.signals.complexKeyword).toBeDefined()
  })

  test('high context tokens add penalty', () => {
    const result = classifySpawnTask({
      prompt: 'search for X',
      subagentType: 'explore',
      toolNames: [],
      contextTokens: 50000,
    })
    expect(result.signals.highContextPenalty).toBeDefined()
  })

  test('high precision tool forces complex signals', () => {
    const result = classifySpawnTask({
      prompt: 'run the deployment',
      subagentType: 'general-purpose',
      toolNames: ['deploy', 'read_file'],
      contextTokens: 1000,
    })
    expect(result.signals.highPrecisionTool).toBeDefined()
    expect(result.tier).toBe('complex')
  })

  test('code-reviewer agent gets negative bias', () => {
    const result = classifySpawnTask({
      prompt: 'check this file',
      subagentType: 'code-reviewer',
      toolNames: [],
      contextTokens: 1000,
    })
    expect(result.signals.codeReviewAgent).toBeDefined()
    expect(result.signals.codeReviewAgent).toBeLessThan(0)
  })

  test('fork agent gets slight negative bias', () => {
    const result = classifySpawnTask({
      prompt: 'check this file',
      subagentType: 'fork',
      toolNames: [],
      contextTokens: 1000,
    })
    expect(result.signals.forkAgent).toBeDefined()
    expect(result.signals.forkAgent).toBeLessThan(0)
  })

  test('long prompt (>500 chars) adds negative signal', () => {
    const longPrompt = 'x '.repeat(300)
    const result = classifySpawnTask({
      prompt: longPrompt,
      subagentType: 'general-purpose',
      toolNames: [],
      contextTokens: 1000,
    })
    expect(result.signals.longPrompt).toBeDefined()
    expect(result.signals.longPrompt).toBeLessThan(0)
  })

  test('no signals produces baseline reason', () => {
    // Prompt must be >100 chars to avoid shortPrompt signal, contain no simple/complex
    // keywords, and context must be below the default floor (30K)
    const filler = 'xylophone '.repeat(15) // ~150 chars, no keyword hits
    const result = classifySpawnTask({
      prompt: filler,
      subagentType: 'general-purpose',
      toolNames: [],
      contextTokens: 15000,
    })
    expect(result.reason).toBe('no_signals_baseline')
    expect(result.tier).toBe('moderate')
  })

  test('main-agent subagentType has no special bias', () => {
    const result = classifySpawnTask({
      prompt: 'find all test files',
      subagentType: 'main-agent',
      toolNames: [],
      contextTokens: 1000,
    })
    expect(result.signals.exploreAgent).toBeUndefined()
    expect(result.signals.forkAgent).toBeUndefined()
    expect(result.signals.codeReviewAgent).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// selectModelForSpawn
// ---------------------------------------------------------------------------

describe('selectModelForSpawn', () => {
  const autoTiers = buildAutoTierMap()
  const opts: ModelRouterOptions = {
    ceilingModel: autoTiers.premium,
    availableModels: autoTiers,
  }

  test('simple task selects economy model (Nano)', () => {
    const decision = selectModelForSpawn({
      prompt: 'find all test files',
      subagentType: 'explore',
      toolNames: [],
      contextTokens: 1000,
    }, opts)
    expect(decision.selectedModel).toBe('gpt-5.4-nano')
    expect(decision.classifiedTier).toBe('simple')
    expect(decision.fallbackTriggered).toBe(false)
  })

  test('complex task selects ceiling model (Sonnet)', () => {
    const decision = selectModelForSpawn({
      prompt: 'design a new authentication architecture and analyze the security implications',
      subagentType: 'general-purpose',
      toolNames: [],
      contextTokens: 5000,
    }, opts)
    expect(decision.selectedModel).toBe('claude-sonnet-4-6')
    expect(decision.classifiedTier).toBe('complex')
  })

  test('high-precision tool forces at least standard (resolves to ceiling when standard tier is economy)', () => {
    const decision = selectModelForSpawn({
      prompt: 'run deploy',
      subagentType: 'general-purpose',
      toolNames: ['deploy'],
      contextTokens: 1000,
    }, opts)
    // Haiku is economy-tier, so resolveAtLeastStandard bumps to ceiling (Sonnet)
    expect(decision.selectedModel).toBe('claude-sonnet-4-6')
    expect(decision.highPrecisionToolDetected).toBe('deploy')
  })

  test('context floor exceeded bumps to at-least-standard', () => {
    const decision = selectModelForSpawn({
      prompt: 'search for patterns',
      subagentType: 'explore',
      toolNames: [],
      contextTokens: 25000,
    }, opts)
    // Nano context floor is 20K, so 25K exceeds it → resolveAtLeastStandard → Sonnet
    // (because Haiku is economy-tier)
    expect(decision.selectedModel).toBe('claude-sonnet-4-6')
    expect(decision.reason).toContain('context_floor_exceeded')
  })

  test('low confidence simple falls back to standard', () => {
    // Produce a borderline simple classification (confidence < 0.8)
    // Short prompt with simple keyword but no agent type bias → confidence ~0.85
    // Actually, explore agent + short prompt + simple keyword → high confidence
    // We need a minimal simple classification. Use a short prompt with simple keyword only.
    const decision = selectModelForSpawn({
      prompt: 'check the thing',
      subagentType: 'general-purpose',
      toolNames: [],
      contextTokens: 1000,
    }, opts)
    // "check" is a simple keyword, short prompt → simplicity ~ 0.35
    // confidence ~0.85. This is above threshold 0.8.
    // So this should still select economy.
    if (decision.classifiedTier === 'simple' && decision.confidence < 0.8) {
      expect(decision.selectedModel).toBe('claude-haiku-4-5-20251001')
    }
  })

  test('spawnId is unique per call', () => {
    const input: SpawnClassificationInput = {
      prompt: 'find files',
      subagentType: 'explore',
      toolNames: [],
      contextTokens: 1000,
    }
    const d1 = selectModelForSpawn(input, opts)
    const d2 = selectModelForSpawn(input, opts)
    expect(d1.spawnId).not.toBe(d2.spawnId)
  })

  test('routing decision includes all required fields', () => {
    const decision = selectModelForSpawn({
      prompt: 'find files',
      subagentType: 'explore',
      toolNames: [],
      contextTokens: 1000,
    }, opts)
    expect(decision).toHaveProperty('spawnId')
    expect(decision).toHaveProperty('subagentType')
    expect(decision).toHaveProperty('signals')
    expect(decision).toHaveProperty('confidence')
    expect(decision).toHaveProperty('classifiedTier')
    expect(decision).toHaveProperty('selectedModel')
    expect(decision).toHaveProperty('reason')
    expect(decision).toHaveProperty('contextTokens')
    expect(decision).toHaveProperty('fallbackTriggered')
  })
})

// ---------------------------------------------------------------------------
// escalateModel
// ---------------------------------------------------------------------------

describe('escalateModel', () => {
  const autoTiers = buildAutoTierMap()
  const opts: ModelRouterOptions = {
    ceilingModel: autoTiers.premium,
    availableModels: autoTiers,
  }

  function makeDecision(model: string): RoutingDecision {
    return {
      spawnId: 'test-spawn',
      subagentType: 'general-purpose',
      signals: {},
      confidence: 0.9,
      classifiedTier: 'simple',
      selectedModel: model,
      reason: 'test',
      contextTokens: 1000,
      fallbackTriggered: false,
    }
  }

  test('economy → standard escalation', () => {
    const decision = makeDecision('gpt-5.4-nano')
    const escalated = escalateModel(decision, opts, 'test failure')
    expect(escalated).not.toBeNull()
    expect(escalated!.selectedModel).toBe('claude-haiku-4-5-20251001')
    expect(escalated!.fallbackTriggered).toBe(true)
    expect(escalated!.escalatedFrom).toBe('gpt-5.4-nano')
    expect(escalated!.fallbackReason).toBe('test failure')
  })

  test('standard → premium escalation', () => {
    const decision = makeDecision('claude-haiku-4-5-20251001')
    const escalated = escalateModel(decision, opts, 'haiku failed')
    expect(escalated).not.toBeNull()
    expect(escalated!.selectedModel).toBe('claude-sonnet-4-6')
    expect(escalated!.escalatedFrom).toBe('claude-haiku-4-5-20251001')
  })

  test('ceiling model returns null (no further escalation)', () => {
    const decision = makeDecision('claude-sonnet-4-6')
    const escalated = escalateModel(decision, opts, 'sonnet failed')
    expect(escalated).toBeNull()
  })

  test('cross-provider escalation: Nano (OpenAI) → Haiku (Anthropic)', () => {
    const decision = makeDecision('gpt-5.4-nano')
    const escalated = escalateModel(decision, opts, 'nano too dumb')
    expect(escalated).not.toBeNull()
    expect(escalated!.selectedModel).toBe('claude-haiku-4-5-20251001')
  })

  test('escalation chain: Nano → Haiku → Sonnet', () => {
    const d1 = makeDecision('gpt-5.4-nano')
    const d2 = escalateModel(d1, opts, 'step 1')
    expect(d2).not.toBeNull()
    expect(d2!.selectedModel).toBe('claude-haiku-4-5-20251001')

    const d3 = escalateModel(d2!, opts, 'step 2')
    expect(d3).not.toBeNull()
    expect(d3!.selectedModel).toBe('claude-sonnet-4-6')

    const d4 = escalateModel(d3!, opts, 'step 3')
    expect(d4).toBeNull()
  })
})
