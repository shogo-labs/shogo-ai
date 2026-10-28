// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () => createReactNativeMock({} as any))
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }))
mock.module('streamdown/styles.css', () => ({}))

/**
 * Captures the markdown the renderer actually hands the parser — which is the
 * only way to see whether the hard-break transform reached the render path.
 */
const parsed: string[] = []
mock.module('streamdown', () => ({
  Streamdown: ({ children }: { children: ReactNode }) => {
    parsed.push(String(children))
    return createElement('div', null, children)
  },
  defaultUrlTransform: (url: string) => url,
}))

const { MarkdownText } = await import('../MarkdownText.web')

afterEach(cleanup)
beforeEach(() => {
  parsed.length = 0
})

describe('MarkdownText.web hard breaks', () => {
  test('renders a typed newline as a hard break', () => {
    render(<MarkdownText>{'Oct 22nd - Patch\nOct 21st - IDBI'}</MarkdownText>)
    expect(parsed[0]).toBe('Oct 22nd - Patch  \nOct 21st - IDBI')
  })

  test('leaves a fenced code block alone', () => {
    render(<MarkdownText>{'```\nconst a = 1\nconst b = 2\n```'}</MarkdownText>)
    expect(parsed[0]).toContain('const a = 1\nconst b = 2')
    expect(parsed[0]).not.toContain('const a = 1  ')
  })

  test('a one-line message is untouched', () => {
    render(<MarkdownText>Ship it</MarkdownText>)
    expect(parsed[0]).toBe('Ship it')
  })
})
