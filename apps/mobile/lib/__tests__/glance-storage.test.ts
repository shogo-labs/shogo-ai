// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildGlanceSnapshot } from '../agent-glance'
import { GLANCE_APP_GROUP, GLANCE_STORAGE_KEY, createWidgetSink } from '../glance-storage'

const root = fileURLToPath(new URL('../..', import.meta.url))

describe('createWidgetSink', () => {
  test('writes the snapshot as JSON under the shared key, then reloads the widgets', async () => {
    const writes: Array<[string, string]> = []
    let reloads = 0
    const sink = createWidgetSink({ set: (k, v) => void writes.push([k, v]) }, () => void reloads++)
    const snapshot = buildGlanceSnapshot({ rows: [], now: 5 })
    await sink(snapshot)
    expect(writes).toHaveLength(1)
    expect(writes[0][0]).toBe(GLANCE_STORAGE_KEY)
    expect(JSON.parse(writes[0][1])).toEqual(snapshot)
    expect(reloads).toBe(1)
  })
})

describe('shared native config', () => {
  test('the app and the widget target use the same App Group', () => {
    const appJson = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8'))
    const plugins: unknown[] = appJson.expo.plugins
    const widgetsEnabled = plugins.some((p) => (Array.isArray(p) ? p[0] : p) === '@bacons/apple-targets')
    const appGroups = appJson.expo.ios.entitlements?.['com.apple.security.application-groups'] ?? []
    if (widgetsEnabled) expect(appGroups).toContain(GLANCE_APP_GROUP)
    else expect(appGroups).not.toContain(GLANCE_APP_GROUP)
    const target = readFileSync(join(root, 'targets/widgets/expo-target.config.js'), 'utf8')
    expect(target).toContain('application-groups')
  })

  test('the Swift side reads the same group and key', () => {
    const swift = readFileSync(join(root, 'targets/widgets/GlanceModel.swift'), 'utf8')
    expect(swift).toContain(`"${GLANCE_APP_GROUP}"`)
    expect(swift).toContain(`"${GLANCE_STORAGE_KEY}"`)
  })
})
