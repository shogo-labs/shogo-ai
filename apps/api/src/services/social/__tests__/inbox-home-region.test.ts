// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Inbox writes run only in the workspace's home region (SHO-585 §B).
 *
 * Replies are the dangerous half: the provider is called before the row is
 * stored, so a wrong-region write either delivers twice (forward after the
 * send) or leaves the thread with a message the home region never saw. The
 * guard is therefore the first thing each write does, and an unreachable home
 * region is a retryable 503 — never a local write.
 *
 *   bun test apps/api/src/services/social/__tests__/inbox-home-region.test.ts
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

// --- fakes -----------------------------------------------------------------
const conversations: Record<string, any> = {
  conv_1: { id: 'conv_1', workspaceId: 'ws_eu', accountId: 'acct_1', platform: 'instagram', zernioConversationId: 'zc_1' },
}
const accounts: Record<string, any> = {
  acct_1: { id: 'acct_1', workspaceId: 'ws_eu', zernioAccountId: 'z_ig', username: 'acme.ig', displayName: 'Acme' },
}

mock.module('../../../lib/prisma', () => ({
  prisma: {
    socialConversation: { findFirst: async ({ where }: any) => conversations[where?.id] ?? null },
    socialAccount: { findFirst: async ({ where }: any) => accounts[where?.id] ?? null },
    socialMessage: { count: async () => 0 },
    socialComment: { count: async () => 0 },
  },
}))

type Outcome = 'local' | 'forwarded' | 'unavailable' | 'rejected'
let outcome: Outcome = 'forwarded'
let rejection: { status: number; error: unknown } = { status: 409, error: null }
const HOME_RESULT = { messageId: 'home-message-1', providerMessageId: 'z_m1', conversationId: 'conv_1', metered: false }
const routed: Array<{ workspaceId: string; path: string; body: any }> = []

mock.module('../../../lib/home-region-route', () => ({
  routeToHomeRegion: async (workspaceId: string, path: string, body: any) => {
    routed.push({ workspaceId, path, body })
    if (outcome === 'local') return { outcome: 'local' }
    if (outcome === 'forwarded') return { outcome: 'forwarded', data: HOME_RESULT }
    if (outcome === 'rejected') return { outcome: 'rejected', ...rejection }
    return { outcome: 'unavailable' }
  },
}))

const { replyToComment, replyToConversation, backfillInbox, SOCIAL_INBOX_FORWARD_PATH } = await import('../inbox.service')
const { setSocialClient, SocialError } = await import('../client')

/** Counts provider calls so "forwarded before the send" is observable. */
const providerCalls: string[] = []
setSocialClient({
  request: async (req: any) => {
    providerCalls.push(`${req.method} ${req.path}`)
    throw new Error('the provider must not be called in a region that does not own the write')
  },
} as any)

beforeEach(() => {
  outcome = 'forwarded'
  routed.length = 0
  providerCalls.length = 0
})

describe('a write this region does not own is forwarded', () => {
  test('replyToConversation forwards before calling the provider', async () => {
    const result = await replyToConversation('ws_eu', 'conv_1', { text: 'on its way' })

    expect(result).toEqual(HOME_RESULT as any)
    expect(providerCalls).toEqual([])
    expect(routed).toHaveLength(1)
    expect(routed[0].workspaceId).toBe('ws_eu')
    expect(routed[0].path).toBe(SOCIAL_INBOX_FORWARD_PATH)
    expect(routed[0].body).toMatchObject({ kind: 'reply-conversation', conversationId: 'conv_1', input: { text: 'on its way' } })
  })

  test('replyToComment forwards before calling the provider', async () => {
    await replyToComment('ws_eu', 'cmt_1', { text: 'thanks!' })
    expect(providerCalls).toEqual([])
    expect(routed[0].body).toMatchObject({ kind: 'reply-comment', commentId: 'cmt_1' })
  })

  test('backfillInbox forwards the sweep', async () => {
    const result = await backfillInbox('ws_eu', { limit: 25 })
    expect(result).toEqual(HOME_RESULT as any)
    expect(providerCalls).toEqual([])
    expect(routed[0].body).toMatchObject({ kind: 'backfill', limit: 25 })
  })
})

describe('an unreachable home region is a retryable 503, never a local write', () => {
  for (const call of [
    ['replyToConversation', () => replyToConversation('ws_eu', 'conv_1', { text: 'hi' })],
    ['replyToComment', () => replyToComment('ws_eu', 'cmt_1', { text: 'hi' })],
    ['backfillInbox', () => backfillInbox('ws_eu')],
  ] as const) {
    test(call[0], async () => {
      outcome = 'unavailable'
      let error: any = null
      try {
        await call[1]()
      } catch (err) {
        error = err
      }
      expect(error).toBeInstanceOf(SocialError)
      expect(error.status).toBe(503)
      expect(error.code).toBe('home_region_unavailable')
      expect(providerCalls).toEqual([])
    })
  }
})

describe('a refusal from the home region reaches the caller as its own answer', () => {
  test('a 409 "no account linked" is a 409, not a retryable 503', async () => {
    outcome = 'rejected'
    rejection = { status: 409, error: { error: 'no_account_linked', message: 'No Instagram account is linked yet' } }

    let error: any = null
    try {
      await replyToComment('ws_eu', 'cmt_1', { text: 'thanks!' })
    } catch (err) {
      error = err
    }

    expect(error).toBeInstanceOf(SocialError)
    expect(error.status).toBe(409)
    expect(error.code).toBe('no_account_linked')
    expect(error.message).toBe('No Instagram account is linked yet')
    // The provider was never called: the refusal arrived before the send.
    expect(providerCalls).toEqual([])
  })

  test('falls back to a conflict when the peer sends no usable body', async () => {
    outcome = 'rejected'
    rejection = { status: 409, error: null }

    let error: any = null
    try {
      await backfillInbox('ws_eu')
    } catch (err) {
      error = err
    }
    expect(error?.status).toBe(409)
    expect(error?.code).toBe('home_region_refused')
  })
})

describe('the region that owns the write still does it locally', () => {
  test('a local (this-region-home) reply reaches the provider exactly once', async () => {
    outcome = 'local'
    await expect(replyToConversation('ws_eu', 'conv_1', { text: 'hi' })).rejects.toThrow(/must not be called/)
    expect(providerCalls).toHaveLength(1)
    expect(providerCalls[0]).toBe('POST /inbox/conversations/zc_1/messages')
  })
})
