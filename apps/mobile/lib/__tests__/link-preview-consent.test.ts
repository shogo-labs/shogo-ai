// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { needsLinkPreviewConsent, resolveLinkPreviewOptOuts } from '../link-preview-consent'
import { chatLinkKey, parseChatLink } from '../team-chat-links'

/**
 * The withheld URL is built from `linkBase()`, which is the page origin in a
 * browser and the web app everywhere else — so assert the *identity* it encodes
 * rather than a host that only holds on one of the two.
 */
function keysOf(urls: string[]) {
  return urls.map((url) => {
    const target = parseChatLink(url)
    if (!target) throw new Error(`not one of our links: ${url}`)
    return chatLinkKey(target)
  })
}

const LINK = 'https://studio.shogo.ai/c/private-1?msg=m1'
const PUBLIC_LINK = 'https://studio.shogo.ai/c/general?msg=m2'
const HERE = 'here'

function conversation(id: string, priv: boolean, name: string) {
  return { conversation: { id, name, kind: priv ? 'private' : 'public', topic: null, private: priv } }
}

describe('needsLinkPreviewConsent', () => {
  test('asks only when a private conversation is shared somewhere else', () => {
    expect(needsLinkPreviewConsent({ id: 'private-1', private: true }, HERE)).toBe(true)
    expect(needsLinkPreviewConsent({ id: HERE, private: true }, HERE)).toBe(false)
    expect(needsLinkPreviewConsent({ id: 'general', private: false }, HERE)).toBe(false)
  })
})

describe('resolveLinkPreviewOptOuts', () => {
  test('a message with no chat links never asks', async () => {
    let asked = 0
    const out = await resolveLinkPreviewOptOuts('just talking, https://example.com/x', HERE, {
      loadConversation: async () => conversation('x', true, 'x'),
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
      loadConversation: async () => conversation('general', false, 'general'),
      ask: async () => {
        asked += 1
        return true
      },
    })
    expect(out).toEqual([])
    expect(asked).toBe(0)
  })

  test('declining a private link withholds exactly that URL', async () => {
    const out = await resolveLinkPreviewOptOuts(LINK, HERE, {
      loadConversation: async () => conversation('private-1', true, 'secret-plans'),
      ask: async () => false,
    })
    expect(keysOf(out)).toEqual(['message:private-1:m1'])
  })

  test('accepting shares the preview and withholds nothing', async () => {
    const out = await resolveLinkPreviewOptOuts(LINK, HERE, {
      loadConversation: async () => conversation('private-1', true, 'secret-plans'),
      ask: async () => true,
    })
    expect(out).toEqual([])
  })

  test('the question names the channels and is asked once', async () => {
    const names: string[][] = []
    const text = `${LINK} and https://studio.shogo.ai/c/private-2?msg=m3 and ${PUBLIC_LINK}`
    await resolveLinkPreviewOptOuts(text, HERE, {
      loadConversation: async (id) =>
        id === 'general' ? conversation('general', false, 'general') : conversation(id, true, id === 'private-1' ? 'secret-plans' : 'hiring'),
      ask: async (asked) => {
        names.push(asked)
        return false
      },
    })
    expect(names).toEqual([['secret-plans', 'hiring']])
  })

  test('quoting a private channel into itself asks nothing', async () => {
    let asked = 0
    const out = await resolveLinkPreviewOptOuts(LINK, 'private-1', {
      loadConversation: async () => conversation('private-1', true, 'secret-plans'),
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
      loadConversation: async () => {
        throw Object.assign(new Error('not found'), { status: 404 })
      },
      ask: async () => {
        asked += 1
        return false
      },
    })
    expect(out).toEqual([])
    expect(asked).toBe(0)
  })

  test('the same private link twice is withheld once', async () => {
    const out = await resolveLinkPreviewOptOuts(`${LINK} again ${LINK}`, HERE, {
      loadConversation: async () => conversation('private-1', true, 'secret-plans'),
      ask: async () => false,
    })
    expect(keysOf(out)).toEqual(['message:private-1:m1'])
  })
})
