// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it } from 'vitest'
import { workspaceExperience } from '../useWorkspaceExperience'

describe('workspaceExperience', () => {
  it('team (and unknown/undefined kind) gets the full builder shell', () => {
    for (const kind of ['team', undefined, null, '', 'bogus'] as const) {
      const exp = workspaceExperience(kind)
      expect(exp.kind).toBe('team')
      expect(exp.homeScreen).toBe('builder')
      expect(exp.showProjectsTree).toBe(true)
      expect(exp.showMarketplace).toBe(true)
      expect(exp.showNewChat).toBe(true)
      expect(exp.showGoalsNav).toBe(false)
      expect(exp.showSideChatsNav).toBe(false)
      expect(exp.bottomTabs).toEqual(['chat', 'tasks', 'activity', 'canvases'])
      expect(exp.chatReturnsToProjectContext).toBe(true)
      expect(exp.composer.showModelPicker).toBe(true)
      expect(exp.composer.showInteractionModes).toBe(true)
      expect(exp.composer.forcedMode).toBeUndefined()
    }
  })

  it('personal gets the simplified companion shell', () => {
    const exp = workspaceExperience('personal')
    expect(exp.kind).toBe('personal')
    expect(exp.homeScreen).toBe('companion')
    expect(exp.showProjectsTree).toBe(false)
    expect(exp.showMarketplace).toBe(false)
    expect(exp.showNewChat).toBe(false)
    expect(exp.showGoalsNav).toBe(true)
    expect(exp.showSideChatsNav).toBe(true)
    expect(exp.bottomTabs).toEqual(['chat', 'goals', 'activity'])
    expect(exp.chatReturnsToProjectContext).toBe(false)
    expect(exp.composer.showModelPicker).toBe(false)
    expect(exp.composer.showInteractionModes).toBe(false)
    expect(exp.composer.forcedMode).toBe('agent')
  })

  it('is a pure function of kind (no shared mutable state between calls)', () => {
    const a = workspaceExperience('personal')
    a.bottomTabs.push('canvases')
    const b = workspaceExperience('personal')
    expect(b.bottomTabs).toEqual(['chat', 'goals', 'activity'])
  })
})
