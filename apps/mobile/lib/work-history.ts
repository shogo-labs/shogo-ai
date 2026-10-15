// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** Plain-language lines for a card's history: who did what to it, and when. */
import type { Mentionables } from './team-chat-api'
import { agentName } from './board-layout'
import type { WorkItemEvent } from './work-boards-api'

export function actorName(event: Pick<WorkItemEvent, 'actorUserId' | 'actorAgentRef'>, mentionables: Mentionables | null): string {
  if (event.actorAgentRef) return agentName(event.actorAgentRef, mentionables)
  if (event.actorUserId) return mentionables?.people.find((p) => p.id === event.actorUserId)?.name ?? 'Someone'
  return 'Shogo'
}

const FIELD_LABEL: Record<string, string> = {
  title: 'the title',
  description: 'the description',
  priority: 'the priority',
  dueAt: 'the due date',
  fields: 'the fields',
}

const MOVE_REASON: Record<string, string> = {
  column_deleted: ' (its column was removed)',
  agent_failed: ' after the agent hit an error',
}

/** "Ada moved it from Triage to In progress", or null for events not worth a line. */
export function describeEvent(event: WorkItemEvent, mentionables: Mentionables | null): string | null {
  const who = actorName(event, mentionables)
  const d = event.data ?? {}
  switch (event.type) {
    case 'created':
      return `${who} created it in ${d.column ?? 'the board'}`
    case 'moved': {
      const from = d.from?.board && d.to?.board && d.from.board !== d.to.board ? `${d.from.board} › ${d.from.column}` : d.from?.column
      const to = d.from?.board && d.to?.board && d.from.board !== d.to.board ? `${d.to.board} › ${d.to.column}` : d.to?.column
      const reason = typeof d.reason === 'string' ? MOVE_REASON[d.reason] ?? '' : ''
      return `${who} moved it from ${from ?? '?'} to ${to ?? '?'}${reason}`
    }
    case 'regressed':
      return `It reopened after being closed in ${d.from ?? 'a closed column'}`
    case 'assigned':
      return d.label ? `${who} assigned it to ${d.label}` : `${who} unassigned it`
    case 'updated': {
      const changed: string[] = Array.isArray(d.changed) ? d.changed : []
      const names = changed.map((c) => FIELD_LABEL[c] ?? c)
      return names.length ? `${who} changed ${names.join(', ')}` : `${who} edited it`
    }
    case 'summarized':
      return `${who} updated the summary`
    case 'commented':
      return `${who} commented: ${String(d.text ?? '').slice(0, 280)}`
    case 'archived':
      return `${who} archived it`
    case 'restored':
      return `${who} restored it`
    case 'linked':
      return `${who} linked ${d.kind === 'chat_session' ? 'an agent run' : `a ${String(d.kind ?? 'reference').replace(/_/g, ' ')}`}`
    case 'occurrence':
      return [`It happened again`, d.environment && `in ${d.environment}`, d.release && `on ${d.release}`].filter(Boolean).join(' ')
    case 'agent_woken':
      return `${agentName(String(d.agentRef ?? 'workspace'), mentionables)} picked it up${d.reason ? ` (${d.reason})` : ''}`
    case 'agent_wake_skipped':
      return d.reason === 'rate_limited' ? `${agentName(String(d.agentRef ?? 'workspace'), mentionables)} was not woken again this hour` : null
    case 'agent_failed':
      return `${who} hit an error working on it`
    default:
      return null
  }
}

export function when(iso: string, now = new Date()): string {
  const date = new Date(iso)
  const sameDay = date.toDateString() === now.toDateString()
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return time
  const sameYear = date.getFullYear() === now.getFullYear()
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })} ${time}`
}
