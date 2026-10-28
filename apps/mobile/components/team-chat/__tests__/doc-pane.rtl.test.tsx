// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

const pressable = ({ accessibilityLabel, children, onPress, disabled }: any) =>
  createElement(
    'div',
    { role: 'button', 'aria-label': accessibilityLabel, onClick: disabled ? undefined : onPress },
    children,
  )

mock.module('react-native', () =>
  createReactNativeMock({
    Pressable: pressable,
  } as any),
)

mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }))

const routerPush = mock((_args: unknown) => {})
mock.module('expo-router', () => ({ useRouter: () => ({ push: routerPush, setParams: () => {} }) }))
mock.module('expo-clipboard', () => ({ setStringAsync: async () => true }))

/** Captures what DocPane hands the renderer, so the mention wiring is observable. */
const markdownProps: Array<Record<string, unknown>> = []
mock.module('../../chat/MarkdownText', () => ({
  MarkdownText: (props: { children: ReactNode } & Record<string, unknown>) => {
    markdownProps.push(props)
    return createElement('div', null, props.children)
  },
}))

const edit = mock((_patch: { content?: string; title?: string }) => {})
const flush = mock(async () => {})
const resolve = mock(() => {})
const setLocked = mock(() => {})
const restore = mock(() => {})

let onOpenProfile: ((userId: string) => void) | undefined

mock.module('../../../hooks/useConversationDoc', () => ({
  useConversationDoc: () => ({
    state: {
      loaded: true,
      server: {
        title: 'DevOps Schedule',
        content: 'Intro',
        version: 3,
        locked: false,
        updatedBy: null,
        updatedAt: new Date().toISOString(),
      },
      draft: null,
      saving: null,
      conflict: null,
      error: null,
      canEdit: true,
      canManage: false,
    },
    doc: { title: 'DevOps Schedule', content: 'Intro' },
    dirty: false,
    edit,
    flush,
    resolve,
    setLocked,
    restore,
  }),
}))

const { DocPane } = await import('../DocPane')

afterEach(cleanup)
beforeEach(() => {
  edit.mockClear()
  markdownProps.length = 0
  onOpenProfile = undefined
})

const conversation = { id: 'c-1', archivedAt: null } as any
const mentionables = {
  people: [{ id: 'p1', name: 'Priya' }],
  agents: [],
  groups: [],
} as any

const renderPane = (extra: Record<string, unknown> = {}) =>
  render(
    <DocPane
      conversation={conversation}
      workspaceId="ws-1"
      mentionables={mentionables}
      onClose={() => {}}
      {...(onOpenProfile ? { onOpenProfile } : {})}
      {...extra}
    />,
  )

const enterEditMode = () => fireEvent.click(screen.getByLabelText('Edit doc'))

describe('DocPane formatting toolbar', () => {
  test('offers heading 3, table and divider', () => {
    renderPane()
    enterEditMode()
    expect(screen.getByLabelText('Minor heading')).toBeTruthy()
    expect(screen.getByLabelText('Table')).toBeTruthy()
    expect(screen.getByLabelText('Divider')).toBeTruthy()
  })

  test('Divider inserts a rule', () => {
    renderPane()
    enterEditMode()
    fireEvent.click(screen.getByLabelText('Divider'))
    expect(edit).toHaveBeenCalledTimes(1)
    expect(edit.mock.calls[0][0].content).toContain('---')
  })

  test('Table inserts the skeleton', () => {
    renderPane()
    enterEditMode()
    fireEvent.click(screen.getByLabelText('Table'))
    const content = edit.mock.calls[0][0].content ?? ''
    expect(content).toContain('| Column | Column |')
    expect(content).toContain('| --- | --- |')
  })
})

describe('DocPane mentions', () => {
  test('picking a person inserts a real wire token, not dead text', () => {
    renderPane()
    enterEditMode()
    fireEvent.click(screen.getByLabelText('Mention'))
    fireEvent.click(screen.getByText('Priya'))
    const content = edit.mock.calls[0][0].content ?? ''
    // A real token, which every renderer turns into a highlighted, pressable
    // mention. The old behaviour wrote `@Priya `, which no renderer can link.
    expect(content).toContain('<@u:p1> ')
    expect(content).not.toContain('@Priya ')
  })

  test('a mention opens the person profile through the host', () => {
    onOpenProfile = mock((_userId: string) => {})
    renderPane()
    const withHandler = markdownProps.filter((p) => typeof p.onMentionPress === 'function')
    expect(withHandler.length).toBeGreaterThan(0)
    ;(withHandler[0].onMentionPress as any)({ kind: 'u', id: 'p1' })
    expect(onOpenProfile).toHaveBeenCalledWith('p1')
  })

  test('an agent mention opens the agent profile page', () => {
    onOpenProfile = mock((_userId: string) => {})
    renderPane()
    const withHandler = markdownProps.filter((p) => typeof p.onMentionPress === 'function')
    routerPush.mockClear()
    ;(withHandler[0].onMentionPress as any)({ kind: 'a', id: 'p:proj-1' })
    expect(routerPush).toHaveBeenCalledTimes(1)
    expect((routerPush.mock.calls[0][0] as any).pathname).toBe('/(app)/agents/[key]')
  })

  test('a host with no profile leaves mentions as plain highlights', () => {
    renderPane()
    expect(markdownProps.every((p) => p.onMentionPress === undefined)).toBe(true)
  })
})
