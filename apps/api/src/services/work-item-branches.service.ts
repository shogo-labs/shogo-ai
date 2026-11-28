// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which branches belong to which card (SHO-607 §2).
 *
 * The runtime's `.tmp` hygiene cannot match a worktree by folder name — agent
 * checkouts are named `.tmp/qa-578-base`, `.tmp/pr2147`, `.tmp/learn-words`,
 * many are detached HEADs, and some are standalone clones. It matches by
 * **branch** or by **PR head SHA** instead, and this is where it learns both.
 *
 * `closed` is how a squash-merged branch proves it landed: the merge queue
 * squash-merges, so its commits are never in `origin/main`, and `fetch --prune`
 * drops `origin/<branch>` — only the closed PR's last head SHA survives.
 */

import { prisma } from '../lib/prisma'
import { isClosed } from './work-board-defaults'

const db = prisma

/** How far back a closed card's refs are still reported. */
const CLOSED_LOOKBACK_DAYS = 90

export interface CardPrRefView {
  number: number
  headRef: string | null
  headSha: string | null
  state: 'open' | 'closed'
  merged: boolean
}

export interface CardBranchView {
  key: string
  number: number
  branch: string | null
  prs: CardPrRefView[]
}

export interface WorkItemBranchIndex {
  open: CardBranchView[]
  closed: CardBranchView[]
}

function branchOf(fields: unknown): string | null {
  if (!fields || typeof fields !== 'object') return null
  const raw = (fields as Record<string, unknown>).branch
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

function prRefOf(link: any): CardPrRefView | null {
  const metadata = link?.metadata && typeof link.metadata === 'object' ? link.metadata : {}
  const number = Number(metadata.number ?? link.refId)
  if (!Number.isInteger(number) || number <= 0) return null
  const state = metadata.state === 'closed' ? 'closed' : 'open'
  return {
    number,
    headRef: typeof metadata.headRef === 'string' && metadata.headRef ? metadata.headRef : null,
    headSha: typeof metadata.headSha === 'string' && metadata.headSha ? metadata.headSha : null,
    state,
    merged: metadata.merged === true,
  }
}

/** Every card in the workspace with a branch or a PR, split open / closed. */
export async function listWorkItemBranches(workspaceId: string): Promise<WorkItemBranchIndex> {
  const cutoff = new Date(Date.now() - CLOSED_LOOKBACK_DAYS * 24 * 60 * 60_000)
  const items = await db.workItem.findMany({
    where: { workspaceId, archivedAt: null },
    select: {
      id: true,
      key: true,
      number: true,
      fields: true,
      completedAt: true,
      updatedAt: true,
      column: { select: { category: true } },
    },
    orderBy: { updatedAt: 'desc' },
  })
  if (!items.length) return { open: [], closed: [] }

  const links = await db.workItemLink.findMany({
    where: { workspaceId, kind: 'pr', workItemId: { in: items.map((item: any) => item.id) } },
    select: { workItemId: true, refId: true, metadata: true },
  })
  const prsByItem = new Map<string, CardPrRefView[]>()
  for (const link of links) {
    const pr = prRefOf(link)
    if (!pr) continue
    const list = prsByItem.get(link.workItemId) ?? []
    list.push(pr)
    prsByItem.set(link.workItemId, list)
  }

  const index: WorkItemBranchIndex = { open: [], closed: [] }
  for (const item of items) {
    const branch = branchOf(item.fields)
    const prs = (prsByItem.get(item.id) ?? []).sort((a, b) => a.number - b.number)
    if (!branch && prs.length === 0) continue
    const closed = item.column ? isClosed(item.column.category) : false
    const view: CardBranchView = { key: item.key, number: item.number, branch, prs }
    if (!closed) {
      index.open.push(view)
      continue
    }
    const closedAt = item.completedAt ?? item.updatedAt
    if (closedAt && closedAt < cutoff) continue
    index.closed.push(view)
  }
  return index
}
