// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A message link pasted into a message is a reference, not a URL: it leaves
 * the body and becomes a quote. These check the rules that decide which links
 * count and what is left behind when they are taken out.
 */

import { describe, expect, test } from 'bun:test'
import { extractMessageQuotes } from '../message-quotes'

const HOSTS = new Set(['studio.shogo.ai'])

const link = (messageId: string, conversationId = 'conv-1', extra = '') =>
  `https://studio.shogo.ai/c/${conversationId}?msg=${messageId}${extra}`

describe('extracting message quotes', () => {
  test('a line that holds only the link leaves no body behind', () => {
    const { body, quotes } = extractMessageQuotes(link('m-1'), HOSTS)
    expect(body).toBe('')
    expect(quotes).toHaveLength(1)
    expect(quotes[0]!.target.messageId).toBe('m-1')
    expect(quotes[0]!.target.conversationId).toBe('conv-1')
  })

  test('a link inside a sentence is cut out and the sentence survives', () => {
    const { body, quotes } = extractMessageQuotes(`see this ${link('m-2')} before you ship`, HOSTS)
    expect(quotes).toHaveLength(1)
    expect(body).toBe('see this before you ship')
  })

  test('a markdown link goes with its label', () => {
    const { body, quotes } = extractMessageQuotes(`[the plan](${link('m-3')}) is approved`, HOSTS)
    expect(quotes).toHaveLength(1)
    expect(body).toBe('is approved')
  })

  test('the thread a reply belongs to travels with the quote', () => {
    const { quotes } = extractMessageQuotes(link('m-4', 'conv-9', '&thread=root-9'), HOSTS)
    expect(quotes[0]!.target).toEqual({ conversationId: 'conv-9', messageId: 'm-4', threadRootId: 'root-9' })
  })

  test('a link to someone else’s app is left alone', () => {
    const text = 'https://example.com/c/conv-1?msg=m-1'
    const { body, quotes } = extractMessageQuotes(text, HOSTS)
    expect(quotes).toEqual([])
    expect(body).toBe(text)
  })

  test('a link in a fenced code block is documentation, not a reference', () => {
    const text = ['```', link('m-5'), '```'].join('\n')
    const { body, quotes } = extractMessageQuotes(text, HOSTS)
    expect(quotes).toEqual([])
    expect(body).toBe(text)
  })

  test('a link in inline code is left as written', () => {
    const text = `wire it as \`${link('m-6')}\``
    const { body, quotes } = extractMessageQuotes(text, HOSTS)
    expect(quotes).toEqual([])
    expect(body).toBe(text)
  })

  test('the same message linked twice is one quote, and both copies go', () => {
    const text = `${link('m-7')}\n\nand again ${link('m-7')}`
    const { body, quotes } = extractMessageQuotes(text, HOSTS)
    expect(quotes).toHaveLength(1)
    expect(body).toBe('and again')
  })

  test('a sentence-final period is not part of the URL', () => {
    const { quotes, body } = extractMessageQuotes(`read ${link('m-8')}.`, HOSTS)
    expect(quotes).toHaveLength(1)
    expect(quotes[0]!.href.endsWith('m-8')).toBe(true)
    expect(body).toBe('read.')
  })

  test('two different messages are two quotes, in order', () => {
    const { quotes } = extractMessageQuotes(`${link('m-a')}\n${link('m-b')}`, HOSTS)
    expect(quotes.map((q) => q.target.messageId)).toEqual(['m-a', 'm-b'])
  })

  test('a body with no links is returned unchanged', () => {
    const text = '# Notes\n\n- one\n- two'
    const { body, quotes } = extractMessageQuotes(text, HOSTS)
    expect(quotes).toEqual([])
    expect(body).toBe(text)
  })
})
