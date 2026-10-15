// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { loadBundledSkills } from '../skills'
import { BOARD_TOOL_NAMES, CHANNEL_TOOL_NAMES } from '../work-tool-names'

const GOAL_TOOLS = ['goal_create', 'goal_list', 'goal_log', 'goal_update']

describe('company-ops bundled skill', () => {
  const skill = loadBundledSkills(new Set()).find((s) => s.name === 'company-ops')

  test('ships with the runtime', () => {
    expect(skill).toBeDefined()
    expect(skill!.trigger).toContain('board sweep')
  })

  test('only names tools that exist', () => {
    const known = new Set<string>([...BOARD_TOOL_NAMES, ...CHANNEL_TOOL_NAMES, ...GOAL_TOOLS])
    const named = [...new Set(skill!.content.match(/`((?:board|work_item|team_chat|goal)_[a-z_]+)`/g) ?? [])].map((s) => s.slice(1, -1))
    expect(named.length).toBeGreaterThan(8)
    expect(named.filter((n) => !known.has(n))).toEqual([])
  })
})
