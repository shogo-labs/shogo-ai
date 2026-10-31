// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The in-app destination of a lifecycle notification row (SHO-266).
 *
 * The API's rows carry an absolute web `actionUrl` (`${appBaseUrl()}/chat?project=…`,
 * SHO-258 §4) that the app cannot route, so the inbox derives the destination
 * from `type` + `metadata.projectId` instead. These cases pin that mapping to
 * the shapes `apps/api/src/lib/lifecycle-notifications.ts` actually writes.
 */
import { describe, expect, test } from 'bun:test'

import {
  lifecycleKindForNotificationType,
  lifecycleNotificationRoute,
  notificationMetadata,
} from '../notifications/lifecycle-notification-link'

describe('lifecycleKindForNotificationType', () => {
  test('maps the two API row types to their chip kinds', () => {
    expect(lifecycleKindForNotificationType('build_ready')).toBe('build-ready')
    expect(lifecycleKindForNotificationType('credits_reset')).toBe('credits-reset')
  })

  test('is null for every other row', () => {
    expect(lifecycleKindForNotificationType('payment_succeeded')).toBeNull()
    expect(lifecycleKindForNotificationType('invitation_pending')).toBeNull()
    expect(lifecycleKindForNotificationType('build-ready')).toBeNull()
    expect(lifecycleKindForNotificationType(undefined)).toBeNull()
    expect(lifecycleKindForNotificationType(null)).toBeNull()
    expect(lifecycleKindForNotificationType(42)).toBeNull()
  })
})

describe('notificationMetadata', () => {
  test('parses the JSON string the API sends', () => {
    expect(
      notificationMetadata('{"projectId":"p1","workspaceId":"w1","chatSessionId":"c1"}'),
    ).toEqual({ projectId: 'p1', workspaceId: 'w1', chatSessionId: 'c1' })
  })

  test('passes an already-frozen object through', () => {
    expect(notificationMetadata({ workspaceId: 'w1', resetAt: '2026-10-31T00:00:00.000Z' })).toEqual(
      { workspaceId: 'w1', resetAt: '2026-10-31T00:00:00.000Z' },
    )
  })

  test('never throws on a missing or malformed value', () => {
    expect(notificationMetadata(null)).toEqual({})
    expect(notificationMetadata(undefined)).toEqual({})
    expect(notificationMetadata('not json')).toEqual({})
    expect(notificationMetadata('[1,2]')).toEqual({})
    expect(notificationMetadata(7)).toEqual({})
  })
})

describe('lifecycleNotificationRoute', () => {
  test('a build-ready row opens its project, flagged', () => {
    // Exactly what `notifyBuildReady` writes, including the absolute actionUrl
    // the app must ignore.
    const row = {
      type: 'build_ready',
      actionUrl: 'https://app.shogo.ai/chat?project=proj-1',
      metadata: '{"projectId":"proj-1","workspaceId":"ws-1","chatSessionId":"sess-1"}',
    }
    expect(lifecycleNotificationRoute(row)).toEqual({
      pathname: '/(app)/projects/[id]',
      params: { id: 'proj-1', fromLifecycle: 'build-ready' },
    })
  })

  test('a credits-reset row that names a project opens it too', () => {
    const row = {
      type: 'credits_reset',
      metadata: { projectId: 'proj-2', workspaceId: 'ws-1', resetAt: '2026-10-31T00:00:00.000Z' },
    }
    expect(lifecycleNotificationRoute(row)).toEqual({
      pathname: '/(app)/projects/[id]',
      params: { id: 'proj-2', fromLifecycle: 'credits-reset' },
    })
  })

  test('a credits-reset row with no project lands on the project list', () => {
    // `notifyCreditsReset` metadata is `{workspaceId, resetAt}` — the wallet
    // that ran out need not have built anything.
    expect(
      lifecycleNotificationRoute({
        type: 'credits_reset',
        metadata: '{"workspaceId":"ws-1","resetAt":"2026-10-31T00:00:00.000Z"}',
      }),
    ).toEqual({ pathname: '/(app)/projects', params: {} })
  })

  test('a projectId that is not a non-empty string is treated as absent', () => {
    for (const metadata of ['{"projectId":""}', '{"projectId":7}', '{}', 'not json', null]) {
      expect(lifecycleNotificationRoute({ type: 'build_ready', metadata })).toEqual({
        pathname: '/(app)/projects',
        params: {},
      })
    }
  })

  test('is null for any other notification, so its actionUrl still applies', () => {
    expect(
      lifecycleNotificationRoute({
        type: 'payment_succeeded',
        metadata: '{"projectId":"proj-1"}',
      }),
    ).toBeNull()
    expect(lifecycleNotificationRoute({ type: undefined, metadata: undefined })).toBeNull()
  })
})
