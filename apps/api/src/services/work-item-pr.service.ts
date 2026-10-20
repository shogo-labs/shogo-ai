// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cards that know their PR.
 *
 * A card's pull request is a `WorkItemLink` of kind `pr` whose `refId` is the
 * PR number. This service keeps that link honest:
 *
 *  - link at creation, from an explicit card key, a `KEY-12` in the head
 *    branch, or a key in the title (never an error when there is no key);
 *  - refresh the link's `metadata` from GitHub (`pull_request`, `check_run`
 *    and `workflow_run` webhooks, plus a 60-second-on-read top-up);
 *  - refuse to merge a linked PR from a column whose `rules.allowAutoMerge`
 *    is not true (`merge_not_allowed_in_column`);
 *  - move the card back to the board's first active column when a check that
 *    GitHub considers blocking turns red, and to `done` when the PR merges.
 *
 * The rules only run on a transition (green→red, open→merged), so a burst of
 * `check_run` events for one head SHA cannot move a card twice.
 */

import { prisma } from '../lib/prisma'
// Type-only: the GitHub client is imported at call time so this service can be
// pulled into a route that a test mocks github.service for.
import type { GitHubAuth, PullRequestSnapshot } from './github.service'
import { commentWorkItem, moveWorkItem, recordEvent } from './work-boards.service'

const db = prisma as any

/** What a `pr` link's `metadata` holds. */
export interface PrMetadata {
  repo: string
  number: number
  url: string | null
  state: 'open' | 'closed'
  draft: boolean
  merged: boolean
  mergedAt: string | null
  headSha: string | null
  headRef: string | null
  /**
   * GitHub's `mergeable_state`. `blocked` is a failing **required** check;
   * `unstable` is a red check that is not required (`cla`, an emulator job).
   */
  mergeableState: string | null
  checks: { total: number; passing: number; failing: number; pending: number }
  failing: Array<{ name: string; url: string | null }>
  /** GitHub's `auto_merge` is set. */
  armed: boolean
  /** Entered the merge queue: GitHub drops `auto_merge`, the card stays armed. */
  queued: boolean
  /** A blocking check failed on `headSha` and the card was already sent back. */
  regressedFor?: string | null
  /**
   * Armed while its column does not allow arming (a `gh pr merge --auto` or a
   * click on GitHub, neither of which passes through the merge route). The PR
   * is left armed — a person may have armed it deliberately — and the card
   * reports it instead (Planner, SHO-64: never auto-unarm).
   */
  armingWarning?: boolean
}

/** The `pr` block a card payload carries, so an agent reads state instead of `gh`. */
export interface PrBlock extends Omit<PrMetadata, 'regressedFor'> {
  ok: boolean
  red: boolean
  syncedAt: string | null
}

const PR_URL_RE = /github\.com\/([^/\s]+)\/([^/\s#?]+)\/pull\/(\d+)/i
const CARD_KEY_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/

const ZERO_CHECKS = { total: 0, passing: 0, failing: 0, pending: 0 }

// ─── Reading a card key ──────────────────────────────────────────────────────

/**
 * The card key an agent meant: an explicit `workItem`, then a key in the head
 * branch (`sho-57-skills…`), then one in the title. A key that names no card in
 * the workspace is skipped rather than linked to a stranger's card.
 */
export async function resolveCardForPullRequest(opts: {
  workspaceId: string
  workItem?: string | null
  head?: string | null
  title?: string | null
}): Promise<any | null> {
  for (const candidate of [opts.workItem, opts.head, opts.title]) {
    const key = cardKeyFromText(candidate)
    if (!key) continue
    const item = await db.workItem.findFirst({ where: { workspaceId: opts.workspaceId, key } })
    if (item) return item
  }
  return null
}

/** The first `KEY-12` in a string, upper-cased; null when there is none. */
export function cardKeyFromText(text: string | null | undefined): string | null {
  if (!text) return null
  const match = String(text).toUpperCase().match(CARD_KEY_RE)
  return match ? match[1]! : null
}

/** `owner`, `repo` and the number in a PR URL. */
export function parsePullRequestUrl(url: string | null | undefined): { repo: string; number: number } | null {
  const match = String(url ?? '').match(PR_URL_RE)
  if (!match) return null
  const number = Number(match[3])
  return Number.isInteger(number) && number > 0 ? { repo: `${match[1]}/${match[2]}`, number } : null
}

// ─── Serialization ───────────────────────────────────────────────────────────

function metadataOf(link: any): PrMetadata | null {
  const raw = link?.metadata
  if (!raw || typeof raw !== 'object') return null
  return raw as PrMetadata
}

/**
 * A **required** check failed, so GitHub blocks the merge. `unstable` is a red
 * check that is *not* required (`cla`, an emulator job) — a red `cla` never
 * holds a card (Russell, 2026-10-19, SHO-43), so only `blocked` counts here.
 * The chip still shows a failing `cla`; it just does not move the card.
 */
export function isRed(pr: Pick<PrMetadata, 'checks' | 'mergeableState'>): boolean {
  if (!pr.checks?.failing) return false
  return pr.mergeableState === 'blocked'
}

/** The `pr` block for one `pr` link, or null when its metadata was never read. */
export function prBlock(link: any): PrBlock | null {
  const metadata = metadataOf(link)
  if (!metadata) return null
  const { regressedFor: _regressedFor, ...rest } = metadata
  return {
    ...rest,
    ok: metadata.state === 'open' || metadata.merged,
    red: metadata.state === 'open' && isRed(metadata),
    armingWarning: metadata.armingWarning === true,
    syncedAt: link.syncedAt ? new Date(link.syncedAt).toISOString() : null,
  }
}

/**
 * Attach `pr` to serialized items (board view, inbox, card detail). One query
 * for the whole page; cards without a PR link are untouched.
 */
export async function attachPrBlocks<T extends { id: string }>(items: T[]): Promise<T[]> {
  if (!items.length) return items
  const links = await db.workItemLink.findMany({
    where: { workItemId: { in: items.map((i) => i.id) }, kind: 'pr' },
    orderBy: { createdAt: 'desc' },
  })
  if (!links.length) return items
  const byItem = new Map<string, any>()
  for (const link of links) if (!byItem.has(link.workItemId)) byItem.set(link.workItemId, link)
  return items.map((item) => {
    const block = prBlock(byItem.get(item.id))
    return block ? { ...item, pr: block } : item
  })
}

// ─── Connections ─────────────────────────────────────────────────────────────

/** The GitHub connection that lets this workspace read `repoFullName`. */
async function connectionForRepo(workspaceId: string, repoFullName: string) {
  const connections = await db.gitHubConnection.findMany({
    where: { repoFullName },
    include: { project: { select: { id: true, workspaceId: true } } },
  })
  return connections.find((c: any) => c.project?.workspaceId === workspaceId) ?? null
}

function repoOf(link: any): { owner: string; name: string; repo: string } | null {
  const metadata = metadataOf(link)
  const full = metadata?.repo || parsePullRequestUrl(link?.url)?.repo
  if (!full || !full.includes('/')) return null
  const [owner, name] = full.split('/')
  return owner && name ? { owner, name, repo: full } : null
}

async function authOf(connection: any): Promise<GitHubAuth | null> {
  if (!connection) return null
  const mod = await cloudGitHub()
  return mod && typeof mod.connectionAuth === 'function' ? mod.connectionAuth(connection) : null
}

/**
 * The GitHub App client is a cloud-only island. The desktop bundle is built
 * with `SHOGO_LOCAL_MODE="true"`, which lets bun dead-code-eliminate this
 * branch — `github.service` must not be inlined into `resources/bundle/api.js`
 * (see `lib/runtime/__tests__/local-bundle-integrity.test.ts`). Desktop keeps
 * the card and its link; only a cloud API refreshes the PR's live state.
 */
async function cloudGitHub(): Promise<typeof import('./github.service') | null> {
  return process.env.SHOGO_LOCAL_MODE !== 'true' ? await import('./github.service') : null
}

// ─── Linking ─────────────────────────────────────────────────────────────────

/**
 * Link a created PR to its card. `workItem` is the key an agent passed, or the
 * server's own guess from the branch/title; a PR with no card is simply not
 * linked. Idempotent: an existing link (an agent's `work_item_link`) is reused
 * and only gains metadata.
 */
export async function linkPullRequestToCard(opts: {
  workspaceId: string
  repoFullName: string
  number: number
  url?: string | null
  title?: string | null
  head?: string | null
  workItem?: string | null
  actor?: { userId?: string | null; agentRef?: string | null; sessionId?: string | null }
}): Promise<{ link: any; item: any; key: string } | null> {
  const item = await resolveCardForPullRequest({
    workspaceId: opts.workspaceId,
    workItem: opts.workItem,
    head: opts.head,
    title: opts.title,
  })
  if (!item) return null

  const refId = String(opts.number)
  const existing = await db.workItemLink.findFirst({ where: { workItemId: item.id, kind: 'pr', refId } })
  if (existing) {
    const link = await db.workItemLink.update({
      where: { id: existing.id },
      data: {
        url: opts.url ?? existing.url,
        snippet: opts.title ? String(opts.title).slice(0, 500) : existing.snippet,
        metadata: { ...(metadataOf(existing) ?? {}), repo: opts.repoFullName, number: opts.number, url: opts.url ?? existing.url ?? null },
      },
    })
    return { link, item, key: item.key }
  }

  const link = await db.workItemLink.create({
    data: {
      workItemId: item.id,
      workspaceId: item.workspaceId,
      kind: 'pr',
      refId,
      reason: 'sync',
      addedByUserId: opts.actor?.agentRef ? null : opts.actor?.userId ?? null,
      addedByAgentRef: opts.actor?.agentRef ?? null,
      snippet: opts.title ? String(opts.title).slice(0, 500) : null,
      url: opts.url ?? null,
      metadata: { repo: opts.repoFullName, number: opts.number, url: opts.url ?? null, state: 'open', checks: ZERO_CHECKS, failing: [] },
    },
  })
  await db.workItem.update({ where: { id: item.id }, data: { lastActivityAt: new Date() } })
  await recordEvent(item, 'linked', opts.actor ?? {}, { kind: 'pr', refId, reason: 'sync' })
  return { link, item, key: item.key }
}

// ─── Refreshing ──────────────────────────────────────────────────────────────

function metadataFromSnapshot(snapshot: PullRequestSnapshot, repo: string, previous: PrMetadata | null): PrMetadata {
  // GitHub clears `auto_merge` when a PR enters the merge queue. An open PR
  // that was armed and no longer reports one is queued, not disarmed.
  const queued = snapshot.state === 'open' && !snapshot.autoMerge && previous?.armed === true
  return {
    repo,
    number: snapshot.number,
    url: snapshot.url || previous?.url || null,
    state: snapshot.state,
    draft: snapshot.draft,
    merged: snapshot.merged,
    mergedAt: snapshot.mergedAt,
    headSha: snapshot.headSha || previous?.headSha || null,
    headRef: snapshot.headRef || previous?.headRef || null,
    mergeableState: snapshot.mergeableState,
    checks: snapshot.checks ?? ZERO_CHECKS,
    failing: snapshot.failing ?? [],
    armed: snapshot.state === 'open' && (snapshot.autoMerge || queued),
    queued,
    regressedFor: previous?.regressedFor ?? null,
    // Recomputed by `applyPrRules` against the card's current column.
    armingWarning: previous?.armingWarning ?? false,
  }
}

/**
 * Read one linked PR from GitHub and save its state. Returns null (without
 * touching the row) when the repo has no readable connection — a repo wired
 * up through a bare `GITHUB_TOKEN` still links, it just cannot be polled.
 */
export async function refreshPrLink(link: any): Promise<{ link: any; metadata: PrMetadata; previous: PrMetadata | null } | null> {
  const repo = repoOf(link)
  if (!repo) return null
  const connection = await connectionForRepo(link.workspaceId, repo.repo)
  const auth = connection ? await authOf(connection) : null
  if (!auth) return null
  const previous = metadataOf(link)
  const github = await cloudGitHub()
  if (!github) return null
  const snapshot = await github.getPullRequestSnapshot(auth, repo.owner, repo.name, Number(link.refId))
  const metadata = metadataFromSnapshot(snapshot, repo.repo, previous)
  const updated = await db.workItemLink.update({
    where: { id: link.id },
    data: { metadata, syncedAt: new Date(), ...(metadata.url ? { url: metadata.url } : {}) },
  })
  return { link: updated, metadata, previous }
}

/** A snapshot built from a webhook payload, for repos with no readable connection. */
export function snapshotFromPullRequestPayload(data: any): PullRequestSnapshot | null {
  const pr = data?.pull_request
  if (!pr) return null
  return {
    number: pr.number,
    url: pr.html_url ?? '',
    state: pr.state === 'closed' ? 'closed' : 'open',
    draft: pr.draft === true,
    merged: pr.merged === true,
    mergedAt: typeof pr.merged_at === 'string' ? pr.merged_at : null,
    headSha: pr.head?.sha ?? '',
    headRef: pr.head?.ref ?? '',
    baseRef: pr.base?.ref ?? '',
    mergeableState: null,
    autoMerge: pr.auto_merge != null,
    checks: ZERO_CHECKS,
    failing: [],
  }
}

// ─── The rules ───────────────────────────────────────────────────────────────

/** Columns an agent may arm or merge from. */
export function columnAllowsAutoMerge(column: any): boolean {
  const rules = column?.rules
  return !!rules && typeof rules === 'object' && rules.allowAutoMerge === true
}

function firstColumn(board: any, category: string): any | null {
  const columns = (board?.columns ?? []).slice().sort((a: any, b: any) => a.position - b.position)
  return columns.find((c: any) => c.category === category) ?? null
}

function blockingColumns(board: any): string[] {
  return (board?.columns ?? [])
    .filter((c: any) => columnAllowsAutoMerge(c))
    .sort((a: any, b: any) => a.position - b.position)
    .map((c: any) => c.name)
}

const SYSTEM_ACTOR = { userId: null, agentRef: null, sessionId: null } as const

/**
 * Apply a card's PR state to the board: back to the first active column on a
 * newly red blocking check, to `done` on a merge, and a comment either way.
 * Runs only on the transition that matters, so repeat webhooks are no-ops.
 */
export async function applyPrRules(link: any, metadata: PrMetadata, previous: PrMetadata | null): Promise<'regressed' | 'merged' | 'closed' | 'none'> {
  const item = await db.workItem.findUnique({
    where: { id: link.workItemId },
    include: { column: true, board: { include: { columns: true } } },
  })
  if (!item || item.archivedAt) return 'none'
  const board = item.board
  const column = item.column
  const label = `#${metadata.number}`

  if (metadata.merged && !previous?.merged) {
    const target = firstColumn(board, 'done')
    if (target && column.category !== 'done' && column.category !== 'dismissed') {
      await moveWorkItem(item, { column: target.id }, { ...SYSTEM_ACTOR })
      await commentWorkItem(item, `${label} merged${metadata.mergedAt ? ` at ${metadata.mergedAt}` : ''}. Moved to ${target.name}.`, SYSTEM_ACTOR, { system: true })
    } else {
      await commentWorkItem(item, `${label} merged${metadata.mergedAt ? ` at ${metadata.mergedAt}` : ''}.`, SYSTEM_ACTOR, { system: true })
    }
    return 'merged'
  }

  if (metadata.state === 'closed' && previous?.state !== 'closed') {
    await commentWorkItem(item, `${label} was closed without merging.`, SYSTEM_ACTOR, { system: true })
    return 'closed'
  }

  // Detection, not interception. `gh pr merge --auto` and GitHub's own UI never
  // pass through the merge route, so a PR can be armed from a column that does
  // not allow it. The board reports that once and flags the card; it never
  // un-arms — a person may have armed deliberately, and silently cancelling
  // someone's merge is worse than the hole (Planner, SHO-64).
  const armingColumns = blockingColumns(board)
  const armingWarning =
    metadata.state === 'open' && metadata.armed && !columnAllowsAutoMerge(column) && armingColumns.length > 0
  if (armingWarning !== (previous?.armingWarning === true)) {
    await db.workItemLink.update({
      where: { id: link.id },
      data: { metadata: { ...metadata, armingWarning } },
    })
  }
  if (armingWarning && previous?.armingWarning !== true) {
    const allowed = armingColumns.map((c) => `"${c}"`).join(' or ')
    await commentWorkItem(
      item,
      `${label} is armed from "${column.name}", which does not allow auto-merge. Left armed — move ${item.key} to ${allowed} before arming it.`,
      SYSTEM_ACTOR,
      { system: true },
    )
  }

  const red = metadata.state === 'open' && isRed(metadata)
  if (!red) return 'none'
  if (previous && isRed(previous) && previous.headSha === metadata.headSha) return 'none'
  if (metadata.regressedFor && metadata.regressedFor === metadata.headSha) return 'none'
  // Only a card waiting on its PR (an arming column, or any review column) is
  // sent back. A card already in development is left where it is.
  if (!columnAllowsAutoMerge(column) && column.category !== 'review') return 'none'

  const target = firstColumn(board, 'active')
  if (!target) return 'none'
  const names = metadata.failing.map((c) => c.name).filter(Boolean)
  const runs = metadata.failing.map((c) => c.url).filter(Boolean) as string[]
  const lines = [
    `${label} has a failing check${names.length === 1 ? '' : 's'}${names.length ? `: ${names.join(', ')}` : ''}.`,
    runs.length ? `Run: ${runs[0]}` : '',
    `Moved back to ${target.name}.`,
  ].filter(Boolean).join(' ')

  await db.workItemLink.update({ where: { id: link.id }, data: { metadata: { ...metadata, regressedFor: metadata.headSha } } })
  await moveWorkItem(item, { column: target.id }, { ...SYSTEM_ACTOR })
  await commentWorkItem(item, lines, SYSTEM_ACTOR, { system: true })
  return 'regressed'
}

// ─── Webhooks ────────────────────────────────────────────────────────────────

/**
 * Refresh every card linked to `repo#number` and apply the rules. Called by the
 * `pull_request`, `check_run` and `workflow_run` webhooks — targeted updates,
 * no polling loop.
 */
export async function refreshPrLinksForPullRequest(opts: {
  repoFullName: string
  number: number
  /** Used only when no connection can read the repo (token-only setup). */
  snapshot?: PullRequestSnapshot | null
}): Promise<{ refreshed: number; applied: Array<{ key: string; action: string }> }> {
  const connections = await db.gitHubConnection.findMany({
    where: { repoFullName: opts.repoFullName },
    include: { project: { select: { id: true, workspaceId: true } } },
  })
  const workspaceIds = [...new Set(connections.map((c: any) => c.project?.workspaceId).filter(Boolean))] as string[]
  if (!workspaceIds.length) return { refreshed: 0, applied: [] }

  const links = await db.workItemLink.findMany({
    where: { kind: 'pr', refId: String(opts.number), workspaceId: { in: workspaceIds } },
  })

  const applied: Array<{ key: string; action: string }> = []
  let refreshed = 0
  for (const link of links) {
    const previous = metadataOf(link)
    let metadata: PrMetadata | null = null
    try {
      const result = await refreshPrLink(link)
      if (result) {
        metadata = result.metadata
        refreshed += 1
      }
    } catch (err: any) {
      console.warn(`[GitHub] Could not refresh PR #${opts.number} on ${opts.repoFullName}:`, err?.message ?? err)
    }
    if (!metadata && opts.snapshot) {
      metadata = metadataFromSnapshot(opts.snapshot, opts.repoFullName, previous)
      await db.workItemLink.update({ where: { id: link.id }, data: { metadata, syncedAt: new Date() } })
      refreshed += 1
    }
    if (!metadata) continue
    const action = await applyPrRules({ ...link, metadata }, metadata, previous)
    if (action !== 'none') applied.push({ key: (await cardKeyOf(link.workItemId)) ?? link.workItemId, action })
  }
  return { refreshed, applied }
}

async function cardKeyOf(workItemId: string): Promise<string | null> {
  const item = await db.workItem.findUnique({ where: { id: workItemId }, select: { key: true } })
  return item?.key ?? null
}

function prNumberIn(data: any): number | null {
  const candidates = [
    data?.pull_request?.number,
    data?.check_run?.pull_requests?.[0]?.number,
    data?.workflow_run?.pull_requests?.[0]?.number,
  ]
  for (const candidate of candidates) {
    const number = Number(candidate)
    if (Number.isInteger(number) && number > 0) return number
  }
  return null
}

const PULL_REQUEST_ACTIONS = new Set([
  'opened', 'edited', 'synchronize', 'reopened', 'ready_for_review', 'closed',
  'auto_merge_enabled', 'auto_merge_disabled', 'enqueued', 'dequeued',
])

/** `pull_request` webhook: opened/synchronize/reopened/ready/closed + arming. */
export async function handlePullRequestWebhook(data: any): Promise<void> {
  if (!PULL_REQUEST_ACTIONS.has(String(data?.action))) return
  const repoFullName = data?.repository?.full_name
  const number = prNumberIn(data)
  if (!repoFullName || !number) return
  await refreshPrLinksForPullRequest({ repoFullName, number, snapshot: snapshotFromPullRequestPayload(data) })
}

/** `check_run` webhook: only a completed run changes a card. */
export async function handleCheckRunWebhook(data: any): Promise<void> {
  if (data?.check_run?.status && data.check_run.status !== 'completed') return
  const repoFullName = data?.repository?.full_name
  const number = prNumberIn(data)
  if (!repoFullName || !number) return
  await refreshPrLinksForPullRequest({ repoFullName, number })
}

/** `workflow_run` webhook: only a completed run, and only when it names a PR. */
export async function handleWorkflowRunWebhook(data: any): Promise<void> {
  if (data?.workflow_run?.status && data.workflow_run.status !== 'completed') return
  const repoFullName = data?.repository?.full_name
  const number = prNumberIn(data)
  if (!repoFullName || !number) return
  await refreshPrLinksForPullRequest({ repoFullName, number })
}

// ─── Merge guard ─────────────────────────────────────────────────────────────

export interface MergeGuardRefusal {
  ok: false
  code: 'merge_not_allowed_in_column'
  message: string
  card: string
  column: string
  allowedColumns: string[]
}

/**
 * Whether an agent may merge `number` on this project's board. A PR with no
 * card is unaffected (a project can open PRs unrelated to its board); a linked
 * card must sit in a column that allows auto-merge.
 */
export async function mergeGuard(projectId: string, number: number): Promise<{ ok: true } | MergeGuardRefusal> {
  try {
    return await mergeGuardUnsafe(projectId, number)
  } catch (err: any) {
    // A board lookup must never block a merge it cannot reason about (a
    // project row outside this database, a transient query failure).
    console.warn(`[WorkItemPR] Merge guard skipped for #${number}:`, err?.message ?? err)
    return { ok: true }
  }
}

async function mergeGuardUnsafe(projectId: string, number: number): Promise<{ ok: true } | MergeGuardRefusal> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } })
  if (!project?.workspaceId) return { ok: true }
  const link = await db.workItemLink.findFirst({
    where: { workspaceId: project.workspaceId, kind: 'pr', refId: String(number) },
  })
  if (!link) return { ok: true }
  const item = await db.workItem.findUnique({
    where: { id: link.workItemId },
    include: { column: true, board: { include: { columns: true } } },
  })
  if (!item) return { ok: true }
  if (columnAllowsAutoMerge(item.column)) return { ok: true }

  const allowedColumns = blockingColumns(item.board)
  const message = allowedColumns.length
    ? `${item.key} is in "${item.column.name}", which does not allow arming or merging. Move it to ${allowedColumns.map((c) => `"${c}"`).join(' or ')} first, or merge it from the GitHub UI.`
    : `${item.key} is in "${item.column.name}", and no column on ${item.board.name} allows arming yet. Turn on "Allow auto-merge" for the column the card waits in (board settings), or merge from the GitHub UI.`
  return { ok: false, code: 'merge_not_allowed_in_column', message, card: item.key, column: item.column.name, allowedColumns }
}

// ─── Read-path top-up and sweep ──────────────────────────────────────────────

/**
 * A repo connected with a personal token never receives a webhook, so a read
 * tops up any link the server has not seen for a minute. Fire-and-forget: the
 * card renders the state it has and the next read shows the fresh one.
 */
export function topUpStalePrLinks(links: any[], maxAgeMs = 60_000): void {
  const stale = links.filter((l) => !l.syncedAt || Date.now() - new Date(l.syncedAt).getTime() > maxAgeMs)
  for (const link of stale) {
    void refreshPrLink(link).catch((err: any) => console.warn('[WorkItemPR] Background refresh failed:', err?.message ?? err))
  }
}

/**
 * Link cards that already carry their PR in `fields.pr` but have no `pr` link —
 * every card that existed before PR links did. Without this the sweep skips
 * exactly the cards it was added for: the ones with a PR nobody is watching.
 */
export async function adoptPrLinksForWorkspace(workspaceId: string, limit = 50): Promise<number> {
  const items = (await db.workItem.findMany({
    where: { workspaceId, archivedAt: null },
    include: { column: true },
    orderBy: { lastActivityAt: 'desc' },
    take: 200,
  })) as any[]
  // A finished card's PR has nothing left to report, and adopting it would
  // replay a merge comment on an old card.
  const open = items.filter((i) => i.column?.category !== 'done' && i.column?.category !== 'dismissed')
  if (!open.length) return 0

  const linked = (await db.workItemLink.findMany({
    where: { workspaceId, kind: 'pr', workItemId: { in: open.map((i) => i.id) } },
    select: { workItemId: true },
  })) as Array<{ workItemId: string }>
  const hasLink = new Set(linked.map((l) => l.workItemId))

  let adopted = 0
  for (const item of open) {
    if (adopted >= limit) break
    if (hasLink.has(item.id)) continue
    const parsed = parsePullRequestUrl(typeof item.fields?.pr === 'string' ? item.fields.pr : null)
    if (!parsed) continue
    const result = await linkPullRequestToCard({
      workspaceId,
      repoFullName: parsed.repo,
      number: parsed.number,
      url: item.fields.pr,
      workItem: item.key,
    })
    if (result) adopted += 1
  }
  return adopted
}

/**
 * Fallback sweep: adopt cards whose PR is only in `fields.pr`, then refresh a
 * workspace's PR links that have gone stale (a dropped webhook, a repo
 * connected without the App). Returns how many links were read.
 */
export async function syncPrLinksForWorkspace(workspaceId: string, opts: { staleMs?: number; limit?: number } = {}): Promise<number> {
  const staleMs = opts.staleMs ?? 15 * 60_000
  await adoptPrLinksForWorkspace(workspaceId).catch((err: any) =>
    console.warn(`[WorkItemPR] Could not adopt PR links for ${workspaceId}:`, err?.message ?? err),
  )
  const cutoff = new Date(Date.now() - staleMs)
  const links = await db.workItemLink.findMany({
    where: {
      workspaceId,
      kind: 'pr',
      OR: [{ syncedAt: null }, { syncedAt: { lt: cutoff } }],
    },
    orderBy: { syncedAt: 'asc' },
    take: Math.min(opts.limit ?? 25, 100),
  })
  let refreshed = 0
  for (const link of links) {
    const previous = metadataOf(link)
    try {
      const result = await refreshPrLink(link)
      if (!result) continue
      refreshed += 1
      await applyPrRules(result.link, result.metadata, previous)
    } catch (err: any) {
      console.warn(`[WorkItemPR] Sweep could not refresh ${link.workspaceId}#${link.refId}:`, err?.message ?? err)
    }
  }
  return refreshed
}
