// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the shared file-tree walker. These tests are intentionally
 * standalone (no agent-runtime server boot, no SQLite) because the same
 * walker is bundled into the Electron desktop main process — these are the
 * tests that protect both consumers from policy drift.
 *
 * The server-side end-to-end tests in `file-workspace-e2e.test.ts` cover
 * the HTTP route on top, which exercises the walker against a live API.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WORKSPACE_TREE_HIDDEN_DIRS,
  WORKSPACE_TREE_HIDDEN_FILES,
  WORKSPACE_TREE_LAZY_DIRS,
  walkFilesTree,
} from '../fs-tree-walker'

const ROOT = mkdtempSync(join(tmpdir(), 'shogo-fs-tree-walker-'))

beforeAll(() => {
  // Visible regulars
  writeFileSync(join(ROOT, 'package.json'), '{"name":"vis"}')
  writeFileSync(join(ROOT, 'AGENTS.md'), '# agents')
  writeFileSync(join(ROOT, '.env'), 'SECRET=value')
  writeFileSync(join(ROOT, '.gitignore'), 'node_modules\n')
  mkdirSync(join(ROOT, '.shogo'), { recursive: true })
  writeFileSync(join(ROOT, '.shogo', 'config.json'), '{}')

  // Hidden VCS
  mkdirSync(join(ROOT, '.git', 'objects'), { recursive: true })
  writeFileSync(join(ROOT, '.git', 'HEAD'), 'ref: refs/heads/main')
  mkdirSync(join(ROOT, '.svn'))

  // OS junk
  writeFileSync(join(ROOT, '.DS_Store'), 'macos')

  // Lazy dirs with nested content the walker MUST NOT recurse into.
  mkdirSync(join(ROOT, 'node_modules', 'lodash', 'src'), { recursive: true })
  writeFileSync(join(ROOT, 'node_modules', 'lodash', 'package.json'), '{}')
  mkdirSync(join(ROOT, 'dist', 'assets'), { recursive: true })
  writeFileSync(join(ROOT, 'dist', 'bundle.js'), '/* built */')

  // Regular nested project with its own lazy dir inside — the walker must
  // recurse into `src/` and stop again at `src/node_modules/`.
  mkdirSync(join(ROOT, 'src', 'features'), { recursive: true })
  writeFileSync(join(ROOT, 'src', 'index.ts'), 'export const x = 1')
  mkdirSync(join(ROOT, 'src', 'node_modules', 'inner'), { recursive: true })
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe('fs-tree-walker policy constants', () => {
  test('HIDDEN_DIRS covers VS Code defaults', () => {
    for (const dir of ['.git', '.svn', '.hg', 'CVS']) {
      expect(WORKSPACE_TREE_HIDDEN_DIRS.has(dir)).toBe(true)
    }
  })

  test('LAZY_DIRS includes node_modules / dist / .next / __pycache__', () => {
    for (const dir of ['node_modules', 'dist', '.next', '__pycache__', 'venv']) {
      expect(WORKSPACE_TREE_LAZY_DIRS.has(dir)).toBe(true)
    }
  })

  test('HIDDEN_FILES covers OS junk', () => {
    for (const file of ['.DS_Store', 'Thumbs.db', 'desktop.ini', '.virtfs_metadata']) {
      expect(WORKSPACE_TREE_HIDDEN_FILES.has(file)).toBe(true)
    }
  })
})

describe('walkFilesTree (default policy)', () => {
  test('emits visible dotfiles + configs at the workspace root', () => {
    const tree = walkFilesTree(ROOT, ROOT)
    const names = tree.map((n) => n.name).sort()
    expect(names).toContain('package.json')
    expect(names).toContain('AGENTS.md')
    expect(names).toContain('.env')
    expect(names).toContain('.gitignore')
    expect(names).toContain('.shogo')
  })

  test('hard-hides .git / .svn and OS junk files', () => {
    const tree = walkFilesTree(ROOT, ROOT)
    const names = tree.map((n) => n.name)
    expect(names).not.toContain('.git')
    expect(names).not.toContain('.svn')
    expect(names).not.toContain('.DS_Store')
  })

  test('emits node_modules / dist as lazy entries with no children', () => {
    const tree = walkFilesTree(ROOT, ROOT)
    const nm = tree.find((n) => n.name === 'node_modules')
    expect(nm).toBeDefined()
    expect(nm?.type).toBe('directory')
    expect(nm?.lazy).toBe(true)
    expect(nm?.children).toBeUndefined()

    const dist = tree.find((n) => n.name === 'dist')
    expect(dist?.lazy).toBe(true)
    expect(dist?.children).toBeUndefined()
  })

  test('recurses into non-lazy subdirs and lazy-stops at nested lazy dirs', () => {
    const tree = walkFilesTree(ROOT, ROOT)
    const src = tree.find((n) => n.name === 'src')
    expect(src?.type).toBe('directory')
    expect(src?.children).toBeDefined()
    const srcChildren = (src?.children ?? []).map((n) => n.name).sort()
    expect(srcChildren).toContain('index.ts')
    expect(srcChildren).toContain('node_modules')

    const nestedNm = src?.children?.find((n) => n.name === 'node_modules')
    expect(nestedNm?.lazy).toBe(true)
    expect(nestedNm?.children).toBeUndefined()
  })

  test('paths are workspace-relative + POSIX-separated', () => {
    const tree = walkFilesTree(ROOT, ROOT)
    const src = tree.find((n) => n.name === 'src')
    const index = src?.children?.find((n) => n.name === 'index.ts')
    expect(index?.path).toBe('src/index.ts')
    expect(index?.path?.includes('\\')).toBe(false)
  })

  test('files carry size + modified, directories carry modified', () => {
    const tree = walkFilesTree(ROOT, ROOT)
    const pkg = tree.find((n) => n.name === 'package.json')
    expect(pkg?.type).toBe('file')
    expect(typeof pkg?.size).toBe('number')
    expect(typeof pkg?.modified).toBe('number')
    expect(pkg!.size!).toBeGreaterThan(0)

    const shogo = tree.find((n) => n.name === '.shogo')
    expect(shogo?.type).toBe('directory')
    expect(typeof shogo?.modified).toBe('number')
  })

  test('?path= equivalent: starting from a lazy dir yields its real children', () => {
    // Same call shape both the HTTP route and the Electron IPC use when the
    // user expands `node_modules` in the tree.
    const subtree = walkFilesTree(join(ROOT, 'node_modules'), ROOT)
    const names = subtree.map((n) => n.name).sort()
    expect(names).toEqual(['lodash'])

    // Going one level deeper — node_modules/lodash — should expose the
    // package.json + src/ that we wrote.
    const lodash = walkFilesTree(join(ROOT, 'node_modules', 'lodash'), ROOT)
    const lodashNames = lodash.map((n) => n.name).sort()
    expect(lodashNames).toEqual(['package.json', 'src'])
  })

  test('returns [] for a non-existent starting directory', () => {
    const out = walkFilesTree(join(ROOT, 'does-not-exist'), ROOT)
    expect(out).toEqual([])
  })
})

describe('walkFilesTree (custom policy sets)', () => {
  test('respects caller-supplied overrides', () => {
    // Promote `dist` from lazy to hidden, demote `node_modules` to fully
    // walked. Exercises the parameter wiring that lets the desktop bundle
    // (or a future cloud variant) tweak policy without forking the walker.
    const hiddenDirs = new Set([...WORKSPACE_TREE_HIDDEN_DIRS, 'dist'])
    const lazyDirs = new Set<string>() // none lazy
    const out = walkFilesTree(ROOT, ROOT, hiddenDirs, lazyDirs, WORKSPACE_TREE_HIDDEN_FILES)
    const names = out.map((n) => n.name)
    expect(names).not.toContain('dist')
    const nm = out.find((n) => n.name === 'node_modules')
    expect(nm?.lazy).toBeUndefined()
    expect(nm?.children).toBeDefined() // walked fully now
    expect(nm?.children?.length).toBeGreaterThan(0)
  })
})


describe('walkFilesTree (statSync failures)', () => {
  test('skips entries whose statSync() throws (broken symlink) instead of bubbling', () => {
    // Set up a freshly isolated root so the broken symlink is the ONLY
    // entry — that way an assertion-shaped "missing the file" check
    // proves the catch-and-continue branch actually fired.
    const brokenRoot = mkdtempSync(join(tmpdir(), 'shogo-fs-tree-walker-broken-'))
    try {
      // Mix one regular file in so we can confirm the walker continued
      // past the broken symlink rather than aborting.
      writeFileSync(join(brokenRoot, 'survivor.txt'), 'ok')
      // Point a symlink at a path that does not exist. statSync() will
      // throw ENOENT for this; the walker's try/catch must swallow it.
      symlinkSync(join(brokenRoot, '__does_not_exist__'), join(brokenRoot, 'broken-link'))

      const out = walkFilesTree(brokenRoot, brokenRoot)
      const names = out.map((n) => n.name).sort()
      // The broken symlink is dropped, the survivor stays — and the call
      // did not throw, which is the whole point of the catch.
      expect(names).toEqual(['survivor.txt'])
    } finally {
      rmSync(brokenRoot, { recursive: true, force: true })
    }
  })
})
