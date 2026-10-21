// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A link whose author declined a preview is the one link that stays in the body.
 *
 * Taking it out and rendering nothing would delete the link from the message
 * entirely — the reader would lose the ability to open it at all. So a refusal
 * means "no quote card", never "no link".
 */

import { describe, expect, test } from 'bun:test'
import { extractMessageQuotes } from '../message-quotes'

const HOSTS = new Set(['studio.shogo.ai'])
const LINK = 'https://studio.shogo.ai/c/c1?msg=m1'

describe('extractMessageQuotes with a refusal', () => {
  test('without a refusal the link becomes a quote, as before', () => {
    const { body, quotes } = extractMessageQuotes(`see ${LINK} please`, HOSTS)
    expect(quotes).toHaveLength(1)
    expect(body).toBe('see please')
  })

  test('a refused link stays in the body and quotes nothing', () => {
    const { body, quotes } = extractMessageQuotes(`see ${LINK} please`, HOSTS, { skip: () => true })
    expect(quotes).toEqual([])
    // The URL is still there, verbatim — the link still works for anyone who can
    // open it, and the message never looks like content was removed.
    expect(body).toBe(`see ${LINK} please`)
  })

  test('a refusal is per link: the rest still quote', () => {
    const other = 'https://studio.shogo.ai/c/c2?msg=m2'
    const { body, quotes } = extractMessageQuotes(`a ${LINK} b ${other} c`, HOSTS, {
      skip: (href) => href === LINK,
    })
    expect(quotes).toHaveLength(1)
    expect(quotes[0]!.href).toBe(other)
    expect(body).toContain(LINK)
    expect(body).not.toContain(other)
  })

  test('a refused link inside a markdown link keeps its label too', () => {
    const { body, quotes } = extractMessageQuotes(`[the thread](${LINK})`, HOSTS, { skip: () => true })
    expect(quotes).toEqual([])
    expect(body).toBe(`[the thread](${LINK})`)
  })

  test('a skip that matches nothing changes nothing', () => {
    const skipped = extractMessageQuotes(`see ${LINK}`, HOSTS, { skip: () => false })
    expect(skipped.quotes).toHaveLength(1)
    expect(skipped.body).toBe('see')
  })
})
