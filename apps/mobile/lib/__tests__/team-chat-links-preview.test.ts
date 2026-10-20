// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  chatLinkHref,
  chatLinkKey,
  chatLinksInText,
  linkPreviewOptOuts,
  MAX_LINK_PREVIEWS,
  parseChatLink,
  previewTargetsFor,
} from '../team-chat-links'

const hosts = new Set(['studio.shogo.ai'])

describe('parseChatLink', () => {
  test('reads a message link and a bare conversation link', () => {
    expect(parseChatLink('https://studio.shogo.ai/c/c1?msg=m1', hosts)).toEqual({
      kind: 'message',
      conversationId: 'c1',
      messageId: 'm1',
      threadRootId: null,
    })
    expect(parseChatLink('https://studio.shogo.ai/c/c1', hosts)).toEqual({
      kind: 'conversation',
      conversationId: 'c1',
      messageId: null,
      threadRootId: null,
    })
  })

  test('a thread reply keeps its root', () => {
    expect(parseChatLink('https://studio.shogo.ai/c/c1?msg=r1&thread=m1', hosts)).toEqual({
      kind: 'message',
      conversationId: 'c1',
      messageId: 'r1',
      threadRootId: 'm1',
    })
  })

  test('somebody else\u2019s host, or another route, is not ours', () => {
    expect(parseChatLink('https://evil.example/c/c1?msg=m1', hosts)).toBeNull()
    expect(parseChatLink('https://studio.shogo.ai/projects/p1?msg=m1', hosts)).toBeNull()
    expect(parseChatLink('not a url', hosts)).toBeNull()
  })

  test('a canvas link is a document, not a conversation preview', () => {
    expect(parseChatLink('https://studio.shogo.ai/c/c1?doc=1', hosts)).toBeNull()
    // …but a message link that also opens the canvas is still a message.
    expect(parseChatLink('https://studio.shogo.ai/c/c1?doc=1&msg=m1', hosts)?.messageId).toBe('m1')
  })
})

describe('chatLinksInText', () => {
  test('finds links inside prose, including markdown link syntax', () => {
    const text = [
      'have a look at https://studio.shogo.ai/c/c1?msg=m1 for context',
      'and [this one](https://studio.shogo.ai/c/c2) too',
    ].join('\n')
    expect(chatLinksInText(text, hosts).map(chatLinkKey)).toEqual([
      'message:c1:m1',
      'conversation:c2:',
    ])
  })

  test('drops trailing sentence punctuation', () => {
    const text = 'see https://studio.shogo.ai/c/c1?msg=m1.'
    expect(chatLinksInText(text, hosts)).toHaveLength(1)
    expect(chatLinksInText(text, hosts)[0]!.messageId).toBe('m1')
  })

  test('the same link twice is one target', () => {
    const href = 'https://studio.shogo.ai/c/c1?msg=m1'
    expect(chatLinksInText(`${href} and again ${href}`, hosts)).toHaveLength(1)
  })

  test('leaves ordinary text alone', () => {
    expect(chatLinksInText('no links here', hosts)).toEqual([])
    expect(chatLinksInText('https://example.com/whatever', hosts)).toEqual([])
  })
})

describe('previewTargetsFor', () => {
  const href = 'https://studio.shogo.ai/c/c1?msg=m1'

  test('previews our own links', () => {
    expect(previewTargetsFor(href, null, { hosts }).map(chatLinkKey)).toEqual(['message:c1:m1'])
  })

  test('a link the author declined a preview for is skipped', () => {
    const blocks = { linkPreviewsOff: [href] }
    expect(previewTargetsFor(href, blocks, { hosts })).toEqual([])
  })

  test('the opt-out matches the same link written on another origin', () => {
    // Stored when the sender was on the browser's own origin…
    const blocks = { linkPreviewsOff: ['https://app.local/c/c1?msg=m1'] }
    const written = 'https://studio.shogo.ai/c/c1?msg=m1'
    // …and read back on a build whose link base is the web app.
    expect(previewTargetsFor(written, blocks, { hosts: new Set(['studio.shogo.ai', 'app.local']) })).toEqual([])
  })

  test('an opt-out survives the sender and reader being on different origins', () => {
    // The sender wrote the link from a preview deployment; this reader is on the
    // app's own origin and has never heard of that host. The refusal must still
    // hold — a preview the author declined must not reappear somewhere else.
    const blocks = { linkPreviewsOff: ['https://some-preview-deploy.example/c/c1?msg=m1'] }
    const written = 'https://studio.shogo.ai/c/c1?msg=m1'
    expect(previewTargetsFor(written, blocks, { hosts })).toEqual([])
  })

  test('an opt-out that is not a link to anything is simply ignored', () => {
    const blocks = { linkPreviewsOff: ['https://example.com/not-a-chat-link'] }
    expect(previewTargetsFor(href, blocks, { hosts })).toHaveLength(1)
  })

  test('a message linking to itself gets no card', () => {
    expect(previewTargetsFor(href, null, { hosts, selfId: 'm1' })).toEqual([])
    expect(previewTargetsFor(href, null, { hosts, selfId: 'other' })).toHaveLength(1)
  })

  test('caps how many cards one message can render', () => {
    const text = Array.from({ length: MAX_LINK_PREVIEWS + 2 }, (_, i) => `https://studio.shogo.ai/c/c${i}`).join(' ')
    expect(previewTargetsFor(text, null, { hosts })).toHaveLength(MAX_LINK_PREVIEWS)
  })
})

describe('linkPreviewOptOuts', () => {
  test('only strings survive a malformed block', () => {
    expect(linkPreviewOptOuts({ linkPreviewsOff: ['a', 3, null, { x: 1 }] })).toEqual(['a'])
    expect(linkPreviewOptOuts(null)).toEqual([])
    expect(linkPreviewOptOuts({})).toEqual([])
    expect(linkPreviewOptOuts({ linkPreviewsOff: 'nope' })).toEqual([])
  })
})

describe('chatLinkHref', () => {
  test('rebuilds the canonical link for a target', () => {
    expect(chatLinkHref({ kind: 'message', conversationId: 'c1', messageId: 'm1', threadRootId: null }, 'https://studio.shogo.ai'))
      .toBe('https://studio.shogo.ai/c/c1?msg=m1')
    expect(chatLinkHref({ kind: 'conversation', conversationId: 'c1', messageId: null, threadRootId: null }, 'https://studio.shogo.ai'))
      .toBe('https://studio.shogo.ai/c/c1')
  })
})
