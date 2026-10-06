// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * How a glance snapshot reaches the iOS widgets. The widget runs in its own
 * process and cannot reach the app's JS, so the app writes the snapshot as JSON
 * into the shared App Group and asks WidgetKit to redraw.
 *
 * `GLANCE_APP_GROUP` must match `ios.entitlements` in app.json and
 * `targets/widgets/expo-target.config.js`; `GLANCE_STORAGE_KEY` must match
 * `GlanceStore.key` in `targets/widgets/GlanceModel.swift`.
 */
import type { AgentGlanceSnapshot } from './agent-glance'
import type { GlanceSink } from './glance-publisher'

export const GLANCE_APP_GROUP = 'group.ai.shogo.app'
export const GLANCE_STORAGE_KEY = 'glance'

export interface WidgetStorage {
  set(key: string, value: string): void
}

/** A sink that writes the snapshot where the widgets read it, then reloads them. */
export function createWidgetSink(storage: WidgetStorage, reloadWidgets: () => void): GlanceSink {
  return (snapshot: AgentGlanceSnapshot) => {
    storage.set(GLANCE_STORAGE_KEY, JSON.stringify(snapshot))
    reloadWidgets()
  }
}
