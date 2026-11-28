// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A pasted markdown block is a `data:` URL attachment, and Android cannot open
 * one: `Linking.openURL('data:text/markdown;base64,…')` throws
 * `Could not open URL 'data:…'` (SHOGO-ANDROID-1D, SHO-436). Tapping the chip
 * must show the text in the app's own viewer and never reach the OS opener.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import React from 'react'
import { createReactNativeMock } from '../../../../test/react-native-mock'
import * as lucideStub from '../../../../test/stubs/lucide-react-native'

const opened: string[] = []
/** Every URL the component asked the network for. */
const fetched: string[] = []
const realFetch = globalThis.fetch

mock.module('lucide-react-native', () => lucideStub)
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))
mock.module('react-native-marked', () => ({
  default: (props: { value: string }) => React.createElement('div', null, props.value),
  Renderer: class Renderer {},
}))
mock.module('nativewind', () => ({
  useColorScheme: () => ({ colorScheme: 'light' }),
  cssInterop: () => {},
  remapProps: () => {},
  useUnstableNativeVariable: () => undefined,
  vars: () => ({}),
}))
// The mention chip navigates; this test only needs the text it renders.
mock.module('expo-router', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  router: { push: () => {}, replace: () => {}, back: () => {} },
  Link: ({ children }: { children: React.ReactNode }) => React.createElement('span', null, children),
}))
mock.module('../../../../lib/agent-image-source', () => ({
  useAgentImageSource: (uri: string | null) => (uri ? { uri } : null),
}))
mock.module('../../../../lib/native-phone-layout', () => ({
  usePhoneLayout: () => false,
  usePhoneLayoutOverride: () => null,
}))
mock.module('../../ChatMentionChip', () => ({
  ChatMentionText: ({ text, selectable }: { text: string; selectable?: boolean }) =>
    React.createElement('span', { 'data-selectable': String(selectable) }, text),
  chatMentionSince: () => null,
}))
mock.module('../../../layout/MobileWorkspaceChromeContext', () => ({
  useMobileWorkspaceChrome: () => false,
}))
mock.module('../../../../contexts/theme', () => ({ useResolvedTheme: () => 'light' }))
mock.module('../../FileTypeIcon', () => ({ FileTypeIcon: () => null }))
mock.module('../../MarkdownMediaNative', () => ({ MarkdownMediaNative: () => null }))
mock.module('../../share-file-context', () => ({ useShareFileOpener: () => null }))
// The viewer is a modal with its own fetch/scroll machinery; the assertion is
// that the decoded text reaches it.
mock.module('../../FileViewerModal', () => ({
  FileViewerModal: ({ visible, content }: { visible: boolean; content: string }) =>
    visible ? React.createElement('div', { 'data-testid': 'file-viewer' }, content) : null,
}))

mock.module('react-native', () =>
  createReactNativeMock({
    useWindowDimensions: () => ({ width: 900, height: 700, scale: 1, fontScale: 1 }),
    Linking: {
      openURL: async (url: string) => {
        opened.push(url)
      },
      canOpenURL: async () => false,
      addEventListener: () => ({ remove: () => {} }),
    },
    Pressable: ({
      children,
      onPress,
      disabled,
      testID,
      accessibilityLabel,
      ...rest
    }: Record<string, unknown>) =>
      React.createElement(
        'div',
        {
          ...rest,
          'aria-label': accessibilityLabel as string,
          'data-rn-shim': testID as string,
          onClick: disabled ? undefined : (onPress as () => void),
        },
        children as React.ReactNode,
      ),
  } as never),
)

const { MessageContent } = await import('../MessageContent')
const { Platform } = await import('react-native')

beforeEach(() => {
  globalThis.fetch = (async (input: never, init?: never) => {
    fetched.push(String(input))
    return realFetch(input, init)
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
  opened.length = 0
  fetched.length = 0
})

const MARKDOWN = '# Pasted notes\n\n- first\n- second'
const DATA_URL = `data:text/markdown;base64,${Buffer.from(MARKDOWN, 'utf8').toString('base64')}`

function renderMessage() {
  return render(
    <MessageContent
      message={
        {
          id: 'm-1',
          role: 'user',
          parts: [
            { type: 'text', text: 'here are my notes' },
            { type: 'file', url: DATA_URL, mediaType: 'text/markdown', name: 'Pasted markdown.md' },
          ],
        } as never
      }
    />,
  ).container
}

describe('a markdown attachment carried as a data: URL', () => {
  test('opens in the app viewer, not the OS opener', () => {
    const container = renderMessage()

    const chip = container.querySelector('[aria-label^="File attachment"]') as HTMLElement
    expect(chip).not.toBeNull()
    fireEvent.click(chip)

    const viewer = container.querySelector('[data-testid="file-viewer"]')
    expect(viewer?.textContent).toContain('# Pasted notes')
    // The bytes are in the message already: no fetch, and nothing handed to a
    // URL opener that Android cannot serve.
    expect(fetched).toEqual([])
    expect(opened).toEqual([])
  })
})

describe('a native user bubble', () => {
  test('keeps its message text selectable', () => {
    const originalPlatform = Platform.OS
    Platform.OS = 'ios'
    try {
      const { container } = render(
        <MessageContent
          variant="userBubble"
          message={{ id: 'm-selectable', role: 'user', parts: [{ type: 'text', text: 'Select me' }] } as never}
        />,
      )

      expect(container.querySelector('[data-selectable="true"]')?.textContent).toBe('Select me')
    } finally {
      Platform.OS = originalPlatform
    }
  })
})
