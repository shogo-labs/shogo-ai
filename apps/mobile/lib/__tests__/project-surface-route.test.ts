// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-571: one builder for a project surface route, so the chat list's quick
 * buttons and the project tab bar cannot drift apart.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectSurfaceRoute } from '../project-surface-route'

const navSource = readFileSync(join(import.meta.dir, '../../components/layout/MobileBottomNav.tsx'), 'utf8')

describe('projectSurfaceRoute', () => {
  test('names the project, the surface and the tab it lights', () => {
    expect(projectSurfaceRoute('p1', 'files')).toEqual({
      pathname: '/(app)/project-surface/[id]',
      params: { id: 'p1', surface: 'files', navTab: 'files' },
    })
  })

  test('carries the chat when there is one, and leaves the key out when there is not', () => {
    expect(projectSurfaceRoute('p1', 'canvas', { chatSessionId: 's1' }).params).toEqual({
      id: 'p1',
      surface: 'canvas',
      navTab: 'canvas',
      chatSessionId: 's1',
    })
    expect(projectSurfaceRoute('p1', 'canvas', { chatSessionId: null }).params).not.toHaveProperty(
      'chatSessionId',
    )
  })
})

describe('the project tab bar opens surfaces through the same builder', () => {
  test('it calls the helper with the active project and the chat it holds', () => {
    expect(navSource).toMatch(
      /router\.replace\(projectSurfaceRoute\(activeProjectId, tab, \{ chatSessionId \}\)/,
    )
    // No second, inline copy of the route to drift.
    expect(navSource).not.toContain('pathname: "/(app)/project-surface/[id]"')
  })

  test('the settings surface lights the project gear, not Chat', () => {
    expect(navSource).toMatch(/if \(tab === "settings"\) return "more";/)
  })
})
