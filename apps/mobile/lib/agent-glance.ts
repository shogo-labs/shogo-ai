// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The one small picture of "what are my agents doing" that every glanceable
 * surface shows: Home Screen and Lock Screen widgets, the iOS Live Activity,
 * the Android ongoing notification. Built once here, so no platform shapes its
 * own data. Pure; `AgentGlancePublisher` builds it and hands it to the sinks.
 */
import { glowHex } from './agent-glow'
import { stateLabel, type AgentRow, type AgentUrgencyState } from './agent-urgency'

export const GLANCE_VERSION = 1
/** Widgets and notifications have room for a handful of agents, not a directory. */
export const GLANCE_MAX_AGENTS = 8

export interface GlanceQuestion {
  id: string
  prompt: string
  options: string[]
}

export interface GlanceAgent {
  /** The agent's key: its project id, or `ws` for the workspace agent. */
  id: string
  name: string
  state: AgentUrgencyState
  stateLabel: string
  detail: string
  /** `#rrggbb`, already safe to glow in. */
  color: string
  /** When state is `needs_you` because of an approval. */
  approval: { messageId: string; conversationId: string; summary: string } | null
  question: GlanceQuestion | null
  /** `shogo://agents/<id>` */
  link: string
  updatedAt: number
}

export interface AgentGlanceSnapshot {
  version: typeof GLANCE_VERSION
  generatedAt: number
  workspaceId: string | null
  /** Agents waiting on you, counted before the list is cut to the widget size. */
  waiting: number
  /** Agents working right now, counted the same way. */
  working: number
  agents: GlanceAgent[]
}

export const AGENT_LINK_PREFIX = 'shogo://agents/'

export function agentDeepLink(id: string): string {
  return `${AGENT_LINK_PREFIX}${encodeURIComponent(id)}`
}

/** The agent id in a `shogo://agents/<id>` link, or null for any other URL. */
export function parseAgentDeepLink(url: string | null | undefined): string | null {
  if (!url || !url.startsWith(AGENT_LINK_PREFIX)) return null
  const rest = url.slice(AGENT_LINK_PREFIX.length).split(/[?#]/)[0].replace(/\/+$/, '')
  if (!rest) return null
  try {
    return decodeURIComponent(rest)
  } catch {
    return null
  }
}

export function buildGlanceSnapshot(input: {
  rows: readonly AgentRow[]
  /** An agent's own colour by key; agents missing here glow the default blue. */
  colors?: Readonly<Record<string, string | null | undefined>>
  questions?: Readonly<Record<string, GlanceQuestion | undefined>>
  workspaceId?: string | null
  now?: number
}): AgentGlanceSnapshot {
  const colors = input.colors ?? {}
  const questions = input.questions ?? {}
  const agents: GlanceAgent[] = input.rows.slice(0, GLANCE_MAX_AGENTS).map((row) => ({
    id: row.key,
    name: row.name,
    state: row.state,
    stateLabel: stateLabel(row.state),
    detail: row.detail,
    color: glowHex(colors[row.key]),
    approval: row.approval
      ? { messageId: row.approval.messageId, conversationId: row.approval.conversationId, summary: row.approval.summary }
      : null,
    question: questions[row.key] ?? null,
    link: agentDeepLink(row.key),
    updatedAt: row.at,
  }))
  return {
    version: GLANCE_VERSION,
    generatedAt: input.now ?? Date.now(),
    workspaceId: input.workspaceId ?? null,
    waiting: input.rows.filter((r) => r.state === 'needs_you').length,
    working: input.rows.filter((r) => r.state === 'running').length,
    agents,
  }
}

/** Whether two snapshots show different things; the time they were built at does not count. */
export function glanceChanged(prev: AgentGlanceSnapshot | null, next: AgentGlanceSnapshot): boolean {
  if (!prev) return true
  return JSON.stringify({ ...prev, generatedAt: 0 }) !== JSON.stringify({ ...next, generatedAt: 0 })
}
