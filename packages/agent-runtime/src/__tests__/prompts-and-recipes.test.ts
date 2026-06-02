// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Greenfield sweep for the three never-loaded constant/data modules:
 *   canvas-v2-prompt.ts, optimized-prompts.ts, agent-recipes.ts
 * They are pure exported constants + one data array; importing executes every
 * assignment line. Assertions validate structural integrity + key markers.
 */
import { describe, test, expect } from 'bun:test'
import { CANVAS_V2_GUIDE, CANVAS_V2_BACKEND_GUIDE } from '../canvas-v2-prompt'
import {
  OPTIMIZED_CANVAS_EXAMPLES,
  OPTIMIZED_MEMORY_GUIDE,
  SELF_EVOLUTION_GUIDE,
  OPTIMIZED_PERSONALITY_GUIDE,
  OPTIMIZED_TOOL_PLANNING_GUIDE,
  OPTIMIZED_CONSTRAINT_AWARENESS_GUIDE,
  OPTIMIZED_SESSION_SUMMARY_GUIDE,
  OPTIMIZED_SKILL_MATCHING_GUIDE,
  OPTIMIZED_MCP_DISCOVERY_GUIDE,
  BROWSER_TOOL_GUIDE,
} from '../optimized-prompts'
import {
  AGENT_RECIPES,
  RECIPE_CATEGORIES,
  type AgentRecipe,
  type RecipeCategory,
} from '../agent-recipes'

describe('canvas-v2-prompt constants', () => {
  test('CANVAS_V2_GUIDE is a populated frontend guide', () => {
    expect(typeof CANVAS_V2_GUIDE).toBe('string')
    expect(CANVAS_V2_GUIDE.length).toBeGreaterThan(500)
    expect(CANVAS_V2_GUIDE).toContain('Frontend App Reference')
    expect(CANVAS_V2_GUIDE).toContain('@/components/ui/')
  })
  test('CANVAS_V2_BACKEND_GUIDE is a populated backend guide', () => {
    expect(typeof CANVAS_V2_BACKEND_GUIDE).toBe('string')
    expect(CANVAS_V2_BACKEND_GUIDE.length).toBeGreaterThan(200)
    expect(CANVAS_V2_BACKEND_GUIDE).toContain('Backend')
  })
})

describe('optimized-prompts constants', () => {
  const guides: Array<[string, string]> = [
    ['OPTIMIZED_MEMORY_GUIDE', OPTIMIZED_MEMORY_GUIDE],
    ['SELF_EVOLUTION_GUIDE', SELF_EVOLUTION_GUIDE],
    ['OPTIMIZED_PERSONALITY_GUIDE', OPTIMIZED_PERSONALITY_GUIDE],
    ['OPTIMIZED_TOOL_PLANNING_GUIDE', OPTIMIZED_TOOL_PLANNING_GUIDE],
    ['OPTIMIZED_CONSTRAINT_AWARENESS_GUIDE', OPTIMIZED_CONSTRAINT_AWARENESS_GUIDE],
    ['OPTIMIZED_SESSION_SUMMARY_GUIDE', OPTIMIZED_SESSION_SUMMARY_GUIDE],
    ['OPTIMIZED_SKILL_MATCHING_GUIDE', OPTIMIZED_SKILL_MATCHING_GUIDE],
    ['OPTIMIZED_MCP_DISCOVERY_GUIDE', OPTIMIZED_MCP_DISCOVERY_GUIDE],
    ['BROWSER_TOOL_GUIDE', BROWSER_TOOL_GUIDE],
  ]
  test('all non-empty guides are populated strings', () => {
    for (const [name, val] of guides) {
      expect(typeof val, name).toBe('string')
      expect(val.length, name).toBeGreaterThan(20)
    }
  })
  test('OPTIMIZED_CANVAS_EXAMPLES is defined (intentionally empty placeholder)', () => {
    expect(typeof OPTIMIZED_CANVAS_EXAMPLES).toBe('string')
  })
  test('guides carry their expected section markers', () => {
    expect(OPTIMIZED_MEMORY_GUIDE).toContain('Memory')
    expect(OPTIMIZED_MCP_DISCOVERY_GUIDE).toContain('Tool')
    expect(BROWSER_TOOL_GUIDE).toContain('Browser')
  })
})

describe('agent-recipes data', () => {
  test('RECIPE_CATEGORIES covers all four category keys', () => {
    expect(Object.keys(RECIPE_CATEGORIES).sort()).toEqual(
      ['business', 'developer', 'personal', 'quick-start'],
    )
    for (const v of Object.values(RECIPE_CATEGORIES)) {
      expect(v.label.length).toBeGreaterThan(0)
      expect(v.icon.length).toBeGreaterThan(0)
    }
  })

  test('AGENT_RECIPES is a non-empty, well-formed catalog', () => {
    expect(Array.isArray(AGENT_RECIPES)).toBe(true)
    expect(AGENT_RECIPES.length).toBeGreaterThan(0)
    const ids = new Set<string>()
    for (const r of AGENT_RECIPES) {
      expect(r.id, `id for ${r.name}`).toBeTruthy()
      expect(ids.has(r.id), `duplicate id ${r.id}`).toBe(false)
      ids.add(r.id)
      expect(r.name.length).toBeGreaterThan(0)
      expect(r.description.length).toBeGreaterThan(0)
      expect(r.templateId.length).toBeGreaterThan(0)
      expect(r.icon.length).toBeGreaterThan(0)
      expect(Array.isArray(r.mcpServers)).toBe(true)
      expect(Array.isArray(r.tags)).toBe(true)
      expect(r.tags.length).toBeGreaterThan(0)
      expect(Array.isArray(r.examplePrompts)).toBe(true)
      expect(r.examplePrompts.length).toBeGreaterThan(0)
      expect(typeof r.heartbeatInterval).toBe('number')
      expect(r.heartbeatInterval).toBeGreaterThan(0)
      // category must be one of the declared categories
      expect(Object.keys(RECIPE_CATEGORIES)).toContain(r.category)
      // requiredCredentials well-formed
      expect(Array.isArray(r.requiredCredentials)).toBe(true)
      for (const c of r.requiredCredentials) {
        expect(c.key.length).toBeGreaterThan(0)
        expect(c.label.length).toBeGreaterThan(0)
        expect(c.source.length).toBeGreaterThan(0)
      }
    }
  })

  test('every category has at least one recipe', () => {
    const used = new Set<RecipeCategory>(AGENT_RECIPES.map((r) => r.category))
    for (const cat of Object.keys(RECIPE_CATEGORIES) as RecipeCategory[]) {
      expect(used.has(cat), `category ${cat} has no recipes`).toBe(true)
    }
  })

  test('recipes with a channel use a known channel type', () => {
    const known = ['telegram', 'discord', 'slack', 'whatsapp', 'teams', 'webhook', 'email', 'webchat']
    for (const r of AGENT_RECIPES) {
      if (r.channel) expect(known).toContain(r.channel)
    }
  })

  test('AgentRecipe type is structurally satisfied (compile-time smoke)', () => {
    const sample: AgentRecipe = AGENT_RECIPES[0]
    expect(sample).toBeDefined()
  })
})
