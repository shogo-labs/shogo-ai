// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { notesForClipboard, parseTranscript, stripActionItemsSection } from '../meeting-notes'

describe('stripActionItemsSection', () => {
  test('drops only the Action items section', () => {
    const md = '## Summary\n- a\n\n## Action items\n- [ ] x — Sam\n\n## Open questions\n- q'
    expect(stripActionItemsSection(md)).toBe('## Summary\n- a\n\n## Open questions\n- q')
  })

  test('leaves notes without that section alone', () => {
    expect(stripActionItemsSection('## Summary\n- a')).toBe('## Summary\n- a')
  })
})

describe('notesForClipboard', () => {
  test('uses the checklist state, not the stale markdown', () => {
    const text = notesForClipboard({
      title: 'Sync',
      enhancedNotes: '## Summary\n- a\n## Action items\n- [ ] Ship',
      notes: null,
      actionItems: [{ text: 'Ship', owner: 'Ana', done: true }],
    })
    expect(text).toBe('# Sync\n\n## Summary\n- a\n\n## Action items\n- [x] Ship — Ana')
  })

  test('falls back to rough notes before enhancement', () => {
    expect(notesForClipboard({ title: null, enhancedNotes: null, notes: ' ask about pricing ', actionItems: [] })).toBe(
      '# Meeting notes\n\nask about pricing',
    )
  })
})

describe('parseTranscript', () => {
  test('handles JSON strings, objects and plain text', () => {
    expect(parseTranscript('{"text":"hi","segments":[{"start":0,"end":1,"text":"hi"}]}')?.segments).toHaveLength(1)
    expect(parseTranscript({ text: 'hi' })?.segments).toEqual([])
    expect(parseTranscript('not json')).toEqual({ text: 'not json', segments: [] })
    expect(parseTranscript(null)).toBeNull()
  })
})
