/**
 * Shogo Persona Tests
 *
 * Validates that the agent always uses the Shogo persona —
 * no env-var switching, no fallback to a generic default.
 *
 * Run: bun test apps/api/src/__tests__/shogo-persona.test.ts
 */

import { describe, test, expect } from 'bun:test'
import { SHOGO_AGENT_PROMPT } from '../prompts/persona-prompts'
import { buildSystemPrompt, BASE_SYSTEM_PROMPT } from '../server'

describe('Shogo persona', () => {
  test('SHOGO_AGENT_PROMPT identifies as Shogo', () => {
    expect(SHOGO_AGENT_PROMPT).toContain('You are **Shogo**')
  })

  test('SHOGO_AGENT_PROMPT includes template guidance', () => {
    expect(SHOGO_AGENT_PROMPT).toContain('template.copy')
    expect(SHOGO_AGENT_PROMPT).toContain('Templates First')
  })

  test('buildSystemPrompt() always returns Shogo persona + base prompt', () => {
    const prompt = buildSystemPrompt()
    // Must contain the Shogo identity
    expect(prompt).toContain('You are **Shogo**')
    // Must contain the base MCP tool docs
    expect(prompt).toContain(BASE_SYSTEM_PROMPT)
  })

  test('buildSystemPrompt() takes no arguments (no persona switching)', () => {
    // Verify the function signature accepts zero args
    expect(buildSystemPrompt.length).toBe(0)
  })

  test('persona-prompts module does not export persona selection types', () => {
    // These were removed — ensure they don't sneak back in
    const exports = require('../prompts/persona-prompts')
    expect(exports.PERSONAS).toBeUndefined()
    expect(exports.AgentPersona).toBeUndefined()
    expect(exports.isAgentPersona).toBeUndefined()
    expect(exports.PERSONA_PROMPTS).toBeUndefined()
    expect(exports.getPersonaPrompt).toBeUndefined()
  })
})
