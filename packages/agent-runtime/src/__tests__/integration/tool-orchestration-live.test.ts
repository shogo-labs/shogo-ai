// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression — orchestration proxy must stay live across .slice()
 *
 * pi-agent-core slices the tools array twice (once in
 * createMutableAgentState, again in createContextSnapshot) before the loop
 * starts. The gateway's tools proxy is dynamic by design (composio
 * `connect` promotes hidden tools mid-turn, hot-added MCP servers expose
 * tools mid-turn) — but if .slice() materializes a static array, none of
 * those mid-turn additions reach the LLM on subsequent iterations.
 *
 * Concretely: agent calls connect → _promoteHiddenMocksFromInstall appends
 * GMAIL_SEND_EMAIL to gateway.promotedMockTools → next LLM call still
 * sees the original snapshot → LLM falls back to skill.invoke /
 * agent_spawn (observed in composio-preference, composio-gmail-send,
 * composio-multi-skill evals).
 *
 * This test pins the contract: a slice of the orchestrated proxy must
 * still reflect tools that appear in the underlying target after the
 * slice was taken.
 */

import { describe, test, expect } from 'bun:test'
import { wrapToolsWithOrchestration } from '../../tool-orchestration'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { Type } from '@sinclair/typebox'

function makeTool(name: string): AgentTool {
  return {
    name,
    description: `Mock ${name}`,
    label: name,
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: 'text' as const, text: `result:${name}` }],
      details: { name },
    }),
  }
}

describe('orchestration proxy liveness', () => {
  test('no-arg slice stays live — promoted tool appears post-snapshot', () => {
    const live: AgentTool[] = [makeTool('search_integrations'), makeTool('connect')]
    const { tools } = wrapToolsWithOrchestration(live)

    // pi-agent-core: createMutableAgentState
    const snapshot1 = tools.slice()
    expect(snapshot1.length).toBe(2)

    // Mid-turn: connect promotes a hidden composio tool
    live.push(makeTool('GMAIL_SEND_EMAIL'))

    // pi-agent-core's next iteration reads from the snapshot.
    // If snapshot is static, the LLM never sees GMAIL_SEND_EMAIL.
    expect(snapshot1.length).toBe(3)
    expect(snapshot1.find(t => t.name === 'GMAIL_SEND_EMAIL')).toBeTruthy()
  })

  test('double slice stays live — createContextSnapshot pattern', () => {
    const live: AgentTool[] = [makeTool('a')]
    const { tools } = wrapToolsWithOrchestration(live)

    // createMutableAgentState then createContextSnapshot — two .slice()
    // calls before any iteration runs.
    const snapshot1 = tools.slice()
    const snapshot2 = snapshot1.slice()

    expect(snapshot2.length).toBe(1)

    live.push(makeTool('b'))

    expect(snapshot2.length).toBe(2)
    expect(snapshot2.find(t => t.name === 'b')).toBeTruthy()
  })

  test('slice iteration reflects current live tools', () => {
    const live: AgentTool[] = [makeTool('a')]
    const { tools } = wrapToolsWithOrchestration(live)
    const snapshot = tools.slice()

    live.push(makeTool('b'))
    live.push(makeTool('c'))

    const names = [...snapshot].map(t => t.name)
    expect(names).toEqual(['a', 'b', 'c'])
  })

  test('slice find() resolves a promoted tool by name', () => {
    const live: AgentTool[] = [makeTool('search_integrations')]
    const { tools } = wrapToolsWithOrchestration(live)
    const snapshot = tools.slice()

    expect(snapshot.find(t => t.name === 'GITHUB_LIST_ISSUES')).toBeUndefined()

    live.push(makeTool('GITHUB_LIST_ISSUES'))

    const found = snapshot.find(t => t.name === 'GITHUB_LIST_ISSUES')
    expect(found?.name).toBe('GITHUB_LIST_ISSUES')
  })

  test('range slice (start, end) returns a static copy as expected', () => {
    // Range slices are explicit "snapshot this portion" — they should NOT
    // be live. Only the no-arg form is the cache-and-iterate pattern.
    const live: AgentTool[] = [makeTool('a'), makeTool('b'), makeTool('c')]
    const { tools } = wrapToolsWithOrchestration(live)
    const partial = tools.slice(0, 2)
    expect(partial.length).toBe(2)
    expect(partial[0]?.name).toBe('a')

    live.push(makeTool('d'))
    expect(partial.length).toBe(2) // unchanged — range slice is static
  })
})
