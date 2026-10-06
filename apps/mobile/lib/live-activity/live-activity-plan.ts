// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Decides what the Lock Screen Live Activity should do for a glance snapshot:
 * start when an agent needs you or is working, follow it as things change, and
 * end when nothing is left. Pure; `live-activity-controller.ts` carries it out.
 *
 * `AgentActivityProps` is also built by the API for pushes while the app is
 * closed (`apps/api/src/services/live-activity-push.ts`); keep them in step.
 */
import type { AgentGlanceSnapshot, GlanceAgent } from '../agent-glance'
import { glanceAgentSubtitle, glanceHeadline, isGlanceStale } from '../glance-summary'

export type AgentActivityState = 'needs_you' | 'running' | 'failed' | 'done'

export interface AgentActivityProps {
  agentId: string
  agentName: string
  state: AgentActivityState
  headline: string
  detail: string
  /** `#rrggbb` */
  color: string
  waiting: number
  working: number
  /** `shogo://agents/<id>` */
  link: string
  startedAt: number
}

export type LiveActivityAction =
  | { kind: 'none' }
  | { kind: 'start'; props: AgentActivityProps }
  | { kind: 'update'; props: AgentActivityProps }
  | { kind: 'end'; props: AgentActivityProps | null }

/** The agent the activity follows: one waiting on you, else one that is working. */
export function leadAgent(snapshot: AgentGlanceSnapshot | null, now: number): GlanceAgent | null {
  if (!snapshot || isGlanceStale(snapshot, now)) return null
  return snapshot.agents.find((a) => a.state === 'needs_you') ?? snapshot.agents.find((a) => a.state === 'running') ?? null
}

export function activityPropsFor(snapshot: AgentGlanceSnapshot, agent: GlanceAgent, now: number, startedAt?: number): AgentActivityProps {
  return {
    agentId: agent.id,
    agentName: agent.name,
    state: agent.state === 'needs_you' ? 'needs_you' : 'running',
    headline: glanceHeadline(snapshot, now),
    detail: glanceAgentSubtitle(agent),
    color: agent.color,
    waiting: snapshot.waiting,
    working: snapshot.working,
    link: agent.link,
    startedAt: startedAt ?? now,
  }
}

/** Whether two activities show different things; when they started does not count. */
export function activityPropsChanged(a: AgentActivityProps | null, b: AgentActivityProps): boolean {
  if (!a) return true
  return JSON.stringify({ ...a, startedAt: 0 }) !== JSON.stringify({ ...b, startedAt: 0 })
}

/** What the card says for its last moment on the Lock Screen. */
export function finishedProps(last: AgentActivityProps): AgentActivityProps {
  return { ...last, state: 'done', headline: 'Done', detail: 'Finished', waiting: 0, working: 0 }
}

export function planLiveActivity(input: {
  snapshot: AgentGlanceSnapshot | null
  /** An activity is on screen now. */
  running: boolean
  now: number
  last: AgentActivityProps | null
}): LiveActivityAction {
  const { snapshot, running, now, last } = input
  const lead = leadAgent(snapshot, now)
  if (!lead || !snapshot) {
    return running ? { kind: 'end', props: last ? finishedProps(last) : null } : { kind: 'none' }
  }
  // The card keeps its start time while it follows the same agent.
  const startedAt = last && last.agentId === lead.id ? last.startedAt : undefined
  const props = activityPropsFor(snapshot, lead, now, startedAt)
  if (!running) return { kind: 'start', props }
  return activityPropsChanged(last, props) ? { kind: 'update', props } : { kind: 'none' }
}
