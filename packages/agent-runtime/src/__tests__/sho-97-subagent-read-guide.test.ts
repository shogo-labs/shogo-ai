// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-97: a subagent's `read_guide({ tool })` must read and activate the
 * SUBAGENT's advertised set, never the parent's.
 *
 * `runSubagent` reuses the parent's tool objects and installs the subagent's
 * profile on a copy of the ctx. The parent's `read_guide` closed over
 * `parentCtx`, so before the fix discovery loaded the parent's schema and grew
 * the parent's advertised set mid-turn — changing the parent's cache prefix,
 * the exact opposite of the plan's "a parent's activations do not leak" — while
 * the child's own next API call still omitted the tool.
 */

import { describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AgentTool } from '@mariozechner/pi-agent-core'

import * as agentLoop from '../agent-loop'
import { runSubagent } from '../subagent'
import { createReadGuideTool } from '../gateway-tools'
import { createToolProfile, DEFERRED_TOOLS_ENV } from '../tool-profile'

let captured: any = null
let loopSpy: ReturnType<typeof spyOn> | undefined

function plainTool(name: string): AgentTool {
  return {
    name,
    description: `${name} tool`,
    label: name,
    parameters: { type: 'object', properties: {} } as any,
    execute: async () => ({ content: [], details: {} }),
  } as AgentTool
}

let tmp: string
const originalEnv = process.env[DEFERRED_TOOLS_ENV]

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sho97-sub-'))
  captured = null
  delete process.env[DEFERRED_TOOLS_ENV]
  // A spy on the module export, not `mock.module`: module mocks are process-wide
  // and leak into the next file when bun runs the package's tests together.
  loopSpy = spyOn(agentLoop, 'runAgentLoop').mockImplementation(async (opts: any) => {
    captured = opts
    return {
      text: 'ok',
      toolCalls: [],
      iterations: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      newMessages: [],
      effectiveModelId: 'm',
      maxIterationsExhausted: false,
      loopBreak: false,
    } as any
  })
})

afterEach(() => {
  loopSpy?.mockRestore()
  loopSpy = undefined
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  if (originalEnv === undefined) delete process.env[DEFERRED_TOOLS_ENV]
  else process.env[DEFERRED_TOOLS_ENV] = originalEnv
})

/** Build the parent exactly as the gateway does, then run a subagent off it. */
async function runWithParentProfile(): Promise<{
  parentAdvertised: (name: string) => boolean
  subAdvertised: (name: string) => boolean
  readGuide: AgentTool
  parentReadGuide: AgentTool | undefined
  result: any
}> {
  const parentTools: AgentTool[] = [
    plainTool('read_file'),
    plainTool('write_file'),
    plainTool('edit_file'),
    plainTool('exec'),
    plainTool('todo_write'),
    plainTool('web'),
    plainTool('ask_user'),
    plainTool('share_file'),
    plainTool('agent_spawn'),
    plainTool('obscure_tool'),
  ]

  const parentCtx: any = {
    workspaceDir: tmp,
    sessionId: 'parent-session',
    projectId: null,
    config: { model: { name: 'claude-sonnet-4-5', provider: 'anthropic' }, channels: [] },
    autoRouting: false,
    channels: new Map(),
    fileStateCache: undefined,
    toolMockFns: undefined,
    sessionPersistence: undefined,
    uiWriter: undefined,
  }

  const parentProfile = createToolProfile(parentTools, {})
  parentCtx.toolProfileRef = { current: parentProfile }
  const parentReadGuide = createReadGuideTool(parentCtx)
  parentTools.push(parentReadGuide)

  // `general-purpose` has no toolNames, so it inherits read_guide — the common
  // shape for spawn-heavy agents.
  const result = await runSubagent(
    { name: 'general-purpose', description: 'd', systemPrompt: 's' } as any,
    'do the thing',
    parentCtx,
    parentTools,
  )

  const readGuide = captured.tools.find((t: AgentTool) => t.name === 'read_guide')
  expect(readGuide).toBeDefined()
  return {
    parentAdvertised: (name: string) => parentProfile.isAdvertised(name),
    subAdvertised: (name: string) => captured.isAdvertisedTool({ name } as AgentTool),
    readGuide,
    parentReadGuide,
    result,
  }
}

describe('SHO-97: a subagent reads its own profile', () => {
  it('deferred the non-core tool for both parent and subagent', async () => {
    const { parentAdvertised, subAdvertised } = await runWithParentProfile()
    expect(parentAdvertised('obscure_tool')).toBe(false)
    expect(subAdvertised('obscure_tool')).toBe(false)
    // The subagent gets its own catalog in its own (copied) prompt.
    expect(captured.system).toContain('## Deferred Tools')
    expect(captured.system).toContain('obscure_tool')
  })

  it('read_guide({ tool }) activates in the subagent set and leaves the parent untouched', async () => {
    const { parentAdvertised, subAdvertised, readGuide } = await runWithParentProfile()

    const out: any = await readGuide.execute('call-1', { tool: 'obscure_tool' })
    const text = out?.content?.[0]?.text ?? JSON.stringify(out)

    expect(text).toContain('obscure_tool')
    expect(text).not.toContain('Unknown tool')

    // The fix: the activation lands in the child's own advertised set...
    expect(subAdvertised('obscure_tool')).toBe(true)
    // ...and never in the parent's, whose tool block is the head of its cache prefix.
    expect(parentAdvertised('obscure_tool')).toBe(false)
  })

  it('the subagent holds a rebound read_guide, not the parent instance', async () => {
    const { readGuide, parentReadGuide } = await runWithParentProfile()
    expect(readGuide).not.toBe(parentReadGuide)
  })

  it('the parent’s own read_guide still activates the parent’s set', async () => {
    const { parentReadGuide, parentAdvertised, subAdvertised } = await runWithParentProfile()

    await parentReadGuide!.execute('call-2', { tool: 'obscure_tool' })

    expect(parentAdvertised('obscure_tool')).toBe(true)
    expect(subAdvertised('obscure_tool')).toBe(false)
  })
})
