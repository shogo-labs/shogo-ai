// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { workspaceInView, workspaceInViewWhileLoading } from '../workspace-in-view'

describe('workspaceInView (SHO-285)', () => {
  test('a cloud workspace is in view as itself', () => {
    expect(workspaceInView({ id: 'ws-1', name: 'Acme', kind: 'team' })).toEqual({
      id: 'ws-1',
      name: 'Acme',
      kind: 'team',
      host: 'cloud',
    })
  })

  test('a hosted workspace keeps its own id and names its host', () => {
    expect(workspaceInView({ id: 'ws-2', name: 'Samsara', kind: 'personal', hostInstanceId: 'inst-odin' })).toEqual({
      id: 'ws-2',
      name: 'Samsara',
      kind: 'personal',
      host: 'machine',
      instanceId: 'inst-odin',
    })
  })

  test('nothing selected is nothing in view', () => {
    expect(workspaceInView(null)).toBeNull()
    expect(workspaceInView({ id: null })).toBeNull()
  })
})

describe('workspaceInViewWhileLoading (SHO-309)', () => {
  const personal = { id: 'ws-1', name: 'Local User Personal', kind: 'personal' as const, host: 'cloud' as const }
  const team = { id: 'ws-2', name: 'Acme', kind: 'team' as const, host: 'cloud' as const }

  test('the loaded workspace always wins', () => {
    expect(workspaceInViewWhileLoading(team, personal, 'ws-1', 'personal')).toBe(team)
  })

  test('a refresh keeps the workspace that is already on screen', () => {
    // `useActiveWorkspace()` is null for the whole of every `loadAll()`.
    expect(workspaceInViewWhileLoading(null, personal, 'ws-1', 'personal')).toBe(personal)
  })

  test('a remount with no answer yet uses the persisted selection and its cached kind', () => {
    // Every reopen remounts this screen inside a collection refresh: no
    // workspace object, no `lastInView`, but the person's selection is on the
    // device — which is what the chat's boot record is keyed by.
    expect(workspaceInViewWhileLoading(null, null, 'ws-1', 'personal')).toEqual({
      id: 'ws-1',
      name: 'ws-1',
      kind: 'personal',
      host: 'cloud',
    })
  })

  test('a switch to another workspace does not keep showing the old one', () => {
    // The selection moved first (that is how a switch is persisted), so the
    // workspace on screen is not the one being opened.
    expect(workspaceInViewWhileLoading(null, personal, 'ws-2', null)).toBeNull()
    expect(workspaceInViewWhileLoading(null, personal, 'ws-2', 'team')).toEqual({
      id: 'ws-2',
      name: 'ws-2',
      kind: 'team',
      host: 'cloud',
    })
  })

  test('an id this device never resolved is not a workspace yet', () => {
    // No cached kind: showing a chat here would be guessing which shell and
    // which session source the id belongs to.
    expect(workspaceInViewWhileLoading(null, null, 'ws-new', null)).toBeNull()
    expect(workspaceInViewWhileLoading(null, personal, null, 'personal')).toBeNull()
  })
})
