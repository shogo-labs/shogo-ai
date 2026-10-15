// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Resolving a stored avatar URL for display.
 *
 * `User.image` holds two different shapes — the relative `/api/user-avatar/...`
 * URL we write for an uploaded picture, and the absolute provider URL OAuth
 * writes (Google/Apple `picture`) — and the ~10 render sites pass it straight to
 * an `<Image>`. Getting this wrong is silent: an unresolvable relative value
 * simply renders nothing on a phone, where there is no page origin to resolve it
 * against.
 */

import { resolve } from 'node:path'
import { describe, expect, mock, test } from 'bun:test'

mock.module(resolve(import.meta.dir, '../api-url'), () => ({ API_URL: 'https://api.example.com' }))

const { resolveAvatarUrl } = await import('../chat-attachment-url')

describe('resolveAvatarUrl', () => {
  test('makes our own relative URL absolute against the API origin', () => {
    expect(resolveAvatarUrl('/api/user-avatar/u1?k=abcdef0123456789.jpg&t=sig'))
      .toBe('https://api.example.com/api/user-avatar/u1?k=abcdef0123456789.jpg&t=sig')
  })

  test('leaves an absolute OAuth photo alone', () => {
    // Re-prefixing this would produce a URL that 404s.
    expect(resolveAvatarUrl('https://lh3.googleusercontent.com/a/oauth-photo'))
      .toBe('https://lh3.googleusercontent.com/a/oauth-photo')
    expect(resolveAvatarUrl('https://avatars.githubusercontent.com/u/1?v=4'))
      .toBe('https://avatars.githubusercontent.com/u/1?v=4')
  })

  test('leaves local-only schemes alone', () => {
    expect(resolveAvatarUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    // What the picker hands back for a local preview before the upload lands.
    expect(resolveAvatarUrl('blob:https://app.example.com/abc')).toBe('blob:https://app.example.com/abc')
  })

  test('returns null for the many places a user has no picture', () => {
    // `<Image source={{ uri: null }}>` is fine; a missing value must not become
    // the string "null" or the API origin on its own.
    expect(resolveAvatarUrl(null)).toBeNull()
    expect(resolveAvatarUrl(undefined)).toBeNull()
    expect(resolveAvatarUrl('')).toBeNull()
  })
})
