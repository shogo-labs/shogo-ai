// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-370 — the API proxy's plan-gated attachment cap and its 413 body.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'

const MB = 1024 * 1024

/**
 * `resolveChatAttachmentCap` resolves the workspace's paid/free answer through
 * the billing seam. Stub that seam here so the unit never reaches
 * `billing.service` → `resolveBillingWorkspaceId` → a live Prisma read (the
 * full-package run has no database). Controllable per test.
 */
let paid = true
let billingThrows = false
mock.module('../../services/billing-runtime', () => ({
  hasPaidSubscription: async (_workspaceId: string) => {
    if (billingThrows) throw new Error('billing lookup unavailable')
    return paid
  },
}))

const {
  CHAT_ATTACHMENT_MAX_BYTES_HEADER,
  chatAttachmentTooLargeBody,
  isChatAttachmentUpload,
  resolveChatAttachmentCap,
} = await import('../chat-attachment-upload')

afterEach(() => {
  paid = true
  billingThrows = false
})

describe('chat attachment upload cap (SHO-370)', () => {
  it('recognises only PUT /agent/chat/attachments as a streamed upload', () => {
    expect(isChatAttachmentUpload('PUT', '/agent/chat/attachments')).toBe(true)
    expect(isChatAttachmentUpload('POST', '/agent/chat/attachments')).toBe(false)
    expect(isChatAttachmentUpload('PUT', '/agent/chat')).toBe(false)
  })

  it('exposes the header the runtime reads', () => {
    expect(CHAT_ATTACHMENT_MAX_BYTES_HEADER).toBe('x-attachment-max-bytes')
  })

  it('builds a free-plan 413 body with the upgrade prompt', () => {
    const body = chatAttachmentTooLargeBody({ capBytes: 100 * MB, plan: 'free' })
    expect(body.error.code).toBe('attachment_too_large')
    expect(body.error.plan).toBe('free')
    expect(body.error.limitBytes).toBe(100 * MB)
    expect(body.error.upgrade).toBe(true)
    expect(body.error.message).toContain('100 MB')
    expect(body.error.message).toContain('Upgrade')
  })

  it('builds a paid-plan 413 body without the upgrade prompt', () => {
    const body = chatAttachmentTooLargeBody({ capBytes: 500 * MB, plan: 'paid' })
    expect(body.error.plan).toBe('paid')
    expect(body.error.limitBytes).toBe(500 * MB)
    expect(body.error.upgrade).toBe(false)
    expect(body.error.message).toContain('500 MB')
  })

  it('resolves the paid 500 MB cap when the workspace has a paid subscription', async () => {
    paid = true
    const cap = await resolveChatAttachmentCap('paid-workspace')
    expect(cap).toEqual({ capBytes: 500 * MB, plan: 'paid' })
  })

  it('resolves the free 100 MB cap when the workspace has no paid subscription', async () => {
    paid = false
    const cap = await resolveChatAttachmentCap('free-workspace')
    expect(cap).toEqual({ capBytes: 100 * MB, plan: 'free' })
  })

  it('falls back to the paid cap when the billing lookup throws', async () => {
    billingThrows = true
    const cap = await resolveChatAttachmentCap('failing-workspace')
    expect(cap).toEqual({ capBytes: 500 * MB, plan: 'paid' })
  })
})
