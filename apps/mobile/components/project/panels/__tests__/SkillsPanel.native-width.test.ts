// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve(import.meta.dir, '../SkillsPanel.tsx'), 'utf8')

describe('SkillsPanel native phone width', () => {
  test('fills the settings pane so the list can scroll', () => {
    expect(source).toContain('nativeSettingsPaneStyle')
    expect(source).toContain('alwaysBounceVertical={comfortable}')
    expect(source).toContain('collapsable={false}')
    expect(source).toContain('NATIVE_PHONE_PICKER_INSET')
  })

  test('library button stretches beside the refresh control', () => {
    expect(source).toContain('nativeSkillsActionWidths')
    expect(source).toContain('nativeChrome.actionRow')
    expect(source).toContain('actionWidths.library')
    expect(source).toContain('nativeChrome.cta')
  })
})
