// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A pasted markdown attachment renders as markdown.
 *
 * The bug: a paste over the long-text threshold is uploaded as
 * `Pasted markdown.md` and every non-media attachment went to
 * `FileAttachmentCard`, which shows six flattened plain-text lines and needs a
 * tap to read anything. The card people paste a plan into must be the one that
 * renders it.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, forwardRef, type ReactNode } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

const Host = forwardRef<HTMLElement, Record<string, unknown>>(function Host(
  { accessibilityLabel, children, disabled, onPress, testID, ...props },
  ref,
) {
  return createElement(
    'button',
    {
      ...props,
      'aria-label': accessibilityLabel,
      'data-testid': testID,
      disabled,
      onClick: disabled ? undefined : onPress,
      ref,
    },
    children as ReactNode,
  )
})
const TextHost = forwardRef<HTMLElement, Record<string, unknown>>(function TextHost(
  { children, testID, numberOfLines: _n, ...props },
  ref,
) {
  return createElement('span', { ...props, 'data-testid': testID, ref }, children as ReactNode)
})
const ViewHost = forwardRef<HTMLElement, Record<string, unknown>>(function ViewHost(
  { children, testID, ...props },
  ref,
) {
  return createElement('div', { ...props, 'data-testid': testID, ref }, children as ReactNode)
})

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: Record<string, unknown>) => s.web ?? s.default },
    Pressable: Host,
    Text: TextHost,
    View: ViewHost,
  } as any),
)
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(' ') }))
// The fade is decoration; the clamp is what the test asserts.
mock.module('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: any) => createElement('div', { 'data-fade': 'true' }, children),
}))
mock.module('../../../lib/attachment-download', () => ({
  attachmentDownloadUrl: (url: string) => `${url}&dl=1`,
  downloadAttachment: async () => {},
}))

/** What the raw text route answers; each test sets it. */
let fileTextImpl: (id: string, opts: { offset?: number; limit?: number; raw?: boolean }) => Promise<any>
const calls: Array<{ id: string; opts: { offset?: number; raw?: boolean } }> = []

mock.module('../../../lib/team-chat-api', () => ({
  absoluteApiUrl: (url: string) => url,
  teamChatApi: () => ({
    fileText: (id: string, opts: any) => {
      calls.push({ id, opts })
      return fileTextImpl(id, opts)
    },
  }),
}))

const { MarkdownAttachmentBody, PastedMarkdownCard } = await import('../MarkdownAttachmentBody')
const { isPastedMarkdownAttachment, pastedEntryToAttachment, analyzeContent } = await import(
  '../../chat/long-text-utils'
)

const PLAN = ['# Q4 plan', '', 'Ship the **billing** rewrite first.', '', '- invoices', '- dunning'].join('\n')

function page(text: string, extra: Record<string, unknown> = {}) {
  return {
    fileId: 'att',
    name: 'Pasted markdown.md',
    mimeType: 'text/markdown',
    text,
    offset: 0,
    totalChars: text.length,
    nextOffset: null,
    ...extra,
  }
}

beforeEach(() => {
  calls.length = 0
  fileTextImpl = async () => page(PLAN)
})
afterEach(cleanup)

describe('MarkdownAttachmentBody', () => {
  test('renders the pasted plan as markdown: a heading, bold and a list', async () => {
    const { container } = render(<MarkdownAttachmentBody attachmentId="att-markdown" />)

    await waitFor(() => expect(container.querySelector('[data-streamdown="heading-1"]')).toBeTruthy())
    expect(container.querySelector('[data-streamdown="heading-1"]')!.textContent).toBe('Q4 plan')
    expect(container.querySelector('[data-streamdown="strong"]')!.textContent).toBe('billing')
    expect(container.querySelectorAll('[data-streamdown="list-item"]').length).toBe(2)
    // The plain sample is replaced, not stacked under the markdown.
    expect(screen.queryByTestId('attachment-preview-text')).toBeNull()
    // Read as written: the tidied search text would glue these together.
    expect(calls[0]?.opts).toMatchObject({ raw: true, offset: 0 })
  })

  test('paints the plain preview while the body is in flight, then the markdown', async () => {
    let release: (value: any) => void = () => {}
    fileTextImpl = () => new Promise((res) => (release = res))
    const preview = { kind: 'text', lines: ['# Q4 plan', '', 'Ship the **billing** rewrite first.'] }

    render(<MarkdownAttachmentBody attachmentId="att-inflight" preview={preview as any} />)
    expect(screen.getByTestId('attachment-preview-text').textContent).toContain('# Q4 plan')

    release(page(PLAN))
    await waitFor(() => expect(screen.getByTestId('pasted-markdown-body')).toBeTruthy())
    expect(screen.queryByTestId('attachment-preview-text')).toBeNull()
  })

  test('a failed read leaves the plain sample and raises nothing', async () => {
    fileTextImpl = async () => {
      throw new Error('HTTP 404')
    }
    const preview = { kind: 'text', lines: ['# Q4 plan', '', 'Ship it.'] }

    render(<MarkdownAttachmentBody attachmentId="att-failed" preview={preview as any} />)

    await waitFor(() => expect(screen.getByTestId('attachment-preview-text')).toBeTruthy())
    expect(screen.getByTestId('attachment-preview-text').textContent).toContain('Ship it.')
    expect(screen.queryByTestId('pasted-markdown-body')).toBeNull()
  })

  test('a body with no text (text: null) keeps the plain sample too', async () => {
    fileTextImpl = async () => page(null as unknown as string, { totalChars: 0 })

    render(
      <MarkdownAttachmentBody attachmentId="att-null" preview={{ kind: 'text', lines: ['nothing to render'] } as any} />,
    )

    await waitFor(() => expect(screen.getByTestId('attachment-preview-text')).toBeTruthy())
  })

  test('a long body clamps and expands in place, paging the rest', async () => {
    const first = ['# Long plan', '', ...Array.from({ length: 40 }, (_, i) => `- step ${i + 1}`)].join('\n')
    const second = '\n\n## Second page\n\nThe rest of the plan.'
    fileTextImpl = async (_id, opts) =>
      opts.offset
        ? page(second, { offset: opts.offset, nextOffset: null })
        : page(first, { nextOffset: first.length })

    const { container } = render(<MarkdownAttachmentBody attachmentId="att-long" />)

    await waitFor(() => expect(screen.getByTestId('pasted-markdown-content')).toBeTruthy())
    const toggle = screen.getByTestId('pasted-markdown-toggle')
    expect(toggle.textContent).toBe('Show more')
    expect(container.querySelector('[data-streamdown="heading-2"]')).toBeNull()

    fireEvent.click(toggle)

    await waitFor(() => expect(screen.getByTestId('pasted-markdown-toggle').textContent).toBe('Show less'))
    await waitFor(() =>
      expect(container.querySelector('[data-streamdown="heading-2"]')?.textContent).toBe('Second page'),
    )
    expect(calls.some((c) => c.opts.offset === first.length)).toBe(true)
  })

  test('a short body has no Show more and no second read', async () => {
    const { container } = render(<MarkdownAttachmentBody attachmentId="att-short" />)

    await waitFor(() => expect(container.querySelector('[data-streamdown="heading-1"]')).toBeTruthy())
    expect(screen.queryByTestId('pasted-markdown-toggle')).toBeNull()
    expect(calls.length).toBe(1)
  })
})

describe('PastedMarkdownCard', () => {
  test('shows the file header and opens the whole document', async () => {
    const opened: number[] = []
    render(
      <PastedMarkdownCard
        attachmentId="att-card"
        name="Pasted markdown.md"
        mimeType="text/markdown"
        size={2048}
        url="/api/conversation-files/att-card?t=x"
        onOpen={() => opened.push(1)}
      />,
    )

    expect(screen.getByTestId('pasted-markdown-card').textContent).toContain('Pasted markdown.md')
    expect(screen.getByTestId('pasted-markdown-card').textContent).toContain('2.0 KB')

    await waitFor(() => expect(screen.getByTestId('pasted-markdown-body')).toBeTruthy())
    fireEvent.click(screen.getByTestId('pasted-markdown-open'))
    expect(opened.length).toBe(1)
  })
})

describe('isPastedMarkdownAttachment', () => {
  const entry = (content: string) => ({
    id: '1',
    content,
    info: { ...analyzeContent(content), kind: 'markdown' as const },
  })

  test('recognises exactly what the paste builder produces, numbering included', () => {
    for (const index of [0, 1, 4]) {
      const built = pastedEntryToAttachment(entry('# Hi\n\n- one'), index)
      expect(isPastedMarkdownAttachment(built.name, built.type)).toBe(true)
    }
  })

  test('leaves other pastes and ordinary uploads alone', () => {
    expect(isPastedMarkdownAttachment('Pasted code.txt', 'text/plain')).toBe(false)
    expect(isPastedMarkdownAttachment('Pasted json.json', 'application/json')).toBe(false)
    expect(isPastedMarkdownAttachment('Pasted markdown.md', 'text/plain')).toBe(false)
    expect(isPastedMarkdownAttachment('q4-plan.md', 'text/markdown')).toBe(false)
    expect(isPastedMarkdownAttachment('notes.md')).toBe(false)
    expect(isPastedMarkdownAttachment(null, 'text/markdown')).toBe(false)
  })
})
