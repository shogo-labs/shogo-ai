// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-370 — the API proxy's plan-gated attachment cap and its 413 body.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const previousLocalMode = process.env.SHOGO_LOCAL_MODE
beforeAll(() => {
  // Local mode resolves `hasPaidSubscription` to true without touching Stripe.
  process.env.SHOGO_LOCAL_MODE = 'true'
})
afterAll(() => {
  if (previousLocalMode === undefined) delete process.env.SHOGO_LOCAL_MODE
  else process.env.SHOGO_LOCAL_MODE = previousLocalMode
})

const {
  CHAT_ATTACHMENT_MAX_BYTES_HEADER,
  chatAttachmentTooLargeBody,
  isChatAttachmentUpload,
  resolveChatAttachmentCap,
} = await import('../chat-attachment-upload')

const MB = 1024 * 1024

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

  it('resolves the paid cap in local mode (desktop is never blocked)', async () => {
    const cap = await resolveChatAttachmentCap('local-workspace')
    expect(cap).toEqual({ capBytes: 500 * MB, plan: 'paid' })
  })
})
