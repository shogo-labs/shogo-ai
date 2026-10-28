// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { buildCapabilityStatusSection, capabilityState } from '../capability-status-prompt'

describe('buildCapabilityStatusSection', () => {
  test('defaults: opt-in capabilities are disabled and the rest are enabled', () => {
    const text = buildCapabilityStatusSection({})
    expect(text).toContain('## Project capabilities')
    expect(text).toContain('Web search (`webEnabled`)')
    expect(text).toContain('Shell (`shellEnabled`)')
    expect(text).toContain('Disabled: Video generation (`videoGenEnabled`), Music generation (`musicGenEnabled`), 3D generation (`threeDGenEnabled`), Git worktrees (`gitWorktreesEnabled`), Social media (`socialMediaEnabled`)')
    expect(text).not.toContain('Locked by')
    expect(text).toContain('capabilities_configure')
  })

  test('an explicit false moves that capability to the disabled list', () => {
    const text = buildCapabilityStatusSection({ channelsEnabled: false, imageGenEnabled: false })
    expect(text).toContain('Channels (`channelsEnabled`)')
    expect(text).toContain('Image generation (`imageGenEnabled`)')
    const disabled = text.split('\n').find((line) => line.startsWith('Disabled:')) ?? ''
    expect(disabled).toContain('channelsEnabled')
    expect(disabled).toContain('imageGenEnabled')
    expect(disabled).toContain('gitWorktreesEnabled')
    const enabled = text.split('\n').find((line) => line.startsWith('Enabled:')) ?? ''
    expect(enabled).not.toContain('channelsEnabled')
    expect(enabled).not.toContain('imageGenEnabled')
  })

  test('3D generation is opt-in and named with both of its tools', () => {
    const off = buildCapabilityStatusSection({})
    expect(off.split('\n').find((line) => line.startsWith('Disabled:'))).toContain('threeDGenEnabled')

    const on = buildCapabilityStatusSection({ threeDGenEnabled: true })
    const enabled = on.split('\n').find((line) => line.startsWith('Enabled:')) ?? ''
    expect(enabled).toContain('3D generation (`threeDGenEnabled`)')
    expect(on.split('\n').find((line) => line.startsWith('Disabled:'))).not.toContain('threeDGenEnabled')
  })

  test('opt-in toggles appear as enabled only when exactly true', () => {
    const text = buildCapabilityStatusSection({ gitWorktreesEnabled: true, socialMediaEnabled: true })
    const enabled = text.split('\n').find((line) => line.startsWith('Enabled:')) ?? ''
    expect(enabled).toContain('gitWorktreesEnabled')
    expect(enabled).toContain('socialMediaEnabled')
    const disabled = text.split('\n').find((line) => line.startsWith('Disabled:')) ?? ''
    expect(disabled).not.toContain('gitWorktreesEnabled')
    expect(disabled).not.toContain('socialMediaEnabled')
    expect(disabled).toContain('boardAdminEnabled')
  })

  test('personal profile locks shell and canvas out of the enabled and disabled lists', () => {
    const text = buildCapabilityStatusSection({ capabilityProfile: 'personal', shellEnabled: true, canvasEnabled: true })
    expect(text).toContain('Locked by the personal workspace profile: Canvas (`canvasEnabled`) — off, Shell (`shellEnabled`) — off')
    const enabled = text.split('\n').find((line) => line.startsWith('Enabled:')) ?? ''
    const disabled = text.split('\n').find((line) => line.startsWith('Disabled:')) ?? ''
    expect(enabled).not.toContain('shellEnabled')
    expect(enabled).not.toContain('canvasEnabled')
    expect(disabled).not.toContain('shellEnabled')
    expect(disabled).not.toContain('canvasEnabled')
    expect(capabilityState({ capabilityProfile: 'personal' }).locked).toEqual([
      'canvasEnabled', 'shellEnabled', 'teamChatEnabled', 'boardAdminEnabled', 'companyOpsEnabled',
    ])
  })
})


describe('buildCapabilityStatusSection per scope', () => {
  test('a workspace session is titled for the workspace and applies its defaults', () => {
    const text = buildCapabilityStatusSection({}, { scope: 'workspace' })
    expect(text).toContain('## Workspace capabilities')
    expect(text).not.toContain('## Project capabilities')
    // The workspace agent is opted in to running a company by default.
    expect(text).toContain('Board management (`boardAdminEnabled`)')
    expect(text).toContain('Company operations (`companyOpsEnabled`)')
    expect(text).not.toContain('for this project')
  })

  test('a workspace session reads the workspace\'s own toggles, not an anchor project\'s', () => {
    const workspace = buildCapabilityStatusSection({ boardAdminEnabled: false }, { scope: 'workspace' })
    expect(workspace).toContain('Disabled:')
    expect(workspace).toContain('Board management (`boardAdminEnabled`)')
    const project = buildCapabilityStatusSection({ boardAdminEnabled: true }, { scope: 'project' })
    expect(project).toContain('## Project capabilities')
    expect(project).toContain('Board management (`boardAdminEnabled`)')
  })

  test('a project chat is titled with the project name', () => {
    const text = buildCapabilityStatusSection({}, { scope: 'project', projectName: 'Shogo Planner' })
    expect(text).toContain('## Project capabilities (Shogo Planner)')
  })

  test('the anchor project is a separate pointer, never part of the workspace list', () => {
    const text = buildCapabilityStatusSection({}, {
      scope: 'workspace',
      projectName: 'Shogo Planner',
      anchorProjectName: 'Shogo Planner',
    })
    expect(text.startsWith('## Workspace capabilities')).toBe(true)
    expect(text).not.toContain('## Project capabilities (Shogo Planner)')
    const pointer = text.split('\n').find((line) => line.includes('Project chats run with their own toggles'))
    expect(pointer).toContain('**Shogo Planner**')
  })
})
