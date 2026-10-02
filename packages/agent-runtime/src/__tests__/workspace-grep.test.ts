import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileGlobList, grepWorkspace, GrepError, resolveRipgrep } from '../workspace-grep'

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'shogo-grep-'))
  mkdirSync(join(root, 'src', 'deep'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
  mkdirSync(join(root, 'logs'), { recursive: true })
  writeFileSync(join(root, '.gitignore'), 'logs/\n.env\n')
  writeFileSync(join(root, 'src', 'a.ts'), 'const needle = 1\nconst other = 2\nlet Needle = 3\n')
  writeFileSync(join(root, 'src', 'deep', 'b.test.ts'), 'needle in test\n')
  writeFileSync(join(root, 'README.md'), 'héllo needle\n')
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'needle\n')
  writeFileSync(join(root, 'logs', 'out.log'), 'needle\n')
  writeFileSync(join(root, '.env'), 'needle=1\n')
  writeFileSync(join(root, 'bin.dat'), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0, 1, 2]))
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

const engines: Array<['auto' | 'js', string]> = [['js', 'js engine']]
if (resolveRipgrep()) engines.unshift(['auto', 'ripgrep engine'])

for (const [engine, label] of engines) {
  describe(label, () => {
    const run = (req: Parameters<typeof grepWorkspace>[1]) => grepWorkspace(root, req, { engine })

    test('case-insensitive literal search skips ignored, lazy and binary files', async () => {
      const res = await run({ query: 'needle' })
      const paths = res.results.map((r) => r.path).sort()
      expect(paths).toEqual(['README.md', 'src/a.ts', 'src/deep/b.test.ts'])
      const a = res.results.find((r) => r.path === 'src/a.ts')!
      expect(a.matches.map((m) => m.line)).toEqual([1, 3])
      expect(a.matches[0].col).toBe(7)
    })

    test('case sensitive + regex', async () => {
      const cs = await run({ query: 'Needle', caseSensitive: true })
      expect(cs.results.map((r) => r.path)).toEqual(['src/a.ts'])
      const re = await run({ query: 'const \\w+ = 2', regex: true })
      expect(re.results[0].matches[0].line).toBe(2)
    })

    test('columns are UTF-16 based', async () => {
      const res = await run({ query: 'needle', include: 'README.md' })
      expect(res.results[0].matches[0].col).toBe(7)
    })

    test('include / exclude globs', async () => {
      const inc = await run({ query: 'needle', include: 'src' })
      expect(inc.results.map((r) => r.path).sort()).toEqual(['src/a.ts', 'src/deep/b.test.ts'])
      const exc = await run({ query: 'needle', include: 'src', exclude: '*.test.ts' })
      expect(exc.results.map((r) => r.path)).toEqual(['src/a.ts'])
    })

    test('limit truncates', async () => {
      const res = await run({ query: 'needle', limit: 1 })
      expect(res.truncated).toBe(true)
      expect(res.results.reduce((n, r) => n + r.matches.length, 0)).toBe(1)
    })

    test('invalid regex raises GrepError', async () => {
      await expect(run({ query: '(', regex: true })).rejects.toBeInstanceOf(GrepError)
    })

    test('empty query is empty result', async () => {
      expect((await run({ query: '' })).results).toEqual([])
    })
  })
}

describe('compileGlobList', () => {
  test('matches like the client implementation', () => {
    const m = compileGlobList('*.{ts,tsx}, docs')!
    expect(m('a/b.tsx')).toBe(true)
    expect(m('docs/x.md')).toBe(true)
    expect(m('a/b.js')).toBe(false)
  })
})
