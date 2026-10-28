// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A project's model is owned by the database (`AgentConfig.modelName`) and
 * mirrored into `config.json` for the turns that don't go through the channel
 * dispatcher. These tests pin the mapping — especially the legacy default,
 * which means "nobody chose" and must resolve to Auto rather than pinning the
 * runtime to Haiku (SHO-145).
 *
 *   bun test packages/agent-runtime/src/__tests__/agent-model-config.test.ts
 */

import { describe, test, expect } from 'bun:test'
import { agentModelAliasForConfig, mergeAgentModelIntoConfig } from '../agent-model-config'

describe('agentModelAliasForConfig', () => {
  test('a concrete model name is used as-is', () => {
    expect(agentModelAliasForConfig('8947628a-0000-0000-0000-000000000000')).toBe('8947628a-0000-0000-0000-000000000000')
    expect(agentModelAliasForConfig('  claude-opus-5-5 ')).toBe('claude-opus-5-5')
  })

  test('auto and the legacy default both mean Auto', () => {
    expect(agentModelAliasForConfig('auto')).toBe('auto')
    expect(agentModelAliasForConfig('claude-haiku-4-5')).toBe('auto')
  })

  test('a missing or blank column expresses no choice', () => {
    expect(agentModelAliasForConfig(undefined)).toBeNull()
    expect(agentModelAliasForConfig(null)).toBeNull()
    expect(agentModelAliasForConfig('')).toBeNull()
    expect(agentModelAliasForConfig('   ')).toBeNull()
    expect(agentModelAliasForConfig(42)).toBeNull()
  })
})

describe('mergeAgentModelIntoConfig', () => {
  const base = { model: { provider: 'anthropic', name: 'auto' }, webEnabled: true }

  test('applies a model change and leaves the rest of the file alone', () => {
    const { config, changed } = mergeAgentModelIntoConfig(base, {
      modelName: 'claude-opus-5-5',
      modelProvider: 'anthropic',
    })
    expect(changed).toBe(true)
    expect(config.model).toEqual({ provider: 'anthropic', name: 'claude-opus-5-5' })
    expect(config.webEnabled).toBe(true)
  })

  test('keeps model.thinkingLevel and other model keys', () => {
    const withThinking = { model: { provider: 'anthropic', name: 'auto', thinkingLevel: 'high' } }
    const { config } = mergeAgentModelIntoConfig(withThinking, { modelName: 'auto', modelProvider: 'anthropic' })
    expect(config.model).toEqual({ provider: 'anthropic', name: 'auto', thinkingLevel: 'high' })
  })

  test('the legacy default resolves to Auto, not to Haiku', () => {
    const { config } = mergeAgentModelIntoConfig(base, { modelName: 'claude-haiku-4-5' })
    expect(config.model.name).toBe('auto')
  })

  test('no change means the very same object comes back (no pointless file write)', () => {
    const { config, changed } = mergeAgentModelIntoConfig(base, { modelName: 'auto', modelProvider: 'anthropic' })
    expect(changed).toBe(false)
    expect(config).toBe(base)
  })

  test('a missing agent block changes nothing', () => {
    expect(mergeAgentModelIntoConfig(base, null).changed).toBe(false)
    expect(mergeAgentModelIntoConfig(base, undefined).config).toBe(base)
    expect(mergeAgentModelIntoConfig(base, {}).changed).toBe(false)
  })

  test('a name without a provider still lands', () => {
    const { config, changed } = mergeAgentModelIntoConfig(base, { modelName: 'gpt-6-luna' })
    expect(changed).toBe(true)
    expect(config.model).toEqual({ provider: 'anthropic', name: 'gpt-6-luna' })
  })

  test('a provider-only change lands too', () => {
    const { config, changed } = mergeAgentModelIntoConfig(
      { model: { provider: 'anthropic', name: 'custom-uuid' } },
      { modelProvider: 'openai' },
    )
    expect(changed).toBe(true)
    expect(config.model).toEqual({ provider: 'openai', name: 'custom-uuid' })
  })
})
