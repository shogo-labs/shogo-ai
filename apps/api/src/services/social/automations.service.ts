// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Comment→DM automations and DM sequences.
 *
 * Zernio owns the execution — it watches the comments, dedupes a commenter and
 * sends the DM — so this module is configuration, not a scheduler:
 *
 *   `comment_dm` / `keyword_reply`  `POST /v1/comment-automations`
 *   `sequence`                      `POST /v1/workflows` (a comment-triggered
 *                                   graph), then `/activate`
 *
 * Two provider rules decide what a workspace is allowed to ask for, and both
 * are enforced here *before* the call so a user gets a reason rather than a
 * provider 400:
 *
 * - Instagram and Facebook get the full private-reply DM. TikTok, Threads,
 *   LinkedIn and YouTube have no private reply to a comment, so the automation
 *   is a **public** reply and `commentReply` is required — which is why a
 *   `comment_dm` there is refused instead of silently degrading.
 * - X refuses comment automations outright (its comment polling is off, so one
 *   could never fire) and also refuses DM sequences, so it is refused here.
 *
 * Run counts come from the provider's own run webhooks (`workflow.run.*` →
 * `social.automation.run.*`), one row per execution, so analytics can answer a
 * date range without a counter that only ever goes up.
 */

import { prisma } from '../../lib/prisma'
import { SocialError, getSocialClient } from './client'
import { ensureProfile, workspaceName } from './profiles.service'
import { zernioId } from './provider-ids'

const db = prisma as any

/** Platforms where Zernio can answer a comment with a private reply (a DM). */
export const DM_AUTOMATION_PLATFORMS = ['instagram', 'facebook'] as const
/** Platforms where a comment automation is a public reply and nothing else. */
export const REPLY_ONLY_AUTOMATION_PLATFORMS = ['tiktok', 'threads', 'linkedin', 'youtube'] as const
/** Platforms that refuse comment automations and DM workflows entirely. */
export const REFUSED_AUTOMATION_PLATFORMS = ['x', 'twitter'] as const

export type AutomationKind = 'comment_dm' | 'keyword_reply' | 'sequence'
export type AutomationMode = 'static' | 'agent'

const KINDS: readonly AutomationKind[] = ['comment_dm', 'keyword_reply', 'sequence']
const MODES: readonly AutomationMode[] = ['static', 'agent']
const MATCH_MODES = new Set(['contains', 'word', 'exact'])
const MAX_KEYWORDS = 25

export interface AutomationCapability {
  /** The automation can DM the commenter. */
  privateReply: boolean
  /** The automation answers the comment publicly. */
  publicReply: boolean
  /** The platform refuses automations completely. */
  refused: boolean
}

/**
 * What a platform's automations can do. Anything we do not recognise is treated
 * as reply-only rather than assumed to DM: guessing "private reply" on a
 * platform that has none would put a DM field in a request Zernio rejects.
 */
export function automationCapability(platform: string): AutomationCapability {
  const name = typeof platform === 'string' ? platform.trim().toLowerCase() : ''
  if ((REFUSED_AUTOMATION_PLATFORMS as readonly string[]).includes(name)) {
    return { privateReply: false, publicReply: false, refused: true }
  }
  const privateReply = (DM_AUTOMATION_PLATFORMS as readonly string[]).includes(name)
  return { privateReply, publicReply: true, refused: false }
}

function invalid(message: string): SocialError {
  return new SocialError(400, 'invalid_body', message)
}

function normalizeKind(raw: unknown): AutomationKind {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!value) return 'comment_dm'
  if (!(KINDS as readonly string[]).includes(value)) {
    throw invalid(`kind must be one of ${KINDS.join(', ')}`)
  }
  return value as AutomationKind
}

function normalizeKeywords(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : []
  const out: string[] = []
  for (const entry of list) {
    const value = typeof entry === 'string' ? entry.trim() : ''
    if (!value) continue
    const key = value.toLowerCase()
    if (out.some((existing) => existing.toLowerCase() === key)) continue
    out.push(value)
    if (out.length >= MAX_KEYWORDS) break
  }
  return out
}

function normalizeMatchMode(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return MATCH_MODES.has(value) ? value : 'contains'
}

function optionalText(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

function clampDelay(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(86_400, Math.floor(value))
}

/** A row's `keywords` is JSON text on SQLite and a string[] in Postgres. */
export function readKeywords(row: any): string[] {
  const raw = row?.keywords
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : []
    } catch {
      return []
    }
  }
  return []
}

function storeKeywords(keywords: string[]): string[] {
  // The Prisma client JSON-encodes `keywords` for SQLite and keeps the list for
  // Postgres (see ARRAY_FIELDS in lib/create-prisma-client.ts), so write the
  // list exactly as the API presents it.
  return keywords
}

export function presentAutomation(row: any): Record<string, unknown> {
  return {
    id: row.id,
    accountId: row.accountId,
    kind: row.kind,
    platform: row.platform,
    name: row.name,
    mode: row.mode,
    status: row.status,
    keywords: readKeywords(row),
    runCount: row.runCount,
    lastRunAt: row.lastRunAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export interface CreateAutomationInput {
  accountId?: unknown
  kind?: unknown
  name?: unknown
  keywords?: unknown
  matchMode?: unknown
  dmMessage?: unknown
  commentReply?: unknown
  dmDelaySeconds?: unknown
  platformPostId?: unknown
  mode?: unknown
  isActive?: unknown
  /** Sequence steps: `[{ text, delaySeconds? }]`, 1–3 messages after the trigger. */
  messages?: unknown
}

interface ProviderRequest {
  path: string
  body: Record<string, unknown>
  /** Path template used to activate/delete afterwards, when the kind needs it. */
  activatePath?: (id: string) => string
}

/**
 * Turn an automation request into the provider call it corresponds to.
 *
 * Kept pure and exported so the platform rules can be tested without a
 * provider or a database — the refusal is the part that matters.
 */
export function planAutomationRequest(args: {
  kind: AutomationKind
  platform: string
  zernioProfileId: string
  zernioAccountId: string
  name: string
  keywords: string[]
  matchMode: string
  dmMessage?: string | null
  commentReply?: string | null
  dmDelaySeconds: number
  platformPostId?: string | null
  messages?: Array<{ text: string; delaySeconds?: number }>
  isActive: boolean
}): ProviderRequest {
  const capability = automationCapability(args.platform)
  if (capability.refused) {
    throw new SocialError(
      400,
      'platform_not_supported',
      `${args.platform} does not support comment automations: its comment polling is off, so an automation could never fire.`,
    )
  }

  if (args.kind === 'sequence') {
    if (!capability.privateReply) {
      throw new SocialError(
        400,
        'platform_not_supported',
        `A DM sequence needs a platform that can open a conversation from a comment; ${args.platform} can only post a public reply.`,
      )
    }
    const messages = (args.messages ?? []).filter((message) => message.text.trim())
    if (messages.length === 0) {
      throw invalid('A sequence needs at least one message.')
    }
    const nodes: Array<Record<string, unknown>> = [
      {
        id: 'n_trigger',
        type: 'trigger',
        label: 'Comment',
        config: {
          triggerType: 'comment',
          comment: {
            keywords: args.keywords,
            ...(args.platformPostId ? { platformPostId: args.platformPostId } : {}),
          },
        },
      },
    ]
    const edges: Array<Record<string, unknown>> = []
    let previous = 'n_trigger'
    messages.slice(0, 3).forEach((message, index) => {
      const id = `n_message_${index + 1}`
      nodes.push({
        id,
        type: 'send_message',
        label: `Message ${index + 1}`,
        config: { messageType: 'text', text: message.text.trim() },
      })
      edges.push({ id: `e_${previous}_${id}`, source: previous, target: id })
      previous = id
    })
    const endId = 'n_end'
    nodes.push({ id: endId, type: 'end', label: 'End', config: {} })
    edges.push({ id: `e_${previous}_${endId}`, source: previous, target: endId })

    return {
      path: '/workflows',
      body: {
        profileId: args.zernioProfileId,
        accountId: args.zernioAccountId,
        platform: args.platform,
        name: args.name,
        nodes,
        edges,
      },
      activatePath: (id) => `/workflows/${encodeURIComponent(id)}/activate`,
    }
  }

  // A DM kind on a reply-only platform: the platform can only answer publicly,
  // so asking for a comment→DM is a request the provider would reject. Say why.
  if (args.kind === 'comment_dm' && !capability.privateReply) {
    throw new SocialError(
      400,
      'private_reply_unsupported',
      `${args.platform} cannot send a private reply to a comment. Use kind "keyword_reply" for a public answer.`,
    )
  }

  const body: Record<string, unknown> = {
    profileId: args.zernioProfileId,
    accountId: args.zernioAccountId,
    name: args.name,
    keywords: args.keywords,
    matchMode: args.matchMode,
    isActive: args.isActive,
  }
  if (args.platformPostId) body.platformPostId = args.platformPostId

  if (capability.privateReply) {
    if (!args.dmMessage) {
      throw invalid('dmMessage is required: the automation has to send something.')
    }
    body.dmMessage = args.dmMessage
    if (args.dmDelaySeconds > 0) body.dmDelaySeconds = args.dmDelaySeconds
    if (args.commentReply) body.commentReply = args.commentReply
  } else {
    // Reply-only platform: `commentReply` is the automation's only action, and
    // the DM fields are rejected by the provider, so they are never sent.
    if (!args.commentReply) {
      throw invalid(
        `commentReply is required on ${args.platform}: it has no private reply, so the public reply is the whole automation.`,
      )
    }
    body.commentReply = args.commentReply
  }

  return { path: '/comment-automations', body }
}

function providerResourceId(payload: any): string | null {
  return zernioId(payload, 'automation', 'workflow', 'data')
}

function providerStatus(payload: any): string | null {
  const candidate = payload?.automation?.status ?? payload?.workflow?.status
  return typeof candidate === 'string' && candidate ? candidate : null
}

/**
 * Create an automation on the provider and store the row that mirrors it.
 *
 * The provider id is the routing key: a `workflow.run.*` webhook carries it, so
 * run counts land on this row without a second lookup table.
 */
export async function createAutomation(
  workspaceId: string,
  input: CreateAutomationInput,
): Promise<any> {
  const accountId = optionalText(input.accountId)
  if (!accountId) throw invalid('accountId is required: an automation runs on one account.')
  const name = optionalText(input.name)
  if (!name) throw invalid('name is required.')

  const account = await db.socialAccount.findFirst({ where: { id: accountId, workspaceId } })
  if (!account) throw new SocialError(404, 'account_not_found', 'Account not found')
  if (!account.isActive) {
    throw new SocialError(409, 'account_inactive', 'Reconnect that account before automating it.')
  }

  const kind = normalizeKind(input.kind)
  const mode: AutomationMode =
    typeof input.mode === 'string' && (MODES as readonly string[]).includes(input.mode)
      ? (input.mode as AutomationMode)
      : 'static'
  const keywords = normalizeKeywords(input.keywords)
  const messagesRaw = Array.isArray(input.messages) ? input.messages : []
  const messages = messagesRaw
    .map((entry: any) => ({
      text: typeof entry?.text === 'string' ? entry.text : typeof entry === 'string' ? entry : '',
      delaySeconds: clampDelay(entry?.delaySeconds),
    }))
    .filter((message) => message.text.trim())

  const profile = await ensureProfile(workspaceId, await workspaceName(workspaceId))
  const plan = planAutomationRequest({
    kind,
    platform: account.platform,
    zernioProfileId: profile.zernioProfileId,
    zernioAccountId: account.zernioAccountId,
    name,
    keywords,
    matchMode: normalizeMatchMode(input.matchMode),
    dmMessage: optionalText(input.dmMessage),
    commentReply: optionalText(input.commentReply),
    dmDelaySeconds: clampDelay(input.dmDelaySeconds),
    platformPostId: optionalText(input.platformPostId),
    messages,
    isActive: input.isActive !== false,
  })

  const client = getSocialClient()
  const created = await client.request<any>({
    workspaceId,
    method: 'POST',
    path: plan.path,
    body: plan.body,
  })
  const zernioResourceId = providerResourceId(created)
  if (!zernioResourceId) {
    throw new SocialError(
      502,
      'automation_unresolved',
      'Zernio did not return an automation id.',
    )
  }

  let status = input.isActive === false ? 'draft' : 'active'
  if (plan.activatePath && input.isActive !== false) {
    // A workflow is created as a draft and only starts matching once activated,
    // so a sequence the user switched on has to be activated in the same call.
    const activated = await client.request<any>({
      workspaceId,
      method: 'POST',
      path: plan.activatePath(zernioResourceId),
    })
    status = providerStatus(activated) ?? 'active'
  } else if (!plan.activatePath) {
    status = providerStatus(created) ?? status
  }

  return storeAutomation({
    workspaceId,
    accountId: account.id,
    kind,
    platform: account.platform,
    name,
    mode,
    status,
    keywords,
    zernioResourceId,
    config: plan.body,
  })
}

/** Upsert the row that mirrors a provider automation. Shared with the relay. */
export async function storeAutomation(args: {
  workspaceId: string
  accountId: string | null
  kind: string
  platform: string
  name: string
  mode: string
  status: string
  keywords: string[]
  zernioResourceId: string
  config: unknown
}): Promise<any> {
  const data = {
    workspaceId: args.workspaceId,
    accountId: args.accountId,
    kind: args.kind,
    platform: args.platform,
    name: args.name,
    mode: args.mode,
    status: args.status,
    keywords: storeKeywords(args.keywords),
    zernioResourceId: args.zernioResourceId,
    config: (args.config ?? {}) as any,
  }
  return db.socialAutomation.upsert({
    where: { zernioResourceId: args.zernioResourceId },
    create: data,
    update: {
      accountId: data.accountId,
      name: data.name,
      status: data.status,
      keywords: data.keywords,
      config: data.config,
    },
  })
}

export async function listAutomations(
  workspaceId: string,
  opts: { status?: string | null; kind?: string | null; limit?: number } = {},
): Promise<Record<string, unknown>[]> {
  const where: Record<string, unknown> = { workspaceId }
  if (opts.status) where.status = opts.status
  if (opts.kind) where.kind = opts.kind
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const rows = await db.socialAutomation.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }],
    take: limit,
  })
  return rows.map(presentAutomation)
}

export async function getAutomation(workspaceId: string, automationId: string): Promise<any> {
  const row = await db.socialAutomation.findFirst({ where: { id: automationId, workspaceId } })
  if (!row) throw new SocialError(404, 'automation_not_found', 'Automation not found')
  const runs = await db.socialAutomationRun.findMany({
    where: { automationId: row.id },
    orderBy: { startedAt: 'desc' },
    take: 20,
  })
  return {
    ...presentAutomation(row),
    runs: runs.map((run: any) => ({
      id: run.id,
      status: run.status,
      error: run.error,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
    })),
  }
}

/**
 * Pause or resume. The provider owns execution, so this is a provider call
 * first: flipping only our row would show "paused" while DMs kept going out.
 */
export async function setAutomationStatus(
  workspaceId: string,
  automationId: string,
  rawStatus: unknown,
): Promise<any> {
  const status = typeof rawStatus === 'string' ? rawStatus.trim().toLowerCase() : ''
  if (status !== 'active' && status !== 'paused') {
    throw invalid('status must be active or paused')
  }
  const row = await db.socialAutomation.findFirst({ where: { id: automationId, workspaceId } })
  if (!row) throw new SocialError(404, 'automation_not_found', 'Automation not found')
  if (!row.zernioResourceId) {
    throw new SocialError(409, 'automation_unlinked', 'That automation has no provider id to update.')
  }

  const client = getSocialClient()
  if (row.kind === 'sequence') {
    await client.request({
      workspaceId,
      method: 'POST',
      path: `/workflows/${encodeURIComponent(row.zernioResourceId)}/${status === 'active' ? 'activate' : 'pause'}`,
    })
  } else {
    await client.request({
      workspaceId,
      method: 'PATCH',
      path: `/comment-automations/${encodeURIComponent(row.zernioResourceId)}`,
      body: { isActive: status === 'active' },
    })
  }

  const updated = await db.socialAutomation.update({ where: { id: row.id }, data: { status } })
  return presentAutomation(updated)
}

/** Delete at the provider first: an automation left running keeps sending DMs. */
export async function deleteAutomation(workspaceId: string, automationId: string): Promise<void> {
  const row = await db.socialAutomation.findFirst({ where: { id: automationId, workspaceId } })
  if (!row) throw new SocialError(404, 'automation_not_found', 'Automation not found')
  if (row.zernioResourceId) {
    const path =
      row.kind === 'sequence'
        ? `/workflows/${encodeURIComponent(row.zernioResourceId)}`
        : `/comment-automations/${encodeURIComponent(row.zernioResourceId)}`
    await getSocialClient().request({ workspaceId, method: 'DELETE', path })
  }
  await db.socialAutomation.delete({ where: { id: row.id } })
}

/**
 * Record one execution from the provider's run webhooks.
 *
 * One row per provider execution id: a redelivered completion updates the row
 * instead of adding a second run, which is the whole reason this is a table and
 * not a counter.
 */
export async function recordAutomationRun(args: {
  workspaceId: string
  detail: any
  failed: boolean
}): Promise<{ recorded: boolean; automationId: string | null }> {
  const detail = args.detail ?? {}
  const executionId =
    optionalText(detail.executionId) ?? optionalText(detail.execution_id) ?? optionalText(zernioId(detail))
  if (!executionId) return { recorded: false, automationId: null }

  const resourceId =
    optionalText(detail.workflowId) ??
    optionalText(detail.automationId) ??
    optionalText(detail.resourceId)
  const automation = resourceId
    ? await db.socialAutomation.findFirst({
        where: { zernioResourceId: resourceId, workspaceId: args.workspaceId },
      })
    : null

  const status =
    (typeof detail.status === 'string' && detail.status) || (args.failed ? 'failed' : 'completed')
  const startedAt = detail.startedAt ? new Date(detail.startedAt) : undefined
  const data = {
    workspaceId: args.workspaceId,
    automationId: automation?.id ?? null,
    zernioExecutionId: executionId,
    status,
    error: typeof detail.error === 'string' ? detail.error : null,
    startedAt: startedAt && !Number.isNaN(startedAt.getTime()) ? startedAt : new Date(),
    endedAt: new Date(),
  }

  const existing = await db.socialAutomationRun.findUnique({
    where: { zernioExecutionId: executionId },
  })
  if (existing) {
    await db.socialAutomationRun.update({ where: { id: existing.id }, data })
  } else {
    await db.socialAutomationRun.create({ data })
  }

  if (automation) {
    await db.socialAutomation.update({
      where: { id: automation.id },
      data: {
        ...(existing ? {} : { runCount: { increment: 1 } }),
        lastRunAt: new Date(),
      },
    })
  }
  return { recorded: true, automationId: automation?.id ?? null }
}
