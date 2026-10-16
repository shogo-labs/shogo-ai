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
import { describe, test, expect, afterEach, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { createTools, type ToolContext } from '../gateway-tools'
import { FileStateCache } from '../file-state-cache'
import { buildToolPlanningGuide } from '../optimized-prompts'
import { buildCodeAgentGeneralGuide } from '../code-agent-prompt'
import { buildExploreSystemPrompt, getBuiltinSubagentConfig } from '../subagent'
import { isSearchEnabled } from '../search-flag'
import { AgentGateway } from '../gateway'

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

  test('prod-like: coding guide does not advertise the search tool and offers rg instead', () => {
    const guide = buildCodeAgentGeneralGuide(false)
    expect(guide).not.toContain('search({')
    expect(guide).not.toContain('`search`')
    expect(guide).toContain('rg -n')
  })

  test('when enabled: coding guide includes the semantic search section', () => {
    const guide = buildCodeAgentGeneralGuide(true)
    expect(guide).toContain('### search — Semantic Workspace Search')
    expect(guide).toContain('search({ query:')
  })

  test('prod-like: exec and read_file descriptions point at rg, not the search tool', () => {
    delete process.env.SHOGO_SEARCH_ENABLED
    const tools = createTools(makeCtx())
    const exec = tools.find((t) => t.name === 'exec')!
    const readFile = tools.find((t) => t.name === 'read_file')!
    expect(exec.description).not.toContain('`search` tool')
    expect(exec.description).toContain('rg')
    expect(readFile.description).not.toContain('`search` tool')
    expect(readFile.description).toContain('rg -n')
  })

  test('when enabled: exec and read_file descriptions mention the search tool', () => {
    process.env.SHOGO_SEARCH_ENABLED = '1'
    const tools = createTools(makeCtx())
    expect(tools.find((t) => t.name === 'exec')!.description).toContain('`search` tool')
    expect(tools.find((t) => t.name === 'read_file')!.description).toContain('`search` tool')
  })

  test('prod-like: code-reviewer toolNames are a subset of registered tools', () => {
    delete process.env.SHOGO_SEARCH_ENABLED
    const registered = registeredToolNames()
    const cfg = getBuiltinSubagentConfig('code-reviewer', makeCtx(), [])
    const toolNames = cfg!.toolNames ?? []
    expect(toolNames).not.toContain('search')
    for (const name of toolNames) {
      expect({ name, registered: registered.has(name) }).toEqual({ name, registered: true })
    }
    process.env.SHOGO_SEARCH_ENABLED = '1'
    expect(getBuiltinSubagentConfig('code-reviewer', makeCtx(), [])!.toolNames).toContain('search')
  })

  test('plan-mode prompt and PLAN_MODE_ALLOWED gate search on isSearchEnabled()', () => {
    const src = readFileSync(join(__dirname, '..', 'gateway.ts'), 'utf-8')
    expect(src).toContain("read-only tools (read_file, ${isSearchEnabled() ? 'search, ' : ''}web, etc.)")
    expect(src).toContain("'read_file', ...(isSearchEnabled() ? ['search'] : []),")
    expect(src).not.toContain("'read_file', 'search',")
  })
})

describe('uploaded-files section matches search registration', () => {
  const WS = '/tmp/test-search-contract-uploads'
  afterAll(() => rmSync(WS, { recursive: true, force: true }))

  function uploadedFilesSection(): string {
    rmSync(WS, { recursive: true, force: true })
    mkdirSync(join(WS, 'files'), { recursive: true })
    writeFileSync(join(WS, 'files', 'report.csv'), 'a,b\n1,2\n')
    const gw = new AgentGateway(WS, 'search-contract')
    return (gw as any).buildUploadedFilesContext() as string
  }

  test('prod-like: suggests read_file / rg, not search', () => {
    delete process.env.SHOGO_SEARCH_ENABLED
    const section = uploadedFilesSection()
    expect(section).toContain('files/report.csv')
    expect(section).not.toContain('Use `search`')
    expect(section).toContain('rg -n')
  })

  test('when enabled: suggests search', () => {
    process.env.SHOGO_SEARCH_ENABLED = '1'
    expect(uploadedFilesSection()).toContain('Use `search`')
  })
})
