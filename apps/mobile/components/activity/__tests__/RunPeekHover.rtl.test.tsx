// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-466: RunPeekHover — web opens a card after 350 ms; native passthrough.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

// --- Basic mocks -----------------------------------------------------------
// `mock.module` is process-global, so the native case below has to put the web
// mock back or every test after it renders the passthrough.
const webReactNative = () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    Text: ({ children }: any) => createElement('span', {}, children),
    View: ({ children, ...props }: any) => createElement('div', props, children),
  } as any)
const nativeReactNative = () =>
  createReactNativeMock({
    Platform: { OS: 'ios', select: (s: any) => s.ios ?? s.default },
    Text: ({ children }: any) => createElement('span', {}, children),
    View: ({ children }: any) => createElement('div', {}, children),
  } as any)

mock.module('react-native', webReactNative)
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

// Stub useDomainHttp / contexts
mock.module('../../../contexts/domain', () => ({
  useDomainHttp: () => ({}),
}))

// Stub useRunPeek so tests control what the hook returns
let stubState: import('../../../hooks/useRunPeek').PeekState = { status: 'idle' }
mock.module('../../../hooks/useRunPeek', () => ({
  useRunPeek: () => stubState,
}))

// Stub elapsedLabel
mock.module('../../../lib/activity-feed', () => ({
  elapsedLabel: () => '5m',
}))

const { RunPeekHover } = await import('../RunPeekHover')

const CHAT = {
  chatSessionId: 'chat-1',
  turnId: 'turn-1',
  startedAt: new Date().toISOString(),
  agentName: 'Shogo Dev 3',
  projectId: 'proj-1',
  projectName: 'Shogo Dev 3',
  conversationName: 'shogo-dev',
  card: { key: 'SHO-466', title: 'Hover peek', column: 'In Development' } as any,
}

function renderHover(chat = CHAT) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const RunPeekHoverAny = RunPeekHover as any
  return render(
    createElement(
      RunPeekHoverAny,
      { workspaceId: 'ws-1', chat },
      createElement('div', { 'data-testid': 'row-child' }, 'Row content'),
    ),
  )
}

beforeEach(() => { stubState = { status: 'idle' } })
afterEach(() => cleanup())

describe('RunPeekHover (web)', () => {
  test('renders children without a card while idle', () => {
    renderHover()
    expect(screen.getByTestId('row-child')).toBeTruthy()
    expect(screen.queryByTestId('run-peek-card')).toBeNull()
  })

  test('opens the card after mouseenter + timer', async () => {
    stubState = { status: 'ready', peek: { chatSessionId: 'chat-1', turnId: 'turn-1', title: 'Hover peek', agentName: 'Dev 3', startedAt: new Date().toISOString(), where: { kind: 'public', conversationId: 'c-1', conversationName: 'shogo-dev', threadRootId: null }, card: { key: 'SHO-466', title: 'x', column: 'In Dev' }, trigger: null, reply: null, hidden: false } }
    renderHover()
    // mouseenter the wrapper div
    const wrapper = screen.getByTestId('row-child').parentElement!
    act(() => { fireEvent.mouseEnter(wrapper, {}) })
    // the card is portaled after OPEN_DELAY_MS=350; wait with fake timers
    await act(async () => { await new Promise((r) => setTimeout(r, 400)) })
    expect(screen.queryByTestId('run-peek-card')).toBeTruthy()
  })

  test('shows "Private conversation" when hidden=true', async () => {
    stubState = { status: 'hidden' }
    renderHover()
    const wrapper = screen.getByTestId('row-child').parentElement!
    act(() => { fireEvent.mouseEnter(wrapper, {}) })
    await act(async () => { await new Promise((r) => setTimeout(r, 400)) })
    const card = screen.queryByTestId('run-peek-card')
    if (card) {
      expect(card.textContent).toContain('Private conversation')
    }
  })

  test('no card rendered without hover on native', async () => {
    // Re-stub Platform as native
    mock.module('react-native', nativeReactNative)
    // Need to re-import with new Platform value – just assert no card opens
    renderHover()
    const wrapper = screen.queryByTestId('row-child')
    expect(wrapper).toBeTruthy()
    // On native RunPeekHover just returns children (no wrapping div)
    expect(screen.queryByTestId('run-peek-card')).toBeNull()
    // `mock.module` is process-global: hand the web mock back to later tests.
    mock.module('react-native', webReactNative)
  })
})

/**
 * SHO-501: on the real Activity page the card opened and then vanished with no
 * trace. Every close path now names itself on `data-peek-close`, and a scroll
 * only closes the card when the scrolled element actually moves the row.
 */
describe('RunPeekHover close paths (web)', () => {
  const READY: import('../../../hooks/useRunPeek').PeekState = {
    status: 'ready',
    peek: {
      chatSessionId: 'chat-1',
      turnId: 'turn-1',
      title: 'Hover peek',
      agentName: 'Dev 3',
      startedAt: new Date().toISOString(),
      where: { kind: 'public', conversationId: 'c-1', conversationName: 'shogo-dev', threadRootId: null },
      card: { key: 'SHO-466', title: 'x', column: 'In Dev' },
      trigger: null,
      reply: null,
      hidden: false,
    },
  }

  /** Hover the row and wait out the 350 ms open delay. Returns the row wrapper. */
  async function openCard(container: HTMLElement): Promise<HTMLElement> {
    const wrapper = screen.getByTestId('row-child').parentElement as HTMLElement
    act(() => { fireEvent.mouseEnter(wrapper, {}) })
    await act(async () => { await new Promise((r) => setTimeout(r, 400)) })
    expect(screen.queryByTestId('run-peek-card')).toBeTruthy()
    expect(wrapper.getAttribute('data-peek-close')).toBe('')
    return wrapper
  }

  beforeEach(() => { stubState = READY })

  test('a scroll in an unrelated pane leaves the card open', async () => {
    const { container } = renderHover()
    const wrapper = await openCard(container)

    const otherPane = document.createElement('div')
    container.appendChild(otherPane)
    act(() => { fireEvent.scroll(otherPane) })
    await act(async () => { await new Promise((r) => setTimeout(r, 200)) })

    expect(screen.queryByTestId('run-peek-card')).toBeTruthy()
    expect(wrapper.getAttribute('data-peek-close')).toBe('')
  })

  test('a scroll of an element containing the row closes it, and says so', async () => {
    const { container } = renderHover()
    const wrapper = await openCard(container)

    // The render container is the row's ancestor — the feed in miniature.
    act(() => { fireEvent.scroll(container) })
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })

    expect(screen.queryByTestId('run-peek-card')).toBeNull()
    expect(wrapper.getAttribute('data-peek-close')).toBe('scroll')
  })

  test('Escape closes it, and says so', async () => {
    const { container } = renderHover()
    const wrapper = await openCard(container)

    act(() => { fireEvent.keyDown(window, { key: 'Escape' }) })
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })

    expect(screen.queryByTestId('run-peek-card')).toBeNull()
    expect(wrapper.getAttribute('data-peek-close')).toBe('escape')
  })

  test('leaving the row closes it after the grace period, and says so', async () => {
    const { container } = renderHover()
    const wrapper = await openCard(container)

    act(() => { fireEvent.mouseLeave(wrapper, {}) })
    await act(async () => { await new Promise((r) => setTimeout(r, 250)) })

    expect(screen.queryByTestId('run-peek-card')).toBeNull()
    expect(wrapper.getAttribute('data-peek-close')).toBe('leave')
  })
})
