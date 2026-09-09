// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path';
import { overlayScrollbarProps } from "../overlay-scrollbar"

const css = readFileSync(resolve(import.meta.dir, '../../global.css'), 'utf8')

describe('overlay scrollbar track', () => {
  test('global CSS paints a transparent track behind the thumb', () => {
    expect(css).toContain('scrollbar-color: rgba(150, 150, 150, 0.3) transparent')
    expect(css).toContain('::-webkit-scrollbar-track')
    expect(css).toContain('::-webkit-scrollbar-track-piece')
    expect(css).toContain('scrollbar-gutter: auto')
  })

  test('native overlay props are iOS-only and do not restyle web scrollbars', () => {
    expect(overlayScrollbarProps).toEqual({})
  })
})
