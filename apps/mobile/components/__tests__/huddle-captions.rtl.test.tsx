// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The captions strip in a live huddle: the newest lines with a name on each, a
 * phone showing two instead of three, the agent's wake status beneath them, and
 * nothing at all when there is nothing to say. The call feeds this from the
 * room; here we only prove it puts the right text on the screen.
 */
import { describe, expect, mock, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../test/react-native-mock'
import type { CaptionLine } from '../../lib/huddle-captions'

// 390 px wide: the phone case, where the strip shows two lines.
let width = 390
mock.module('react-native', () =>
  createReactNativeMock({
    useWindowDimensions: () => ({ width, height: 844, scale: 1, fontScale: 1 }),
  }),
)
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

const { HuddleCaptions } = await import('../team-chat/HuddleCaptions')

const names: Record<string, string> = { u1: 'Ada', u2: 'Grace' }
const nameOf = (id: string) => names[id]

const line = (itemId: string, speakerId: string, text: string, extra: Partial<CaptionLine> = {}): CaptionLine => ({
  itemId,
  speakerId,
  text,
  final: true,
  at: 0,
  start: 0,
  ...extra,
})

const strip = () => document.querySelector('[data-rn-shim="huddle-captions"]')
const shown = () => [...document.querySelectorAll('[data-rn-shim="huddle-captions"] span')].map((node) => node.textContent)

describe('HuddleCaptions', () => {
  test('shows the newest two lines on a phone, each under its speaker', () => {
    width = 390
    render(
      createElement(HuddleCaptions, {
        lines: [line('a', 'u1', 'one'), line('b', 'u2', 'two'), line('c', 'u1', 'three')],
        nameOf,
      }),
    )
    expect(strip()).not.toBeNull()
    expect(shown()).toEqual(['Grace', 'two', 'Ada', 'three'])
  })

  test('a wide screen shows three', () => {
    width = 1280
    render(
      createElement(HuddleCaptions, {
        lines: [line('a', 'u1', 'one'), line('b', 'u2', 'two'), line('c', 'u1', 'three')],
        nameOf,
      }),
    )
    expect(shown()).toEqual(['Ada', 'one', 'Grace', 'two', 'Ada', 'three'])
  })

  test('an unknown speaker still gets a line', () => {
    width = 390
    render(createElement(HuddleCaptions, { lines: [line('a', 'nobody', 'hello there')], nameOf }))
    expect(screen.getByText('Someone')).toBeInTheDocument()
    expect(screen.getByText('hello there')).toBeInTheDocument()
  })

  test('the wake notice sits under the lines while the agent works', () => {
    width = 390
    render(
      createElement(HuddleCaptions, {
        lines: [line('a', 'u1', 'make a card')],
        nameOf,
        notice: '⚡ Shogo is on it (Ada)',
      }),
    )
    expect(screen.getByText('⚡ Shogo is on it (Ada)')).toBeInTheDocument()
  })

  test('with the notes off and nothing to caption it says why', () => {
    width = 390
    render(createElement(HuddleCaptions, { lines: [], nameOf, notesOff: true }))
    expect(screen.getByText('Captions need notes on')).toBeInTheDocument()
  })

  test('with nothing to say, and notes on, it draws nothing at all', () => {
    width = 390
    render(createElement(HuddleCaptions, { lines: [], nameOf }))
    expect(strip()).toBeNull()
  })
})
