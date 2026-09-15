// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

export interface SlackRoutableProject {
  id: string
  name: string
  description?: string | null
}

export interface SlackRoutingRule {
  keyword: string
  projectId: string
}

export interface SlackRoutingContext {
  message: string
  projects: SlackRoutableProject[]
  recentProjectId?: string | null
  channelDefaultProjectId?: string | null
  personalDefaultProjectId?: string | null
  workspaceDefaultProjectId?: string | null
  routingRules?: SlackRoutingRule[]
}

export type SlackCommand =
  | { type: 'settings' }
  | { type: 'list_projects' }
  | { type: 'agent'; prompt: string; forceNew: boolean }
  | { type: 'prompt'; prompt: string; forceNew: boolean }
  | { type: 'empty' }

export interface ParsedSlackMessage {
  command: SlackCommand
  projectSelector?: string
  options: Record<string, string>
}

export interface SlackRouteResult {
  project: SlackRoutableProject | null
  reason:
    | 'explicit'
    | 'recent'
    | 'routing_rule'
    | 'channel_default'
    | 'personal_default'
    | 'workspace_default'
    | 'ambiguous'
    | 'unresolved'
  candidates: SlackRoutableProject[]
}

export interface NormalizedSlackMessage {
  text: string
  channelId: string
  senderId: string
  timestamp: number
  threadTs?: string
  isMention: boolean
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[`"'“”‘’]/g, '')
    .replace(/[^a-z0-9._/-]+/g, ' ')
    .trim()
}

function findProject(projects: SlackRoutableProject[], selector: string): SlackRoutableProject | null {
  const normalizedSelector = normalize(selector)
  if (!normalizedSelector) return null

  const exactId = projects.find((project) => project.id.toLowerCase() === normalizedSelector)
  if (exactId) return exactId

  const exactName = projects.find((project) => normalize(project.name) === normalizedSelector)
  if (exactName) return exactName

  const matches = projects.filter((project) => {
    const name = normalize(project.name)
    const description = normalize(project.description || '')
    return name.includes(normalizedSelector) || description.includes(normalizedSelector)
  })
  return matches.length === 1 ? matches[0] : null
}

function matchingProjects(projects: SlackRoutableProject[], selector: string): SlackRoutableProject[] {
  const normalizedSelector = normalize(selector)
  if (!normalizedSelector) return []
  return projects.filter((project) => {
    const name = normalize(project.name)
    const description = normalize(project.description || '')
    return name.includes(normalizedSelector) || description.includes(normalizedSelector)
  })
}

/**
 * Extracts the small command language used by the Slack base agent. Options
 * are intentionally parsed without evaluating arbitrary input; the remaining
 * text is passed to the selected project agent as the user's prompt.
 */
export function parseSlackMessage(text: string): ParsedSlackMessage {
  const withoutMention = text
    .replace(/<@[A-Z0-9]+>/gi, ' ')
    .replace(/^\s*@(?:shogo|cursor)\b\s*/i, '')
    .trim()

  const options: Record<string, string> = {}
  const optionPattern = /(?:^|\s)(project|repo|env|branch|model|autopr|channel)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))/gi
  let projectSelector: string | undefined
  let match: RegExpExecArray | null
  while ((match = optionPattern.exec(withoutMention))) {
    const key = match[1].toLowerCase()
    const value = (match[2] || match[3] || match[4] || '').trim()
    if (!value) continue
    options[key] = value
    if (key === 'project') projectSelector = value
  }

  const prompt = withoutMention
    .replace(optionPattern, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!prompt) return { command: { type: 'empty' }, projectSelector, options }
  if (/^settings(?:\s|$)/i.test(prompt)) {
    return { command: { type: 'settings' }, projectSelector, options }
  }
  if (/^(?:list\s+)?(?:my\s+)?projects(?:\s|$)/i.test(prompt)) {
    return { command: { type: 'list_projects' }, projectSelector, options }
  }

  const forceNew = /^agent(?:\s|$)/i.test(prompt) ||
    /\b(?:start|launch|create)\s+(?:a\s+)?(?:new|fresh)\s+agent\b/i.test(prompt)
  const agentPrompt = forceNew
    ? prompt.replace(/^agent\s*/i, '').replace(/\b(?:start|launch|create)\s+(?:a\s+)?(?:new|fresh)\s+agent\b/i, '').trim()
    : prompt
  return {
    command: {
      type: forceNew ? 'agent' : 'prompt',
      prompt: agentPrompt || prompt,
      forceNew,
    },
    projectSelector,
    options,
  }
}

/**
 * Normalize only user-authored message events. Bot messages, message
 * subtypes, and events without a routable channel/user are ignored here so
 * every ingress can share the same loop-prevention behavior.
 */
export function normalizeSlackMessageEvent(
  event: Record<string, any>,
  botUserId?: string | null,
): NormalizedSlackMessage | null {
  if (event.type !== 'message' && event.type !== 'app_mention') return null
  if (!event.user || !event.channel || event.subtype || event.bot_id) return null
  if (botUserId && event.user === botUserId) return null
  const mention = botUserId
    ? new RegExp(`<@${escapeRegExp(botUserId)}>`, 'gi')
    : /<@[A-Z0-9]+>/gi
  const text = String(event.text || '').replace(mention, ' ').replace(/\s+/g, ' ').trim()
  if (!text) return null
  return {
    text,
    channelId: String(event.channel),
    senderId: String(event.user),
    timestamp: event.ts ? Number.parseFloat(String(event.ts)) * 1000 : Date.now(),
    threadTs: event.thread_ts,
    isMention: event.type === 'app_mention',
  }
}

/**
 * Resolves a request using Cursor-inspired precedence. The caller must pass
 * only projects the Slack user is allowed to access and has enabled for Slack.
 */
export function resolveSlackProject(context: SlackRoutingContext): SlackRouteResult {
  const { projects, message } = context
  if (projects.length === 0) {
    return { project: null, reason: 'unresolved', candidates: [] }
  }

  const parsed = parseSlackMessage(message)
  const explicitSelector = parsed.projectSelector ||
    parsed.options.repo ||
    projects.find((project) => {
      const normalizedName = normalize(project.name)
      const normalizedMessage = normalize(message)
      return normalizedName.length > 2 && normalizedMessage.includes(normalizedName)
    })?.name

  if (explicitSelector) {
    const explicit = findProject(projects, explicitSelector)
    if (explicit) return { project: explicit, reason: 'explicit', candidates: [explicit] }
    const explicitCandidates = matchingProjects(projects, explicitSelector)
    if (explicitCandidates.length > 1) {
      return { project: null, reason: 'ambiguous', candidates: explicitCandidates }
    }
  }

  const recent = context.recentProjectId && projects.find((project) => project.id === context.recentProjectId)
  if (recent) return { project: recent, reason: 'recent', candidates: [recent] }

  for (const rule of context.routingRules || []) {
    const keyword = normalize(rule.keyword)
    if (!keyword || !new RegExp(`(?:^|\\s)${escapeRegExp(keyword)}(?:$|\\s)`, 'i').test(normalize(message))) {
      continue
    }
    const project = projects.find((candidate) => candidate.id === rule.projectId)
    if (project) return { project, reason: 'routing_rule', candidates: [project] }
  }

  const defaults: Array<[SlackRouteResult['reason'], string | null | undefined]> = [
    ['channel_default', context.channelDefaultProjectId],
    ['personal_default', context.personalDefaultProjectId],
    ['workspace_default', context.workspaceDefaultProjectId],
  ]
  for (const [reason, id] of defaults) {
    const project = id && projects.find((candidate) => candidate.id === id)
    if (project) return { project, reason, candidates: [project] }
  }

  return projects.length === 1
    ? { project: projects[0], reason: 'unresolved', candidates: projects }
    : { project: null, reason: 'ambiguous', candidates: projects }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Slack conversation IDs are consistently prefixed by type: `D` for a 1:1
 * DM, `G` for a private channel/MPIM, `C` for a public channel.
 */
export function isSlackDirectMessageChannel(channelId: string): boolean {
  return channelId.startsWith('D')
}

export interface SlackThreadResolutionContext {
  channelId: string
  /** `thread_ts` on the *inbound* Slack event, if the user replied inside an existing thread. */
  messageThreadTs?: string | null
  /** `message.ts || randomUUID()` — used when none of the cases below apply. */
  fallbackTs: string
  /** True for an explicit "agent: ..." / "start a new agent" command. */
  forceNew: boolean
  /** The DM channel a prior turn last used for `activeDmThreadTs`, if any (from `SlackUserLink`). */
  activeDmChannelId?: string | null
  /** The Slack thread a prior turn in that DM is still running in, if any. */
  activeDmThreadTs?: string | null
}

/**
 * Resolves which Slack thread a turn should reply in.
 *
 *  - An explicit Slack reply-in-thread always wins — the user chose to
 *    branch a side conversation off some earlier message.
 *  - Otherwise, in a DM, reuse the running conversation's thread so
 *    consecutive plain messages keep appending to the same visible
 *    conversation and the same Shogo chat history, instead of each one
 *    spawning a brand-new Agent session that used to fragment both the
 *    Slack Messages tab and Shogo's own memory of the conversation.
 *  - `forceNew` ("agent: ...") explicitly starts a fresh thread.
 *  - Channel messages (app_mention) always get their own thread per
 *    mention, so replies don't clutter the shared channel.
 */
export function resolveSlackThreadTs(context: SlackThreadResolutionContext): string {
  if (context.messageThreadTs) return context.messageThreadTs
  const isDm = isSlackDirectMessageChannel(context.channelId)
  if (
    isDm &&
    !context.forceNew &&
    context.activeDmChannelId === context.channelId &&
    context.activeDmThreadTs
  ) {
    return context.activeDmThreadTs
  }
  return context.fallbackTs
}
