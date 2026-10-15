// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The attachment preview builders and readers. Pure functions only — the
 * parsing that needs bytes lives in `conversation-file-text.ts` and is covered
 * by `conversation-attachment-preview.integration.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import {
  MAX_CODE_LINES,
  MAX_PREVIEW_CHARS,
  MAX_PROSE_LINES,
  MAX_TABLE_COLS,
  MAX_TABLE_ROWS,
  PREVIEW_VERSION,
  buildCodePreview,
  buildSlidesPreview,
  buildTablePreview,
  buildTextPreview,
  fitPreview,
  parseDelimited,
  parseSharedStrings,
  parseSheetGrid,
  parseSheetName,
  publicPreview,
} from '../conversation-file-preview'

describe('text and code previews', () => {
  test('prose drops blank runs and clamps length', () => {
    const preview = buildTextPreview('First line\n\n\nSecond line\n' + 'x'.repeat(400))!
    expect(preview.kind).toBe('text')
    expect(preview.lines[0]).toBe('First line')
    expect(preview.lines[1]).toBe('Second line')
    // The long line is clamped rather than rejected.
    expect(preview.lines[2].length).toBeLessThanOrEqual(160)
    expect(preview.v).toBe(PREVIEW_VERSION)
  })

  test('a page count rides along only when there is one', () => {
    expect(buildTextPreview('Body text', { pages: 12 })!.pages).toBe(12)
    expect(buildTextPreview('Body text', { pages: 0 })!.pages).toBeUndefined()
    expect(buildTextPreview('Body text')!.pages).toBeUndefined()
  })

  test('whitespace-only content produces no preview at all', () => {
    expect(buildTextPreview('   \n\n \t ')).toBeNull()
    expect(buildCodePreview('  \n\t\n')).toBeNull()
  })

  test('code keeps its own indentation, unlike the tidied search text', () => {
    const preview = buildCodePreview('function a() {\n  return 1\n}', { lang: 'ts' })!
    expect(preview.kind).toBe('code')
    expect(preview.lines[1]).toBe('  return 1')
    expect(preview.lang).toBe('ts')
  })

  test('code drops blank lines above the first real one', () => {
    expect(buildCodePreview('\n\n\nconst a = 1')!.lines).toEqual(['const a = 1'])
  })
})

describe('slide previews', () => {
  test('the first slide becomes a title plus bullets, with the deck size', () => {
    const preview = buildSlidesPreview(['Kickoff\nGoals\nOwners', 'Roadmap', 'Risks'])!
    expect(preview).toMatchObject({ kind: 'slides', title: 'Kickoff', count: 3 })
    expect(preview.bullets).toEqual(['Goals', 'Owners'])
  })

  test('a deck with one slide reports a count of one', () => {
    expect(buildSlidesPreview(['Solo'])!.count).toBe(1)
  })

  test('no slides means no preview', () => {
    expect(buildSlidesPreview([])).toBeNull()
    expect(buildSlidesPreview(['   '])).toBeNull()
  })
})

describe('table previews', () => {
  test('rows and columns are capped, and overflow is reported', () => {
    const wide = Array.from({ length: 10 }, (_, r) =>
      Array.from({ length: 9 }, (_, c) => `r${r}c${c}`),
    )
    const preview = buildTablePreview(wide)!
    expect(preview.rows.length).toBe(MAX_TABLE_ROWS)
    expect(preview.rows[0].length).toBe(MAX_TABLE_COLS)
    expect(preview.truncated).toBe(true)
  })

  test('an empty grid produces nothing', () => {
    expect(buildTablePreview([])).toBeNull()
    expect(buildTablePreview([['', ''], ['']])).toBeNull()
  })

  test('a sheet name is carried through', () => {
    expect(buildTablePreview([['Region']], { sheet: 'Q3' })!.sheet).toBe('Q3')
  })
})

describe('csv and tsv', () => {
  test('quoted fields keep their delimiter and an unterminated file is not padded', () => {
    const { rows } = parseDelimited('Region,Revenue\nEMEA,"1,200"\nAPAC,900\n', ',')
    expect(rows).toEqual([['Region', 'Revenue'], ['EMEA', '1,200'], ['APAC', '900']])
  })

  test('doubled quotes are an escaped quote, and tabs split a tsv', () => {
    expect(parseDelimited('a\n"he said ""hi"""', ',').rows).toEqual([['a'], ['he said "hi"']])
    expect(parseDelimited('a\tb\n1\t2', '\t').rows).toEqual([['a', 'b'], ['1', '2']])
  })

  test('a quoted newline stays inside its field', () => {
    expect(parseDelimited('a,"line1\nline2"', ',').rows).toEqual([['a', 'line1\nline2']])
  })

  test('overflow is flagged rather than silently dropped', () => {
    const many = Array.from({ length: 20 }, (_, i) => `row${i}`).join('\n')
    const parsed = parseDelimited(many, ',')
    expect(parsed.rows.length).toBe(MAX_TABLE_ROWS)
    expect(parsed.truncated).toBe(true)
  })
})

describe('spreadsheet XML', () => {
  test('shared strings are read in index order and decoded', () => {
    expect(parseSharedStrings('<sst><si><t>Region</t></si><si><t>A &amp; B</t></si></sst>'))
      .toEqual(['Region', 'A & B'])
  })

  test('the first sheet name is read from the workbook', () => {
    expect(parseSheetName('<workbook><sheets><sheet name="Q3" sheetId="1"/></sheets></workbook>')).toBe('Q3')
    expect(parseSheetName('<workbook/>')).toBeUndefined()
  })

  test('cells resolve shared strings, inline strings and numbers', () => {
    const worksheet = [
      '<worksheet><sheetData>',
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Inline</t></is></c></row>',
      '<row r="2"><c r="A2"><v>42</v></c><c r="C2" t="s"><v>1</v></c></row>',
      '</sheetData></worksheet>',
    ].join('')
    const { rows } = parseSheetGrid(worksheet, ['Shared', 'Second'])
    expect(rows[0]).toEqual(['Shared', 'Inline'])
    // C2 is the third column, so the gap at B is filled and trailing blanks dropped.
    expect(rows[1]).toEqual(['42', '', 'Second'])
  })

  test('more rows than the preview shows is flagged', () => {
    const body = Array.from({ length: 20 }, (_, i) => `<row r="${i + 1}"><c><v>${i}</v></c></row>`).join('')
    const { rows, truncated } = parseSheetGrid(`<worksheet><sheetData>${body}</sheetData></worksheet>`, [])
    expect(rows.length).toBe(MAX_TABLE_ROWS)
    expect(truncated).toBe(true)
  })
})

describe('fitting the ceiling', () => {
  test('a preview that already fits is returned untouched', () => {
    const preview = buildTextPreview('Short and sweet')!
    expect(fitPreview(preview)).toEqual({ preview, dropped: false })
  })

  test('an oversized preview is shaved until it fits', () => {
    const huge = { v: 1 as const, kind: 'text' as const, lines: Array.from({ length: 60 }, () => 'x'.repeat(160)) }
    const { preview, dropped } = fitPreview(huge)
    expect(dropped).toBe(true)
    expect(JSON.stringify(preview).length).toBeLessThanOrEqual(MAX_PREVIEW_CHARS)
    expect(preview!.kind).toBe('text')
  })

  test('nothing to fit stays nothing', () => {
    expect(fitPreview(null)).toEqual({ preview: null, dropped: false })
  })
})

describe('reading stored previews', () => {
  test('every builder output survives the read-side check unchanged', () => {
    const built = [
      buildTextPreview('First line\nSecond line', { pages: 3 }),
      buildCodePreview('const a = 1\n  const b = 2', { lang: 'ts' }),
      buildSlidesPreview(['Kickoff\nGoals', 'Roadmap']),
      buildTablePreview([['Region', 'Revenue'], ['EMEA', '1200']], { sheet: 'Q3', truncated: true }),
    ]
    for (const preview of built) {
      expect(preview).not.toBeNull()
      expect(publicPreview(preview)).toEqual(preview)
    }
  })

  test('a SQLite row arrives as a JSON string and is parsed', () => {
    const preview = buildTextPreview('Stored as text')!
    expect(publicPreview(JSON.stringify(preview))).toEqual(preview)
  })

  test('a different version, an unknown kind, or rubbish is dropped', () => {
    expect(publicPreview({ v: 2, kind: 'text', lines: ['a'] })).toBeNull()
    expect(publicPreview({ v: 1, kind: 'video', lines: ['a'] })).toBeNull()
    expect(publicPreview('not json')).toBeNull()
    expect(publicPreview(null)).toBeNull()
    expect(publicPreview([])).toBeNull()
  })

  test('malformed shapes are dropped rather than half-rendered', () => {
    expect(publicPreview({ v: 1, kind: 'text', lines: 'a string' })).toBeNull()
    expect(publicPreview({ v: 1, kind: 'text', lines: [1, 2] })).toBeNull()
    // More lines than the shape allows.
    expect(publicPreview({ v: 1, kind: 'text', lines: Array.from({ length: MAX_PROSE_LINES + 1 }, () => 'a') })).toBeNull()
    expect(publicPreview({ v: 1, kind: 'code', lines: Array.from({ length: MAX_CODE_LINES + 1 }, () => 'a') })).toBeNull()
    expect(publicPreview({ v: 1, kind: 'slides', title: 'a', bullets: [], count: 0 })).toBeNull()
    expect(publicPreview({ v: 1, kind: 'table', rows: [['a', 'b', 'c', 'd', 'e', 'f']], truncated: false })).toBeNull()
    expect(publicPreview({ v: 1, kind: 'slides', title: 'a', bullets: ['x'], count: 'lots' })).toBeNull()
  })

  test('an oversized payload is refused outright', () => {
    const stuffed = { v: 1, kind: 'text', lines: ['a'], pad: 'x'.repeat(MAX_PREVIEW_CHARS + 50) }
    expect(publicPreview(stuffed)).toBeNull()
  })
})
