// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Work boards for agents: Kanban boards in team channels and the cards on
 * them. Channels themselves are created and edited with `system_apply`
 * (`teamChannels`) and `team_chat_*`; these tools only add boards and cards.
 *
 * Gated by capability: `boardsEnabled` (work cards), `boardAdminEnabled`
 * (board structure) and `problemsEnabled` (problem cards). See
 * `work-tool-names.ts` and `filterDisabledCapabilityTools`.
 */

import { Type, type TSchema } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { ToolContext } from './gateway-tools'
import { textResult } from './gateway-tools'
import { trackRemoteTask } from './remote-tasks'
import { channelIdentity } from './channel-tools'
import { resolveRuntimeIdentity } from './workspace-runtime-mode'
import { agentBoardsRequest, uploadAgentFile } from './internal-api'
import { publishWorkspaceMedia, uploadWorkspaceMedia, type MediaUploader } from './workspace-media'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { isSafeRelativePath, parseSystemManifest } from './system-manifest'
import { BOARD_TEMPLATES, boardTemplateArgs, findWorkTemplate, listWorkTemplates, mergeWorkTemplate } from './work-templates'

const MANIFEST_PATH = 'shogo-system.yaml'

export { BOARD_ADMIN_TOOL_NAMES, BOARD_TOOL_NAMES, PROBLEM_TOOL_NAMES } from './work-tool-names'

const ITEM_TYPE = Type.Union(
  ['task', 'problem', 'ticket', 'deal', 'candidate', 'approval', 'content', 'custom'].map((v) => Type.Literal(v)),
  { description: 'What the cards are. Sets the default columns: ticket (New, Open, Waiting on customer, Solved), deal (Lead … Won, Lost), candidate (Applied … Hired, Rejected), approval, content, problem (Detected … Resolved, Dismissed), task, custom.' },
)

const CATEGORY = Type.Union(
  ['backlog', 'active', 'waiting', 'review', 'done', 'dismissed'].map((v) => Type.Literal(v)),
  { description: 'What the column means: backlog (not started), active (being worked), waiting (blocked on someone outside), review (needs a person to check), done, dismissed (closed without doing).' },
)

const PRIORITY = Type.Union(['urgent', 'high', 'medium', 'low', 'none'].map((v) => Type.Literal(v)))

const AGENT_REF = 'An agent: "workspace" for the workspace agent, or a project id (from team_directory) for a project agent.'

const COLUMN = Type.Object({
  name: Type.String(),
  category: Type.Optional(CATEGORY),
  wip_limit: Type.Optional(Type.Number({ description: 'Most cards allowed in the column at once.' })),
  agent: Type.Optional(Type.String({ description: `${AGENT_REF} Cards moved here are handed to it.` })),
  sla_hours: Type.Optional(Type.Number({ description: 'Hours a card may sit here before it counts as breaching SLA.' })),
})

const FIELD = Type.Object({
  key: Type.String({ description: 'Field key, e.g. "amount" or "customer".' }),
  label: Type.Optional(Type.String()),
  type: Type.Optional(Type.Union(['text', 'number', 'money', 'date', 'select', 'user', 'url', 'boolean'].map((v) => Type.Literal(v)))),
  options: Type.Optional(Type.Array(Type.String(), { description: 'For select fields.' })),
  required: Type.Optional(Type.Boolean()),
})

const BOARD_REF = Type.String({ description: 'Board name, slug or id. Pass channel too when two channels have boards with the same name.' })
const ITEM_REF = Type.String({ description: 'Card key (e.g. "SUP-42") or id.' })
const CHANNEL = Type.String({ description: 'Channel name (without #) or id.' })

function workspaceIdOf(ctx: ToolContext): string | null {
  return resolveRuntimeIdentity().workspaceId || ctx.workspaceId || null
}

function identity(ctx: ToolContext) {
  return { projectId: channelIdentity(ctx).projectId, sessionId: ctx.sessionId }
}

const enc = (s: string) => encodeURIComponent(s.replace(/^#/, ''))

type Params = Record<string, any>

const DESCRIPTION_MEDIA =
  'Markdown. Embed workspace images or videos with ![what it shows](path/to/file.png); they are uploaded to the card so people can see them. Always write the alt text.'

const MEDIA_ATTACHMENTS = Type.Optional(Type.Array(Type.String(), {
  description: 'Workspace paths of images or videos to attach (up to 10), e.g. ["renders/hero.png", "clips/demo.mp4"].',
}))

/** Uploads into the board's channel through `route` (a board or card attachments route). */
function boardUploader(ctx: ToolContext, ws: string, route: string): MediaUploader {
  const { projectId, sessionId } = identity(ctx)
  return (file) => uploadAgentFile(ws, route, file, { projectId, sessionId })
}

/** Rewrites workspace media in a description to stored URLs; returns the body field and any problems. */
async function withPublishedDescription(ctx: ToolContext, ws: string, route: string, description: unknown) {
  if (typeof description !== 'string' || !description.includes('![')) return { description, mediaErrors: [] as string[] }
  const published = await publishWorkspaceMedia(description, ctx.workspaceDir, boardUploader(ctx, ws, route))
  return { description: published.markdown, mediaErrors: published.errors }
}

function withMediaErrors<T extends { ok: boolean; data?: any }>(r: T, errors: string[]): T {
  return errors.length && r.ok ? { ...r, data: { ...r.data, media_errors: errors } } : r
}

function defineTool(
  ctx: ToolContext,
  spec: { name: string; label: string; description: string; parameters: TSchema },
  run: (workspaceId: string, p: Params) => Promise<{ ok: boolean; data?: any; error?: string; code?: string; status?: number }>,
): AgentTool {
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters as any,
    execute: async (_id, params) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return textResult({ error: 'This runtime has no workspace context, so boards are unavailable.', code: 'no_workspace' })
      const result = await run(workspaceId, (params ?? {}) as Params)
      if (result.ok) return textResult({ ok: true, ...(result.data ?? {}) })
      return textResult({ error: result.error ?? `${spec.label} failed`, code: result.code, status: result.status })
    },
  }
}

/**
 * Event lines (see cardEventLine in the API) that mean a handed-off card needs
 * its assigner: it reached review, waiting, done or dismissed, or the
 * assignee's run ended without moving it.
 */
export const HANDOFF_WATCH_UNTIL = 'moved to [^\\n]*\\((review|waiting|done|dismissed)\\)|(^|\\n)agent (stopped|failed)'

const OPEN_CATEGORIES = new Set(['backlog', 'active'])

/** The card sits with another agent (its assignee, or its column's agent) that still has work to do on it. */
export function isHandedOff(item: { assignee_agent?: string | null; column_agent?: string | null; category?: string | null }, selfRef: string): boolean {
  const holder = item.assignee_agent ?? item.column_agent
  return !!holder && holder !== selfRef && OPEN_CATEGORIES.has(item.category ?? 'backlog')
}

function selfAgentRef(ctx: ToolContext): string {
  const projectId = channelIdentity(ctx).projectId
  return projectId ? `project:${projectId}` : 'workspace'
}

/**
 * A card read or write returns the card as a task: waiting on it with `until`
 * (e.g. "Done") blocks until the card gets there, and wakes this session if it
 * gets there later. A card this agent hands to another agent is watched right
 * away (`handoff`), so the assigner is woken when it comes back; any other card
 * is tracked only once the agent waits on it.
 */
async function withCardTask(ctx: ToolContext, r: { ok: boolean; data?: any }, opts: { handoff?: boolean } = {}) {
  const item = r.data?.item
  if (!r.ok || !item?.id || !ctx.commandRegistry || !ctx.sessionId) return r
  const watch = !!opts.handoff && isHandedOff(item, selfAgentRef(ctx))
  const task = await trackRemoteTask(ctx.commandRegistry, ctx.sessionId, {
    source: 'work_item',
    targetRef: item.id,
    title: [item.key, item.title].filter(Boolean).join(' ') || item.id,
    lazy: !watch,
    ...(watch ? { until: HANDOFF_WATCH_UNTIL } : {}),
  }).catch(() => undefined)
  if (!task) return r
  return { ...r, data: { ...r.data, task_id: task.task_id, ...(watch ? { watching: true } : {}) } }
}

/** Board responses carry every column; agents need names, categories and limits. */
function compactBoard(b: any) {
  if (!b) return b
  return {
    id: b.id,
    name: b.name,
    slug: b.slug,
    channel: b.channelName ?? b.conversationId ?? null,
    item_type: b.itemType,
    key_prefix: b.keyPrefix,
    post_to_channel: b.postToChannel,
    requires_human_review: b.requiresHumanReview,
    default_agent: b.defaultAssigneeAgentRef,
    managed_by: b.managedBy,
    archived: !!b.archivedAt,
    ...(b.itemCount !== undefined ? { cards: b.itemCount } : {}),
    columns: (b.columns ?? []).map((c: any) => ({
      name: c.name,
      category: c.category,
      ...(c.wipLimit ? { wip_limit: c.wipLimit } : {}),
      ...(c.agentRef ? { agent: c.agentRef } : {}),
      ...(c.slaHours ? { sla_hours: c.slaHours } : {}),
    })),
    ...(b.fieldsSchema?.length ? { fields: b.fieldsSchema } : {}),
  }
}

function compactItem(i: any) {
  if (!i) return i
  return {
    key: i.key,
    id: i.id,
    title: i.title,
    column: i.column?.name,
    category: i.column?.category,
    board: i.board?.name,
    priority: i.priority,
    assignee_user: i.assigneeUserId,
    assignee_agent: i.assigneeAgentRef,
    ...(i.column?.agentRef ? { column_agent: i.column.agentRef } : {}),
    due_at: i.dueAt,
    ...(i.fields && Object.keys(i.fields).length ? { fields: i.fields } : {}),
    thread_id: i.threadRootMessageId,
    last_activity_at: i.lastActivityAt,
  }
}

function columnBody(c: Params) {
  return { name: c.name, category: c.category, wip_limit: c.wip_limit, agent: c.agent, sla_hours: c.sla_hours }
}

// ─── Working cards (boardsEnabled) ───────────────────────────────────────────

function boardList(ctx: ToolContext) {
  return defineTool(ctx, {
    name: 'board_list',
    label: 'List Boards',
    description: 'List work boards you can see, with their columns. Pass channel to list one channel’s boards (a channel can have several, e.g. #sales: Pipeline, Renewals).',
    parameters: Type.Object({ channel: Type.Optional(CHANNEL), include_archived: Type.Optional(Type.Boolean()) }),
  }, async (ws, p) => {
    const r = await agentBoardsRequest(ws, 'GET', '/agent-boards', { query: { channel: p.channel, includeArchived: p.include_archived, projectId: identity(ctx).projectId } })
    return r.ok ? { ...r, data: { boards: (r.data?.boards ?? []).map(compactBoard) } } : r
  })
}

function boardSummaryTool(ctx: ToolContext) {
  return defineTool(ctx, {
    name: 'board_summary',
    label: 'Board Summary',
    description: 'Counts per column, open cards by assignee, cards created and finished in the window, and median cycle time for one board. Use for digests and status reports.',
    parameters: Type.Object({ board: BOARD_REF, channel: Type.Optional(CHANNEL), days: Type.Optional(Type.Number({ description: 'Window in days (default 7).' })) }),
  }, (ws, p) => agentBoardsRequest(ws, 'GET', `/agent-boards/${enc(p.board)}/summary`, { query: { channel: p.channel, days: p.days, projectId: identity(ctx).projectId } }))
}

function boardHealthTool(ctx: ToolContext) {
  return defineTool(ctx, {
    name: 'board_health',
    label: 'Board Health',
    description: 'What needs attention across boards: SLA breaches, columns over their WIP limit, stale cards, unassigned active cards, overdue cards, and cards waiting in "Needs attention". Use it in a heartbeat sweep or a status report to catch what slipped through; cards you handed off already report back on their own.',
    parameters: Type.Object({ channel: Type.Optional(CHANNEL), board: Type.Optional(BOARD_REF), stale_hours: Type.Optional(Type.Number({ description: 'Hours without activity that make a card stale (default 72).' })) }),
  }, (ws, p) => agentBoardsRequest(ws, 'GET', '/agent-boards/health', { query: { channel: p.channel, board: p.board, staleHours: p.stale_hours, projectId: identity(ctx).projectId } }))
}

function itemList(ctx: ToolContext) {
  return defineTool(ctx, {
    name: 'work_item_list',
    label: 'List Cards',
    description: 'List open cards across boards, filtered by channel, board, assignee ("me" for cards assigned to you, "none" for unassigned, a user id, or an agent), column category or priority. Sorted by priority, then latest activity.',
    parameters: Type.Object({
      channel: Type.Optional(CHANNEL),
      board: Type.Optional(BOARD_REF),
      assignee: Type.Optional(Type.String()),
      category: Type.Optional(Type.Array(CATEGORY)),
      priority: Type.Optional(Type.Array(PRIORITY)),
      q: Type.Optional(Type.String({ description: 'Search titles and keys.' })),
      include_closed: Type.Optional(Type.Boolean()),
      sort: Type.Optional(Type.Union(['priority', 'activity', 'due', 'created'].map((v) => Type.Literal(v)))),
      limit: Type.Optional(Type.Number()),
    }),
  }, async (ws, p) => {
    const r = await agentBoardsRequest(ws, 'GET', '/agent-work-items', {
      query: {
        channel: p.channel,
        board: p.board,
        assignee: p.assignee,
        category: Array.isArray(p.category) ? p.category.join(',') : undefined,
        priority: Array.isArray(p.priority) ? p.priority.join(',') : undefined,
        q: p.q,
        include_closed: p.include_closed,
        sort: p.sort,
        limit: p.limit ?? 50,
        projectId: identity(ctx).projectId,
      },
    })
    return r.ok ? { ...r, data: { items: (r.data?.items ?? []).map(compactItem) } } : r
  })
}

function itemCreate(ctx: ToolContext) {
  return defineTool(ctx, {
    name: 'work_item_create',
    label: 'Create Card',
    description:
      'Create a card on a board. It gets a key (e.g. SUP-42) and its own thread in the board’s channel, which is where its discussion and agent work happen. ' +
      'Assigning an agent, or creating it in a column with an agent, hands the card to that agent in the thread and returns a task_id you are already watching (`watching: true`): you get a [Task update] when the card reaches review, waiting, done or dismissed, or that agent stops without moving it. Pass from_message to make a card from a channel message (it is quoted and linked). ' +
      'For intake from systems (tickets, alerts), pass fingerprint so repeats update the open card instead of making duplicates.',
    parameters: Type.Object({
      board: BOARD_REF,
      channel: Type.Optional(CHANNEL),
      title: Type.String(),
      description: Type.Optional(Type.String({ description: `What is needed and the acceptance criteria. ${DESCRIPTION_MEDIA}` })),
      column: Type.Optional(Type.String({ description: 'Column name; default is the first backlog column.' })),
      fields: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: 'Values for the board’s fields, e.g. { "amount": 12000, "customer": "Acme" }.' })),
      priority: Type.Optional(PRIORITY),
      assignee_user: Type.Optional(Type.String({ description: 'User id of the person who owns it.' })),
      assignee_agent: Type.Optional(Type.String({ description: AGENT_REF })),
      due_at: Type.Optional(Type.String({ description: 'ISO date.' })),
      external_ref: Type.Optional(Type.String({ description: 'Id or URL in another system (Zendesk ticket, GitHub issue).' })),
      fingerprint: Type.Optional(Type.String()),
      from_message: Type.Optional(Type.String({ description: 'Message id to make the card from.' })),
    }),
  }, async (ws, p) => {
    const { board, channel, ...rest } = p
    const route = `/agent-boards/${enc(board)}/attachments${channel ? `?channel=${enc(channel)}` : ''}`
    const { description, mediaErrors } = await withPublishedDescription(ctx, ws, route, rest.description)
    const r = await agentBoardsRequest(ws, 'POST', `/agent-boards/${enc(board)}/items`, { body: { ...rest, description, ...identity(ctx) }, query: { channel } })
    return withCardTask(ctx, withMediaErrors(r.ok ? { ...r, data: { item: compactItem(r.data?.item) } } : r, mediaErrors), { handoff: true })
  })
}

function itemGet(ctx: ToolContext) {
  return defineTool(ctx, {
    name: 'work_item_get',
    label: 'Get Card',
    description:
      'Everything needed to pick up a card: its fields, column, assignee, the rolling history summary, the latest thread messages, conversations it was mentioned in elsewhere, and earlier agent runs on it. ' +
      'Call this first when you are handed a card, then continue from where the last person or agent stopped. ' +
      'Returns task_id for the card: wait on it with until (e.g. "Done") to block until the card gets there.',
    parameters: Type.Object({ item: ITEM_REF }),
  }, async (ws, p) => withCardTask(ctx, await agentBoardsRequest(ws, 'GET', `/agent-work-items/${enc(p.item)}`, { query: { projectId: identity(ctx).projectId } })))
}

function itemUpdate(ctx: ToolContext) {
  return defineTool(ctx, {
    name: 'work_item_update',
    label: 'Update Card',
    description:
      'Change a card’s title, description, fields (merged; set a field to null to clear it), priority, assignee or due date. Assigning an agent hands the card to it, and you are told through a [Task update] when it comes back. ' +
      'Before you finish working a card, set history_summary to two to five sentences on where it stands and what is next, so whoever picks it up next starts from there.',
    parameters: Type.Object({
      item: ITEM_REF,
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String({ description: DESCRIPTION_MEDIA })),
      fields: Type.Optional(Type.Record(Type.String(), Type.Any())),
      priority: Type.Optional(PRIORITY),
      assignee_user: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      assignee_agent: Type.Optional(Type.Union([Type.String({ description: AGENT_REF }), Type.Null()])),
      due_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      external_ref: Type.Optional(Type.String()),
      history_summary: Type.Optional(Type.String()),
    }),
  }, async (ws, p) => {
    const { item, ...rest } = p
    const { description, mediaErrors } = await withPublishedDescription(ctx, ws, `/agent-work-items/${enc(item)}/attachments`, rest.description)
    const body = { ...rest, ...(description !== undefined ? { description } : {}), ...identity(ctx) }
    const r = await agentBoardsRequest(ws, 'PATCH', `/agent-work-items/${enc(item)}`, { body })
    return withCardTask(ctx, withMediaErrors(r.ok ? { ...r, data: { item: compactItem(r.data?.item) } } : r, mediaErrors), { handoff: true })
  })
}

function itemMove(ctx: ToolContext) {
  return defineTool(ctx, {
    name: 'work_item_move',
    label: 'Move Card',
    description:
      'Move a card to another column, or to a board in another channel (e.g. escalate a support ticket to #eng’s Bug Triage). The card keeps its key and thread; the other channel gets a link. ' +
      'Moving into a column with an agent hands the card to that agent, and you are told through a [Task update] when it comes back. On boards that require human review, agents move cards to a review column and a person closes them.',
    parameters: Type.Object({
      item: ITEM_REF,
      column: Type.String({ description: 'Column name (or category, e.g. "done").' }),
      board: Type.Optional(Type.String({ description: 'Destination board, when moving across boards.' })),
      after: Type.Optional(Type.String({ description: 'Card id to place it after.' })),
      before: Type.Optional(Type.String({ description: 'Card id to place it before.' })),
    }),
  }, async (ws, p) => {
    const { item, ...rest } = p
    const r = await agentBoardsRequest(ws, 'POST', `/agent-work-items/${enc(item)}/move`, { body: { ...rest, ...identity(ctx) } })
    return withCardTask(ctx, r.ok ? { ...r, data: { item: compactItem(r.data?.item), warnings: r.data?.warnings ?? [] } } : r, { handoff: true })
  })
}

function itemComment(ctx: ToolContext) {
  return defineTool(ctx, {
    name: 'work_item_comment',
    label: 'Comment on Card',
    description: 'Post in a card’s thread as yourself, e.g. what you did, what you found, or a question. Tag a person or agent the same way as in team_chat_post. Use this rather than team_chat_post when you are not already replying in the card’s thread. ' +
      'To show images or videos you made (renders, screenshots, clips), pass their workspace paths in attachments; they appear in the thread.',
    parameters: Type.Object({ item: ITEM_REF, text: Type.Optional(Type.String()), attachments: MEDIA_ATTACHMENTS }),
  }, async (ws, p) => {
    const paths: string[] = Array.isArray(p.attachments) ? p.attachments : []
    if (!p.text?.trim() && !paths.length) return { ok: false, error: 'text or attachments is required', code: 'invalid_input' }
    const uploaded = paths.length
      ? await uploadWorkspaceMedia(ctx.workspaceDir, paths, boardUploader(ctx, ws, `/agent-work-items/${enc(p.item)}/attachments`))
      : { files: [], errors: [] as string[] }
    if (paths.length && !uploaded.files.length && !p.text?.trim()) {
      return { ok: false, error: uploaded.errors.join('; ') || 'No attachments could be uploaded', code: 'upload_failed' }
    }
    const r = await agentBoardsRequest(ws, 'POST', `/agent-work-items/${enc(p.item)}/comments`, {
      body: { text: p.text ?? '', attachmentIds: uploaded.files.map((f) => f.id), ...identity(ctx) },
    })
    return withMediaErrors(r, uploaded.errors)
  })
}

function itemBulk(ctx: ToolContext) {
  return defineTool(ctx, {
    name: 'work_item_bulk_update',
    label: 'Bulk Update Cards',
    description: 'Apply one change to up to 100 cards: move them to a column, set priority or assignee, or archive them. Each card is checked and recorded separately; the result lists which ones failed.',
    parameters: Type.Object({
      items: Type.Array(ITEM_REF),
      column: Type.Optional(Type.String()),
      priority: Type.Optional(PRIORITY),
      assignee_user: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      assignee_agent: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      archived: Type.Optional(Type.Boolean()),
    }),
  }, (ws, p) => {
    const { items, ...patch } = p
    return agentBoardsRequest(ws, 'POST', '/agent-work-items/bulk', { body: { ids: items, patch, ...identity(ctx) } })
  })
}

function itemHistory(ctx: ToolContext) {
  return defineTool(ctx, {
    name: 'work_item_history',
    label: 'Card History',
    description: 'Page through a card’s full timeline, newest first: thread messages, moves and assignments, links to other conversations, and agent runs. Filter to comments, status, agent or links. Pass next_before to get older entries.',
    parameters: Type.Object({
      item: ITEM_REF,
      filter: Type.Optional(Type.Union(['all', 'comments', 'status', 'agent', 'links'].map((v) => Type.Literal(v)))),
      limit: Type.Optional(Type.Number()),
      before: Type.Optional(Type.String({ description: 'ISO timestamp from a previous call’s nextBefore.' })),
    }),
  }, (ws, p) => agentBoardsRequest(ws, 'GET', `/agent-work-items/${enc(p.item)}/history`, { query: { filter: p.filter, limit: p.limit, before: p.before, projectId: identity(ctx).projectId } }))
}

function itemLink(ctx: ToolContext) {
  return defineTool(ctx, {
    name: 'work_item_link',
    label: 'Link to Card',
    description: 'Record that a message, thread, PR, doc, or external thread belongs to a card’s history. Mentions of the card key in chat are linked automatically, so use this for things that do not mention it.',
    parameters: Type.Object({
      item: ITEM_REF,
      kind: Type.Union(['message', 'thread', 'pr', 'doc', 'external_thread'].map((v) => Type.Literal(v))),
      ref_id: Type.String({ description: 'Message id, or the PR / doc / external id.' }),
      url: Type.Optional(Type.String()),
      snippet: Type.Optional(Type.String({ description: 'One line on what it is.' })),
    }),
  }, (ws, p) => {
    const { item, ...rest } = p
    return agentBoardsRequest(ws, 'POST', `/agent-work-items/${enc(item)}/links`, { body: { ...rest, ...identity(ctx) } })
  })
}

// ─── Board structure (boardAdminEnabled) ─────────────────────────────────────

function boardCreate(ctx: ToolContext) {
  return defineTool(ctx, {
    name: 'board_create',
    label: 'Create Board',
    description:
      'Add a Kanban board to a channel (a channel can hold several). Omit columns to get the item type’s defaults. ' +
      'Pass template (a board id from work_template_list, e.g. "renewals") to start from a ready-made board; anything else you pass overrides it. ' +
      'For a whole department (channel, boards, agents, triggers) use work_template_add or shogo-system.yaml and system_apply instead.',
    parameters: Type.Object({
      template: Type.Optional(Type.String({ description: 'Board template id, e.g. "support-tickets", "sales-pipeline", "okrs".' })),
      channel: Type.Optional(Type.String({ description: 'Channel name (without #) or id. Required unless the template names one.' })),
      name: Type.Optional(Type.String({ description: 'Required unless a template is given.' })),
      item_type: Type.Optional(ITEM_TYPE),
      description: Type.Optional(Type.String()),
      columns: Type.Optional(Type.Array(COLUMN)),
      fields: Type.Optional(Type.Array(FIELD, { description: 'Card fields, e.g. amount (money), customer (text), stage owner (user).' })),
      post_to_channel: Type.Optional(Type.Union([Type.Literal('all'), Type.Literal('done_only'), Type.Literal('none')], { description: 'Which card events post in the channel (default all).' })),
      requires_human_review: Type.Optional(Type.Boolean({ description: 'Agents cannot close cards; a person must move them from review to done.' })),
      default_agent: Type.Optional(Type.String({ description: `${AGENT_REF} New cards go to it unless assigned.` })),
      key_prefix: Type.Optional(Type.String({ description: 'Card key prefix, e.g. "SUP".' })),
    }),
  }, async (ws, raw) => {
    const { template, ...given } = raw
    let p: Params = given
    if (template) {
      if (findWorkTemplate(template)?.kind !== 'board') {
        return { ok: false, error: `No board template "${template}". Board templates: ${BOARD_TEMPLATES.map((t) => t.id).join(', ')}.`, code: 'unknown_template' }
      }
      p = { ...boardTemplateArgs(template), ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)) }
    }
    if (!p.channel || !p.name) return { ok: false, error: 'channel and name are required (or pass a board template).', code: 'invalid' }
    const body = { ...p, columns: Array.isArray(p.columns) ? p.columns.map(columnBody) : undefined, ...identity(ctx) }
    const r = await agentBoardsRequest(ws, 'POST', '/agent-boards', { body })
    return r.ok ? { ...r, data: { board: compactBoard(r.data?.board) } } : r
  })
}

function boardUpdate(ctx: ToolContext) {
  return defineTool(ctx, {
    name: 'board_update',
    label: 'Update Board',
    description: 'Rename a board or change its settings: description, what posts to the channel, human review, default agent, key prefix, or the channel it lives in (move_to_channel).',
    parameters: Type.Object({
      board: BOARD_REF,
      channel: Type.Optional(CHANNEL),
      name: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      post_to_channel: Type.Optional(Type.Union([Type.Literal('all'), Type.Literal('done_only'), Type.Literal('none')])),
      requires_human_review: Type.Optional(Type.Boolean()),
      default_agent: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      key_prefix: Type.Optional(Type.String()),
      fields: Type.Optional(Type.Array(FIELD)),
      move_to_channel: Type.Optional(CHANNEL),
    }),
  }, async (ws, p) => {
    const { board, channel, move_to_channel, ...rest } = p
    const r = await agentBoardsRequest(ws, 'PATCH', `/agent-boards/${enc(board)}`, {
      body: { ...rest, ...(move_to_channel ? { channel: move_to_channel } : {}), ...identity(ctx) },
      query: { channel },
    })
    return r.ok ? { ...r, data: { board: compactBoard(r.data?.board) } } : r
  })
}

function boardArchive(ctx: ToolContext) {
  return defineTool(ctx, {
    name: 'board_archive',
    label: 'Archive Board',
    description: 'Archive a board (its cards and history are kept and it can be restored), or restore an archived one with restore: true. Confirm with the person before archiving a board that still has open cards.',
    parameters: Type.Object({ board: BOARD_REF, channel: Type.Optional(CHANNEL), restore: Type.Optional(Type.Boolean()) }),
  }, async (ws, p) => {
    const r = await agentBoardsRequest(ws, 'POST', `/agent-boards/${enc(p.board)}/archive`, { body: { archived: p.restore !== true, ...identity(ctx) }, query: { channel: p.channel } })
    return r.ok ? { ...r, data: { board: compactBoard(r.data?.board) } } : r
  })
}

function boardReorder(ctx: ToolContext) {
  return defineTool(ctx, {
    name: 'board_reorder',
    label: 'Reorder Boards',
    description: 'Set the tab order of a channel’s boards. Boards you leave out keep their relative order after the ones you list.',
    parameters: Type.Object({ channel: CHANNEL, boards: Type.Array(BOARD_REF) }),
  }, (ws, p) => agentBoardsRequest(ws, 'PUT', '/agent-boards/order', { body: { channel: p.channel, boards: p.boards, ...identity(ctx) } }))
}

function columnCreate(ctx: ToolContext) {
  return defineTool(ctx, {
    name: 'column_create',
    label: 'Add Column',
    description: 'Add a column to a board, placed after or before a named column (e.g. "Legal review" after "Proposal"). Existing cards stay where they are.',
    parameters: Type.Object({
      board: BOARD_REF,
      channel: Type.Optional(CHANNEL),
      name: Type.String(),
      category: Type.Optional(CATEGORY),
      after: Type.Optional(Type.String()),
      before: Type.Optional(Type.String()),
      wip_limit: Type.Optional(Type.Number()),
      agent: Type.Optional(Type.String({ description: AGENT_REF })),
      sla_hours: Type.Optional(Type.Number()),
    }),
  }, async (ws, p) => {
    const { board, channel, ...rest } = p
    const r = await agentBoardsRequest(ws, 'POST', `/agent-boards/${enc(board)}/columns`, { body: { ...rest, ...identity(ctx) }, query: { channel } })
    return r.ok ? { ...r, data: { board: compactBoard(r.data?.board) } } : r
  })
}

function columnUpdate(ctx: ToolContext) {
  return defineTool(ctx, {
    name: 'column_update',
    label: 'Update Column',
    description: 'Rename a column, change its category, WIP limit, agent or SLA, or move it (after another column).',
    parameters: Type.Object({
      board: BOARD_REF,
      channel: Type.Optional(CHANNEL),
      column: Type.String({ description: 'Current column name.' }),
      name: Type.Optional(Type.String()),
      category: Type.Optional(CATEGORY),
      after: Type.Optional(Type.String()),
      wip_limit: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
      agent: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      sla_hours: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    }),
  }, async (ws, p) => {
    const { board, channel, column, ...rest } = p
    const r = await agentBoardsRequest(ws, 'PATCH', `/agent-boards/${enc(board)}/columns/${encodeURIComponent(column)}`, { body: { ...rest, ...identity(ctx) }, query: { channel } })
    return r.ok ? { ...r, data: { board: compactBoard(r.data?.board) } } : r
  })
}

function columnDelete(ctx: ToolContext) {
  return defineTool(ctx, {
    name: 'column_delete',
    label: 'Delete Column',
    description: 'Delete a column. Refused while it has cards unless you pass move_to with the column to move them to first.',
    parameters: Type.Object({ board: BOARD_REF, channel: Type.Optional(CHANNEL), column: Type.String(), move_to: Type.Optional(Type.String()) }),
  }, async (ws, p) => {
    const r = await agentBoardsRequest(ws, 'DELETE', `/agent-boards/${enc(p.board)}/columns/${encodeURIComponent(p.column)}`, { query: { channel: p.channel, move_to: p.move_to, projectId: identity(ctx).projectId } })
    return r.ok ? { ...r, data: { moved: r.data?.moved ?? 0, board: compactBoard(r.data?.board) } } : r
  })
}

// ─── Problems (problemsEnabled) ──────────────────────────────────────────────

function problemReport(ctx: ToolContext) {
  return defineTool(ctx, {
    name: 'problem_report',
    label: 'Report Problem',
    description:
      'Record an error on a problem board. Errors with the same fingerprint group into one card: a new one opens a card in Detected, a repeat adds an occurrence, and a repeat after the card was resolved reopens it as a regression.',
    parameters: Type.Object({
      board: BOARD_REF,
      title: Type.String({ description: 'Short error title, e.g. "TypeError in CheckoutForm.submit".' }),
      fingerprint: Type.String({ description: 'Stable grouping key, e.g. error type + top stack frame.' }),
      environment: Type.Optional(Type.String()),
      release: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
      stack: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
    }),
  }, (ws, p) => {
    const { board, ...rest } = p
    return agentBoardsRequest(ws, 'POST', `/agent-boards/${enc(board)}/problems`, { body: { ...rest, ...identity(ctx) } })
  })
}

function problemOccurrences(ctx: ToolContext) {
  return defineTool(ctx, {
    name: 'problem_occurrences',
    label: 'Problem Occurrences',
    description: 'Recent occurrences of a problem card, grouped by day and environment, with the latest message and stack. Use when investigating a problem.',
    parameters: Type.Object({ item: ITEM_REF, limit: Type.Optional(Type.Number()) }),
  }, (ws, p) => agentBoardsRequest(ws, 'GET', `/agent-work-items/${enc(p.item)}/occurrences`, { query: { limit: p.limit, projectId: identity(ctx).projectId } }))
}

// ─── Templates (boardAdminEnabled) ───────────────────────────────────────────

function templateList(): AgentTool {
  return {
    name: 'work_template_list',
    label: 'List Work Templates',
    description:
      'Ready-made setups: company bundles (several departments at once), department bundles (a channel, its boards, a department agent and triggers) and single boards. ' +
      'Add a company or department with work_template_add, then run system_apply; add a single board with board_create { template }.',
    parameters: Type.Object({ kind: Type.Optional(Type.Union([Type.Literal('company'), Type.Literal('department'), Type.Literal('board')])) }),
    execute: async (_id, params) => textResult({ templates: listWorkTemplates((params as Params)?.kind) }),
  }
}

function templateAdd(ctx: ToolContext): AgentTool {
  return {
    name: 'work_template_add',
    label: 'Add Work Template',
    description:
      'Merge a company or department template into shogo-system.yaml (created if missing). Nothing already in the manifest is changed, so adding the same template twice is a no-op. ' +
      'Review or edit the file, then run system_apply (dryRun first to show the plan). A board template can be added only to a channel the manifest already declares; otherwise use board_create { template }.',
    parameters: Type.Object({
      template: Type.String({ description: 'Template id from work_template_list, e.g. "saas-startup" or "support".' }),
      channel: Type.Optional(Type.String({ description: 'For a board template: the channel to add it to (default: the template’s).' })),
      manifestPath: Type.Optional(Type.String({ description: `Path relative to the project root (default "${MANIFEST_PATH}").` })),
    }),
    execute: async (_id, params) => {
      const p = (params ?? {}) as Params
      const rel = typeof p.manifestPath === 'string' && p.manifestPath ? p.manifestPath : MANIFEST_PATH
      if (!isSafeRelativePath(rel)) return textResult({ error: `Unsafe manifestPath "${rel}"`, code: 'invalid' })
      const abs = resolve(ctx.workspaceDir, rel)
      try {
        const existing = existsSync(abs) ? readFileSync(abs, 'utf-8') : null
        const merged = mergeWorkTemplate(existing, String(p.template), { channel: p.channel })
        const check = parseSystemManifest(merged.yaml)
        if (!check.ok) return textResult({ error: 'The merged manifest does not validate; nothing was written.', errors: check.errors, code: 'invalid_manifest' })
        if (merged.added.length) {
          mkdirSync(dirname(abs), { recursive: true })
          writeFileSync(abs, merged.yaml, 'utf-8')
        }
        return textResult({
          ok: true,
          manifestPath: rel,
          added: merged.added,
          ...(merged.skipped.length ? { already_there: merged.skipped } : {}),
          next: merged.added.length ? `Run system_apply { manifestPath: "${rel}", dryRun: true } to show the plan, then apply it.` : 'Nothing new to add.',
        })
      } catch (err) {
        return textResult({ error: err instanceof Error ? err.message : String(err), code: 'template_failed' })
      }
    },
  }
}

export function createBoardTools(ctx: ToolContext): AgentTool[] {
  return [
    boardList(ctx),
    boardSummaryTool(ctx),
    boardHealthTool(ctx),
    itemList(ctx),
    itemCreate(ctx),
    itemGet(ctx),
    itemUpdate(ctx),
    itemMove(ctx),
    itemComment(ctx),
    itemBulk(ctx),
    itemHistory(ctx),
    itemLink(ctx),
    boardCreate(ctx),
    boardUpdate(ctx),
    boardArchive(ctx),
    boardReorder(ctx),
    columnCreate(ctx),
    columnUpdate(ctx),
    columnDelete(ctx),
    templateList(),
    templateAdd(ctx),
    problemReport(ctx),
    problemOccurrences(ctx),
  ]
}

export const BOARDS_GUIDE = [
  '## Work Boards',
  '',
  'Channels can hold Kanban boards (several per channel, e.g. #support: Tickets, Bugs). Each card has a key like SUP-42 and its own thread in the channel; that thread, plus every conversation that mentions the key, is the card’s history.',
  '- Handed a card (tagged in its thread, or it was moved into your column)? Call `work_item_get` first, read its history summary and recent thread, then do the work in that thread.',
  '- Finish by moving the card with `work_item_move` and setting `history_summary` with `work_item_update`: where it stands, what you did, what is next.',
  '- Work that should be tracked goes on a card (`work_item_create`), not only in a chat message. Use `from_message` when someone asks for it in chat.',
  '- On boards that require human review, move finished cards to the review column; a person closes them.',
  '- Running a project through other agents (phases, milestones, "keep it going until it is done")? Hand each card off, then end your turn. Every card you hand to an agent is watched for you, and a `[Task update]` wakes you the moment it reaches review, waiting or done, or its agent stops without moving it. On each update: check the evidence yourself, move the card on, hand off the next card, and end your turn again. Never create a schedule or raise a heartbeat to follow cards; that only adds delay and misses agents that stop. If one of your schedules already does that (an hourly loop that reviews cards and assigns the next), turn it off with `schedule_update` (enabled: false) and tell the user why; keeping it "as a backstop" makes cards wait for the timer and gets them reviewed twice.',
  '- Escalate across teams by moving the card to the other channel’s board; do not copy it.',
  '- Set up a department’s channel, boards, agents and triggers together in shogo-system.yaml with `system_apply`; use `board_create` and `column_*` for one-off changes.',
  '- Start from a template when one fits: `work_template_list`, then `work_template_add` for a company or department (then `system_apply`), or `board_create { template }` for one board.',
  '- To turn an event into a card, add a trigger with `target: work_item` and a `card`, e.g. `{ key: onboarding-cards, name: New members get an onboarding card, event: member.joined, target: work_item, card: { board: Onboarding, channel: people, title: "Onboard {{member.name}}" } }`. `trigger_types_list` lists the events.',
].join('\n')

export const COMPANY_OPS_GUIDE = [
  '## Company Operations',
  '',
  'You keep the workspace’s boards moving. Cards you hand off report back through `[Task update]`; act on those as they arrive. The heartbeat is the sweep for everything else:',
  '- Run `board_health`. For each SLA breach or stale card, comment in its thread tagging its assignee with one specific question; reassign only when the owner is away or the card is unassigned.',
  '- Cards in "Needs attention" (an agent failed on them): read the thread, then fix, reassign, or ask the owner.',
  '- Once a day, post one digest per department channel with `team_chat_post` (kind status): what was finished, what is blocked and on whom, what breached SLA. Use `board_summary`.',
  '- Once a week, post a summary across departments to #general and update goals with `goal_log`.',
  '- Do not nudge the same card twice within its SLA window, and never archive boards or delete columns on your own.',
  'Load the `company-ops` skill for the full playbook.',
].join('\n')
