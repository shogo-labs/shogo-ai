// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect, beforeEach, mock } from 'bun:test'

// ─── In-memory prisma double ──────────────────────────────────────────────
// notification.service.ts only touches prisma.notification.{findMany,create,
// count} and prisma.member.findMany, so a tiny hand-rolled store is enough and
// keeps the test fast + deterministic.

interface Row {
  id: string
  userId: string
  type: string
  title: string
  message: string
  metadata: any
  actionUrl?: string
  readAt: Date | null
  createdAt: Date
}

const db = {
  notifications: [] as Row[],
  members: [] as { workspaceId: string; userId: string; role: string; isBillingAdmin: boolean }[],
}
let idSeq = 0
let createShouldThrow = false

mock.module('../../lib/prisma', () => ({
  prisma: {
    notification: {
      findMany: async ({ where, take }: any) => {
        let rows = db.notifications.filter(
          (n) => n.userId === where.userId && n.type === where.type,
        )
        rows = rows.slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        if (take) rows = rows.slice(0, take)
        return rows.map((r) => ({ id: r.id, metadata: r.metadata }))
      },
      create: async ({ data }: any) => {
        if (createShouldThrow) throw new Error('boom')
        const row: Row = {
          id: `n${++idSeq}`,
          userId: data.userId,
          type: data.type,
          title: data.title,
          message: data.message,
          metadata: data.metadata ?? null,
          actionUrl: data.actionUrl,
          readAt: null,
          createdAt: new Date(Date.now() + idSeq), // strictly increasing
        }
        db.notifications.push(row)
        return { id: row.id }
      },
      count: async ({ where }: any) =>
        db.notifications.filter(
          (n) => n.userId === where.userId && (where.readAt === null ? n.readAt === null : true),
        ).length,
    },
    member: {
      findMany: async ({ where }: any) =>
        db.members
          .filter((m) => m.workspaceId === where.workspaceId && (m.role === 'owner' || m.isBillingAdmin))
          .map((m) => ({ userId: m.userId })),
    },
  },
}))

const svc = await import('../notification.service')

beforeEach(() => {
  db.notifications = []
  db.members = []
  idSeq = 0
  createShouldThrow = false
})

describe('createNotification', () => {
  it('creates a row and returns its id', async () => {
    const res = await svc.createNotification({
      userId: 'u1',
      type: 'overage_charged' as any,
      title: 'Charged',
      message: 'You were charged',
    })
    expect(res).not.toBeNull()
    expect(db.notifications).toHaveLength(1)
    expect(db.notifications[0]).toMatchObject({ userId: 'u1', type: 'overage_charged' })
  })

  it('merges dedupeKey into metadata', async () => {
    await svc.createNotification({
      userId: 'u1',
      type: 'payment_succeeded' as any,
      title: 'Paid',
      message: 'ok',
      metadata: { amountUsd: 5 },
      dedupeKey: 'inv_1',
    })
    expect(db.notifications[0].metadata).toMatchObject({ amountUsd: 5, dedupeKey: 'inv_1' })
  })

  it('skips a duplicate with the same (userId, type, dedupeKey)', async () => {
    const first = await svc.createNotification({
      userId: 'u1',
      type: 'payment_succeeded' as any,
      title: 'Paid',
      message: 'ok',
      dedupeKey: 'inv_1',
    })
    const second = await svc.createNotification({
      userId: 'u1',
      type: 'payment_succeeded' as any,
      title: 'Paid again',
      message: 'dup',
      dedupeKey: 'inv_1',
    })
    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(db.notifications).toHaveLength(1)
  })

  it('does NOT skip when the dedupeKey differs', async () => {
    await svc.createNotification({ userId: 'u1', type: 'payment_succeeded' as any, title: 'a', message: 'a', dedupeKey: 'inv_1' })
    await svc.createNotification({ userId: 'u1', type: 'payment_succeeded' as any, title: 'b', message: 'b', dedupeKey: 'inv_2' })
    expect(db.notifications).toHaveLength(2)
  })

  it('returns null (best-effort) when the insert throws', async () => {
    createShouldThrow = true
    const res = await svc.createNotification({ userId: 'u1', type: 'usage_threshold' as any, title: 't', message: 'm' })
    expect(res).toBeNull()
  })
})

describe('getWorkspaceBillingRecipients', () => {
  it('returns owners and billing admins, de-duplicated', async () => {
    db.members = [
      { workspaceId: 'w1', userId: 'owner', role: 'owner', isBillingAdmin: false },
      { workspaceId: 'w1', userId: 'admin', role: 'member', isBillingAdmin: true },
      { workspaceId: 'w1', userId: 'plain', role: 'member', isBillingAdmin: false },
      { workspaceId: 'w2', userId: 'other', role: 'owner', isBillingAdmin: false },
    ]
    const recipients = await svc.getWorkspaceBillingRecipients('w1')
    expect(recipients.sort()).toEqual(['admin', 'owner'])
  })

  it('counts an owner-and-billing-admin user only once', async () => {
    db.members = [{ workspaceId: 'w1', userId: 'dual', role: 'owner', isBillingAdmin: true }]
    const recipients = await svc.getWorkspaceBillingRecipients('w1')
    expect(recipients).toEqual(['dual'])
  })
})

describe('notifyWorkspaceBillingAdmins', () => {
  it('fans a single payload out to every recipient and returns the created count', async () => {
    db.members = [
      { workspaceId: 'w1', userId: 'owner', role: 'owner', isBillingAdmin: false },
      { workspaceId: 'w1', userId: 'admin', role: 'member', isBillingAdmin: true },
    ]
    const created = await svc.notifyWorkspaceBillingAdmins('w1', {
      type: 'overage_charged' as any,
      title: 'Charged',
      message: 'usage overage',
    })
    expect(created).toBe(2)
    expect(db.notifications.map((n) => n.userId).sort()).toEqual(['admin', 'owner'])
  })

  it('dedupes per recipient so webhook retries do not double-notify', async () => {
    db.members = [{ workspaceId: 'w1', userId: 'owner', role: 'owner', isBillingAdmin: false }]
    const a = await svc.notifyWorkspaceBillingAdmins('w1', { type: 'payment_succeeded' as any, title: 'p', message: 'p', dedupeKey: 'inv_9' })
    const b = await svc.notifyWorkspaceBillingAdmins('w1', { type: 'payment_succeeded' as any, title: 'p', message: 'p', dedupeKey: 'inv_9' })
    expect(a).toBe(1)
    expect(b).toBe(0)
    expect(db.notifications).toHaveLength(1)
  })
})

describe('getUnreadNotificationCount', () => {
  it('counts only the given user’s unread rows', async () => {
    await svc.createNotification({ userId: 'u1', type: 'usage_threshold' as any, title: 'a', message: 'a' })
    await svc.createNotification({ userId: 'u1', type: 'usage_threshold' as any, title: 'b', message: 'b' })
    await svc.createNotification({ userId: 'u2', type: 'usage_threshold' as any, title: 'c', message: 'c' })
    expect(await svc.getUnreadNotificationCount('u1')).toBe(2)
    expect(await svc.getUnreadNotificationCount('u2')).toBe(1)
    expect(await svc.getUnreadNotificationCount('nobody')).toBe(0)
  })
})
