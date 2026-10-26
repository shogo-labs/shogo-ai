// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The ⚙️ in the bottom nav means "this project's settings" while you are in a
 * project, and "workspace settings" on Home (SHO-220, plan Part 1 item 5).
 *
 * Before the fix both descriptors called `setOpenProjectSettings(false)`, so the
 * gear inside a project opened the account/workspace sheet and the project's own
 * settings were unreachable from the nav.
 *
 * The decision is tested directly rather than by rendering the dock: mounting
 * `MobileBottomNav` pulls in the settings sheet and the whole project settings
 * tree, which is far more surface than this one boolean deserves.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { settingsTargetFor } from '../../../lib/bottom-nav-settings'

const source = readFileSync(join(import.meta.dir, '../MobileBottomNav.tsx'), 'utf8')

describe('settingsTargetFor', () => {
  test('in a project the gear targets that project’s settings', () => {
    expect(settingsTargetFor(true)).toEqual({ openProjectSettings: true })
  })

  test('on Home the gear targets workspace settings', () => {
    expect(settingsTargetFor(false)).toEqual({ openProjectSettings: false })
  })
})

describe('the dock uses it for both items', () => {
  test('project mode asks for project settings, Home does not', () => {
    expect(source).toMatch(/onPress: \(\) => openSettings\(settingsTargetFor\(true\)\)/)
    expect(source).toMatch(/onPress: \(\) => openSettings\(settingsTargetFor\(false\)\)/)
  })

  test('both items open the same sheet with the target they asked for', () => {
    // One place sets the flag, so a new item cannot skip it.
    expect(source).toMatch(
      /const openSettings = \(target: \{ openProjectSettings: boolean \}\) => \{\s*setOpenProjectSettings\(target\.openProjectSettings\);\s*setSettingsOpen\(true\);/,
    )
    expect(source).toMatch(/openProjectSettings=\{openProjectSettings\}/)
  })
})
