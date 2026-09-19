/**
 * Baseline regression suite. All of these pass at HEAD (before the bug is
 * fixed) — none of them end the input in punctuation, so none of them
 * exercise the planted bug. The pipeline's implementer is expected to add a
 * *new* test that does exercise it (see ../ISSUE.md); this file should not
 * need to change.
 */
import { expect, test } from 'bun:test'
import { slugify } from './slugify'

test('lowercases and hyphenates', () => {
  expect(slugify('Hello World')).toBe('hello-world')
})

test('collapses repeated separators', () => {
  expect(slugify('foo   bar')).toBe('foo-bar')
})

test('strips leading punctuation', () => {
  expect(slugify('---Foo Bar')).toBe('foo-bar')
})

test('handles already-slugified input', () => {
  expect(slugify('already-a-slug')).toBe('already-a-slug')
})
