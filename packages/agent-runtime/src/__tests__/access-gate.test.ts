// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The runtime half of SHO-417: the tool gate and the downgrade notice.
 *
 * The gate is a turn-saver, not the security boundary — the server refuses the
 * internal route either way. So the two properties that matter here are:
 * an unknown ability set allows everything (a runtime that cannot reach the
 * API must not lose every tool), and a known set hides exactly the tools whose
 * ability is missing.
 */

import { describe, expect, test } from 'bun:test'
import {
  TOOL_ABILITIES,
  abilityForTool,
  applyAbilityGate,
  isToolAllowed,
  withAbilityGate,
} from '../access-gate'
import { modelDowngradeNotice, parseModelDowngrade } from '../model-downgrade'
import type { AgentTool } from '@mariozechner/pi-agent-core'

function tool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: 'object', properties: {} } as any,
    async execute() {
      return { content: [{ type: 'text', text: 'ran' }], details: {} } as any
    },
  } as AgentTool
}

describe('abilityForTool', () => {
  test('maps a gated tool to its ability', () => {
    expect(abilityForTool('exec')).toBe('agent.exec:use')
    expect(abilityForTool('browser')).toBe('agent.browser:use')
    expect(abilityForTool('schedule_create')).toBe('schedule:manage')
  })

  test('an ungated tool needs no ability', () => {
    expect(abilityForTool('read_file')).toBeNull()
    expect(abilityForTool('work_item_move')).toBeNull()
  })

  test('every mapped ability is a real permission name', () => {
    for (const ability of Object.values(TOOL_ABILITIES)) {
      expect(ability).toMatch(/^[a-z][a-z.]*:[a-z_]+$/)
    }
  })
})

describe('isToolAllowed', () => {
  test('an unknown ability set allows everything', () => {
    expect(isToolAllowed('exec', null)).toBe(true)
    expect(isToolAllowed('browser', null)).toBe(true)
  })

  test('a known set allows a tool whose ability is present', () => {
    expect(isToolAllowed('exec', new Set(['agent.exec:use']))).toBe(true)
  })

  test('a known set denies a tool whose ability is missing', () => {
    expect(isToolAllowed('exec', new Set(['agent.browser:use']))).toBe(false)
  })

  test('an ungated tool is allowed even with an empty set', () => {
    expect(isToolAllowed('read_file', new Set())).toBe(true)
  })
})

describe('applyAbilityGate', () => {
  test('hides denied tools and keeps the rest', () => {
    const tools = [tool('exec'), tool('browser'), tool('read_file')]
    const gated = applyAbilityGate(tools, new Set(['agent.browser:use']))
    expect(gated.map((t) => t.name)).toEqual(['browser', 'read_file'])
  })

  test('an unknown ability set leaves the list untouched', () => {
    const tools = [tool('exec'), tool('browser')]
    expect(applyAbilityGate(tools, null)).toBe(tools)
  })

  test('a denied tool that is called anyway answers with the ability to ask for', async () => {
    const gated = withAbilityGate(tool('exec'), new Set(['agent.browser:use']))
    const result = (await gated.execute('call-1', {})) as any
    const body = JSON.parse(result.content[0].text)
    expect(body.error).toBe('ability_not_allowed')
    expect(body.permission).toBe('agent.exec:use')
    expect(result.details.error).toBe('ability_not_allowed')
  })

  test('an allowed tool runs unchanged', async () => {
    const gated = withAbilityGate(tool('exec'), new Set(['agent.exec:use']))
    const result = (await gated.execute('call-1', {})) as any
    expect(result.content[0].text).toBe('ran')
  })
})

describe('parseModelDowngrade', () => {
  test('reads a well-formed downgrade', () => {
    expect(parseModelDowngrade({ from: 'opus', to: 'sonnet' })).toEqual({ from: 'opus', to: 'sonnet' })
  })

  test('ignores anything malformed', () => {
    expect(parseModelDowngrade(null)).toBeNull()
    expect(parseModelDowngrade(undefined)).toBeNull()
    expect(parseModelDowngrade('opus')).toBeNull()
    expect(parseModelDowngrade({ from: 'opus' })).toBeNull()
    expect(parseModelDowngrade({ from: '', to: 'sonnet' })).toBeNull()
    expect(parseModelDowngrade({ from: 'opus', to: 42 })).toBeNull()
  })
})

describe('modelDowngradeNotice', () => {
  test('names both models and ends with a blank line', () => {
    expect(modelDowngradeNotice({ from: 'opus', to: 'sonnet' })).toBe(
      "Ran on sonnet because your role can't use opus.\n\n",
    )
  })
})
