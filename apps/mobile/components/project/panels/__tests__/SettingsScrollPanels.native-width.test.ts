// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function readPanel(name: string): string {
  return readFileSync(resolve(import.meta.dir, `../${name}`), 'utf8')
}

describe('native settings panes scroll and fill the phone width', () => {
  test('StatusPanel pins a bounded ScrollView', () => {
    const source = readPanel('StatusPanel.tsx')
    expect(source).toContain('nativeSettingsPaneStyle')
    expect(source).toContain('alwaysBounceVertical={comfortable}')
    expect(source).toContain('nestedScrollEnabled')
    expect(source).toContain('nativeTwoColumnCardWidth')
    expect(source).toContain('collapsable={false}')
    expect(source).not.toContain('w-[48%]')
  })

  test('AnalyticsPanel pins a bounded ScrollView', () => {
    const source = readPanel('AnalyticsPanel.tsx')
    expect(source).toContain('nativeSettingsPaneStyle')
    expect(source).toContain('alwaysBounceVertical={comfortable}')
    expect(source).toContain('nestedScrollEnabled')
    expect(source).toContain('periodTrackWidth')
    expect(source).toContain('NATIVE_PHONE_CONTROL_SIZE')
    expect(source).toContain('collapsable={false}')
    expect(source).not.toContain('w-[48%]')
  })

  test('LogsPanel fills the pane and lets rows use the full width', () => {
    const source = readPanel('LogsPanel.tsx')
    expect(source).toContain('nativeSettingsPaneStyle')
    expect(source).toContain('alwaysBounceVertical={comfortable}')
    expect(source).toContain('nestedScrollEnabled')
    expect(source).toContain('getItemLayout={comfortable ? undefined : getItemLayout}')
    expect(source).toContain('flex: 1, minWidth: 0, flexShrink: 1')
    expect(source).toContain('collapsable={false}')
    expect(source).not.toContain('#09090b')
  })
})
