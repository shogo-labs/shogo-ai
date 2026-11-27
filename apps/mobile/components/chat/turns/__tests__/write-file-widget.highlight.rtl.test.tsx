// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-601 — the write preview's highlighter lives in an async chunk now, so
 * this opens the feature that needs it: render the real widget with a real
 * `write_file` call and assert the code it paints is Shiki's coloured HTML, not
 * the plain-text fallback.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { createReactNativeMock } from '../../../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    ScrollView: ({ children, ...props }: any) => createElement('div', props, children as ReactNode),
  }),
)

mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...parts: unknown[]) => parts.filter(Boolean).join(' '),
}))

mock.module('../../../../contexts/theme', () => ({
  useResolvedTheme: () => 'dark',
}))

const Icon = () => createElement('span', { 'data-icon': 'true' })
mock.module('lucide-react-native', () => ({
  FilePlus2: Icon,
  Loader2: Icon,
  CheckCircle2: Icon,
  XCircle: Icon,
  ChevronRight: Icon,
  ChevronDown: Icon,
}))

const { WriteFileWidget } = await import('../WriteFileWidget.web')

afterEach(cleanup)

describe('WriteFileWidget.web highlighting', () => {
  test('paints the code with Shiki, loaded on demand', async () => {
    const tool = {
      id: 'call_1',
      name: 'write_file',
      state: 'success',
      args: { path: 'src/example.ts', content: 'const answer: number = 42' },
      result: { bytes: 27 },
    } as any

    const { container } = render(createElement(WriteFileWidget, { tool, isExpanded: true }))

    await waitFor(
      () => {
        const html = container.innerHTML
        expect(html).toContain('<pre')
        expect(html).toContain('style="color:')
        expect(html).toContain('answer')
      },
      { timeout: 5000 },
    )
  })
})
