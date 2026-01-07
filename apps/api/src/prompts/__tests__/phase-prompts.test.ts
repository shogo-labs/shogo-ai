import { describe, it, expect } from 'bun:test'

// Test: task-cpbi-006 - Phase Prompt Templates
// Tests for phase-specific system prompt templates that guide Claude toward appropriate skill invocation

describe('phase-prompts', () => {
  // test-cpbi-006-a: phase-prompts.ts exports PHASE_PROMPTS Record
  it('exports PHASE_PROMPTS Record', async () => {
    const { PHASE_PROMPTS } = await import('../phase-prompts')

    expect(PHASE_PROMPTS).toBeDefined()
    expect(typeof PHASE_PROMPTS).toBe('object')
  })

  // test-cpbi-006-b: All 8 phases have prompt templates defined
  it('defines prompt templates for all 8 phases', async () => {
    const { PHASE_PROMPTS, PHASES } = await import('../phase-prompts')

    const expectedPhases = [
      'discovery',
      'analysis',
      'classification',
      'design',
      'spec',
      'testing',
      'implementation',
      'complete'
    ] as const

    // Verify all phases are present
    for (const phase of expectedPhases) {
      expect(PHASE_PROMPTS[phase]).toBeDefined()
      expect(typeof PHASE_PROMPTS[phase]).toBe('string')
      expect(PHASE_PROMPTS[phase].length).toBeGreaterThan(0)
    }

    // Verify exact count of phases
    expect(Object.keys(PHASE_PROMPTS).length).toBe(8)
  })

  // test-cpbi-006-c: Each template includes required guidance sections
  it('includes required guidance sections in each template', async () => {
    const { PHASE_PROMPTS, PHASES } = await import('../phase-prompts')

    // Expected skill mapping for each phase
    const phaseSkillMapping: Record<string, string> = {
      discovery: '/platform-feature-discovery',
      analysis: '/platform-feature-analysis',
      classification: '/platform-feature-classification',
      design: '/platform-feature-design',
      spec: '/platform-feature-spec',
      testing: '/platform-feature-tests',
      implementation: '/platform-feature-implementation',
      complete: '' // complete phase doesn't invoke a skill
    }

    for (const phase of PHASES) {
      const template = PHASE_PROMPTS[phase]

      // (1) phase context description - should mention the phase name
      expect(template.toLowerCase()).toContain(phase.toLowerCase())

      // (2) skill to invoke - all phases except 'complete' should have a skill
      if (phase !== 'complete') {
        const expectedSkill = phaseSkillMapping[phase]
        expect(template).toContain(expectedSkill)
      }

      // (3) expected outcome - should describe what happens
      expect(template.toLowerCase()).toMatch(/outcome|result|complete|captured|generated|created/i)
    }
  })

  // test-cpbi-006-d: Type safety ensures all phases have prompts
  it('provides type safety for phase prompts', async () => {
    const { PHASE_PROMPTS, PHASES } = await import('../phase-prompts')

    // This test verifies the exported types work correctly
    // If Phase type and PHASE_PROMPTS Record don't align, TypeScript would catch it at build time

    // Runtime verification that PHASES array matches Phase type
    const phaseSet = new Set(PHASES)
    expect(phaseSet.size).toBe(8)

    // Verify PHASE_PROMPTS keys match PHASES
    const promptPhases = Object.keys(PHASE_PROMPTS)
    expect(promptPhases.sort()).toEqual([...PHASES].sort())

    // Type guard function should work
    const { isPhase } = await import('../phase-prompts')

    for (const phase of PHASES) {
      expect(isPhase(phase)).toBe(true)
    }

    expect(isPhase('invalid-phase')).toBe(false)
    expect(isPhase('')).toBe(false)
    expect(isPhase(123)).toBe(false)
  })
})
