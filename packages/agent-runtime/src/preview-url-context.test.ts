// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reproduction (P0): the agent ran inside a cloud pod in app/build mode and
 * handed the user localhost URLs because the preview-URL block was only
 * injected in canvas mode. These tests pin the fixed behavior:
 *   - the block is injected in EVERY mode, and
 *   - a public URL is always presented as the user-facing address.
 */
import { describe, test, expect } from 'bun:test'
import { shouldInjectPreviewUrl, buildPreviewUrlBlock } from './preview-url-context'

describe('preview-url context', () => {
  describe('shouldInjectPreviewUrl', () => {
    test('injects in canvas mode', () => {
      expect(shouldInjectPreviewUrl('canvas')).toBe(true)
    })

    // REGRESSION: in app/build mode the agent had no public URL and fell back
    // to localhost. The block must be available wherever the user can ask for
    // a link.
    test('injects in app mode (regression: localhost URL leak)', () => {
      expect(shouldInjectPreviewUrl('app')).toBe(true)
    })

    test('injects in default/none mode', () => {
      expect(shouldInjectPreviewUrl('none')).toBe(true)
    })

    test('injects in plan mode', () => {
      expect(shouldInjectPreviewUrl('plan')).toBe(true)
    })
  })

  describe('buildPreviewUrlBlock', () => {
    test('presents the public URL as the user-facing address', () => {
      const block = buildPreviewUrlBlock({ publicUrl: 'https://preview--demo.shogo.dev', runtimePort: 8080, hasDist: false })
      expect(block).toContain('https://preview--demo.shogo.dev')
      // The user-facing "reachable at" line must NOT be localhost.
      expect(block).not.toMatch(/reachable at \*\*http:\/\/localhost/)
    })

    test('localhost only appears as the internal address when a public URL exists', () => {
      const block = buildPreviewUrlBlock({ publicUrl: 'https://preview--demo.shogo.dev', runtimePort: 8080, hasDist: true })!
      expect(block).toContain('Internal (from inside this runtime, for your own curl checks only): `http://localhost:8080/`')
    })

    test('falls back to localhost as the user-facing link only when running locally', () => {
      const block = buildPreviewUrlBlock({ publicUrl: '', runtimePort: 8080, hasDist: true, isLocal: true })!
      expect(block).toMatch(/reachable at \*\*http:\/\/localhost:8080\/\*\*/)
    })

    test('in cloud with no public URL, NEVER presents localhost as the user-facing link', () => {
      const block = buildPreviewUrlBlock({ publicUrl: '', runtimePort: 8080, hasDist: true, isLocal: false })!
      // No user-facing "reachable at localhost" line at all.
      expect(block).not.toMatch(/reachable at \*\*http:\/\/localhost/)
      // localhost is still offered as the labeled internal curl address.
      expect(block).toContain('http://localhost:8080/')
      expect(block).toContain('curl checks only')
      // And it points the agent at Publish for a shareable link.
      expect(block).toContain('publish')
    })

    test('returns null when there is nothing to serve', () => {
      expect(buildPreviewUrlBlock({ publicUrl: '', runtimePort: 8080, hasDist: false })).toBeNull()
    })
  })
})
