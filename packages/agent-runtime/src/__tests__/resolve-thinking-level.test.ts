// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Precedence tests for resolveThinkingLevel — the per-model reasoning effort
 * (config.model.thinkingLevel, set by the picker from each model's admin
 * reasoningEffort) must win over the AGENT_THINKING_LEVEL env default, while
 * the `basic` agent-mode override and env fallback are preserved.
 *
 * Run: bun test packages/agent-runtime/src/__tests__/resolve-thinking-level.test.ts
 */
import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { resolveThinkingLevel } from '../gateway'

const savedEnv = process.env.AGENT_THINKING_LEVEL
const savedBasic = process.env.AGENT_BASIC_THINKING_LEVEL
const savedLocal = process.env.LOCAL_LLM_BASE_URL

beforeEach(() => {
  delete process.env.LOCAL_LLM_BASE_URL
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env.AGENT_THINKING_LEVEL
  else process.env.AGENT_THINKING_LEVEL = savedEnv
  if (savedBasic === undefined) delete process.env.AGENT_BASIC_THINKING_LEVEL
  else process.env.AGENT_BASIC_THINKING_LEVEL = savedBasic
  if (savedLocal === undefined) delete process.env.LOCAL_LLM_BASE_URL
  else process.env.LOCAL_LLM_BASE_URL = savedLocal
})

describe('resolveThinkingLevel', () => {
  test("config model thinkingLevel beats the env default", () => {
    process.env.AGENT_THINKING_LEVEL = 'low'
    expect(resolveThinkingLevel(undefined, 'high')).toBe('high')
  })

  test('an explicit per-turn effort beats the configured default', () => {
    process.env.AGENT_THINKING_LEVEL = 'low'
    expect(resolveThinkingLevel(undefined, 'medium', 'xhigh')).toBe('xhigh')
  })

  test('invalid per-turn values fall back to the configured model default', () => {
    expect(resolveThinkingLevel(undefined, 'high', 'turbo')).toBe('high')
  })

  test('Auto ignores a per-turn effort override', () => {
    expect(resolveThinkingLevel('auto', 'medium', 'xhigh')).toBe('medium')
  })

  test('basic mode and local LLM behavior still take precedence', () => {
    process.env.AGENT_BASIC_THINKING_LEVEL = 'low'
    expect(resolveThinkingLevel('basic', 'high', 'xhigh')).toBe('low')
    process.env.LOCAL_LLM_BASE_URL = 'http://localhost:11434'
    expect(resolveThinkingLevel(undefined, 'high', 'xhigh')).toBe('off')
  })

  test('falls back to env then medium when no config level', () => {
    process.env.AGENT_THINKING_LEVEL = 'xhigh'
    expect(resolveThinkingLevel(undefined, undefined)).toBe('xhigh')
    delete process.env.AGENT_THINKING_LEVEL
    expect(resolveThinkingLevel(undefined, undefined)).toBe('medium')
  })

  test('basic agent mode override takes precedence over config level', () => {
    process.env.AGENT_BASIC_THINKING_LEVEL = 'low'
    // Even with a config thinkingLevel, basic mode uses its dedicated override.
    expect(resolveThinkingLevel('basic', 'high')).toBe('low')
    expect(resolveThinkingLevel('basic', 'high', 'xhigh')).toBe('low')
  })

  test('basic mode defaults to medium without an env override', () => {
    delete process.env.AGENT_BASIC_THINKING_LEVEL
    expect(resolveThinkingLevel('basic', undefined)).toBe('medium')
  })
})
