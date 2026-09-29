import { describe, expect, test } from 'bun:test'
import { countLineChanges } from '../tool-line-stats'

describe('countLineChanges', () => {
  test('counts lines in a new file without counting the trailing newline', () => {
    expect(countLineChanges('write_file', { content: 'one\ntwo\n' }))
      .toEqual({ linesAdded: 2, linesRemoved: 0 })
  })

  test('counts changed lines for an edit', () => {
    expect(countLineChanges('edit_file', {
      old_string: 'const one = 1\nconst two = 2',
      new_string: 'const one = 10\nconst two = 2\nconst three = 3',
    })).toEqual({ linesAdded: 2, linesRemoved: 1 })
  })

  test('accepts serialized tool arguments', () => {
    expect(countLineChanges('write_file', JSON.stringify({ content: 'hello' })))
      .toEqual({ linesAdded: 1, linesRemoved: 0 })
  })

  test('scales replace_all edits using the tool result replacement count', () => {
    expect(countLineChanges(
      'edit_file',
      { old_string: 'old', new_string: 'new', replace_all: true },
      { ok: true, replacements: 3 },
    )).toEqual({ linesAdded: 3, linesRemoved: 3 })
  })

  test('ignores non-file tools and malformed arguments', () => {
    expect(countLineChanges('create_plan', { overview: 'plan' }))
      .toEqual({ linesAdded: 0, linesRemoved: 0 })
    expect(countLineChanges('edit_file', { old_string: 1, new_string: 2 }))
      .toEqual({ linesAdded: 0, linesRemoved: 0 })
  })
})
