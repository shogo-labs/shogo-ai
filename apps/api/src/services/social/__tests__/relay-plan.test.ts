// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The relay's tenant scoping is the security boundary for the master Zernio
 * key, so it is tested as a pure decision first — no database, no provider.
 */

import { describe, expect, test } from 'bun:test'
import { planRelayRequest } from '../relay-plan'

const workspaceId = '11111111-1111-4111-8111-111111111111'
/** The routing id the cloud derives for the cloud scope. */
const externalId = `ws_${workspaceId}`
const profile = {
  id: 'profile_1',
  workspaceId,
  localWorkspaceId: '',
  zernioProfileId: 'zernio_profile_1',
  externalId,
  name: 'Acme',
}

const plan = (args: Partial<Parameters<typeof planRelayRequest>[0]> = {}) =>
  planRelayRequest({
    method: 'GET',
    path: '/profiles',
    query: {},
    body: undefined,
    workspaceId,
    externalId,
    profile,
    ...args,
  })

describe('relay scoping', () => {
  test('the caller can only ever read its own profile', () => {
    const result = plan({ path: '/profiles', query: { externalId: 'someone_else' } })
    expect(result).toMatchObject({ kind: 'forward', query: { externalId } })
  })

  test('a profile create is rewritten onto the caller’s workspace', () => {
    const result = plan({
      method: 'POST',
      path: '/profiles',
      body: { name: 'Acme', externalId: 'victim_workspace' },
    })
    expect(result).toMatchObject({ kind: 'forward', record: 'profile-created' })
    expect((result as any).body).toEqual({ name: 'Acme', externalId })
  })

  test('each local workspace derives its own routing id, never the request’s', () => {
    const localScope = '22222222-2222-4222-8222-222222222222'
    const localPlan = plan({
      method: 'POST',
      path: '/profiles',
      body: { name: 'Acme', externalId: 'ws_victim' },
      externalId: `lws_${localScope}`,
      profile: { ...profile, localWorkspaceId: localScope, externalId: `lws_${localScope}` },
    })
    expect((localPlan as any).body).toEqual({ name: 'Acme', externalId: `lws_${localScope}` })

    const read = plan({ path: '/profiles', query: { externalId: 'lws_other' }, externalId: `lws_${localScope}` })
    expect(read).toMatchObject({ kind: 'forward', query: { externalId: `lws_${localScope}` } })
  })

  test('another workspace’s profile id is refused', () => {
    const result = plan({ path: '/profiles/zernio_profile_other', method: 'DELETE' })
    expect(result).toMatchObject({ kind: 'deny', status: 403, code: 'profile_out_of_scope' })
  })

  test('account reads are pinned to the caller’s profile id', () => {
    const result = plan({
      path: '/accounts',
      query: { profileId: 'zernio_profile_other' },
    })
    expect(result).toMatchObject({
      kind: 'forward',
      query: { profileId: 'zernio_profile_1' },
      record: 'accounts-listed',
    })
  })

  test('an account mutation must name an id the route can verify', () => {
    const result = plan({ path: '/accounts/zernio_account_9', method: 'DELETE' })
    expect(result).toMatchObject({
      kind: 'forward',
      path: '/accounts/zernio_account_9',
      verifyAccountId: 'zernio_account_9',
    })
  })

  test('a publish is forced onto the caller’s profile', () => {
    const result = plan({
      method: 'POST',
      path: '/posts',
      body: { content: 'hi', profileId: 'zernio_profile_other', platforms: [] },
    })
    expect((result as any).body).toMatchObject({ profileId: 'zernio_profile_1', content: 'hi' })
    expect(result).toMatchObject({ record: 'post-created' })
  })

  test('post mutations must name an id the route can verify', () => {
    const result = plan({ path: '/posts/zernio_post_9', method: 'PATCH', body: { content: 'x' } })
    expect(result).toMatchObject({ kind: 'forward', verifyPostId: 'zernio_post_9' })
    expect((result as any).body).toMatchObject({ profileId: 'zernio_profile_1' })
  })

  test('anything outside the allowlist is denied by default', () => {
    for (const path of ['/analytics', '/webhooks/settings', '/', '/profiles/1/2']) {
      expect(plan({ path, method: 'POST' })).toMatchObject({
        kind: 'deny',
        code: expect.stringMatching(/relay_path_not_allowed|method_not_allowed|invalid_path/),
      })
    }
  })

  test('an automation create is pinned to the caller’s profile and account', () => {
    const result = plan({
      path: '/comment-automations',
      method: 'POST',
      body: { accountId: 'zernio_acc_1', profileId: 'zernio_profile_other', name: 'Merge', dmMessage: 'x' },
    })
    expect(result).toMatchObject({
      kind: 'forward',
      record: 'automation-created',
      verifyAccountId: 'zernio_acc_1',
    })
    expect((result as any).body.profileId).toBe('zernio_profile_1')
  })

  test('an automation mutation must name an id the route can verify', () => {
    expect(plan({ path: '/comment-automations/ca_9', method: 'PATCH', body: { isActive: false } })).toMatchObject({
      kind: 'forward',
      verifyAutomationId: 'ca_9',
    })
    expect(plan({ path: '/workflows/wf_9/activate', method: 'POST' })).toMatchObject({
      kind: 'forward',
      path: '/workflows/wf_9/activate',
      verifyAutomationId: 'wf_9',
    })
  })

  test('operations that need a profile are refused before the provider is called', () => {
    for (const [method, path] of [
      ['GET', '/accounts'],
      ['GET', '/posts'],
      ['POST', '/posts'],
      ['GET', '/inbox/comments'],
    ] as const) {
      expect(plan({ method, path, profile: null })).toMatchObject({
        kind: 'deny',
        status: 412,
        code: 'social_profile_missing',
      })
    }
  })

  test('a first connect may create the scope’s profile, and carries no profileId yet', () => {
    const result = plan({
      path: '/connect/instagram',
      query: { redirect_url: 'https://app.example/social/callback', profileId: 'someone_else' },
      profile: null,
    })
    expect(result).toMatchObject({
      kind: 'forward',
      path: '/connect/instagram',
      ensureProfile: true,
      query: { redirect_url: 'https://app.example/social/callback' },
    })
    expect((result as any).query.profileId).toBeUndefined()
  })

  test('a connect from a scope that has a profile is pinned to it', () => {
    expect(plan({ path: '/connect/tiktok' })).toMatchObject({
      kind: 'forward',
      query: { profileId: 'zernio_profile_1' },
    })
  })

  test('unsupported methods never reach the provider', () => {
    expect(plan({ method: 'PUT', path: '/posts' })).toMatchObject({
      kind: 'deny',
      status: 405,
      code: 'method_not_allowed',
    })
  })
})

describe('inbox scoping', () => {
  const account = 'zernio_ig'

  test('a conversation list is pinned to the caller’s own profile', () => {
    expect(plan({ path: '/inbox/conversations', query: { profileId: 'someone_else', limit: '25' } })).toMatchObject({
      kind: 'forward',
      path: '/inbox/conversations',
      query: { profileId: 'zernio_profile_1', limit: '25' },
    })
  })

  test('a thread needs an account the workspace owns, in either direction', () => {
    expect(
      plan({ path: '/inbox/conversations/conv_1/messages', query: { accountId: account } }),
    ).toMatchObject({
      kind: 'forward',
      path: '/inbox/conversations/conv_1/messages',
      verifyAccountId: account,
    })

    expect(
      plan({
        method: 'POST',
        path: '/inbox/conversations/conv_1/messages',
        body: { accountId: account, message: 'Yes — we ship there.', extra: 'dropped' },
      }),
    ).toMatchObject({
      kind: 'forward',
      body: { accountId: account, message: 'Yes — we ship there.' },
      verifyAccountId: account,
    })
  })

  test('a thread with no account, or an empty message, is refused before it leaves', () => {
    expect(plan({ path: '/inbox/conversations/conv_1/messages', query: {} })).toMatchObject({
      kind: 'deny',
      status: 400,
      code: 'invalid_body',
    })
    expect(
      plan({
        method: 'POST',
        path: '/inbox/conversations/conv_1/messages',
        body: { accountId: account, message: '   ' },
      }),
    ).toMatchObject({ kind: 'deny', status: 400, code: 'invalid_body' })
  })

  test('comments are listed by profile and answered by account + comment id', () => {
    expect(plan({ path: '/inbox/comments', query: { profileId: 'someone_else' } })).toMatchObject({
      kind: 'forward',
      query: { profileId: 'zernio_profile_1' },
    })
    expect(
      plan({
        method: 'POST',
        path: '/inbox/comments/zernio_post_1',
        body: { accountId: account, message: 'Just merged!', commentId: 'cmt_1' },
      }),
    ).toMatchObject({
      kind: 'forward',
      path: '/inbox/comments/zernio_post_1',
      body: { accountId: account, message: 'Just merged!', commentId: 'cmt_1' },
      verifyAccountId: account,
    })
  })

  test('an inbox path outside the allowlist is still denied', () => {
    expect(plan({ method: 'DELETE', path: '/inbox/conversations/conv_1' })).toMatchObject({ kind: 'deny' })
    expect(plan({ method: 'PUT', path: '/inbox/comments/zernio_post_1' })).toMatchObject({
      kind: 'deny',
      status: 405,
    })
  })
})

describe('media presign through the relay', () => {
  const presign = (body: Record<string, unknown>) =>
    plan({ method: 'POST', path: '/media/presign', body })

  test('the mint is forwarded with only the fields Zernio reads', () => {
    expect(
      presign({ filename: 'reel.mp4', contentType: 'video/mp4', size: 1024, workspaceId: 'ws_victim' }),
    ).toEqual({
      kind: 'forward',
      path: '/media/presign',
      query: {},
      body: { filename: 'reel.mp4', contentType: 'video/mp4', size: 1024 },
    })
  })

  test('it needs no profile — an upload slot is scoped to the account', () => {
    // The same plan with no profile resolved still goes through; every other
    // media call would be waiting on one.
    expect(
      planRelayRequest({
        method: 'POST',
        path: '/media/presign',
        query: {},
        body: { filename: 'a.jpg', contentType: 'image/jpeg' },
        workspaceId,
        externalId,
        profile: null,
      }),
    ).toMatchObject({ kind: 'forward', path: '/media/presign' })
  })

  test('a generic content type is refused before the provider sees it', () => {
    expect(presign({ filename: 'a.bin', contentType: 'application/octet-stream' })).toMatchObject({
      kind: 'deny',
      status: 400,
      code: 'invalid_content_type',
    })
    expect(presign({ filename: 'a.bin' })).toMatchObject({ kind: 'deny', status: 400 })
  })

  test('only the mint is relayed — the PUT goes straight to storage', () => {
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      expect(plan({ method, path: '/media/presign', body: {} })).toMatchObject({
        kind: 'deny',
        status: 405,
      })
    }
    expect(plan({ method: 'POST', path: '/media', body: {} })).toMatchObject({ kind: 'deny' })
    expect(plan({ method: 'POST', path: '/media/presign/extra', body: {} })).toMatchObject({
      kind: 'deny',
    })
  })

  test('an empty string content type is not a media type either', () => {
    expect(presign({ filename: 'a.jpg', contentType: '   ' })).toMatchObject({
      kind: 'deny',
      code: 'invalid_content_type',
    })
  })
})
