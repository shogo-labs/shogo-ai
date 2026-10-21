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
import { mirrorApiTasks } from './remote-tasks'
import { resolveRuntimeIdentity } from './workspace-runtime-mode'
import { downloadedPath, pruneChatFiles, saveChatFile } from './chat-files'
import {
  getMemberActivity,
  getTeamDirectory,
  listAgentChannels,
  postAgentChannelMessage,
  readAgentChannel,
  readAgentChannelDoc,
  updateAgentChannelDoc,
  updateAgentChannelMessage,
  searchAgentChannels,
  sendAgentDirectMessage,
  addAgentChannelMembers,
  readAgentQuestionSecret,
  listAgentChatFiles,
  listRunningAgents,
  stopRunningAgents,
  readAgentChatFileText,
  searchAgentChatFiles,
  uploadAgentFile,
  type AgentChannelIdentity,
  type AgentDocMode,
  type AgentMessageKind,
  type AgentStatusCard,
} from './internal-api'
import { uploadWorkspaceMedia } from './workspace-media'

const KIND_SCHEMA = Type.Union(
  [Type.Literal('status'), Type.Literal('result'), Type.Literal('decision'), Type.Literal('alert')],
  { description: 'What this message is for. Only decision and alert notify people; status and result stay quiet.' },
)

const CARD_SCHEMA = Type.Object(
  {
    title: Type.String({ description: 'What this work is, e.g. "Fix coupon total on checkout".' }),
    status: Type.Optional(Type.Union(
      [Type.Literal('working'), Type.Literal('blocked'), Type.Literal('done'), Type.Literal('failed')],
      { description: 'Default working. Set done with a summary when finished.' },
    )),
    steps: Type.Optional(Type.Array(Type.String(), { description: 'Ordered steps, e.g. ["Triage", "Fix", "Review", "Merge"].' })),
    step: Type.Optional(Type.Number({ description: 'Index (from 0) of the step in progress.' })),
    criteria: Type.Optional(Type.Array(Type.String(), { description: 'What has to be true for this to be done. A reviewer works from these.' })),
    links: Type.Optional(Type.Array(Type.Object({ label: Type.Optional(Type.String()), url: Type.String() }), { description: 'Artifacts: PR, preview URL, ticket.' })),
    summary: Type.Optional(Type.String({ description: 'The outcome, once finished.' })),
  },
  { description: 'A status card: one message you keep up to date with team_chat_update instead of posting every step.' },
)

const QUESTIONS_SCHEMA = Type.Array(
  Type.Object({
    header: Type.String({ description: 'Very short label shown as a chip, max 40 chars, e.g. "Alert destination".' }),
    question: Type.String({ description: 'The complete question, ending with a question mark.' }),
    interaction: Type.Optional(Type.Union(
      [Type.Literal('choice'), Type.Literal('confirm'), Type.Literal('text'), Type.Literal('person'), Type.Literal('secret')],
      {
        description:
          'How the person answers. choice: pick from options. confirm: Approve / Not yet / Discuss. text: a short ' +
          'free answer. person: pick a teammate ("who owns…"). secret: a key or password; it is never shown in the ' +
          'channel and you read it with team_chat_question_secret. Default: choice with options, else text.',
      },
    )),
    options: Type.Optional(Type.Array(Type.Object({
      label: Type.String({ description: 'Short option text (1-5 words).' }),
      description: Type.Optional(Type.String({ description: 'What picking this means or what happens next.' })),
    }), { description: 'For choice: 2-6 options. People can always type their own answer instead.' })),
    multiSelect: Type.Optional(Type.Boolean({ description: 'For choice: allow picking several.' })),
    hint: Type.Optional(Type.Union([Type.Literal('number'), Type.Literal('url')], { description: 'For text: the kind of value expected.' })),
    secret_name: Type.Optional(Type.String({ description: 'For secret: an env-style name, e.g. ENSEMBLEDATA_API_TOKEN.' })),
  }),
  {
    description:
      'Questions for the people you tag in this message, shown as an answerable card. The answer comes back to ' +
      'you as a reply in the thread. Use this whenever you need input from a person instead of asking in prose. ' +
      'Questions that repeat one still open in the channel are folded into it, so do not re-ask.',
  },
)

type QuestionInput = {
  header: string
  question: string
  interaction?: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
  hint?: string
  secret_name?: string
}

function questionsForApi(questions: QuestionInput[] | undefined) {
  if (!Array.isArray(questions) || !questions.length) return undefined
  return questions.map(({ question, secret_name, ...rest }) => ({ ...rest, prompt: question, secretName: secret_name }))
}

export { CHANNEL_TOOL_NAMES } from './work-tool-names'

/** True when this runtime registers the team chat tools (non-personal workspace runtimes). */
export function teamChatToolsAvailable(capabilityProfile?: string): boolean {
  return capabilityProfile !== 'personal' && !!(resolveRuntimeIdentity().workspaceId || process.env.WORKSPACE_ID)
}

export const TEAM_CHAT_GUIDE = [
  '## Team Chat',
  '',
  "You're a teammate in this workspace's team chat, alongside people and other agents. When a channel message wakes you:",
  '- Reply in the thread you were woken in. Your final reply is posted there automatically.',
  '- Hand work to another agent by tagging it (`@Planner`, or its tag from `team_directory`). It runs next in the same thread.',
  '- Every agent tag wakes that agent and costs a run, so tag one only to hand it a specific task. Never tag agents to acknowledge, thank, agree, give an FYI, or report back to the agent that handed you the work; your reply is already in the thread. To refer to an agent without waking it, write its name without the `@`.',
  '- Write every message so someone reading the thread later knows what happened and why: in two to four sentences, say what you did, what you found or decided and why, and what you need next. Never post a bare "your turn", "done", or "back to you".',
  '- Tag people only when you need a decision or approval from them, and ask one clear question.',
  '- When you need input from a person, post with `team_chat_post` and pass `questions` (tag them in the text) so they get an answerable card, instead of burying the question in prose. Their answer arrives as a reply in the thread. A question already open in the channel is not re-asked; refer to it instead.',
  '- Keep messages to a few sentences, not paragraphs. Put long content (plans, logs, diffs) in files or links and reference them.',
  '- Use `team_chat_dm` to escalate something urgent to one person instead of tagging a whole channel.',
  '- If someone asks you to message a teammate for them, use `team_chat_dm` with `for_requester: true`; then reply to the requester with the returned link.',
  '- Use `team_chat_add_member` to put someone in a channel, e.g. when welcoming a new teammate.',
  '- Asked to create a channel, or to change one (private, topic, agent members)? Do it yourself; never send the person to the UI. Add or edit it under `teamChannels` in shogo-system.yaml and run `system_apply` (dry run, then apply). The person who asked is added as the new channel\'s owner. Without `system_apply`, ask the workspace agent in the channel to do it.',
  '- Files shared in your channels and DMs: use `fetch_chat_files`. Search them by meaning with `query`, read a document\'s text with `file_id`, and pass `download: true` only when you need the raw file on disk (images, spreadsheets to run code on, archives); it is saved under `chat-files/`.',
  '- Each channel can have a doc: a shared markdown page of the channel\'s plans and decisions, kept by the people in it. Read it with `team_chat_doc_read` when it helps you answer. Do not add to it or edit it on your own initiative; change it only when someone asks you to.',
  '- Asked what a teammate worked on ("what did Sam do today?")? Use `member_activity`. Only owners and admins may ask; if the API refuses, say so plainly and do not guess from channel history. Answer only the person who asked, in the conversation where they asked. Never post someone\'s activity summary into a channel.',
  '- Respect Do Not Disturb: when someone is away, leave the question in the thread rather than pinging them repeatedly.',
  '- Starting a new piece of work? Post a top-level message with `team_chat_post` (pass `run_id` if you track one); you own that thread and unaddressed replies there come to you.',
  '',
  '### Knowing when to stop',
  'Agents tag each other, so you can be tagged into a loop: a thank-you that gets thanked back, a "done" that gets acknowledged, two agents passing the same question back and forth. Limits only stop a loop after many wasted runs; stopping is your job.',
  '- Before you act on an agent\'s tag, ask what it gives you: work you have not done, or information that changes it. If it only acknowledges, thanks, agrees, repeats what you said or reports work that needs nothing from you, reply in one line and tag nobody. A reply with no agent tag ends the exchange.',
  '- When the last few turns with another agent did not move the work forward (the same objection, the same fix, the same question), stop handing it back, even with clearer instructions ("one more round" is how loops continue). Say where it is stuck and tag the person who asked for a decision.',
  '- Agents do not need to tag you when they finish: cards you hand off and runs you start already tell you (a `[Task update]`), and a finishing agent\'s tag on a card you watch is folded into that update. Do not write "tag me when done" into the AGENTS.md of agents you create. If a person asks for it anyway, pass it on (it costs nothing) and say the update comes either way. What makes hand-offs slow is a timer: turn off any schedule of yours that checks on that work, yourself and in the same turn, then tell the person. Do not keep it "as a backstop" or offer to turn it off later; it only delays cards and reviews them twice.',
  '- Tagged by an agent on work you handed it? Its card or task update already reached you or is about to; act on that once and do not reply to the tag separately.',
  '- If you have `agent_run_stop`: when a person asks you to stop an agent, or agents are looping in a thread, find the run with `agent_runs_list` and stop it with `agent_run_stop` instead of posting "please stop".',
  '- "Pause every agent" / "stop everything" is `agent_run_stop({ scope: "workspace" })`: it stops the running agents **and** holds every automatic start (task updates, schedules, triggers, card hand-offs, team-chat tags) until someone resumes with `agent_run_stop({ scope: "workspace", resume: true })`. A person\'s own message still runs. Do not try to deliver a "stop" as a message — that wakes the agent you are trying to stop.',
  '',
  '### Keep the channel readable',
  'Every post you make has a kind. People only get notified for `decision` and `alert`, so choose honestly:',
  '- `status`: routine progress. Prefer one status card you update in place over many separate posts.',
  '- `result`: finished work someone will want to open (a PR, a preview link, a report).',
  '- `decision`: you need a person to choose or approve. Ask one clear question (as `questions`) and say what happens on each answer.',
  '- `alert`: something is broken or blocked and you cannot continue alone.',
  'For work that takes more than a few steps, post one `card` at the top of your thread (title, steps, the criteria that mean it is done), then change it with `team_chat_update` as you go and finish by setting `status: "done"` with a short `summary`. Do not post a new message for each step.',
].join('\n')

function workspaceIdOf(ctx: ToolContext): string | null {
  return resolveRuntimeIdentity().workspaceId || ctx.workspaceId || null
}

export function channelIdentity(ctx: ToolContext): AgentChannelIdentity {
  const identity = resolveRuntimeIdentity()
  // A project with attached projects runs in a merged root but is still that project's agent; only a
  // workspace-wide runtime (no anchor) speaks as the workspace agent.
  if (identity.mode === 'workspace') return { projectId: process.env.WORKSPACE_ANCHOR_PROJECT_ID || null }
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
      'Tagging an agent hands work to it: it runs next and replies in the thread, so tag an agent only when you give it a task, never to thank or update it. ' +
      'A new top-level post makes you the owner of its thread, so unaddressed human replies there come to you. ' +
      'Do not use this to reply to the message you were mentioned in; your normal reply is posted there automatically. ' +
      'To share images or videos you made, pass their workspace paths in attachments; they show in the message. ' +
      'Returns thread_id (for follow-ups), url (a link to the thread for people outside Shogo), and a background task per agent you tagged.',
    parameters: Type.Object({
      channel: Type.String({ description: 'Channel name (without #) or conversation id.' }),
      text: Type.Optional(Type.String({ description: 'Markdown message text. With a card, a note shown under it.' })),
      attachments: Type.Optional(Type.Array(Type.String(), {
        description: 'Workspace paths of images or videos to attach (up to 10), e.g. ["renders/hero.png", "clips/demo.mp4"].',
      })),
      thread_id: Type.Optional(Type.String({ description: 'Root message id to reply in a thread.' })),
      owner: Type.Optional(Type.Boolean({ description: 'Take ownership of the thread when replying in one (default: only for new top-level posts).' })),
      run_id: Type.Optional(Type.String({ description: 'Id of the run or work item this thread tracks; stored on the thread and shown to agents woken in it.' })),
      kind: Type.Optional(KIND_SCHEMA),
      card: Type.Optional(CARD_SCHEMA),
      questions: Type.Optional(QUESTIONS_SCHEMA),
    }),
    execute: async (_id, params) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const input = params as {
        channel: string; text?: string; thread_id?: string; owner?: boolean; run_id?: string
        kind?: AgentMessageKind; card?: AgentStatusCard; questions?: QuestionInput[]; attachments?: string[]
      }
      const paths = Array.isArray(input.attachments) ? input.attachments : []
      if (!input.text?.trim() && !input.card && !paths.length) {
        return textResult({ error: 'text, card or attachments is required', code: 'invalid_input' })
      }
      const channel = input.channel.replace(/^#/, '')
      const identity = channelIdentity(ctx)
      const uploaded = paths.length
        ? await uploadWorkspaceMedia(ctx.workspaceDir, paths, (file) =>
            uploadAgentFile(workspaceId, `/agent-channels/${encodeURIComponent(channel)}/attachments`, file, {
              projectId: identity.projectId,
            }))
        : { files: [], errors: [] as string[] }
      if (paths.length && !uploaded.files.length && !input.text?.trim() && !input.card) {
        return textResult({ error: uploaded.errors.join('; ') || 'No attachments could be uploaded', code: 'upload_failed' })
      }
      const result = await postAgentChannelMessage(workspaceId, channel, {
        text: input.text ?? '',
        threadRootId: input.thread_id,
        identity,
        sessionId: ctx.sessionId,
        owner: input.owner,
        runId: input.run_id,
        kind: input.kind,
        card: input.card,
        questions: questionsForApi(input.questions),
        attachmentIds: uploaded.files.map((f) => f.id),
        trackReplies: !!ctx.commandRegistry && !!ctx.sessionId,
      })
      if (result.ok && result.data) {
        const { threadId, tasks, ...rest } = result.data
        const tracked = tasks?.length && ctx.commandRegistry ? mirrorApiTasks(ctx.commandRegistry, 'agent_reply', tasks) : []
        return textResult({
          ok: true,
          ...rest,
          thread_id: threadId,
          ...(uploaded.files.length ? { attached: uploaded.files.map((f) => f.name) } : {}),
          ...(uploaded.errors.length ? { media_errors: uploaded.errors } : {}),
          ...(tracked.length
            ? {
                tasks: tracked.map((t, i) => ({ ...t, title: tasks![i].title })),
                task_ids: tracked.map((t) => t.task_id),
                hint: 'Each tagged agent replies in the thread. Call wait({ task_ids }) to block on them, or end your turn and you will get a [Task update] when they reply.',
              }
            : {}),
        })
      }
      return apiError(result, 'Could not post the message')
    },
  }
}

export function createChannelUpdateTool(ctx: ToolContext): AgentTool {
  return {
    name: 'team_chat_update',
    label: 'Update a Message',
    description:
      'Edit one of your own earlier channel messages in place, or the shared task card of a thread you are working in (a teammate opened it; you move it forward): change its status card (move to the next step, add a PR ' +
      'or preview link, mark it done with a summary), its text, or its kind. Use this for progress instead of posting ' +
      'a new message each time. Pass the message_id returned by team_chat_post (its `id`). Sending a card replaces ' +
      'the whole card, so include every field you want to keep. Editing never tags or wakes anyone, so to hand work ' +
      'to another agent or ask a person something, post a new message.',
    parameters: Type.Object({
      message_id: Type.String({ description: 'Id of your message to edit (the `id` team_chat_post returned).' }),
      text: Type.Optional(Type.String({ description: 'New Markdown text, or the note under a card.' })),
      kind: Type.Optional(KIND_SCHEMA),
      card: Type.Optional(CARD_SCHEMA),
      questions: Type.Optional(QUESTIONS_SCHEMA),
    }),
    execute: async (_id, params) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const input = params as { message_id: string; text?: string; kind?: AgentMessageKind; card?: AgentStatusCard; questions?: QuestionInput[] }
      if (input.text === undefined && !input.card && !input.kind && !input.questions?.length) {
        return textResult({ error: 'Pass text, card, kind or questions to change', code: 'invalid_input' })
      }
      const result = await updateAgentChannelMessage(workspaceId, input.message_id, {
        identity: channelIdentity(ctx),
        text: input.text,
        kind: input.kind,
        card: input.card,
        questions: questionsForApi(input.questions),
      })
      return result.ok ? textResult({ ok: true, ...result.data }) : apiError(result, 'Could not update the message')
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
      'question, escalate, hand off work, or deliver a result to a specific person. If the person who asked ' +
      'you wants the message sent for them, set for_requester to true; that posts in the requester and ' +
      'recipient\'s shared DM and labels it as sent on their behalf.',
    parameters: Type.Object({
      user: Type.String({ description: 'Email address or user id of the teammate.' }),
      text: Type.String({ description: 'Markdown message text.' }),
      for_requester: Type.Optional(Type.Boolean({
        description: 'Send in the signed-in requester and recipient\'s shared DM, labeled on behalf of the requester.',
      })),
    }),
    execute: async (_id, params) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const input = params as { user: string; text: string; for_requester?: boolean }
      if (!input.text?.trim()) return textResult({ error: 'text is required', code: 'invalid_input' })
      if (input.for_requester && !ctx.userId) {
        return textResult({
          error: 'This run has no signed-in person behind it, so it cannot send a message on someone\'s behalf.',
          code: 'no_requesting_user',
        })
      }
      const result = await sendAgentDirectMessage(workspaceId, {
        user: input.user,
        text: input.text,
        identity: channelIdentity(ctx),
        sessionId: ctx.sessionId,
        onBehalfOfUserId: input.for_requester ? ctx.userId : undefined,
      })
      return result.ok ? textResult({ ok: true, ...result.data }) : apiError(result, 'Could not send the message')
    },
  }
}

export function createAddChannelMemberTool(ctx: ToolContext): AgentTool {
  return {
    name: 'team_chat_add_member',
    label: 'Add to Channel',
    description:
      'Add workspace members (by email or user id) to a team chat channel you can see, e.g. put a new teammate in ' +
      '#general and #onboarding. Only people already in the workspace can be added. Returns the user ids newly added.',
    parameters: Type.Object({
      channel: Type.String({ description: 'Channel name (without #) or conversation id.' }),
      users: Type.Array(Type.String(), { description: 'Emails or user ids of the people to add.' }),
    }),
    execute: async (_id, params) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const input = params as { channel: string; users: string[] }
      if (!Array.isArray(input.users) || input.users.length === 0) {
        return textResult({ error: 'users is required', code: 'invalid_input' })
      }
      const result = await addAgentChannelMembers(workspaceId, input.channel.replace(/^#/, ''), {
        users: input.users,
        identity: channelIdentity(ctx),
      })
      return result.ok ? textResult({ ok: true, ...result.data }) : apiError(result, 'Could not add people to the channel')
    },
  }
}

export function createChannelDocReadTool(ctx: ToolContext): AgentTool {
  return {
    name: 'team_chat_doc_read',
    label: 'Read Channel Doc',
    description:
      "Read a team chat channel's doc: its shared markdown page of plans, decisions and checklists. Returns the " +
      'title, content, version and budget (chars/limit, ok|warn|critical) — pass version as base_version when you ' +
      'replace the whole doc, or doc: null when the channel has none yet. include_archive lists the sections that ' +
      'were archived out of it (heading + chars, no bodies); archive_id returns one archived section in full.',
    parameters: Type.Object({
      channel: Type.String({ description: 'Channel name (without #) or conversation id.' }),
      include_archive: Type.Optional(Type.Boolean({ description: 'Also list the sections archived out of this doc.' })),
      archive_id: Type.Optional(Type.String({ description: 'Return one archived section in full, by id.' })),
    }),
    execute: async (_id, params) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const input = params as { channel: string; include_archive?: boolean; archive_id?: string }
      const result = await readAgentChannelDoc(workspaceId, input.channel.replace(/^#/, ''), channelIdentity(ctx), {
        includeArchive: input.include_archive === true,
        archiveId: input.archive_id,
      })
      if (!result.ok || !result.data) return apiError(result, 'Could not read the channel doc')
      const { doc, url, archives, archive } = result.data
      if (archive) return textResult({ ok: true, archive, budget: doc?.budget })
      return textResult({
        ok: true,
        doc,
        url,
        budget: doc?.budget ?? { chars: 0, limit: 200_000, pct: 0, level: 'ok' },
        ...(archives ? { archives } : {}),
      })
    },
  }
}

function docWriteFailure(result: { error?: string; code?: string; status?: number; details?: Record<string, any> }, fallback: string) {
  const details = result.details ?? {}
  return textResult({
    error: result.error ?? fallback,
    code: result.code,
    status: result.status,
    ...(details.over_by !== undefined ? { over_by: details.over_by, chars: details.chars, limit: details.limit } : {}),
    ...(details.reason ? { reason: details.reason, heading: details.heading, card: details.card } : {}),
    ...(details.matches ? { matches: details.matches } : {}),
    ...(details.next ? { next: details.next } : {}),
  })
}

export function createChannelDocUpdateTool(ctx: ToolContext): AgentTool {
  return {
    name: 'team_chat_doc_update',
    label: 'Update Channel Doc',
    description:
      "Change a team chat channel's doc (creating it if needed), attributed to you. Every response carries the " +
      'doc\'s budget (chars/limit, pct, ok|warn|critical). Modes: "patch_section" replaces the body under one ' +
      'heading (or adds that section), "append" adds to the end, "replace" rewrites the whole doc and needs ' +
      'base_version from team_chat_doc_read, and "archive_section" moves one section into the doc\'s archive ' +
      "(replacing it with a pointer line) so a full doc can be slimmed. Prefer patch_section over append/rewrite " +
      'so you do not clobber teammates. A new section headed like a card (SHO-123, "QA gate", "round 2", ' +
      '"shipped") or longer than 4,000 chars is refused with code use_card_thread: that narrative belongs in the ' +
      'card thread via work_item_comment, and force: true overrides. A write that would exceed the limit returns ' +
      'doc_full with over_by and the next calls — archive a section first. Fails with code doc_conflict if ' +
      'someone saved since you read it: read again and retry.',
    parameters: Type.Object({
      channel: Type.String({ description: 'Channel name (without #) or conversation id.' }),
      mode: Type.Union(
        [Type.Literal('patch_section'), Type.Literal('append'), Type.Literal('replace'), Type.Literal('archive_section')],
        { description: 'How to apply content.' },
      ),
      content: Type.Optional(Type.String({
        description: 'Markdown. For patch_section, the new body of the section (without its heading). Not used by archive_section.',
      })),
      section: Type.Optional(Type.String({
        description: 'Heading text of the section to replace (patch_section) or to archive (archive_section), e.g. "Decisions".',
      })),
      title: Type.Optional(Type.String({ description: 'New doc title. Omit to keep the current one.' })),
      base_version: Type.Optional(Type.Number({ description: 'Version you read; required for replace.' })),
      force: Type.Optional(Type.Boolean({
        description: 'Write a card-narrative or oversized new section anyway (use_card_thread otherwise).',
      })),
    }),
    execute: async (_id, params) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const input = params as {
        channel: string
        mode: AgentDocMode
        content?: string
        section?: string
        title?: string
        base_version?: number
        force?: boolean
      }
      if (input.mode === 'archive_section') {
        if (!input.section?.trim()) return textResult({ error: 'section is required for archive_section', code: 'invalid_input' })
      } else if (typeof input.content !== 'string') {
        return textResult({ error: 'content is required', code: 'invalid_input' })
      }
      if (input.mode === 'patch_section' && !input.section?.trim()) {
        return textResult({ error: 'section is required for patch_section', code: 'invalid_input' })
      }
      if (input.mode === 'replace' && typeof input.base_version !== 'number') {
        return textResult({ error: 'base_version is required for replace; read the doc first', code: 'invalid_input' })
      }
      const result = await updateAgentChannelDoc(workspaceId, input.channel.replace(/^#/, ''), {
        identity: channelIdentity(ctx),
        mode: input.mode,
        content: input.content,
        section: input.section,
        title: input.title,
        baseVersion: input.base_version,
        force: input.force === true,
      })
      if (!result.ok || !result.data) return docWriteFailure(result, 'Could not update the channel doc')
      const { doc, url, archive } = result.data
      return textResult({
        ok: true,
        version: doc?.version,
        title: doc?.title,
        url,
        budget: doc?.budget,
        ...(archive ? { archived: { heading: archive.heading, chars: archive.chars, id: archive.id } } : {}),
      })
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

export function createMemberActivityTool(ctx: ToolContext): AgentTool {
  return {
    name: 'member_activity',
    label: 'Teammate Activity',
    description:
      'Summarise what one teammate did: approvals they decided, tasks they started or finished, messages they sent, ' +
      'meetings, the tools they used and when they were active. Use it to answer "what did Sam work on today?". ' +
      'Owners and admins only; for anyone else the API refuses. The answer is private to the person asking, so reply ' +
      'to them directly and never post it to a channel. Default window is today in the given timezone.',
    parameters: Type.Object({
      user: Type.String({ description: 'The teammate: their email, or a user id from team_directory.' }),
      range: Type.Optional(Type.Union(
        [Type.Literal('today'), Type.Literal('yesterday'), Type.Literal('7d'), Type.Literal('30d')],
        { description: 'Which window to look at. Default today.' },
      )),
      since: Type.Optional(Type.String({ description: 'ISO start time. Overrides range.' })),
      until: Type.Optional(Type.String({ description: 'ISO end time. Defaults to now.' })),
      timezone: Type.Optional(Type.String({ description: 'IANA timezone that defines "today", e.g. America/Los_Angeles. Default UTC.' })),
    }),
    execute: async (_id, params: any) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const user = typeof params?.user === 'string' ? params.user.trim() : ''
      if (!user) return textResult({ error: 'user is required (an email or user id).', code: 'invalid_input' })
      // Who is asking comes from the authenticated chat request, so the model can't pose as an admin.
      if (!ctx.userId) {
        return textResult({
          error: 'This run has no signed-in person behind it (for example a scheduled or agent-to-agent run), so teammate activity cannot be looked up.',
          code: 'no_requesting_user',
        })
      }
      const result = await getMemberActivity(workspaceId, {
        user,
        requestedBy: ctx.userId,
        range: params.range,
        since: params.since,
        until: params.until,
        timezone: params.timezone,
      })
      return result.ok ? textResult({ ok: true, activity: result.data }) : apiError(result, 'Could not load teammate activity')
    },
  }
}

export function createFetchChatFilesTool(ctx: ToolContext): AgentTool {
  return {
    name: 'fetch_chat_files',
    label: 'Chat Files',
    description:
      'Find, read and download files shared in team chat: every channel and DM you can read. ' +
      'With no arguments, lists recent files and the conversations that have them; narrow with conversation or kind. ' +
      'With query, searches file contents by meaning and returns snippets plus char_start to read from. ' +
      'With file_id, returns the file\'s extracted text a page at a time (offset, limit; follow next_offset). ' +
      'With file_id and download: true, saves the raw file under chat-files/ and returns its path, for images, ' +
      'spreadsheets, archives or anything your other tools need on disk. Read text instead of downloading when you can.',
    parameters: Type.Object({
      conversation: Type.Optional(Type.String({ description: 'Limit to one conversation: a channel name, @person (email or user id) for your DM with them, or a conversation id.' })),
      query: Type.Optional(Type.String({ description: 'What to look for inside files, in plain words.' })),
      file_id: Type.Optional(Type.String({ description: 'A file id from a listing, a search result, or a transcript ("file id ...").' })),
      offset: Type.Optional(Type.Number({ description: 'Character offset to read from (file_id only). Use char_start from a search hit or next_offset from the last page.' })),
      limit: Type.Optional(Type.Number({ description: 'Characters to read (default 20000, max 60000), or how many files to list or search results to return.' })),
      download: Type.Optional(Type.Boolean({ description: 'With file_id: save the raw file to disk and return its path.' })),
      kind: Type.Optional(Type.Union([Type.Literal('image'), Type.Literal('document'), Type.Literal('other')], { description: 'Listing only: filter by file type.' })),
      cursor: Type.Optional(Type.String({ description: 'Listing only: next_cursor from the previous page.' })),
    }),
    execute: async (_id, params) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const input = params as {
        conversation?: string; query?: string; file_id?: string; offset?: number; limit?: number
        download?: boolean; kind?: 'image' | 'document' | 'other'; cursor?: string
      }
      const identity = channelIdentity(ctx)
      const conversation = input.conversation?.trim() || undefined
      const fileId = input.file_id?.trim()

      if (fileId && input.download) {
        try {
          const saved = await saveChatFile(ctx.workspaceDir, workspaceId, identity, fileId)
          return textResult({ ok: true, file_id: fileId, path: saved.path, size: saved.size, already_downloaded: saved.reused })
        } catch (err: any) {
          return textResult({ error: err?.message ?? 'Could not download the file', code: err?.code, status: err?.status })
        }
      }

      if (fileId) {
        const result = await readAgentChatFileText(workspaceId, identity, fileId, { offset: input.offset, limit: input.limit })
        if (!result.ok || !result.data) return apiError(result, 'Could not read the file')
        const file = result.data
        const onDisk = downloadedPath(ctx.workspaceDir, fileId)
        if (file.text === null) {
          return textResult({
            ok: true, file_id: fileId, name: file.name, mime_type: file.mimeType, text: null,
            ...(onDisk ? { path: onDisk } : {}),
            hint: onDisk ? 'No extractable text; the raw file is at path.' : 'No extractable text. Call again with download: true to get the raw file.',
          })
        }
        return textResult({
          ok: true, file_id: fileId, name: file.name, mime_type: file.mimeType,
          offset: file.offset, total_chars: file.totalChars, next_offset: file.nextOffset,
          ...(onDisk ? { path: onDisk } : {}),
          text: file.text,
        })
      }

      if (input.query?.trim()) {
        const result = await searchAgentChatFiles(workspaceId, identity, input.query.trim(), { conversation, limit: input.limit })
        if (!result.ok || !result.data) return apiError(result, 'Could not search chat files')
        return textResult({
          ok: true,
          semantic: result.data.semantic,
          results: result.data.results.map((r) => ({
            file_id: r.fileId, name: r.name, mime_type: r.mimeType, size: r.size,
            conversation: r.conversation?.name ?? null, conversation_id: r.conversationId, message_id: r.messageId,
            match: r.match, snippet: r.snippet, char_start: r.charStart,
            path: downloadedPath(ctx.workspaceDir, r.fileId),
          })),
        })
      }

      const result = await listAgentChatFiles(workspaceId, identity, { conversation, kind: input.kind, cursor: input.cursor, limit: input.limit })
      if (!result.ok || !result.data) return apiError(result, 'Could not list chat files')
      const { conversations, files, nextCursor } = result.data
      // The full list names every conversation this agent can still read.
      pruneChatFiles(ctx.workspaceDir, conversations.map((c) => c.folder))
      return textResult({
        ok: true,
        conversations: conversation ? undefined : conversations.map((c) => ({ id: c.id, kind: c.kind, name: c.name, file_count: c.fileCount, last_file_at: c.lastFileAt })),
        files: files.map((f) => ({
          file_id: f.id, name: f.name, kind: f.kind, mime_type: f.mimeType, size: f.size,
          conversation_id: f.conversationId, message_id: f.messageId, uploaded_by: f.uploadedBy, created_at: f.createdAt,
          has_text: f.hasText, path: downloadedPath(ctx.workspaceDir, f.id),
        })),
        next_cursor: nextCursor,
      })
    },
  }
}

export function createQuestionSecretTool(ctx: ToolContext): AgentTool {
  return {
    name: 'team_chat_question_secret',
    label: 'Read a Secret Answer',
    description:
      'Read the value a person entered for one of your `secret` questions (a key, token or password). The reply in ' +
      'the thread names the question but never the value. Only the agent that asked can read it. Use the value ' +
      'directly (e.g. set it as an env var or call the API with it); never post it in a channel or write it to MEMORY.md.',
    parameters: Type.Object({
      message_id: Type.String({ description: 'Id of the message that carries the question card.' }),
      question_id: Type.String({ description: 'Id of the question, from the answer reply.' }),
    }),
    execute: async (_id, params) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const input = params as { message_id: string; question_id: string }
      const result = await readAgentQuestionSecret(workspaceId, input.message_id, input.question_id, channelIdentity(ctx))
      return result.ok ? textResult({ ok: true, ...result.data }) : apiError(result, 'Could not read the secret')
    },
  }
}

export function createAgentRunsListTool(ctx: ToolContext): AgentTool {
  return {
    name: 'agent_runs_list',
    label: 'List Running Agents',
    description:
      'List the agents working right now in team chat: replying in a channel or thread, or working a card. Only runs ' +
      'in channels the person who asked can see are listed. Each run has a message_id to pass to agent_run_stop, and ' +
      'can_stop says whether that person may stop it.',
    parameters: Type.Object({
      channel: Type.Optional(Type.String({ description: 'Only runs in this channel (name without # or conversation id).' })),
      thread: Type.Optional(Type.String({ description: 'Only runs in this thread (its root message id).' })),
    }),
    execute: async (_id, params) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const input = params as { channel?: string; thread?: string }
      const result = await listRunningAgents(workspaceId, {
        channel: input.channel?.replace(/^#/, ''),
        threadRootId: input.thread,
        sessionId: ctx.sessionId,
      })
      if (!result.ok) return apiError(result, 'Could not list running agents')
      return textResult({
        ok: true,
        runs: (result.data ?? []).map((r) => ({
          message_id: r.messageId,
          agent: r.agent,
          channel: r.channel.name ?? r.channel.id,
          thread_id: r.threadRootId,
          started_at: r.startedAt,
          preview: r.preview,
          can_stop: r.canStop,
        })),
        paused: result.data?.paused ?? null,
      })
    },
  }
}

export function createAgentRunStopTool(ctx: ToolContext): AgentTool {
  return {
    name: 'agent_run_stop',
    label: 'Stop Running Agent',
    description:
      'Stop an agent that is working right now, the same as a person pressing Stop on its reply. Pass message_id ' +
      '(from agent_runs_list) to stop one run, or channel and thread to stop every agent running in that thread. ' +
      'A stopped reply does not wake the agents it tagged, so this also ends an agent loop. ' +
      'Pass scope "workspace" to stop every agent run in this workspace and pause all automatic starts ' +
      '(task updates, schedules, triggers, card hand-offs, team-chat tags) until you call it again with ' +
      'resume: true — a person\'s own message still runs while paused. Stop only when the person asks you to, ' +
      'or when agents are looping, then tell that person which agents you stopped.',
    parameters: Type.Object({
      message_id: Type.Optional(Type.String({ description: 'The running reply to stop.' })),
      channel: Type.Optional(Type.String({ description: 'With thread: the channel (name without # or conversation id).' })),
      thread: Type.Optional(Type.String({ description: 'With channel: root message id of the thread whose agents to stop.' })),
      scope: Type.Optional(
        Type.Union([Type.Literal('run'), Type.Literal('thread'), Type.Literal('workspace')], {
          description: '"workspace" stops every run in the workspace and pauses automatic starts; "run"/"thread" are implied by the other arguments.',
        }),
      ),
      resume: Type.Optional(Type.Boolean({ description: 'With scope "workspace": lift the pause instead of setting it.' })),
      reason: Type.Optional(Type.String({ description: 'With scope "workspace": one line on why, kept with the pause.' })),
    }),
    execute: async (_id, params) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const input = params as { message_id?: string; channel?: string; thread?: string; scope?: string; resume?: boolean; reason?: string }
      const scope = input.scope === 'workspace' ? 'workspace' : input.message_id ? 'run' : input.channel && input.thread ? 'thread' : null
      if (!scope) {
        return textResult({
          error: 'Pass message_id, channel and thread, or scope "workspace".',
          code: 'invalid_input',
        })
      }
      if (scope === 'workspace') {
        const result = await stopRunningAgents(workspaceId, {
          scope: 'workspace',
          resume: input.resume === true,
          ...(input.reason ? { reason: input.reason } : {}),
          sessionId: ctx.sessionId,
        })
        if (!result.ok || !result.data) return apiError(result, 'Could not pause the workspace agents')
        return textResult({
          ok: true,
          paused: result.data.paused ?? null,
          resumed: result.data.resumed === true,
          stopped: (result.data.stopped ?? []).map((r) => ({
            message_id: r.messageId,
            agent: r.agent,
            channel: r.channel.name ?? r.channel.id,
            thread_id: r.threadRootId,
          })),
          skipped: (result.data.skipped ?? []).map((s) => ({ message_id: s.messageId, reason: s.reason })),
        })
      }
      const result = await stopRunningAgents(workspaceId, {
        ...(input.message_id
          ? { messageId: input.message_id }
          : { channel: input.channel!.replace(/^#/, ''), threadRootId: input.thread }),
        sessionId: ctx.sessionId,
      })
      if (!result.ok || !result.data) return apiError(result, 'Could not stop the agent')
      return textResult({
        ok: true,
        stopped: result.data.stopped.map((r) => ({ message_id: r.messageId, agent: r.agent, channel: r.channel.name ?? r.channel.id, thread_id: r.threadRootId })),
        skipped: result.data.skipped.map((s) => ({ message_id: s.messageId, reason: s.reason })),
      })
    },
  }
}

/** Seeing and stopping other agents' runs: the workspace agent only. */
export function createAgentRunTools(ctx: ToolContext): AgentTool[] {
  return [createAgentRunsListTool(ctx), createAgentRunStopTool(ctx)]
}

export function createChannelTools(ctx: ToolContext): AgentTool[] {
  return [
    createChannelListTool(ctx),
    createChannelReadTool(ctx),
    createChannelPostTool(ctx),
    createChannelUpdateTool(ctx),
    createChannelSearchTool(ctx),
    createDmUserTool(ctx),
    createAddChannelMemberTool(ctx),
    createFetchChatFilesTool(ctx),
    createChannelDocReadTool(ctx),
    createChannelDocUpdateTool(ctx),
    createTeamDirectoryTool(ctx),
    createMemberActivityTool(ctx),
    createQuestionSecretTool(ctx),
  ]
}
