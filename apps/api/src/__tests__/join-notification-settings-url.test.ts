// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Where join mail sends people (SHO-110).
 *
 * Every `member.joined` / invite-accepted mail links to Settings → People. That
 * URL used to be a latent 404-ish bounce: two route files claimed `/settings`
 * on web — the end-user Settings page and the admin AI/provider console — and
 * the admin console won, so an emailed link landed on `/projects`.
 *
 * The fix gives the admin console `/admin/settings`. This test pins the path the
 * mail builds; the other half of the proof lives in
 * `apps/mobile/test/route-path-collisions.test.ts`, which resolves the real
 * route tree and asserts `/settings` is claimed by the end-user page alone.
 *
 * Run one file per invocation (how CI runs apps/api, via run-tests-isolated):
 *   bun --no-env-file --conditions=development test src/__tests__/join-notification-settings-url.test.ts
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { settingsPeoplePath, settingsPeopleUrl } from '../services/join-notifications'

const hadAppUrl = Object.hasOwn(process.env, 'APP_URL')
const originalAppUrl = process.env.APP_URL

beforeEach(() => {
  process.env.APP_URL = 'https://app.example.com'
})

afterAll(() => {
  if (hadAppUrl) process.env.APP_URL = originalAppUrl
  else delete process.env.APP_URL
})

describe('join notification → Settings → People link', () => {
  test('points at the end-user Settings page, not the chat preferences redirect', () => {
    expect(settingsPeoplePath()).toBe('/settings?tab=people')
    // `/c/settings` is SHO-109's chat-preferences alias; join mail must not use
    // it as a stand-in for Settings itself.
    expect(settingsPeoplePath().startsWith('/c/')).toBe(false)
  })

  test('never targets the admin console', () => {
    expect(settingsPeoplePath().startsWith('/admin/')).toBe(false)
  })

  test('absolute URL is APP_URL + the pinned path', () => {
    expect(settingsPeopleUrl()).toBe('https://app.example.com/settings?tab=people')
  })
})
