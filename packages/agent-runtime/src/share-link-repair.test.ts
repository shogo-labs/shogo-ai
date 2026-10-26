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

// SHO-172: a `share_file` result relayed through `project_call` reached the
// workspace agent as a string it re-typed with `"workspaceId"` ->
// `"wworkspaceId"`. The extra JSON byte shifts base64 alignment, so every
// character after it differs while the 43-char signature is copied exactly.
const b64url = (value: string) => Buffer.from(value, 'utf8').toString('base64url')
const RELAY_PAYLOAD = JSON.stringify({
  typ: 'shared-file',
  projectId: 'd3cce05d-5a1e-4c2b-9f30-6f1a2b3c4d5e',
  workspaceId: '0599aa18-8e7d-4f6a-9b21-3c4d5e6f7a8b',
  path: 'public/takes/2026-10-24-A.mp4',
  exp: 1792400531,
  iat: 1791795731,
})
const RELAY_SIG = 'Rk7mQ2xT9vLp0aWz4NbCy6Hs8EdF1gJu3Kt5MoPq7Sw'
const RELAY_MINTED = `${b64url(RELAY_PAYLOAD)}.${RELAY_SIG}`
const RELAY_RETYPED = `${b64url(RELAY_PAYLOAD.replace('"workspaceId"', '"wworkspaceId"'))}.${RELAY_SIG}`
const RELAY_TRUNCATED = `${b64url(RELAY_PAYLOAD.replace('"public/takes', '"publc/takes'))}.${RELAY_SIG}`

/** Characters that sit at the same index in both strings. */
function samePlaceCount(a: string, b: string): number {
  return [...a].filter((ch, i) => ch === b[i]).length
}

describe('share-link repair by signature (SHO-172)', () => {
  test('repairs a re-encoded payload that only the signature can identify', () => {
    // No edit-distance budget can reach this: a one-character JSON slip
    // re-encodes the whole tail of the payload.
    expect(samePlaceCount(RELAY_MINTED, RELAY_RETYPED)).toBeLessThan(RELAY_MINTED.length / 2)
    expect(repairShareLinks(`Download link: ${url(RELAY_RETYPED)}`, new Set([RELAY_MINTED]))).toBe(
      `Download link: ${url(RELAY_MINTED)}`,
    )
  })

  test('repairs a payload that lost a character as well as one that gained it', () => {
    expect(repairShareLinks(url(RELAY_TRUNCATED), new Set([RELAY_MINTED]))).toBe(url(RELAY_MINTED))
  })

  test('repairs a token whose separator was URL-encoded', () => {
    expect(repairShareLinks(url(RELAY_RETYPED.replace('.', '%2E')), new Set([RELAY_MINTED]))).toBe(url(RELAY_MINTED))
    expect(repairShareLinks(url(RELAY_RETYPED.replace('.', '%2e')), new Set([RELAY_MINTED]))).toBe(url(RELAY_MINTED))
  })

  test('a re-encoded payload resolves to its own token among several shared files', () => {
    expect(repairShareLinks(url(RELAY_RETYPED), new Set([OTHER, MINTED, RELAY_MINTED]))).toBe(url(RELAY_MINTED))
  })

  test('an unknown signature far from every minted token is left alone', () => {
    const stranger = `${b64url(RELAY_PAYLOAD)}.${'z'.repeat(43)}`
    expect(repairShareLinks(url(stranger), new Set([MINTED, RELAY_MINTED]))).toBe(url(stranger))
  })

  test('an ambiguous signature is never guessed: the text is left unchanged', () => {
    const twin = `${b64url(RELAY_PAYLOAD.replace('2026-10-24-A.mp4', '2026-10-25-B.mp4'))}.${RELAY_SIG}`
    const candidate = `${b64url(RELAY_PAYLOAD.replace('"typ":"shared-file"', '"typ":"shared-files"'))}.${RELAY_SIG}`
    expect(repairShareLinks(url(candidate), new Set([RELAY_MINTED, twin, MINTED]))).toBe(url(candidate))
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
