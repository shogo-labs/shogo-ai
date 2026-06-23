// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * WS6 contract: the `search` tool is only registered when SHOGO_SEARCH_ENABLED=1.
 * Production does NOT set that flag, so prompts/guides/subagents must NOT
 * advertise `search` there — otherwise weak models call a tool that doesn't
 * exist and get "Tool search not found" (100% failure in prod telemetry).
 *
 * This proves the prompt surface matches tool registration in BOTH states.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { createTools, type ToolContext } from '../gateway-tools'
import { FileStateCache } from '../file-state-cache'
import { buildToolPlanningGuide } from '../optimized-prompts'
import { buildExploreSystemPrompt, getBuiltinSubagentConfig } from '../subagent'
import { isSearchEnabled } from '../search-flag'

const prev = process.env.SHOGO_SEARCH_ENABLED
afterEach(() => {
  if (prev === undefined) delete process.env.SHOGO_SEARCH_ENABLED
  else process.env.SHOGO_SEARCH_ENABLED = prev
})

function makeCtx(): ToolContext {
  return {
    workspaceDir: '/tmp/test-search-contract',
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    } as any,
    projectId: 'test',
    fileStateCache: new FileStateCache(),
  }
}

function registeredToolNames(): Set<string> {
  return new Set(createTools(makeCtx()).map((t) => t.name))
}

describe('search advertisement contract (WS6)', () => {
  test('prod-like (flag unset): search is NOT registered', () => {
    delete process.env.SHOGO_SEARCH_ENABLED
    expect(isSearchEnabled()).toBe(false)
    expect(registeredToolNames().has('search')).toBe(false)
  })

  test('prod-like: tool-planning guide does not mention the search tool', () => {
    const guide = buildToolPlanningGuide(false)
    expect(guide.toLowerCase()).not.toContain('search')
  })

  test('prod-like: explore subagent prompt does not reference the search tool', () => {
    const prompt = buildExploreSystemPrompt(false)
    expect(prompt).not.toMatch(/exec, search/)
    expect(prompt).not.toContain('Use search for semantic')
    expect(prompt).toContain('read_file, exec, web, impact_radius')
  })

  test('prod-like: explore subagent toolNames are a subset of registered tools', () => {
    delete process.env.SHOGO_SEARCH_ENABLED
    const registered = registeredToolNames()
    const cfg = getBuiltinSubagentConfig('explore', makeCtx(), [])
    expect(cfg).not.toBeNull()
    const toolNames = cfg!.toolNames ?? []
    expect(toolNames).not.toContain('search')
    for (const name of toolNames) {
      expect({ name, registered: registered.has(name) }).toEqual({ name, registered: true })
    }
  })

  test('when enabled: search IS registered and advertised', () => {
    process.env.SHOGO_SEARCH_ENABLED = '1'
    expect(isSearchEnabled()).toBe(true)
    expect(registeredToolNames().has('search')).toBe(true)
    expect(buildToolPlanningGuide(true).toLowerCase()).toContain('search')
    expect(buildExploreSystemPrompt(true)).toContain('exec, search, web')
    const cfg = getBuiltinSubagentConfig('explore', makeCtx(), [])
    expect(cfg!.toolNames).toContain('search')
  })
})
