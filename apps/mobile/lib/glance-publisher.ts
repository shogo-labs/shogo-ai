// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Hands each new glance snapshot to the surfaces that show it. A surface (iOS
 * widgets, Android widgets, the Live Activity) registers a sink; this module
 * skips snapshots that changed nothing and never lets one sink's failure
 * reach the app or another sink.
 */
import { glanceChanged, type AgentGlanceSnapshot } from './agent-glance'

export type GlanceSink = (snapshot: AgentGlanceSnapshot) => void | Promise<void>

const sinks = new Set<GlanceSink>()
let last: AgentGlanceSnapshot | null = null

/** Register a surface. It is handed the latest snapshot straight away, if there is one. */
export function registerGlanceSink(sink: GlanceSink): () => void {
  sinks.add(sink)
  if (last) void run(sink, last)
  return () => sinks.delete(sink)
}

async function run(sink: GlanceSink, snapshot: AgentGlanceSnapshot) {
  try {
    await sink(snapshot)
  } catch (err) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn('[glance] sink failed:', (err as Error)?.message)
  }
}

/** Returns true when the snapshot differed from the last one and was sent on. */
export async function publishGlance(snapshot: AgentGlanceSnapshot): Promise<boolean> {
  if (!glanceChanged(last, snapshot)) return false
  last = snapshot
  await Promise.all([...sinks].map((sink) => run(sink, snapshot)))
  return true
}

export function latestGlance(): AgentGlanceSnapshot | null {
  return last
}

export function _resetGlanceForTests(): void {
  sinks.clear()
  last = null
}
