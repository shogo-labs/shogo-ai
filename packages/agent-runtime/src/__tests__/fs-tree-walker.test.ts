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
  test('emits visible dotfiles + configs at the workspace root', async () => {
    const tree = await walkFilesTree(ROOT, ROOT)
    const names = tree.map((n) => n.name).sort()
    expect(names).toContain('package.json')
    expect(names).toContain('AGENTS.md')
    expect(names).toContain('.env')
    expect(names).toContain('.gitignore')
    expect(names).toContain('.shogo')
  })

  test('hard-hides .git / .svn and OS junk files', async () => {
    const tree = await walkFilesTree(ROOT, ROOT)
    const names = tree.map((n) => n.name)
    expect(names).not.toContain('.git')
    expect(names).not.toContain('.svn')
    expect(names).not.toContain('.DS_Store')
  })

  test('emits node_modules / dist as lazy entries with no children', async () => {
    const tree = await walkFilesTree(ROOT, ROOT)
    const nm = tree.find((n) => n.name === 'node_modules')
    expect(nm).toBeDefined()
    expect(nm?.type).toBe('directory')
    expect(nm?.lazy).toBe(true)
    expect(nm?.children).toBeUndefined()

    const dist = tree.find((n) => n.name === 'dist')
    expect(dist?.lazy).toBe(true)
    expect(dist?.children).toBeUndefined()
  })

  test('recurses into non-lazy subdirs and lazy-stops at nested lazy dirs', async () => {
    const tree = await walkFilesTree(ROOT, ROOT)
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

  test('paths are workspace-relative + POSIX-separated', async () => {
    const tree = await walkFilesTree(ROOT, ROOT)
    const src = tree.find((n) => n.name === 'src')
    const index = src?.children?.find((n) => n.name === 'index.ts')
    expect(index?.path).toBe('src/index.ts')
    expect(index?.path?.includes('\\')).toBe(false)
  })

  test('files carry size + modified, directories carry modified', async () => {
    const tree = await walkFilesTree(ROOT, ROOT)
    const pkg = tree.find((n) => n.name === 'package.json')
    expect(pkg?.type).toBe('file')
    expect(typeof pkg?.size).toBe('number')
    expect(typeof pkg?.modified).toBe('number')
    expect(pkg!.size!).toBeGreaterThan(0)

    const shogo = tree.find((n) => n.name === '.shogo')
    expect(shogo?.type).toBe('directory')
    expect(typeof shogo?.modified).toBe('number')
  })

  test('?path= equivalent: starting from a lazy dir yields its real children', async () => {
    // Same call shape both the HTTP route and the Electron IPC use when the
    // user expands `node_modules` in the tree. Disable gitignore here
    // because the fixture's root `.gitignore` lists `node_modules` — with
    // the default (respectGitignore=true) we'd see lazy stubs all the way
    // down, which is the correct first-paint behavior but not what this
    // test is checking. The test is about lazy-dir expansion semantics.
    const subtree = await walkFilesTree(join(ROOT, 'node_modules'), ROOT, {
      respectGitignore: false,
    })
    const names = subtree.map((n) => n.name).sort()
    expect(names).toEqual(['lodash'])

    // Going one level deeper — node_modules/lodash — should expose the
    // package.json + src/ that we wrote.
    const lodash = await walkFilesTree(join(ROOT, 'node_modules', 'lodash'), ROOT, {
      respectGitignore: false,
    })
    const lodashNames = lodash.map((n) => n.name).sort()
    expect(lodashNames).toEqual(['package.json', 'src'])
  })

  test('returns [] for a non-existent starting directory', async () => {
    const out = await walkFilesTree(join(ROOT, 'does-not-exist'), ROOT)
    expect(out).toEqual([])
  })
})

describe('walkFilesTree (custom policy sets)', () => {
  test('respects caller-supplied overrides', async () => {
    // Promote `dist` from lazy to hidden, demote `node_modules` to fully
    // walked. Exercises the parameter wiring that lets the desktop bundle
    // (or a future cloud variant) tweak policy without forking the walker.
    //
    // `respectGitignore: false` because the fixture writes a root
    // `.gitignore` containing `node_modules` — the walker would otherwise
    // (correctly) keep node_modules lazy via the gitignore path even
    // though the caller asked for fully-walked. This test is about the
    // policy-override wiring, not gitignore behavior; gitignore has its
    // own dedicated test below.
    const hiddenDirs = new Set([...WORKSPACE_TREE_HIDDEN_DIRS, 'dist'])
    const lazyDirs = new Set<string>() // none lazy
    const out = await walkFilesTree(ROOT, ROOT, {
      hiddenDirs,
      lazyDirs,
      hiddenFiles: WORKSPACE_TREE_HIDDEN_FILES,
      respectGitignore: false,
    })
    const names = out.map((n) => n.name)
    expect(names).not.toContain('dist')
    const nm = out.find((n) => n.name === 'node_modules')
    expect(nm?.lazy).toBeUndefined()
    expect(nm?.children).toBeDefined() // walked fully now
    expect(nm?.children?.length).toBeGreaterThan(0)
  })
})

describe('walkFilesTree (gitignore awareness)', () => {
  // These tests prove the 2026-05-25 critical fix: the walker honors
  // `.gitignore` at the workspace root, so a polyglot monorepo with
  // target/, vendor/, Pods/, bazel-out/, etc. isn't fully descended on
  // the first paint.
  test('directories matched by root .gitignore become lazy:true', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shogo-fs-tree-walker-gitignore-'))
    try {
      writeFileSync(join(root, '.gitignore'), 'target/\nvendor/\nbazel-out/\n')
      mkdirSync(join(root, 'target', 'classes'), { recursive: true })
      writeFileSync(join(root, 'target', 'classes', 'A.class'), 'binary')
      mkdirSync(join(root, 'vendor', 'github.com'), { recursive: true })
      writeFileSync(join(root, 'vendor', 'github.com', 'pkg.go'), 'package x')
      mkdirSync(join(root, 'src'), { recursive: true })
      writeFileSync(join(root, 'src', 'index.ts'), 'export {}')

      const tree = await walkFilesTree(root, root)
      const target = tree.find((n) => n.name === 'target')
      expect(target?.type).toBe('directory')
      expect(target?.lazy).toBe(true)
      expect(target?.children).toBeUndefined()
      const vendor = tree.find((n) => n.name === 'vendor')
      expect(vendor?.lazy).toBe(true)
      expect(vendor?.children).toBeUndefined()
      // Non-ignored dirs are walked normally.
      const src = tree.find((n) => n.name === 'src')
      expect(src?.children).toBeDefined()
      expect(src?.children?.map((n) => n.name)).toContain('index.ts')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('files matched by root .gitignore are hidden', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shogo-fs-tree-walker-gitignore-files-'))
    try {
      writeFileSync(join(root, '.gitignore'), '*.log\n.env.local\n')
      writeFileSync(join(root, 'app.log'), 'log line')
      writeFileSync(join(root, '.env.local'), 'SECRET=x')
      writeFileSync(join(root, 'README.md'), '# project')

      const tree = await walkFilesTree(root, root)
      const names = tree.map((n) => n.name)
      expect(names).not.toContain('app.log')
      expect(names).not.toContain('.env.local')
      expect(names).toContain('README.md')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('.shogoignore is layered on top of .gitignore', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shogo-fs-tree-walker-shogoignore-'))
    try {
      writeFileSync(join(root, '.gitignore'), '*.log\n')
      writeFileSync(join(root, '.shogoignore'), 'private/\n')
      writeFileSync(join(root, 'app.log'), 'log')
      mkdirSync(join(root, 'private'), { recursive: true })
      writeFileSync(join(root, 'private', 'secrets.json'), '{}')
      writeFileSync(join(root, 'public.md'), 'ok')

      const tree = await walkFilesTree(root, root)
      const names = tree.map((n) => n.name)
      expect(names).not.toContain('app.log')           // from .gitignore
      const priv = tree.find((n) => n.name === 'private')
      expect(priv?.lazy).toBe(true)                    // from .shogoignore
      expect(names).toContain('public.md')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('respectGitignore:false disables both files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shogo-fs-tree-walker-disabled-'))
    try {
      writeFileSync(join(root, '.gitignore'), '*.log\nsecret/\n')
      writeFileSync(join(root, 'app.log'), 'log')
      mkdirSync(join(root, 'secret'), { recursive: true })
      writeFileSync(join(root, 'secret', 'file.txt'), 'x')

      const tree = await walkFilesTree(root, root, { respectGitignore: false })
      const names = tree.map((n) => n.name).sort()
      expect(names).toContain('app.log')
      const secret = tree.find((n) => n.name === 'secret')
      expect(secret?.children).toBeDefined() // walked, not lazy
      expect(secret?.children?.map((n) => n.name)).toContain('file.txt')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('walkFilesTree (defensive caps)', () => {
  // The caps exist to keep a runaway tree (symlink cycle, mis-mounted
  // FUSE, multi-million-file repo) from hanging the UI. They're
  // intentionally silent — partial results come back with lazy stubs
  // for the uncrossed parts so the user can still navigate.
  test('maxEntries caps the total entries returned', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shogo-fs-tree-walker-cap-'))
    try {
      for (let i = 0; i < 50; i++) {
        writeFileSync(join(root, `file-${i}.txt`), 'x')
      }
      const tree = await walkFilesTree(root, root, { maxEntries: 10 })
      expect(tree.length).toBeLessThanOrEqual(10)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('maxDepth caps recursion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shogo-fs-tree-walker-depth-'))
    try {
      mkdirSync(join(root, 'a', 'b', 'c', 'd'), { recursive: true })
      writeFileSync(join(root, 'a', 'b', 'c', 'd', 'leaf.txt'), 'x')
      // maxDepth: 1 means we walk the root + one level of children but
      // don't recurse further. `a/` should appear as a directory but its
      // children array should be empty (depth cap hit before descending).
      const tree = await walkFilesTree(root, root, { maxDepth: 1 })
      const a = tree.find((n) => n.name === 'a')
      expect(a?.type).toBe('directory')
      // a/b is present (depth 1) but a/b/c is not (depth 2 > maxDepth 1).
      const b = a?.children?.find((n) => n.name === 'b')
      expect(b?.children).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('aborted AbortSignal stops the walk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shogo-fs-tree-walker-abort-'))
    try {
      for (let i = 0; i < 200; i++) {
        writeFileSync(join(root, `file-${i}.txt`), 'x')
      }
      const controller = new AbortController()
      controller.abort()
      const tree = await walkFilesTree(root, root, { signal: controller.signal })
      // First entry might sneak through before the budget check (the check
      // runs at top of each iteration) — what matters is that the walk
      // didn't process all 200 entries.
      expect(tree.length).toBeLessThan(200)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('walkFilesTree (fs error tolerance)', () => {
  test('skips entries whose stat() throws (broken symlink) instead of bubbling', async () => {
    // Set up a freshly isolated root so the broken symlink is the ONLY
    // entry — that way an assertion-shaped "missing the file" check
    // proves the catch-and-continue branch actually fired.
    const brokenRoot = mkdtempSync(join(tmpdir(), 'shogo-fs-tree-walker-broken-'))
    try {
      // Mix one regular file in so we can confirm the walker continued
      // past the broken symlink rather than aborting.
      writeFileSync(join(brokenRoot, 'survivor.txt'), 'ok')
      // Point a symlink at a path that does not exist. fs.stat() will
      // throw ENOENT for this; the walker's try/catch must swallow it.
      symlinkSync(join(brokenRoot, '__does_not_exist__'), join(brokenRoot, 'broken-link'))

      const out = await walkFilesTree(brokenRoot, brokenRoot)
      const names = out.map((n) => n.name).sort()
      // The broken symlink is dropped, the survivor stays — and the call
      // did not throw, which is the whole point of the catch.
      expect(names).toEqual(['survivor.txt'])
    } finally {
      rmSync(brokenRoot, { recursive: true, force: true })
    }
  })
})
