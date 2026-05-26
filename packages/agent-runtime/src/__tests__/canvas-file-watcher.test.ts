// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { CanvasFileWatcher, type CanvasEvent } from '../canvas-file-watcher'

const TMP_BASE = join(import.meta.dir, '..', '..', '.test-tmp-canvas-watcher')

let tmpDir: string
let nextId = 0

function freshDir(): string {
  const dir = join(TMP_BASE, `w-${nextId++}-${Date.now()}`)
  mkdirSync(join(dir, 'src'), { recursive: true })
  return dir
}

function resetSingleton() {
  // @ts-expect-error — accessing private static for test isolation
  CanvasFileWatcher.instance = null
}

beforeEach(() => {
  resetSingleton()
  tmpDir = freshDir()
})

afterEach(() => {
  resetSingleton()
  if (existsSync(TMP_BASE)) {
    rmSync(TMP_BASE, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// onFileChanged — triggers rebuild for src/ files
// ---------------------------------------------------------------------------

describe('onFileChanged', () => {
  test('calls onRebuild for src/*.tsx', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    let rebuildCalled = false
    watcher.setOnRebuild(() => { rebuildCalled = true })

    watcher.onFileChanged('src/App.tsx', join(tmpDir, 'src', 'App.tsx'))

    expect(rebuildCalled).toBe(true)
  })

  test('calls onRebuild for src/components/*.tsx', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    let rebuildCalled = false
    watcher.setOnRebuild(() => { rebuildCalled = true })

    watcher.onFileChanged('src/components/Header.tsx', join(tmpDir, 'src', 'components', 'Header.tsx'))

    expect(rebuildCalled).toBe(true)
  })

  test('calls onRebuild for src/*.css', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    let rebuildCalled = false
    watcher.setOnRebuild(() => { rebuildCalled = true })

    watcher.onFileChanged('src/index.css', join(tmpDir, 'src', 'index.css'))

    expect(rebuildCalled).toBe(true)
  })

  test('calls onRebuild for index.html', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    let rebuildCalled = false
    watcher.setOnRebuild(() => { rebuildCalled = true })

    watcher.onFileChanged('index.html', join(tmpDir, 'index.html'))

    expect(rebuildCalled).toBe(true)
  })

  test('calls onRebuild for vite.config.ts', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    let rebuildCalled = false
    watcher.setOnRebuild(() => { rebuildCalled = true })

    watcher.onFileChanged('vite.config.ts', join(tmpDir, 'vite.config.ts'))

    expect(rebuildCalled).toBe(true)
  })

  // --- Expo / Metro layout ---------------------------------------------------

  test('calls onRebuild for Expo app/*.tsx (expo-router routes)', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    let rebuildCalled = false
    watcher.setOnRebuild(() => { rebuildCalled = true })

    watcher.onFileChanged('app/index.tsx', join(tmpDir, 'app', 'index.tsx'))

    expect(rebuildCalled).toBe(true)
  })

  test('calls onRebuild for Expo app.json', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    let rebuildCalled = false
    watcher.setOnRebuild(() => { rebuildCalled = true })

    watcher.onFileChanged('app.json', join(tmpDir, 'app.json'))

    expect(rebuildCalled).toBe(true)
  })

  test('calls onRebuild for babel.config.js / metro.config.js', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    let calls = 0
    watcher.setOnRebuild(() => { calls++ })

    watcher.onFileChanged('babel.config.js', join(tmpDir, 'babel.config.js'))
    watcher.onFileChanged('metro.config.js', join(tmpDir, 'metro.config.js'))

    expect(calls).toBe(2)
  })

  test('ignores non-buildable paths', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    let rebuildCalled = false
    watcher.setOnRebuild(() => { rebuildCalled = true })

    watcher.onFileChanged('MEMORY.md', join(tmpDir, 'MEMORY.md'))
    watcher.onFileChanged('skills/test.md', join(tmpDir, 'skills', 'test.md'))
    watcher.onFileChanged('.shogo/server/schema.prisma', join(tmpDir, '.shogo', 'server', 'schema.prisma'))

    expect(rebuildCalled).toBe(false)
  })

  test('ignores non-buildable extensions under src/', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    let rebuildCalled = false
    watcher.setOnRebuild(() => { rebuildCalled = true })

    watcher.onFileChanged('src/data.md', join(tmpDir, 'src', 'data.md'))

    expect(rebuildCalled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// onFileDeleted — triggers rebuild for src/ files
// ---------------------------------------------------------------------------

describe('onFileDeleted', () => {
  test('calls onRebuild when src/*.tsx is deleted', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    let rebuildCalled = false
    watcher.setOnRebuild(() => { rebuildCalled = true })

    watcher.onFileDeleted('src/App.tsx')

    expect(rebuildCalled).toBe(true)
  })

  test('ignores non-buildable deletes', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    let rebuildCalled = false
    watcher.setOnRebuild(() => { rebuildCalled = true })

    watcher.onFileDeleted('MEMORY.md')
    expect(rebuildCalled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// broadcastReload & getInitEvent
// ---------------------------------------------------------------------------

describe('broadcastReload', () => {
  test('broadcasts reload event to subscribers', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    const events: CanvasEvent[] = []
    watcher.subscribe((e) => events.push(e))

    watcher.broadcastReload()

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('reload')
  })
})

describe('getInitEvent', () => {
  test('returns init event', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    const init = watcher.getInitEvent()
    expect(init.type).toBe('init')
  })
})

// ---------------------------------------------------------------------------
// Subscriber management
// ---------------------------------------------------------------------------

describe('subscribe/unsubscribe', () => {
  test('broadcasts to multiple subscribers', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    const events1: CanvasEvent[] = []
    const events2: CanvasEvent[] = []
    watcher.subscribe((e) => events1.push(e))
    watcher.subscribe((e) => events2.push(e))

    watcher.broadcastReload()

    expect(events1).toHaveLength(1)
    expect(events2).toHaveLength(1)
    expect(events1[0].type).toBe('reload')
  })

  test('unsubscribed listener stops receiving events', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    const events: CanvasEvent[] = []
    const fn = (e: CanvasEvent) => events.push(e)
    watcher.subscribe(fn)

    watcher.broadcastReload()
    expect(events).toHaveLength(1)

    watcher.unsubscribe(fn)

    watcher.broadcastReload()
    expect(events).toHaveLength(1)
  })

  test('throwing subscriber does not break other subscribers', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    const events: CanvasEvent[] = []
    watcher.subscribe(() => { throw new Error('boom') })
    watcher.subscribe((e) => events.push(e))

    watcher.broadcastReload()

    expect(events).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

describe('getInstance', () => {
  test('returns same instance on repeated calls', () => {
    const a = CanvasFileWatcher.getInstance(tmpDir)
    const b = CanvasFileWatcher.getInstance(tmpDir)
    expect(a).toBe(b)
  })
})

// ---------------------------------------------------------------------------
// .gitignore-aware chokidar ignore globs (MEDIUM #6 fix, 2026-05-26)
// ---------------------------------------------------------------------------
//
// CanvasFileWatcher pre-2026-05-26 used a hard-coded `IGNORED_PATH_PREFIXES`
// list (node_modules, .git, dist, .next, …) — enough to keep the worst
// offenders from blowing past `fs.inotify.max_user_watches`, but oblivious
// to project-specific `.gitignore` entries. A Rust workspace's `target/`,
// an iOS project's `Pods/`, a Python `.venv/`, or anything else the user
// already declared "I don't care about this" would still consume watches
// and re-trigger rebuilds on every build-artefact write.
//
// The fix parses `.gitignore` + `.shogoignore` at watcher startup and
// passes simple directory basenames into `buildIgnoreGlobs` — the same
// recursion-short-circuiting glob path the hardcoded prefixes already use.
// These tests pin down the parsing rules and the OR-with-existing-globs
// behavior so a future refactor can't silently regress the inotify quota.

import { writeFileSync } from 'fs'
import { __testInternals } from '../canvas-file-watcher'

const { buildIgnoreGlobs, loadSimpleIgnoredDirsFromGitignore } = __testInternals

describe('loadSimpleIgnoredDirsFromGitignore (gitignore parser)', () => {
  test('returns [] when no ignore files exist', async () => {
    const dirs = await loadSimpleIgnoredDirsFromGitignore(tmpDir)
    expect(dirs).toEqual([])
  })

  test('parses bare directory names with and without trailing slash', async () => {
    writeFileSync(join(tmpDir, '.gitignore'), [
      'target/',          // trailing slash
      'vendor',           // bare name
      '__pycache__/',
      '.venv',
    ].join('\n'))
    const dirs = await loadSimpleIgnoredDirsFromGitignore(tmpDir)
    expect(dirs.sort()).toEqual(['.venv', '__pycache__', 'target', 'vendor'])
  })

  test('skips empty lines, comments, and negations', async () => {
    writeFileSync(join(tmpDir, '.gitignore'), [
      '',
      '# this is a comment',
      'target/',
      '',
      '# vendor is a peer dep',
      '!keep-this/',     // negation — do NOT add to ignore set
      'Pods/',
    ].join('\n'))
    const dirs = await loadSimpleIgnoredDirsFromGitignore(tmpDir)
    expect(dirs.sort()).toEqual(['Pods', 'target'])
    expect(dirs).not.toContain('keep-this')
  })

  test('skips wildcards and path-anchored patterns (delegated to the walker matcher)', async () => {
    writeFileSync(join(tmpDir, '.gitignore'), [
      'target/',           // ✓ simple dir — kept
      '*.log',             // ✗ wildcard — skipped (file pattern, not a watch-quota issue)
      'foo/bar/',          // ✗ path-anchored — skipped
      '/root-only',        // ✗ root-anchored — skipped
      'build[12]/',        // ✗ character class — skipped
      'tmp?/',             // ✗ single-char wildcard — skipped
      'coverage/',         // ✓ simple dir — kept
    ].join('\n'))
    const dirs = await loadSimpleIgnoredDirsFromGitignore(tmpDir)
    expect(dirs.sort()).toEqual(['coverage', 'target'])
  })

  test('merges .gitignore + .shogoignore and dedupes', async () => {
    writeFileSync(join(tmpDir, '.gitignore'), 'target/\nvendor/\n')
    writeFileSync(join(tmpDir, '.shogoignore'), 'vendor/\nPods/\n')
    const dirs = await loadSimpleIgnoredDirsFromGitignore(tmpDir)
    expect(dirs.sort()).toEqual(['Pods', 'target', 'vendor'])
  })

  test('absent .gitignore is silently skipped (only .shogoignore present)', async () => {
    writeFileSync(join(tmpDir, '.shogoignore'), 'experimental/\n')
    const dirs = await loadSimpleIgnoredDirsFromGitignore(tmpDir)
    expect(dirs).toEqual(['experimental'])
  })
})

describe('buildIgnoreGlobs (.gitignore feed → chokidar globs)', () => {
  test('emits 4-globs-per-dir for each gitignored basename (root-anchored + **/-nested)', () => {
    const globs = buildIgnoreGlobs(tmpDir, ['target'])
    // The two root-anchored shapes plus the two **/-anchored shapes.
    // **/-anchored is critical: in a polyglot monorepo `target/` can
    // live at any depth (e.g. `packages/rust-bindings/target/`).
    expect(globs).toContain(`${tmpDir}/target`)
    expect(globs).toContain(`${tmpDir}/target/**`)
    expect(globs).toContain('**/target')
    expect(globs).toContain('**/target/**')
  })

  test('de-dupes against the hard-coded IGNORED_PATH_PREFIXES list', () => {
    // `node_modules` is already in IGNORED_PATH_PREFIXES with the same
    // 4-glob shape — adding it again from .gitignore would double-emit
    // and bloat the anymatch list with no behavioral change. The fix
    // must skip already-covered names.
    const withDup = buildIgnoreGlobs(tmpDir, ['node_modules'])
    const baseline = buildIgnoreGlobs(tmpDir, [])
    expect(withDup.length).toBe(baseline.length)
  })

  test('empty gitignoredDirs param leaves the baseline globs untouched (backwards compat)', () => {
    // CanvasFileWatcher used to call `buildIgnoreGlobs(workspaceDir)`
    // with no second arg. The default `[]` must produce the exact
    // same shape so anyone still on the old call-form is unaffected.
    const explicit = buildIgnoreGlobs(tmpDir, [])
    const implicit = buildIgnoreGlobs(tmpDir)
    expect(explicit).toEqual(implicit)
    // And the baseline contains every hard-coded prefix, root-anchored.
    expect(explicit).toContain(`${tmpDir}/node_modules`)
    expect(explicit).toContain(`${tmpDir}/.git`)
    expect(explicit).toContain('**/node_modules')
  })

  test('multiple gitignored dirs each get the 4-glob expansion', () => {
    const globs = buildIgnoreGlobs(tmpDir, ['target', 'vendor', 'Pods'])
    for (const name of ['target', 'vendor', 'Pods']) {
      expect(globs).toContain(`${tmpDir}/${name}`)
      expect(globs).toContain(`${tmpDir}/${name}/**`)
      expect(globs).toContain(`**/${name}`)
      expect(globs).toContain(`**/${name}/**`)
    }
  })
})
