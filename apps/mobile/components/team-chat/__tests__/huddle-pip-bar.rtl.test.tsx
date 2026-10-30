// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The floating huddle bar has to look like the in-huddle bar. It used to draw
 * system emoji (🎤 📷 👍 ✋ ⤢ ✕) at font-size, which made every circle a
 * different optical size and read as a different product from the tab. It now
 * draws the same lucide glyphs at the same size, with the same state colours.
 *
 * Rendered as plain DOM: this bar lives in the picture-in-picture window, which
 * has no stylesheets, so it is inline styles and `<svg>` all the way down.
 *
 * Run: bun --no-env-file ../../scripts/run-tests-isolated.ts . --roots components/team-chat/__tests__
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { PIP_ICONS, type PipIconNode } from '../../../lib/huddle-pip-icons'
import type { HuddleCallState } from '../../../lib/huddle-call'
import { PipControlBar } from '../HuddlePip'

const call = (patch: Partial<HuddleCallState> = {}): HuddleCallState => ({
  status: 'connected',
  conversationId: 'c1',
  workspaceId: 'w1',
  label: null,
  kind: null,
  muted: false,
  camera: false,
  screen: false,
  video: [],
  speaking: [],
  playbackBlocked: false,
  error: null,
  participants: [],
  reactions: [],
  handRaised: false,
  view: 'mini',
  layout: 'grid',
  pinned: null,
  pending: null,
  notice: null,
  guest: null,
  notes: { enabled: true, mode: 'off', message: null, covering: [] },
  captions: [],
  wake: null,
  ...patch,
})

const button = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null
const svgOf = (id: string) => button(id)?.querySelector('svg') ?? null

afterEach(cleanup)

describe('floating huddle control bar', () => {
  test('every control draws an icon, never a text glyph', () => {
    render(<PipControlBar call={call()} onReturn={() => {}} />)

    const buttons = Array.from(document.querySelectorAll('[data-testid^="pip-"]')).filter(
      (el) => el.tagName === 'BUTTON',
    ) as HTMLButtonElement[]
    expect(buttons.length).toBeGreaterThanOrEqual(5)

    for (const el of buttons) {
      expect(el.querySelector('svg')).not.toBeNull()
      // A text glyph would leave text nodes behind; an icon leaves none.
      expect(el.textContent).toBe('')
    }
  })

  test('the circles are all the same size and radius', () => {
    render(<PipControlBar call={call()} onReturn={() => {}} />)

    const buttons = Array.from(document.querySelectorAll('[data-testid^="pip-"]')).filter(
      (el) => el.tagName === 'BUTTON',
    ) as HTMLButtonElement[]

    for (const el of buttons) {
      expect(el.style.width).toBe('32px')
      expect(el.style.height).toBe('32px')
      expect(el.style.borderRadius).toBe('16px')
    }
  })

  test('a muted mic is a neutral circle with a red glyph, as in the tab', () => {
    render(<PipControlBar call={call({ muted: true })} onReturn={() => {}} />)

    expect(button('pip-mic')?.style.background).toBe('rgb(42, 42, 42)')
    expect(svgOf('pip-mic')?.getAttribute('stroke')).toBe('rgb(220, 38, 38)')
  })

  test('an open mic is a neutral circle with a foreground glyph', () => {
    render(<PipControlBar call={call({ muted: false })} onReturn={() => {}} />)

    expect(button('pip-mic')?.style.background).toBe('rgb(42, 42, 42)')
    expect(svgOf('pip-mic')?.getAttribute('stroke')).toBe('rgb(222, 222, 222)')
  })

  test('a raised hand uses the accent, not amber', () => {
    render(<PipControlBar call={call({ handRaised: true })} onReturn={() => {}} />)

    expect(button('pip-hand')?.style.background).toBe('rgb(5, 150, 105)')
    expect(svgOf('pip-hand')?.getAttribute('stroke')).toBe('#ffffff')
  })

  test('leaving uses the phone-off glyph and the danger fill', () => {
    render(<PipControlBar call={call()} onReturn={() => {}} />)

    expect(button('pip-leave')?.style.background).toBe('rgb(220, 38, 38)')
    const paths = Array.from(svgOf('pip-leave')?.querySelectorAll('path') ?? []).map((p) => p.getAttribute('d'))
    const nodes: readonly PipIconNode[] = PIP_ICONS.phoneOff
    const expected = nodes.filter(([tag]) => tag === 'path').map(([, attrs]) => attrs.d)
    expect(paths).toEqual(expected)
  })

  test('a control with a real on/off state says so to assistive tech', () => {
    render(<PipControlBar call={call({ handRaised: true })} onReturn={() => {}} />)

    expect(button('pip-hand')?.getAttribute('aria-pressed')).toBe('true')
    // The mic is never "on" or "off" in a way the reader needs announced.
    expect(button('pip-mic')?.getAttribute('aria-pressed')).toBeNull()
  })

  test('labels match the in-huddle bar', () => {
    render(<PipControlBar call={call({ muted: true })} onReturn={() => {}} />)

    expect(button('pip-mic')?.getAttribute('aria-label')).toBe('Unmute')
    expect(button('pip-react')?.getAttribute('aria-label')).toBe('React 👍')
    expect(button('pip-return')?.getAttribute('aria-label')).toBe('Return to the tab')
    expect(button('pip-leave')?.getAttribute('aria-label')).toBe('Leave huddle')
  })
})
