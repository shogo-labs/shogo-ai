// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Meeting memory for the personal companion: search, read and regenerate
 * the user's meeting notes. Meetings are private to the personal workspace,
 * so `createTools()` only registers these for the personal profile.
 */

import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { ToolContext } from './gateway-tools'
import { textResult } from './gateway-tools'
import {
  createMeetingNote,
  enhanceMeeting,
  listMeetings,
  listMeetingTemplates,
  readMeetingMarkdown,
  searchMeetings,
} from './internal-api'

export const MEETING_TOOL_NAMES = [
  'meeting_search',
  'meeting_list',
  'meeting_read',
  'meeting_enhance',
  'meeting_note_create',
] as const

/** Keeps a long meeting from swallowing the context window; head + tail hold the setup and decisions. */
const MAX_MEETING_MARKDOWN_CHARS = 40_000

function workspaceIdOf(ctx: ToolContext): string | null {
  return ctx.workspaceId || process.env.WORKSPACE_ID || null
}

function noWorkspace() {
  return textResult({
    error: 'This runtime has no workspace context, so meeting tools are unavailable.',
    code: 'no_workspace',
  })
}

function apiError(result: { error?: string; code?: string; status?: number }, fallback: string) {
  return textResult({ error: result.error ?? fallback, code: result.code, status: result.status })
}

export function clampMeetingMarkdown(markdown: string, maxChars = MAX_MEETING_MARKDOWN_CHARS): string {
  if (markdown.length <= maxChars) return markdown
  const half = Math.floor(maxChars / 2)
  return `${markdown.slice(0, half)}\n\n[... truncated ${markdown.length - maxChars} characters ...]\n\n${markdown.slice(-half)}`
}

export function createMeetingSearchTool(ctx: ToolContext): AgentTool {
  return {
    name: 'meeting_search',
    label: 'Search Meetings',
    description:
      "Search the user's recorded meetings (titles, their typed notes, enhanced notes and transcripts). " +
      'Use before meetings to brief the user on past conversations with the same people or topic, and ' +
      'whenever they ask what was said or decided. Returns ranked hits with snippets; follow up with meeting_read.',
    parameters: Type.Object({
      query: Type.String({ description: 'Names, company, topic or phrase to look for.' }),
      since_days: Type.Optional(Type.Number({ description: 'Only meetings from the last N days.' })),
      limit: Type.Optional(Type.Number({ description: 'Max results (default 10, max 50).' })),
    }),
    execute: async (_id, params) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const input = params as { query: string; since_days?: number; limit?: number }
      const result = await searchMeetings(workspaceId, input.query, { sinceDays: input.since_days, limit: input.limit })
      return result.ok ? textResult({ ok: true, results: result.data ?? [] }) : apiError(result, 'Could not search meetings')
    },
  }
}

export function createMeetingListTool(ctx: ToolContext): AgentTool {
  return {
    name: 'meeting_list',
    label: 'List Meetings',
    description: "List the user's most recent meetings, newest first, with their transcription and notes status.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: 'How many meetings (default 20, max 200).' })),
    }),
    execute: async (_id, params) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const limit = Math.min(Math.max((params as { limit?: number }).limit ?? 20, 1), 200)
      const result = await listMeetings(workspaceId, limit)
      return result.ok ? textResult({ ok: true, meetings: result.data ?? [] }) : apiError(result, 'Could not list meetings')
    },
  }
}

export function createMeetingReadTool(ctx: ToolContext): AgentTool {
  return {
    name: 'meeting_read',
    label: 'Read Meeting',
    description:
      "Read one meeting as markdown: the enhanced notes, action items and the user's own notes. " +
      'Set include_transcript only when the notes do not answer the question; transcripts are long.',
    parameters: Type.Object({
      meeting_id: Type.String(),
      include_transcript: Type.Optional(Type.Boolean({ description: 'Append the full transcript (default false).' })),
    }),
    execute: async (_id, params) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const input = params as { meeting_id: string; include_transcript?: boolean }
      const result = await readMeetingMarkdown(workspaceId, input.meeting_id, input.include_transcript === true)
      return result.ok
        ? textResult({ ok: true, markdown: clampMeetingMarkdown(result.data ?? '') })
        : apiError(result, 'Could not read the meeting')
    },
  }
}

export function createMeetingEnhanceTool(ctx: ToolContext): AgentTool {
  return {
    name: 'meeting_enhance',
    label: 'Rewrite Meeting Notes',
    description:
      "Regenerate a meeting's enhanced notes, optionally with a different template (e.g. builtin:one-on-one, " +
      'builtin:standup, builtin:customer-call, builtin:interview, builtin:brainstorm, or a custom template id). ' +
      'Runs in the background; the notes update in the Meetings screen when done. Omit template_id to list templates.',
    parameters: Type.Object({
      meeting_id: Type.Optional(Type.String()),
      template_id: Type.Optional(Type.String()),
    }),
    execute: async (_id, params) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const input = params as { meeting_id?: string; template_id?: string }
      if (!input.meeting_id) {
        const templates = await listMeetingTemplates(workspaceId)
        return templates.ok
          ? textResult({ ok: true, templates: templates.data ?? [] })
          : apiError(templates, 'Could not list templates')
      }
      const result = await enhanceMeeting(workspaceId, input.meeting_id, input.template_id)
      return result.ok
        ? textResult({ ok: true, meetingId: input.meeting_id, enhanceStatus: result.data?.enhanceStatus ?? 'running' })
        : apiError(result, 'Could not regenerate the notes')
    },
  }
}

export function createMeetingNoteCreateTool(ctx: ToolContext): AgentTool {
  return {
    name: 'meeting_note_create',
    label: 'Save Meeting Notes',
    description:
      'Save notes from a conversation that was not recorded (the user describes it in chat). ' +
      'Shogo writes them up with the default template so they show in Meetings and meeting_search.',
    parameters: Type.Object({
      notes: Type.String({ description: 'What was discussed, decided and promised, in the user’s words.' }),
      title: Type.Optional(Type.String()),
    }),
    execute: async (_id, params) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const input = params as { notes: string; title?: string }
      const result = await createMeetingNote(workspaceId, input)
      return result.ok ? textResult({ ok: true, meeting: result.data }) : apiError(result, 'Could not save the notes')
    },
  }
}

export function createMeetingTools(ctx: ToolContext): AgentTool[] {
  return [
    createMeetingSearchTool(ctx),
    createMeetingListTool(ctx),
    createMeetingReadTool(ctx),
    createMeetingEnhanceTool(ctx),
    createMeetingNoteCreateTool(ctx),
  ]
}
