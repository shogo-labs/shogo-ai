// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The syntax highlighter is loaded lazily (SHO-601): no grammar is in the eager
 * bundle, so the only thing keeping the code previews working is that the async
 * chunk carries a grammar for every language the previews can ask for. These
 * tests open that path and assert both halves.
 */
import { describe, expect, test } from 'bun:test'
import { EXT_TO_LANG, getLanguageFromPath } from '../../components/chat/turns/file-lang-map'
import { loadHighlighter } from '../code-highlight'

describe('chat code highlighting', () => {
  test('carries a grammar for every language a preview can ask for', async () => {
    const highlighter = await loadHighlighter()
    const loaded = highlighter.getLoadedLanguages()
    // Every extension in the map, plus the two filenames `getLanguageFromPath`
    // special-cases outside it.
    const asked = new Set([
      ...Object.values(EXT_TO_LANG),
      getLanguageFromPath('Makefile'),
      getLanguageFromPath('Dockerfile'),
    ])
    const missing = [...asked].filter((lang) => !loaded.includes(lang))
    expect(missing).toEqual([])
  })

  test('highlights a TypeScript write preview into coloured spans', async () => {
    const highlighter = await loadHighlighter()
    const html = highlighter.codeToHtml('const answer: number = 42', {
      lang: 'typescript',
      theme: 'github-dark-default',
    })
    expect(html).toContain('<span')
    expect(html).toContain('answer')
  })

  test('returns per-token colours for an edit preview, and plaintext for unknown files', async () => {
    const highlighter = await loadHighlighter()
    const tokens = highlighter.codeToTokens('const answer = 42', {
      lang: 'typescript',
      theme: 'github-light-high-contrast',
    })
    expect(tokens.tokens.flat().some((token) => !!token.color)).toBe(true)

    const plain = highlighter.codeToTokens('just words', {
      lang: 'plaintext',
      theme: 'github-dark-default',
    })
    expect(plain.tokens.flat().map((token) => token.content).join('')).toBe('just words')
  })
})
