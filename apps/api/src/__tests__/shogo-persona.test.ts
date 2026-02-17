/**
 * Shogo Persona Tests
 *
 * Validates that the project-runtime agent always identifies as Shogo
 * and includes template guidance. The Shogo system prompt lives solely
 * in packages/project-runtime/src/system-prompt.ts — there is no
 * platform-level persona or prompt.
 *
 * Run: bun test apps/api/src/__tests__/shogo-persona.test.ts
 */

import { describe, test, expect } from 'bun:test'
import { buildSystemPrompt } from '../../../../packages/project-runtime/src/system-prompt'

describe('Shogo persona (project-runtime)', () => {
  const prompt = buildSystemPrompt('/app/project')

  test('identifies as Shogo', () => {
    expect(prompt).toContain('Shogo')
    expect(prompt).toContain('AI assistant for building applications')
  })

  test('explicitly overrides Claude identity', () => {
    expect(prompt).toContain('Never say')
    expect(prompt).toContain('Shogo')
  })

  test('includes template guidance', () => {
    expect(prompt).toContain('template')
    expect(prompt).toContain('template.copy')
    expect(prompt).toContain('Template Selection')
  })

  test('includes project directory in prompt', () => {
    expect(prompt).toContain('/app/project')
  })
})

describe('no platform-level persona', () => {
  test('persona-prompts.ts does not exist', async () => {
    let imported = false
    try {
      await import('../prompts/persona-prompts')
      imported = true
    } catch {
      imported = false
    }
    expect(imported).toBe(false)
  })
})
