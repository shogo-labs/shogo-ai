// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const mobileRoot = resolve(import.meta.dir, '../../..')
const source = readFileSync(resolve(mobileRoot, 'components/project/ProjectTopBar.tsx'), 'utf8')

describe('ProjectTopBar IDE alignment toggle wiring', () => {
  test('renders an icon-only IDE alignment toggle guarded to the active IDE tab', () => {
    expect(source).toContain('testID="ide-sidebar-alignment-toggle"')
    expect(source).toContain("Platform.OS === 'web' && getTabActive('ide')")
    expect(source).toContain('!!onIdePrimarySideBarPositionChange')
    expect(source).not.toContain('Files left')
    expect(source).not.toContain('Files right')
  })

  test('defaults the top-bar control to left alignment and toggles to the opposite side', () => {
    expect(source).toContain("idePrimarySideBarPosition = 'left'")
    expect(source).toContain("idePrimarySideBarPosition === 'left' ? 'right' : 'left'")
    expect(source).toContain('onIdePrimarySideBarPositionChange?.(nextIdePrimarySideBarPosition)')
  })

  test('places the toggle in the right actions area after upgrade/open-workbench controls', () => {
    const rightActionsIndex = source.indexOf('{/* Right actions */}')
    const rightActionsSource = source.slice(rightActionsIndex)
    const openWorkbenchIndex = rightActionsSource.indexOf('onOpenCodeWorkbench')
    const toggleIndex = rightActionsSource.indexOf('{showIdeAlignmentControl && renderIdeAlignmentControl()}')

    expect(rightActionsIndex).toBeGreaterThan(-1)
    expect(openWorkbenchIndex).toBeGreaterThan(-1)
    expect(toggleIndex).toBeGreaterThan(openWorkbenchIndex)
  })
})
