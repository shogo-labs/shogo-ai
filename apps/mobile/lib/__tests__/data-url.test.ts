// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A pasted long-text block travels through chat as a `data:` URL, and Android
 * cannot open one (SHOGO-ANDROID-1D). The bytes are already in the app, so the
 * viewer decodes them locally (SHO-436).
 */

import { describe, expect, it } from 'bun:test'
import { decodeDataUrlText } from '../data-url'

const base64 = (value: string) => Buffer.from(value, 'utf8').toString('base64')

describe('decodeDataUrlText', () => {
  it('decodes a base64 markdown body', () => {
    const url = `data:text/markdown;base64,${base64('# Notes\n\n- one')}`

    expect(decodeDataUrlText(url)).toEqual({
      text: '# Notes\n\n- one',
      mediaType: 'text/markdown',
    })
  })

  it('decodes a percent-encoded body', () => {
    const url = `data:text/plain;charset=utf-8,${encodeURIComponent('héllo ✨')}`

    expect(decodeDataUrlText(url)?.text).toBe('héllo ✨')
  })

  it('keeps multi-byte characters intact', () => {
    const url = `data:text/plain;base64,${base64('日本語 and emoji 🚀')}`

    expect(decodeDataUrlText(url)?.text).toBe('日本語 and emoji 🚀')
  })

  it('is null for a non-text body, so the caller does not pretend to view it', () => {
    expect(decodeDataUrlText('data:application/pdf;base64,JVBERi0=')).toBeNull()
    expect(decodeDataUrlText('data:image/png;base64,iVBORw0KGgo=')).toBeNull()
  })

  it('is null for anything that is not a data URL', () => {
    expect(decodeDataUrlText('https://shogo.ai/notes.md')).toBeNull()
    expect(decodeDataUrlText('data:')).toBeNull()
  })
})
