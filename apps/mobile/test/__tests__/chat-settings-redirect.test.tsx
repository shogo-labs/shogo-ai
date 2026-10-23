// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `/c/settings` is gone as a screen: chat preferences are Settings → Chat.
 * The route stays so old deep links (the weekly digest email, bookmarks,
 * older app builds) still land on the tab.
 */
import { describe, expect, mock, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { createElement } from 'react'

const redirects: string[] = []
mock.module('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => {
    redirects.push(href)
    return createElement('div', { 'data-testid': 'redirect' })
  },
}))

const { default: ChatSettingsRedirect } = await import('../../app/(app)/c/settings')

describe('/c/settings', () => {
  test('redirects to Settings, Chat tab', () => {
    redirects.length = 0
    render(createElement(ChatSettingsRedirect))

    expect(redirects).toEqual(['/(app)/settings?tab=chat'])
    expect(screen.getByTestId('redirect')).toBeTruthy()
  })
})
