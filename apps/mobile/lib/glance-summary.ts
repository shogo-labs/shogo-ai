// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The words every glanceable surface uses for a snapshot, so the Android
 * widget and ongoing notification say what the iOS widgets say. The Swift
 * widgets (`targets/widgets/AgentsWidget.swift`) follow the same rules.
 */
import type { AgentGlanceSnapshot, GlanceAgent } from './agent-glance'

/** A snapshot this old is not shown as if it were current. */
export const GLANCE_STALE_MS = 6 * 60 * 60 * 1000

export function isGlanceStale(snapshot: AgentGlanceSnapshot | null, now: number): boolean {
  return !snapshot || now - snapshot.generatedAt > GLANCE_STALE_MS
}

export function glanceHeadline(snapshot: AgentGlanceSnapshot | null, now: number): string {
  if (!snapshot || isGlanceStale(snapshot, now)) return 'Open Shogo'
  if (snapshot.waiting > 0) return snapshot.waiting === 1 ? '1 needs you' : `${snapshot.waiting} need you`
  if (snapshot.working > 0) return snapshot.working === 1 ? '1 working' : `${snapshot.working} working`
  return 'All quiet'
}

/** What to say under an agent's name: what it wants if it is waiting, else what it is doing. */
export function glanceAgentSubtitle(agent: GlanceAgent): string {
  if (agent.approval?.summary) return agent.approval.summary
  return agent.detail || agent.stateLabel
}

/** The agents worth showing, or none when the snapshot is stale. */
export function glanceAgents(snapshot: AgentGlanceSnapshot | null, now: number, limit: number): GlanceAgent[] {
  if (!snapshot || isGlanceStale(snapshot, now)) return []
  return snapshot.agents.slice(0, limit)
}
