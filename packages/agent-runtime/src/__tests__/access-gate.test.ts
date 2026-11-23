// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The runtime half of SHO-417: the tool gate and the downgrade notice.
 *
 * The gate is a turn-saver, not the security boundary — the server refuses the
 * internal route either way. So the properties that matter here are: an unknown
 * ability set allows everything (a runtime that cannot reach the API must not
 * lose every tool), a known set hides exactly the tools whose ability is
 * missing, and every mapped ability is one `access/effective` can return
 * (SHO-539 — a *project* permission there hides the tool from everyone).
 */

import { describe, expect, test } from 'bun:test'
import { ABILITY_PERMISSIONS, resolveAbilities, type AbilityPermission } from '@shogo/authz'
import {
  TOOL_ABILITIES,
  abilityForTool,
  applyAbilityGate,
  isToolAllowed,
  withAbilityGate,
} from '../access-gate'
import { createToolProfile } from '../tool-profile'
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

  // The invariant this module cannot express in types alone: a mapped ability
  // must be one `access/effective` can actually return. It resolves
  // `WORKSPACE_ROLE_BASE_PERMISSIONS + ABILITY_PERMISSIONS`, so a *project*
  // permission in this map hides the tool from every turn, owners included
  // (SHO-539: `publish` → `project:publish`).
  test('every mapped ability is in ABILITY_PERMISSIONS', () => {
    for (const [tool, ability] of Object.entries(TOOL_ABILITIES)) {
      expect({ tool, ability, grantable: (ABILITY_PERMISSIONS as readonly string[]).includes(ability) }).toEqual({
        tool,
        ability,
        grantable: true,
      })
    }
  })

  test('a project permission never gates a tool', () => {
    expect(abilityForTool('publish')).toBeNull()
  })

  test('every ability the plan names has at least one tool behind it', () => {
    const mapped = new Set(Object.values(TOOL_ABILITIES))
    const named: AbilityPermission[] = [
      'agent.exec:use',
      'agent.browser:use',
      'agent.media:generate',
      'agent.channels:send',
      'agent.social:post',
      'agent:create',
      'schedule:manage',
      'trigger:manage',
      'system:apply',
      'project.files:share_public',
      'integrations:connect',
      'members.activity:read',
      'boards:manage',
    ]
    for (const ability of named) {
      expect(mapped.has(ability)).toBe(true)
    }
  })
})

describe('AC7: one gate per ability', () => {
  // Every mapped tool, checked against its own ability and against an empty
  // set. A tool that is allowed with no abilities at all is a hole in the gate.
  for (const [name, ability] of Object.entries(TOOL_ABILITIES)) {
    test(`${name} needs ${ability}`, () => {
      expect(isToolAllowed(name, new Set([ability]))).toBe(true)
      expect(isToolAllowed(name, new Set())).toBe(false)
      expect(isToolAllowed(name, new Set(['some.other:ability']))).toBe(false)
    })
  }

  test('a turn with no abilities keeps only the ungated tools', () => {
    const names = Object.keys(TOOL_ABILITIES)
    const gated = applyAbilityGate(names.map(tool), new Set())
    expect(gated.map((t) => t.name)).toEqual([])
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

  // SHO-539 acceptance 1: `publish` is decided per project by the server, so a
  // real member's ability set — whatever their role — must not hide it. These
  // sets are what `access/effective` returns for each role, not hand-built.
  for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
    test(`publish survives the filter for a real ${role} ability set`, () => {
      const abilities = new Set<string>(resolveAbilities(role, []))
      expect(abilities.size).toBeGreaterThan(0)
      const gated = applyAbilityGate([tool('publish'), tool('read_file')], abilities)
      expect(gated.map((t) => t.name)).toEqual(['publish', 'read_file'])
      expect(isToolAllowed('publish', abilities)).toBe(true)
    })
  }

  // The other half of acceptance 1: a hidden tool is also absent from the
  // profile, so `read_guide({ tool: 'publish' })` answered "Unknown tool" in
  // production. A filtered-in tool must be describable.
  test('read_guide can describe publish after the gate', () => {
    const abilities = new Set<string>(resolveAbilities('owner', []))
    const gated = applyAbilityGate([tool('publish'), tool('read_file')], abilities)
    const profile = createToolProfile(gated)
    expect(profile.describe('publish')).toContain('publish')
    expect(profile.deferredNames()).not.toContain('read_file')
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
