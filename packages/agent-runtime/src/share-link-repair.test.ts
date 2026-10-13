// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect } from 'bun:test'
import { extractShareLinkTokens, repairShareLinks } from './share-link-repair'
import { LocalhostLinkRewriter } from './preview-link-rewrite'

// Real token from a staging run: the model quoted it with `Zjgx` -> `Zj0x`
// inside the signed payload, so the HMAC failed and the link 404'd.
const MINTED =
  'eyJ0eXAiOiJzaGFyZWQtZmlsZSIsInByb2plY3RJZCI6IjlmMjJjZjgxLWUzYzItNGI4ZC1iYWEwLTVhMGY4ZjkzMWQ4NCIsIndvcmtzcGFjZUlkIjoiMjk1YjRjODktYTNmZi00ZjE0LThhY2EtNjlmNzRiZjhiZGZkIiwicGF0aCI6IjlmMjJjZjgxLWUzYzItNGI4ZC1iYWEwLTVhMGY4ZjkzMWQ4NC9hcnRpZmFjdC1kZWxpdmVyeS10ZXN0LnBkZiIsImV4cCI6MTc5MjQwMDUzMSwiaWF0IjoxNzkxNzk1NzMxfQ.Dr624gnAWGy5pzxxNBFzpsXHDuOHl6qbbRRR-ovG144'
const TYPO = MINTED.replace('cGF0aCI6IjlmMjJjZjgx', 'cGF0aCI6IjlmMjJjZj0x')
const OTHER =
  'eyJ0eXAiOiJzaGFyZWQtZmlsZSIsInByb2plY3RJZCI6ImFhYWFhYWFhLWJiYmItY2NjYy1kZGRkLWVlZWVlZWVlZWVlZSIsIndvcmtzcGFjZUlkIjoiMTExMTExMTEtMjIyMi0zMzMzLTQ0NDQtNTU1NTU1NTU1NTU1IiwicGF0aCI6InJlcG9ydC5wZGYiLCJleHAiOjE3OTI0MDA1MzEsImlhdCI6MTc5MTc5NTczMX0.q2Xb8tY1kLm9Pz0aRcVwE4uJ7nHs3dGf6iOp5QeTy1A'
const ORIGIN = 'https://studio.staging.shogo.ai'
const url = (token: string) => `${ORIGIN}/api/f/${token}`

describe('extractShareLinkTokens', () => {
  test('pulls the token out of minted URLs, including inside a JSON tool result', () => {
    const toolResult = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ ok: true, url: url(MINTED) }) }] })
    expect([...extractShareLinkTokens([toolResult])]).toEqual([MINTED])
  })
})

describe('repairShareLinks', () => {
  const minted = new Set([MINTED])

  test('repairs a one-character typo in the quoted token', () => {
    expect(TYPO).not.toBe(MINTED)
    expect(repairShareLinks(`**Download link:**\n${url(TYPO)}\nExpires in 7 days.`, minted)).toBe(
      `**Download link:**\n${url(MINTED)}\nExpires in 7 days.`,
    )
  })

  test('repairs dropped and inserted characters', () => {
    const dropped = MINTED.slice(0, 100) + MINTED.slice(101)
    const inserted = MINTED.slice(0, 200) + 'x' + MINTED.slice(200)
    expect(repairShareLinks(url(dropped), minted)).toBe(url(MINTED))
    expect(repairShareLinks(url(inserted), minted)).toBe(url(MINTED))
  })

  test('keeps sentence punctuation and markdown link syntax around the URL', () => {
    expect(repairShareLinks(`Here: ${url(TYPO)}.`, minted)).toBe(`Here: ${url(MINTED)}.`)
    expect(repairShareLinks(`[download](${url(TYPO)})`, minted)).toBe(`[download](${url(MINTED)})`)
  })

  test('leaves exact tokens, unrelated tokens and plain text untouched', () => {
    expect(repairShareLinks(url(MINTED), minted)).toBe(url(MINTED))
    expect(repairShareLinks(url(OTHER), minted)).toBe(url(OTHER))
    expect(repairShareLinks('see /f/abc for details', minted)).toBe('see /f/abc for details')
    expect(repairShareLinks(url(TYPO), new Set())).toBe(url(TYPO))
  })

  test('picks the right token when several files were shared', () => {
    expect(repairShareLinks(url(TYPO), new Set([OTHER, MINTED]))).toBe(url(MINTED))
  })
})

describe('LocalhostLinkRewriter share-link repair', () => {
  test('repairs a token split across streamed deltas, with no public preview URL', () => {
    const tokens = new Set<string>()
    const rewriter = new LocalhostLinkRewriter('', tokens)
    expect(rewriter.push('Before the tool ran ')).toBe('Before the tool ran ')

    tokens.add(MINTED)
    const text = `Download link: ${url(TYPO)} (expires in 7 days)`
    let out = ''
    for (let i = 0; i < text.length; i += 17) out += rewriter.push(text.slice(i, i + 17))
    out += rewriter.flush()
    expect(out).toBe(`Download link: ${url(MINTED)} (expires in 7 days)`)
  })

  test('applies localhost rewriting and share-link repair together', () => {
    const rewriter = new LocalhostLinkRewriter('https://demo.preview.shogo.ai', new Set([MINTED]))
    const out = rewriter.push(`app http://localhost:3000/x file ${url(TYPO)} `) + rewriter.flush()
    expect(out).toBe(`app https://demo.preview.shogo.ai/x file ${url(MINTED)} `)
  })
})
