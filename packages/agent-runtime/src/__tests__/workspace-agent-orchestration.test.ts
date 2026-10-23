// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The workspace agent (workspace runtime, no anchor project) delegates to
 * projects, never to subagents: no agent_* / team_* tools, media tools stay
 * directly callable, and the prompt never advertises agent_spawn.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import {
  SUBAGENT_ONLY_TOOLS,
  filterDisabledCapabilityTools,
  filterSubagentOnlyTools,
  subagentOrchestrationDisabled,
} from '../gateway-tools'
import { PROFILE_TOOL_GROUPS } from '../capability-profiles'
import { buildCapabilitiesIndex } from '../guide-registry'
import { buildCodeAgentGeneralGuide } from '../code-agent-prompt'

const ENV_KEYS = ['WORKSPACE_RUNTIME', 'WORKSPACE_ANCHOR_PROJECT_ID']
const ORCHESTRATION = PROFILE_TOOL_GROUPS.orchestration!
const PROJECT_TOOLS = ['project_list', 'project_create', 'project_attach', 'project_configure', 'project_call', 'list_projects', 'connect_project']

function fakeTools(names: string[]): AgentTool[] {
  return names.map((name) => ({ name, label: name, description: name, parameters: {} as any, execute: async () => ({ content: [], details: {} }) }))
}

const names = (tools: AgentTool[]) => tools.map((t) => t.name)

let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env.WORKSPACE_RUNTIME = 'true'
  delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('workspace agent has no subagent orchestration', () => {
  test('agent_* and team_* tools are filtered out; project tools stay', () => {
    const all = fakeTools([...ORCHESTRATION, ...PROJECT_TOOLS, 'read_file'])
    const kept = names(filterDisabledCapabilityTools(all, {} as any))
    for (const n of ORCHESTRATION) expect(kept).not.toContain(n)
    for (const n of [...PROJECT_TOOLS, 'read_file']) expect(kept).toContain(n)
  })

  test('an anchored workspace runtime and single-project runtimes keep orchestration', () => {
    const all = fakeTools([...ORCHESTRATION])
    process.env.WORKSPACE_ANCHOR_PROJECT_ID = 'p1'
    expect(names(filterDisabledCapabilityTools(all, {} as any))).toEqual([...ORCHESTRATION])
    delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
    delete process.env.WORKSPACE_RUNTIME
    expect(names(filterDisabledCapabilityTools(all, {} as any))).toEqual([...ORCHESTRATION])
  })

  test('media tools are never subagent-only — the main agent calls them directly', () => {
    expect(subagentOrchestrationDisabled({})).toBe(true)
    expect(SUBAGENT_ONLY_TOOLS.has('generate_image')).toBe(false)
    expect(SUBAGENT_ONLY_TOOLS.has('transcribe_audio')).toBe(false)
    const kept = names(filterSubagentOnlyTools(fakeTools(['generate_image', 'transcribe_audio', 'browser', 'server_sync']), {} as any))
    expect(kept).toEqual(['generate_image', 'transcribe_audio', 'server_sync'])
    process.env.WORKSPACE_ANCHOR_PROJECT_ID = 'p1'
    expect(subagentOrchestrationDisabled({})).toBe(false)
    expect(names(filterSubagentOnlyTools(fakeTools(['generate_image']), {} as any))).toEqual(['generate_image'])
  })

  test('the capabilities index and coding guide do not advertise agent_spawn', () => {
    expect(buildCapabilitiesIndex({ subagents: false })).not.toContain('agent_spawn')
    expect(buildCapabilitiesIndex({})).toContain('agent_spawn')
    expect(buildCodeAgentGeneralGuide(false, false)).not.toContain('agent_spawn')
    expect(buildCodeAgentGeneralGuide(false, true)).toContain('agent_spawn')
    expect(buildCodeAgentGeneralGuide(false)).not.toContain('agent_spawn')
  })
})
