// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Integration tests for subagent model routing with Auto mode.
 *
 * These tests verify the routing logic at the function level, exercising
 * selectModelForSpawn + buildAutoTierMap + escalateModel together in
 * scenarios that mirror real subagent spawns.
 */

import { describe, test, expect } from 'bun:test'
import {
  selectModelForSpawn,
  escalateModel,
  buildAutoTierMap,
  type ModelRouterOptions,
  type SpawnClassificationInput,
} from '../model-router'
import { inferProviderFromModel } from '@shogo/model-catalog'

const autoTiers = buildAutoTierMap()
const autoOpts: ModelRouterOptions = {
  ceilingModel: autoTiers.premium,
  availableModels: autoTiers,
}

// ---------------------------------------------------------------------------
// Cross-provider routing
// ---------------------------------------------------------------------------

describe('subagent auto routing — cross-provider model selection', () => {
  test('simple explore task routes to Nano (OpenAI)', () => {
    const decision = selectModelForSpawn({
      prompt: 'find all .tsx files in src/',
      subagentType: 'explore',
      toolNames: ['read_file', 'glob', 'grep'],
      contextTokens: 5000,
    }, autoOpts)

    expect(decision.selectedModel).toBe('gpt-5.4-nano')
    expect(inferProviderFromModel(decision.selectedModel)).toBe('openai')
  })

  test('moderate task routes to Haiku (Anthropic)', () => {
    const decision = selectModelForSpawn({
      prompt: 'xyzzy neutral prompt that triggers no keywords',
      subagentType: 'general-purpose',
      toolNames: [],
      contextTokens: 15000,
    }, autoOpts)

    expect(decision.selectedModel).toBe('claude-haiku-4-5-20251001')
    expect(inferProviderFromModel(decision.selectedModel)).toBe('anthropic')
  })

  test('complex task routes to Sonnet (Anthropic)', () => {
    const decision = selectModelForSpawn({
      prompt: 'refactor the authentication system to support OAuth2 and analyze security implications of each strategy',
      subagentType: 'general-purpose',
      toolNames: ['exec', 'edit_file'],
      contextTokens: 40000,
    }, autoOpts)

    expect(decision.selectedModel).toBe('claude-sonnet-4-6')
    expect(inferProviderFromModel(decision.selectedModel)).toBe('anthropic')
  })
})

// ---------------------------------------------------------------------------
// Provider inference consistency
// ---------------------------------------------------------------------------

describe('subagent auto routing — provider inference matches routed model', () => {
  const scenarios: Array<{ name: string; input: SpawnClassificationInput }> = [
    {
      name: 'quick file search',
      input: { prompt: 'search for TODO comments', subagentType: 'explore', toolNames: [], contextTokens: 2000 },
    },
    {
      name: 'code review',
      input: { prompt: 'review this PR for security issues', subagentType: 'code-reviewer', toolNames: [], contextTokens: 10000 },
    },
    {
      name: 'general task with high context',
      input: { prompt: 'summarize', subagentType: 'general-purpose', toolNames: [], contextTokens: 50000 },
    },
  ]

  for (const { name, input } of scenarios) {
    test(`${name}: inferred provider matches the model's actual provider`, () => {
      const decision = selectModelForSpawn(input, autoOpts)
      const inferredProvider = inferProviderFromModel(decision.selectedModel)

      // The provider should be one of the known providers, not a random fallback
      expect(['openai', 'anthropic', 'google']).toContain(inferredProvider)

      // Nano → openai, Haiku/Sonnet → anthropic
      if (decision.selectedModel === 'gpt-5.4-nano') {
        expect(inferredProvider).toBe('openai')
      } else if (decision.selectedModel.startsWith('claude-')) {
        expect(inferredProvider).toBe('anthropic')
      }
    })
  }
})

// ---------------------------------------------------------------------------
// Escalation across providers
// ---------------------------------------------------------------------------

describe('subagent auto routing — cross-provider escalation', () => {
  test('Nano failure escalates to Haiku (cross-provider)', () => {
    const initial = selectModelForSpawn({
      prompt: 'list files in /tmp',
      subagentType: 'explore',
      toolNames: [],
      contextTokens: 1000,
    }, autoOpts)

    expect(initial.selectedModel).toBe('gpt-5.4-nano')

    const escalated = escalateModel(initial, autoOpts, 'Nano returned garbage')
    expect(escalated).not.toBeNull()
    expect(escalated!.selectedModel).toBe('claude-haiku-4-5-20251001')
    expect(inferProviderFromModel(escalated!.selectedModel)).toBe('anthropic')
    expect(escalated!.escalatedFrom).toBe('gpt-5.4-nano')
  })

  test('Haiku failure escalates to Sonnet', () => {
    const initial = selectModelForSpawn({
      prompt: 'neutral task',
      subagentType: 'general-purpose',
      toolNames: [],
      contextTokens: 15000,
    }, autoOpts)

    // If this happens to be Haiku
    if (initial.selectedModel === 'claude-haiku-4-5-20251001') {
      const escalated = escalateModel(initial, autoOpts, 'Haiku failed')
      expect(escalated).not.toBeNull()
      expect(escalated!.selectedModel).toBe('claude-sonnet-4-6')
    }
  })

  test('Sonnet failure has no further escalation', () => {
    const initial = selectModelForSpawn({
      prompt: 'design and implement a complex distributed system with security analysis',
      subagentType: 'general-purpose',
      toolNames: ['exec'],
      contextTokens: 60000,
    }, autoOpts)

    if (initial.selectedModel === 'claude-sonnet-4-6') {
      const escalated = escalateModel(initial, autoOpts, 'Sonnet failed')
      expect(escalated).toBeNull()
    }
  })

  test('full escalation chain crosses providers', () => {
    const step1 = selectModelForSpawn({
      prompt: 'find readme files',
      subagentType: 'explore',
      toolNames: [],
      contextTokens: 1000,
    }, autoOpts)

    expect(step1.selectedModel).toBe('gpt-5.4-nano')

    const step2 = escalateModel(step1, autoOpts, 'nano failed')!
    expect(step2.selectedModel).toBe('claude-haiku-4-5-20251001')
    expect(inferProviderFromModel(step2.selectedModel)).toBe('anthropic')

    const step3 = escalateModel(step2, autoOpts, 'haiku failed')!
    expect(step3.selectedModel).toBe('claude-sonnet-4-6')
    expect(inferProviderFromModel(step3.selectedModel)).toBe('anthropic')

    const step4 = escalateModel(step3, autoOpts, 'sonnet failed')
    expect(step4).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Main agent routing (simulates gateway behavior)
// ---------------------------------------------------------------------------

describe('main agent auto routing', () => {
  test('short user message routes to economy tier', () => {
    const decision = selectModelForSpawn({
      prompt: 'list my files',
      subagentType: 'main-agent',
      toolNames: [],
      contextTokens: 2000,
    }, autoOpts)

    expect(decision.classifiedTier).toBe('simple')
    expect(decision.selectedModel).toBe('gpt-5.4-nano')
  })

  test('complex user message routes to premium tier', () => {
    const decision = selectModelForSpawn({
      prompt: 'please refactor the entire authentication module and design a new strategy pattern for providers',
      subagentType: 'main-agent',
      toolNames: [],
      contextTokens: 30000,
    }, autoOpts)

    expect(decision.classifiedTier).toBe('complex')
    expect(decision.selectedModel).toBe('claude-sonnet-4-6')
  })

  test('model stays consistent for the same input (deterministic)', () => {
    const input: SpawnClassificationInput = {
      prompt: 'help me debug this error',
      subagentType: 'main-agent',
      toolNames: [],
      contextTokens: 10000,
    }

    const d1 = selectModelForSpawn(input, autoOpts)
    const d2 = selectModelForSpawn(input, autoOpts)

    expect(d1.selectedModel).toBe(d2.selectedModel)
    expect(d1.classifiedTier).toBe(d2.classifiedTier)
    expect(d1.confidence).toBe(d2.confidence)
  })
})
