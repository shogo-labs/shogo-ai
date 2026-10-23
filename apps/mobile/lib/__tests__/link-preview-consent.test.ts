// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  chatLinksIn,
  isClosedConversation,
  needsLinkPreviewConsent,
  previewOptOutMatcher,
  resolveLinkPreviewOptOuts,
} from '../link-preview-consent'

const LINK = 'https://studio.shogo.ai/c/private-1?msg=m1'
const PUBLIC_LINK = 'https://studio.shogo.ai/c/general?msg=m2'
const HERE = 'here'

function linked(id: string, kind: string, name: string) {
  return { id, kind, name }
}

describe('needsLinkPreviewConsent', () => {
  test('asks for a closed conversation shared somewhere else', () => {
    expect(needsLinkPreviewConsent(linked('private-1', 'private', 'secret'), HERE)).toBe(true)
    expect(needsLinkPreviewConsent(linked('dm-1', 'dm', 'Ada'), HERE)).toBe(true)
    expect(needsLinkPreviewConsent(linked('gdm-1', 'group_dm', 'Ada, Bo'), HERE)).toBe(true)
  })

  test('does not ask for an open channel, or a closed one quoted into itself', () => {
    expect(needsLinkPreviewConsent(linked('general', 'public', 'general'), HERE)).toBe(false)
    expect(needsLinkPreviewConsent(linked(HERE, 'private', 'secret'), HERE)).toBe(false)
  })

  test('channels are closed; the activity feed is not', () => {
    expect(isClosedConversation('private')).toBe(true)
    expect(isClosedConversation('public')).toBe(false)
    expect(isClosedConversation('activity')).toBe(false)
  })
})

describe('chatLinksIn', () => {
  test('finds message links and bare conversation links, in prose and markdown', () => {
    const text = `look at ${LINK}\nand [this](https://studio.shogo.ai/c/c9) too`
    expect(chatLinksIn(text).map((l) => `${l.kind}:${l.conversationId}:${l.messageId ?? ''}`)).toEqual([
      'message:private-1:m1',
      'conversation:c9:',
    ])
  })

  test('drops trailing punctuation and de-duplicates', () => {
    expect(chatLinksIn(`see ${LINK}.`)).toHaveLength(1)
    expect(chatLinksIn(`${LINK} and ${LINK}`)).toHaveLength(1)
  })

  test('ignores everything that is not a chat link', () => {
    expect(chatLinksIn('nothing here')).toEqual([])
    expect(chatLinksIn('https://example.com/c/c1?msg=m1')).toEqual([])
  })
})

describe('resolveLinkPreviewOptOuts', () => {
  const never = async () => {
    throw new Error('must not be called')
  }

  test('a message with no chat links never asks', async () => {
    let asked = 0
    const out = await resolveLinkPreviewOptOuts('just talking, https://example.com/x', HERE, {
      resolve: never,
      ask: async () => {
        asked += 1
        return true
      },
    })
    expect(out).toEqual([])
    expect(asked).toBe(0)
  })

  test('a public channel never asks', async () => {
    let asked = 0
    const out = await resolveLinkPreviewOptOuts(PUBLIC_LINK, HERE, {
      resolve: async () => linked('general', 'public', 'general'),
      ask: async () => {
        asked += 1
        return true
      },
    })
    expect(out).toEqual([])
    expect(asked).toBe(0)
  })

  test('declining a closed link withholds exactly that URL', async () => {
    const out = await resolveLinkPreviewOptOuts(LINK, HERE, {
      resolve: async () => linked('private-1', 'private', 'secret-plans'),
      ask: async () => false,
    })
    expect(out).toEqual(['https://studio.shogo.ai/c/private-1?msg=m1'])
  })

  test('accepting shares the preview and withholds nothing', async () => {
    const out = await resolveLinkPreviewOptOuts(LINK, HERE, {
      resolve: async () => linked('private-1', 'private', 'secret-plans'),
      ask: async () => true,
    })
    expect(out).toEqual([])
  })

  test('the question names the conversations and is asked once', async () => {
    const names: string[][] = []
    const text = `${LINK} and https://studio.shogo.ai/c/private-2?msg=m3 and ${PUBLIC_LINK}`
    await resolveLinkPreviewOptOuts(text, HERE, {
      resolve: async (link) =>
        link.conversationId === 'general'
          ? linked('general', 'public', 'general')
          : linked(link.conversationId, 'private', link.conversationId === 'private-1' ? 'secret-plans' : 'hiring'),
      ask: async (asked) => {
        names.push(asked)
        return false
      },
    })
    expect(names).toEqual([['secret-plans', 'hiring']])
  })

  test('quoting a closed conversation into itself asks nothing', async () => {
    let asked = 0
    const out = await resolveLinkPreviewOptOuts(LINK, 'private-1', {
      resolve: async () => linked('private-1', 'private', 'secret-plans'),
      ask: async () => {
        asked += 1
        return false
      },
    })
    expect(out).toEqual([])
    expect(asked).toBe(0)
  })

  test('a link the sender cannot resolve asks nothing and withholds nothing', async () => {
    let asked = 0
    const out = await resolveLinkPreviewOptOuts(LINK, HERE, {
      resolve: async () => null,
      ask: async () => {
        asked += 1
        return false
      },
    })
    expect(out).toEqual([])
    expect(asked).toBe(0)
  })

  test('a failing lookup is best-effort, not fatal', async () => {
    const out = await resolveLinkPreviewOptOuts(LINK, HERE, {
      resolve: async () => {
        throw Object.assign(new Error('not found'), { status: 404 })
      },
      ask: never,
    })
    expect(out).toEqual([])
  })

  test('the same closed link twice is withheld once', async () => {
    const out = await resolveLinkPreviewOptOuts(`${LINK} again ${LINK}`, HERE, {
      resolve: async () => linked('private-1', 'private', 'secret-plans'),
      ask: async () => false,
    })
    expect(out).toHaveLength(1)
  })
})

describe('previewOptOutMatcher', () => {
  test('no refusal means no matcher at all', () => {
    expect(previewOptOutMatcher(null)).toBeUndefined()
    expect(previewOptOutMatcher({})).toBeUndefined()
    expect(previewOptOutMatcher({ linkPreviewsOff: [] })).toBeUndefined()
    expect(previewOptOutMatcher({ linkPreviewsOff: [42, null] })).toBeUndefined()
  })

  test('matches the same link, and only that link', () => {
    const match = previewOptOutMatcher({ linkPreviewsOff: [LINK] })!
    expect(match(LINK)).toBe(true)
    expect(match('https://studio.shogo.ai/c/private-1?msg=other')).toBe(false)
    expect(match('https://studio.shogo.ai/c/other?msg=m1')).toBe(false)
  })

  test('matches even when the sender wrote it on a different origin', () => {
    // The refusal was recorded from a preview deployment this reader has never
    // heard of; the identity is what counts, not the host.
    const match = previewOptOutMatcher({
      linkPreviewsOff: ['https://some-preview-deploy.example/c/private-1?msg=m1'],
    })!
    expect(match(LINK)).toBe(true)
  })

  test('a stored value that is not a chat link is ignored', () => {
    expect(previewOptOutMatcher({ linkPreviewsOff: ['https://example.com/hello'] })).toBeUndefined()
  })
})
