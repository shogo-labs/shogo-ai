// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-57 — the `[Skill: …]` trigger wrapper injected when `matchSkill` fires.
// Before this fix the same text was duplicated at two call sites in gateway.ts
// and told the model the skill was "for this integration", pointing it at
// search_integrations instead of the skill tool.

import { describe, test, expect } from 'bun:test'
import { buildSkillMatchPrompt, type Skill } from '../skills'

const skill: Skill = {
  name: 'acf-fields',
  description: 'Advanced Custom Fields reference',
  content: '# ACF\n\nUse get_field() to read a field.',
  skillDir: '/tmp/skills/acf-fields',
  disableModelInvocation: false,
  userInvocable: true,
  trigger: 'acf',
}

describe('buildSkillMatchPrompt', () => {
  test('names the matched installed skill and includes its body', () => {
    const prompt = buildSkillMatchPrompt(skill, 'how do I read an acf field?')
    expect(prompt).toContain('[Skill: acf-fields]')
    expect(prompt).toContain('get_field()')
    expect(prompt).toContain('how do I read an acf field?')
    expect(prompt).toContain('invoke')
  })

  test('does not claim the skill is an integration', () => {
    const prompt = buildSkillMatchPrompt(skill, 'how do I read an acf field?')
    expect(prompt).not.toContain('for this integration')
    expect(prompt).toContain('installed')
  })
})
