// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Team chat for agents: list, read, search and post in the workspace's
 * channels, and DM a teammate. Posts are attributed to this runtime's agent
 * (the workspace agent, or the project's agent in a project runtime).
 */

import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { ToolContext } from './gateway-tools'
import { textResult } from './gateway-tools'
import { resolveRuntimeIdentity } from './workspace-runtime-mode'
import {
  getTeamDirectory,
  listAgentChannels,
  postAgentChannelMessage,
  readAgentChannel,
  searchAgentChannels,
  sendAgentDirectMessage,
  type AgentChannelIdentity,
} from './internal-api'

export const CHANNEL_TOOL_NAMES = [
  'team_chat_list',
  'team_chat_read',
  'team_chat_post',
  'team_chat_search',
  'team_chat_dm',
  'team_directory',
] as const

/** True when this runtime registers the team chat tools (non-personal workspace runtimes). */
export function teamChatToolsAvailable(capabilityProfile?: string): boolean {
  return capabilityProfile !== 'personal' && !!(resolveRuntimeIdentity().workspaceId || process.env.WORKSPACE_ID)
}

export const TEAM_CHAT_GUIDE = [
  '## Team Chat',
  '',
  "You're a teammate in this workspace's team chat, alongside people and other agents. When a channel message wakes you:",
  '- Reply in the thread you were woken in. Your final reply is posted there automatically.',
  '- Hand work to another agent by tagging it (`@Planner`, or its tag from `team_directory`). It runs next in the same thread; say exactly what you need from it.',
  '- Tag people only when you need a decision or approval from them, and ask one clear question.',
  '- Keep messages short. Put long content (plans, logs, diffs) in files or links and reference them.',
  '- Use `team_chat_dm` to escalate something urgent to one person instead of tagging a whole channel.',
  '- Respect Do Not Disturb: when someone is away, leave the question in the thread rather than pinging them repeatedly.',
  '- Starting a new piece of work? Post a top-level message with `team_chat_post` (pass `run_id` if you track one); you own that thread and unaddressed replies there come to you.',
].join('\n')

function workspaceIdOf(ctx: ToolContext): string | null {
  return resolveRuntimeIdentity().workspaceId || ctx.workspaceId || null
}

export function channelIdentity(ctx: ToolContext): AgentChannelIdentity {
  const identity = resolveRuntimeIdentity()
  if (identity.mode === 'workspace') return { projectId: null }
  return { projectId: identity.projectId || ctx.projectId || null }
}

function noWorkspace() {
  return textResult({ error: 'This runtime has no workspace context, so team chat is unavailable.', code: 'no_workspace' })
}

function apiError(result: { error?: string; code?: string; status?: number }, fallback: string) {
  return textResult({ error: result.error ?? fallback, code: result.code, status: result.status })
}

export function createChannelListTool(ctx: ToolContext): AgentTool {
  return {
    name: 'team_chat_list',
    label: 'List Channels',
    description: "List the workspace's public team chat channels (name, topic, last activity).",
    parameters: Type.Object({}),
    execute: async () => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const result = await listAgentChannels(workspaceId)
      return result.ok ? textResult({ ok: true, channels: result.data ?? [] }) : apiError(result, 'Could not list channels')
    },
  }
}

export function createChannelReadTool(ctx: ToolContext): AgentTool {
  return {
    name: 'team_chat_read',
    label: 'Read Channel',
    description:
      'Read recent messages from a team chat channel (by name like "general" or by id), or one thread when ' +
      'thread_id is given. Use to catch up on discussion before answering or reporting.',
    parameters: Type.Object({
      channel: Type.String({ description: 'Channel name (without #) or conversation id.' }),
      thread_id: Type.Optional(Type.String({ description: 'Root message id to read a single thread.' })),
      limit: Type.Optional(Type.Number({ description: 'Max messages (default 30, max 100).' })),
    }),
    execute: async (_id, params) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const input = params as { channel: string; thread_id?: string; limit?: number }
      const result = await readAgentChannel(workspaceId, input.channel.replace(/^#/, ''), {
        limit: input.limit,
        threadRootId: input.thread_id,
      })
      return result.ok ? textResult({ ok: true, ...result.data }) : apiError(result, 'Could not read the channel')
    },
  }
}

export function createChannelPostTool(ctx: ToolContext): AgentTool {
  return {
    name: 'team_chat_post',
    label: 'Post to Channel',
    description:
      'Post a message to a team chat channel as yourself, optionally as a reply in a thread. Use to share ' +
      'results, status updates or questions with the team, or to start a thread for a piece of work. ' +
      'Tag teammates by name (@Planner, @Jane Doe, @maintainers) or with tags from team_directory ' +
      '(<@a:p:PROJECT_ID> for an agent, <@u:USER_ID> for a person, <@g:GROUP_ID> for a group). ' +
      'Tagging an agent hands work to it: it runs next and replies in the thread. ' +
      'A new top-level post makes you the owner of its thread, so unaddressed human replies there come to you. ' +
      'Do not use this to reply to the message you were mentioned in; your normal reply is posted there automatically. ' +
      'Returns thread_id (for follow-ups) and url (a link to the thread for people outside Shogo).',
    parameters: Type.Object({
      channel: Type.String({ description: 'Channel name (without #) or conversation id.' }),
      text: Type.String({ description: 'Markdown message text.' }),
      thread_id: Type.Optional(Type.String({ description: 'Root message id to reply in a thread.' })),
      owner: Type.Optional(Type.Boolean({ description: 'Take ownership of the thread when replying in one (default: only for new top-level posts).' })),
      run_id: Type.Optional(Type.String({ description: 'Id of the run or work item this thread tracks; stored on the thread and shown to agents woken in it.' })),
    }),
    execute: async (_id, params) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const input = params as { channel: string; text: string; thread_id?: string; owner?: boolean; run_id?: string }
      if (!input.text?.trim()) return textResult({ error: 'text is required', code: 'invalid_input' })
      const result = await postAgentChannelMessage(workspaceId, input.channel.replace(/^#/, ''), {
        text: input.text,
        threadRootId: input.thread_id,
        identity: channelIdentity(ctx),
        sessionId: ctx.sessionId,
        owner: input.owner,
        runId: input.run_id,
      })
      if (result.ok && result.data) {
        const { threadId, ...rest } = result.data
        return textResult({ ok: true, ...rest, thread_id: threadId })
      }
      return apiError(result, 'Could not post the message')
    },
  }
}

export function createChannelSearchTool(ctx: ToolContext): AgentTool {
  return {
    name: 'team_chat_search',
    label: 'Search Team Chat',
    description: 'Search messages in public team chat channels for a word or phrase. Returns matches with their channel.',
    parameters: Type.Object({
      query: Type.String({ description: 'Words or phrase to look for.' }),
      limit: Type.Optional(Type.Number({ description: 'Max results (default 20, max 50).' })),
    }),
    execute: async (_id, params) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const input = params as { query: string; limit?: number }
      const result = await searchAgentChannels(workspaceId, input.query, input.limit)
      return result.ok ? textResult({ ok: true, results: result.data ?? [] }) : apiError(result, 'Could not search team chat')
    },
  }
}

export function createDmUserTool(ctx: ToolContext): AgentTool {
  return {
    name: 'team_chat_dm',
    label: 'Message a Teammate',
    description:
      'Send a direct message to a workspace member (by email or user id) as yourself. Use to ask someone a ' +
      'question, escalate, hand off work, or deliver a result to a specific person.',
    parameters: Type.Object({
      user: Type.String({ description: 'Email address or user id of the teammate.' }),
      text: Type.String({ description: 'Markdown message text.' }),
    }),
    execute: async (_id, params) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const input = params as { user: string; text: string }
      if (!input.text?.trim()) return textResult({ error: 'text is required', code: 'invalid_input' })
      const result = await sendAgentDirectMessage(workspaceId, {
        user: input.user,
        text: input.text,
        identity: channelIdentity(ctx),
        sessionId: ctx.sessionId,
      })
      return result.ok ? textResult({ ok: true, ...result.data }) : apiError(result, 'Could not send the message')
    },
  }
}

export function createTeamDirectoryTool(ctx: ToolContext): AgentTool {
  return {
    name: 'team_directory',
    label: 'Team Directory',
    description:
      'List who you can tag in team chat: people (name, email), agents (name and role) and groups, each with the ' +
      'tag to put in a message. Use before handing work to another agent or asking a person for a decision.',
    parameters: Type.Object({}),
    execute: async () => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const result = await getTeamDirectory(workspaceId)
      return result.ok ? textResult({ ok: true, ...result.data }) : apiError(result, 'Could not load the team directory')
    },
  }
}

export function createChannelTools(ctx: ToolContext): AgentTool[] {
  return [
    createChannelListTool(ctx),
    createChannelReadTool(ctx),
    createChannelPostTool(ctx),
    createChannelSearchTool(ctx),
    createDmUserTool(ctx),
    createTeamDirectoryTool(ctx),
  ]
}
