// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-370 — the chat attachment cap is a plan entitlement: Free is a hard
 * 100 MB, every paid tier (and desktop/local) gets the 500 MB body ceiling.
 */
import { describe, expect, it } from 'bun:test'
import {
  FREE_CHAT_ATTACHMENT_BYTES,
  PAID_CHAT_ATTACHMENT_BYTES,
  getChatAttachmentCap,
  getChatAttachmentCapForPaid,
} from '../usage-plans'

const MB = 1024 * 1024

describe('chat attachment cap (SHO-370)', () => {
  it('free is a hard 100 MB', () => {
    expect(FREE_CHAT_ATTACHMENT_BYTES).toBe(100 * MB)
    expect(getChatAttachmentCap('free')).toBe(100 * MB)
  })

  it('every paid tier gets 500 MB', () => {
    expect(PAID_CHAT_ATTACHMENT_BYTES).toBe(500 * MB)
    for (const plan of ['basic', 'pro', 'business', 'enterprise']) {
      expect(getChatAttachmentCap(plan)).toBe(500 * MB)
    }
  })

  it('normalizes decorated ids and falls back to free for unknown', () => {
    expect(getChatAttachmentCap('Basic-Annual')).toBe(500 * MB)
    expect(getChatAttachmentCap('Enterprise-XL')).toBe(500 * MB)
    expect(getChatAttachmentCap('platinum')).toBe(100 * MB)
    expect(getChatAttachmentCap(null)).toBe(100 * MB)
    expect(getChatAttachmentCap(undefined)).toBe(100 * MB)
  })

  it('maps a resolved paid/free entitlement to the same caps', () => {
    expect(getChatAttachmentCapForPaid(true)).toBe(500 * MB)
    expect(getChatAttachmentCapForPaid(false)).toBe(100 * MB)
  })
})
