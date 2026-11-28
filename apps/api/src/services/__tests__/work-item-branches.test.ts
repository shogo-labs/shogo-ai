// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `GET /api/internal/workspaces/:id/work-items/branches` (SHO-607 §2).
 *
 * The runtime matches a `.tmp` worktree to a card by branch or PR head SHA.
 * A squash-merged branch's commits never reach `origin/main` and its remote
 * ref is pruned, so the closed card's `headSha` is the only proof the work
 * landed — it has to survive here.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

let items: any[] = []
let links: any[] = []

mock.module('../../lib/prisma', () => ({
  prisma: {
    workItem: { findMany: async () => items },
    workItemLink: { findMany: async () => links },
  },
}))

const { listWorkItemBranches } = await import('../work-item-branches.service')

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60_000)

beforeEach(() => {
  items = []
  links = []
})

describe('listWorkItemBranches', () => {
  test('splits open from closed and keeps the PR head SHA', async () => {
    items = [
      { id: 'a', key: 'SHO-1', number: 1, fields: { branch: 'sho-1-open' }, column: { category: 'active' }, completedAt: null, updatedAt: new Date() },
      { id: 'b', key: 'SHO-2', number: 2, fields: { branch: 'sho-2-merged' }, column: { category: 'done' }, completedAt: daysAgo(2), updatedAt: daysAgo(2) },
    ]
    links = [
      { workItemId: 'a', refId: '10', metadata: { number: 10, headRef: 'sho-1-open', headSha: 'aaa', state: 'open', merged: false } },
      { workItemId: 'b', refId: '11', metadata: { number: 11, headRef: 'sho-2-merged', headSha: 'bbb', state: 'closed', merged: true } },
    ]

    const index = await listWorkItemBranches('ws-1')

    expect(index.open.map((card) => card.key)).toEqual(['SHO-1'])
    expect(index.closed.map((card) => card.key)).toEqual(['SHO-2'])
    expect(index.closed[0].prs[0]).toMatchObject({ number: 11, headRef: 'sho-2-merged', headSha: 'bbb', merged: true })
  })

  test('drops closed cards older than the lookback and cards with no refs', async () => {
    items = [
      { id: 'old', key: 'SHO-3', number: 3, fields: { branch: 'sho-3-old' }, column: { category: 'done' }, completedAt: daysAgo(120), updatedAt: daysAgo(120) },
      { id: 'bare', key: 'SHO-4', number: 4, fields: {}, column: { category: 'active' }, completedAt: null, updatedAt: new Date() },
      { id: 'now', key: 'SHO-5', number: 5, fields: { branch: 'sho-5' }, column: { category: 'dismissed' }, completedAt: daysAgo(1), updatedAt: daysAgo(1) },
    ]

    const index = await listWorkItemBranches('ws-1')

    expect(index.open).toEqual([])
    expect(index.closed.map((card) => card.key)).toEqual(['SHO-5'])
  })
})
