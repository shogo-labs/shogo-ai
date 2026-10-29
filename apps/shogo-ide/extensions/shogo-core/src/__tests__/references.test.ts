import { beforeEach, describe, expect, test } from 'bun:test'
import { FakeUri, fakeEditor, resetVscodeMock, state } from './vscode-mock'

const { selectionReferences, uriReferences, skippedMessage } = await import('../references')
const { MAX_CONTEXT_TEXT_LENGTH } = await import('../contextOutbox')

const LINES = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`)

beforeEach(() => resetVscodeMock())

describe('selectionReferences', () => {
  test('1-based inclusive lines, workspace-relative path, language and text', () => {
    const editor = fakeEditor('/repo/src/big.ts', LINES, [[9, 0, 11, 7]])
    expect(selectionReferences(editor as any)).toEqual([
      {
        type: 'selection',
        path: 'src/big.ts',
        name: 'big.ts',
        startLine: 10,
        endLine: 12,
        text: 'line 10\nline 11\nline 12',
        languageId: 'typescript',
      },
    ])
  })

  test('a selection ending at character 0 of a later line excludes that line', () => {
    const [ref] = selectionReferences(fakeEditor('/repo/a.ts', LINES, [[4, 0, 8, 0]]) as any)
    expect(ref).toMatchObject({ startLine: 5, endLine: 8 })
  })

  test('multi-selection: sorted, empty skipped, identical ranges deduped', () => {
    const editor = fakeEditor('/repo/a.ts', LINES, [
      [20, 0, 21, 3],
      [2, 0, 3, 4],
      [7, 2, 7, 2],
      [20, 1, 21, 6],
    ])
    expect(selectionReferences(editor as any).map((r: any) => `${r.startLine}-${r.endLine}`)).toEqual(['3-4', '21-22'])
  })

  test('outside every workspace folder keeps the absolute path (selections carry their own text)', () => {
    const [ref] = selectionReferences(fakeEditor('/tmp/scratch.ts', LINES, [[0, 0, 0, 4]]) as any)
    expect(ref).toMatchObject({ path: '/tmp/scratch.ts', name: 'scratch.ts' })
  })

  test('over-long text is truncated and flagged', () => {
    const editor = fakeEditor('/repo/a.ts', ['x'.repeat(MAX_CONTEXT_TEXT_LENGTH + 10)], [[0, 0, 0, MAX_CONTEXT_TEXT_LENGTH + 10]])
    const [ref] = selectionReferences(editor as any) as any[]
    expect(ref.truncated).toBe(true)
    expect(ref.text.length).toBe(MAX_CONTEXT_TEXT_LENGTH)
  })
})

describe('uriReferences', () => {
  test('files and folders inside the workspace', async () => {
    state.directories.add('/repo/src')
    const r = await uriReferences([FakeUri.file('/repo/src'), FakeUri.file('/repo/README.md')] as any)
    expect(r.references).toEqual([
      { type: 'folder', path: 'src', name: 'src' },
      { type: 'file', path: 'README.md', name: 'README.md' },
    ])
    expect(r.skipped).toEqual([])
  })

  test('items outside the workspace (or unreadable) are skipped and named', async () => {
    state.missing.add('/repo/gone.ts')
    const r = await uriReferences([FakeUri.file('/elsewhere/notes.md'), FakeUri.file('/repo/gone.ts')] as any)
    expect(r.references).toEqual([])
    expect(r.skipped).toEqual(['notes.md', 'gone.ts'])
    expect(skippedMessage(r.skipped)).toContain('skipped: notes.md, gone.ts')
  })

  test('duplicates are removed', async () => {
    const uri = FakeUri.file('/repo/a.ts')
    const r = await uriReferences([uri, FakeUri.file('/repo/a.ts')] as any)
    expect(r.references).toHaveLength(1)
  })
})
