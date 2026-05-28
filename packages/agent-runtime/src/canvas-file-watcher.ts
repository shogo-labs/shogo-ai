// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CanvasFileWatcher — Detects workspace file changes and broadcasts events.
 *
 * Two input paths feed the same event stream:
 *
 *   1. Explicit notifications from gateway-tools.ts when the chat agent's
 *      write_file / edit_file tools succeed. These are synchronous with the
 *      tool response and fire before the tool returns.
 *
 *   2. A chokidar watcher on the workspace root. This catches every write
 *      regardless of source — Shogo external agents, the host user editing
 *      files directly on disk, git pulls, etc. Without this, the IDE live-
 *      edit experience is only reliable when the project's own chat agent
 *      is driving, which is a confusing UX.
 *
 * Both paths funnel through broadcast(), and a short-term dedupe guard
 * prevents the same `file.changed` event from firing twice (once from each
 * source) within a small window.
 *
 * Subscribers get:
 *   { type: 'file.changed', path, mtime }
 *   { type: 'file.deleted', path }
 *   { type: 'reload' }  ← legacy, bundle-level signal (not per-file)
 *   { type: 'init' }    ← replayed on first subscribe
 */

import { watch as chokidarWatch, type FSWatcher } from 'chokidar'
import { statSync, promises as fsp } from 'node:fs'
import { relative, resolve as resolvePath, join as joinPath } from 'node:path'

// Files whose changes should trigger a rebuild. Covers both Vite layouts
// (src/, vite.config.ts, postcss.config.js) and Metro/Expo layouts
// (app/ for expo-router routes, app.json for runtime config, babel.config.js,
// metro.config.js). Unknown extensions are ignored to keep noisy writes
// (.DS_Store, swp files, etc.) from triggering builds.
const BUILDABLE_PREFIXES = [
  // Vite + shared
  'src/',
  'index.html',
  'vite.config',
  'tsconfig',
  'postcss',
  // Expo / Metro
  'app/',
  'app.json',
  'babel.config',
  'metro.config',
  'expo-router',
] as const
const BUILDABLE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.css', '.html', '.json'] as const

function isBuildableFile(relativePath: string): boolean {
  if (BUILDABLE_PREFIXES.some(p => relativePath.startsWith(p))) {
    return BUILDABLE_EXTENSIONS.some(ext => relativePath.endsWith(ext))
  }
  return false
}

// Paths under these prefixes are ignored by the chokidar watcher. They're
// either agent-runtime internals, build artefacts, or user-invisible state
// that would flood the event stream.
const IGNORED_PATH_PREFIXES = [
  'node_modules',
  '.git',
  '.shogo/server', // legacy skill-server path — retained so any leftover
                   // pre-migration files don't trigger rebuilds. The
                   // migration deletes the directory but old snapshots
                   // (`.shogo/server.migrated-<ts>/`) are also under
                   // `.shogo/`, which we ignore wholesale next:
  '.shogo/cache',
  'dist',
  // Build-output-commit staging/rotation dirs. Must be ignored or
  // chokidar's recursive ReadDirectoryChangesW on Windows pins a handle
  // inside the staging tree while the bundler is writing into it, which
  // then makes `renameSync(dist.canvas.staging, dist)` fail with EPERM
  // even after the full retry budget. POSIX doesn't care, but the cost
  // of watching these dirs is zero either way — they contain build
  // artefacts, never source files anyone wants live-edit events for.
  // Keep in sync with the staging names in build-output-commit.ts and
  // canvas-build-manager.ts.
  'dist.canvas.staging',
  'dist.staging',
  'dist.prev',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'src/generated',
  // Python convention. These are bytecode/virtualenv dirs that no
  // user ever edits — same rationale as `node_modules` for JS. Both
  // also match nested via the NESTED_PREFIXES set below (e.g. a
  // monorepo with `packages/foo/.venv/`).
  '__pycache__',
  '.venv',
  'venv',
]

function shouldIgnore(relativePath: string): boolean {
  if (!relativePath || relativePath === '.' || relativePath.startsWith('..')) return true
  for (const p of IGNORED_PATH_PREFIXES) {
    if (relativePath === p || relativePath.startsWith(p + '/')) return true
  }
  if (isNoisyFileBasename(relativePath)) return true
  return false
}

// Transient or exclusively-locked files that chokidar will EPERM on when
// it tries to `fs.stat` them for awaitWriteFinish (typical Windows
// failure mode — see the `EPERM: operation not permitted, watch '…dev.db-
// journal'` reports). Each entry pairs a chokidar glob (used to short-
// circuit `add` events before they fire) with a basename regex (used in
// `shouldIgnore` as a defensive net for any event chokidar still
// delivers — e.g. an event for a path matched only by basename, not by
// the workspace-anchored glob). The two MUST stay in sync.
//
// Categories: SQLite (databases + journal/WAL/SHM/master-journal sidecars
// per https://www.sqlite.org/tempfiles.html), lock files (*.lock, Emacs
// `.#*`, MS Office `~$*`), editor swaps/backups (vim `*.sw[opn]`, generic
// `*~`), OS metadata (.DS_Store, Thumbs.db, desktop.ini, .directory), and
// atomic-write temps (*.tmp, .tmp.*, *.partial, *.crdownload).
const NOISY_FILE_PATTERNS: readonly { glob: string; regex: RegExp }[] = [
  // SQLite databases and sidecars
  { glob: '**/*.db',         regex: /\.db$/i },
  { glob: '**/*.db-journal', regex: /\.db-journal$/i },
  { glob: '**/*.db-wal',     regex: /\.db-wal$/i },
  { glob: '**/*.db-shm',     regex: /\.db-shm$/i },
  { glob: '**/*.db-mj*',     regex: /\.db-mj[0-9a-f]+$/i },
  { glob: '**/*.sqlite',     regex: /\.sqlite$/i },
  { glob: '**/*.sqlite-*',   regex: /\.sqlite-(journal|wal|shm|mj[0-9a-f]+)$/i },
  { glob: '**/*.sqlite3',    regex: /\.sqlite3$/i },
  { glob: '**/*.sqlite3-*',  regex: /\.sqlite3-(journal|wal|shm|mj[0-9a-f]+)$/i },

  // Lock files
  { glob: '**/*.lock',       regex: /\.lock$/i },
  { glob: '**/.#*',          regex: /^\.#/ },
  { glob: '**/~$*',          regex: /^~\$/ },

  // Editor swap/backup files
  { glob: '**/*.swp',        regex: /\.swp$/ },
  { glob: '**/*.swo',        regex: /\.swo$/ },
  { glob: '**/*.swn',        regex: /\.swn$/ },
  { glob: '**/?*~',          regex: /.+~$/ },

  // OS metadata
  { glob: '**/.DS_Store',    regex: /^\.DS_Store$/ },
  { glob: '**/Thumbs.db',    regex: /^Thumbs\.db$/i },
  { glob: '**/desktop.ini',  regex: /^desktop\.ini$/i },
  { glob: '**/.directory',   regex: /^\.directory$/ },

  // Atomic-write temps
  { glob: '**/*.tmp',        regex: /\.tmp$/i },
  { glob: '**/.tmp.*',       regex: /^\.tmp\./ },
  { glob: '**/*.partial',    regex: /\.partial$/ },
  { glob: '**/*.crdownload', regex: /\.crdownload$/ },
]

function isNoisyFileBasename(relativePath: string): boolean {
  const slash = Math.max(relativePath.lastIndexOf('/'), relativePath.lastIndexOf('\\'))
  const base = slash === -1 ? relativePath : relativePath.slice(slash + 1)
  for (const p of NOISY_FILE_PATTERNS) {
    if (p.regex.test(base)) return true
  }
  return false
}

/**
 * Build chokidar's `ignored` glob array from `IGNORED_PATH_PREFIXES`.
 *
 * Chokidar 3 supports two ignore shapes: anymatch glob arrays and a
 * predicate function. The predicate form is invoked AFTER chokidar has
 * already stat'd (and on Linux, called `inotify_add_watch` for) every
 * directory it descends into — the function only suppresses event
 * delivery, not traversal. With ~38k files under `node_modules/` per
 * runtime workspace that meant ~44k watches per pod just from this
 * watcher (saturated the per-uid `fs.inotify.max_user_watches` quota
 * in staging on 2026-05-19; uid 1001 hit the kernel max of 164,698
 * watches across 2 co-tenant pods on the same node).
 *
 * Glob patterns DO short-circuit recursion: chokidar's anymatch check
 * against directory paths happens before the readdir + watch call, so
 * a `**\/node_modules/**` glob means we never even read the dep tree.
 *
 * Two patterns per prefix: the directory itself (`<root>/<p>`) so a
 * top-level match doesn't get a watch added, and `<root>/<p>/**` for
 * everything inside. We also append wildcard `**\/<basename>/**`
 * variants for the prefixes that can occur at any depth (`node_modules`,
 * `.git`, `dist*`, `.next`, `.turbo`, `.cache`) so nested instances
 * (e.g. `templates/foo/node_modules/`) are excluded too.
 */
function buildIgnoreGlobs(
  workspaceDir: string,
  /**
   * Extra directory basenames pulled out of the workspace's `.gitignore` /
   * `.shogoignore` at watcher startup (see `loadSimpleIgnoredDirsFromGitignore`).
   * Treated the same as a `NESTED_PREFIXES` entry — emitted at both the
   * workspace-root anchor AND as a `**\/<name>/` wildcard — because the
   * typical user .gitignore entries (`target/`, `vendor/`, `Pods/`,
   * `bazel-out/`, `__pycache__/`, `.venv/`, `coverage/`, `.idea/`,
   * `.vscode/`) can legitimately appear at any depth in a polyglot
   * monorepo.
   */
  gitignoredDirs: readonly string[] = [],
): string[] {
  const NESTED_PREFIXES = new Set([
    'node_modules',
    '.git',
    'dist',
    'dist.canvas.staging',
    'dist.staging',
    'dist.prev',
    'build',
    '.next',
    '.turbo',
    '.cache',
    '__pycache__',
    '.venv',
    'venv',
  ])
  const globs: string[] = []
  for (const p of IGNORED_PATH_PREFIXES) {
    globs.push(`${workspaceDir}/${p}`)
    globs.push(`${workspaceDir}/${p}/**`)
    if (NESTED_PREFIXES.has(p)) {
      globs.push(`**/${p}`)
      globs.push(`**/${p}/**`)
    }
  }
  // Same glob shape as the NESTED_PREFIXES path so chokidar can
  // short-circuit recursion (predicate-form `ignored` does NOT short-
  // circuit — see the JSDoc on this function). De-dupe against the
  // hard-coded list so a user `.gitignore` line for `node_modules` is a
  // no-op rather than emitting two identical globs.
  const alreadyCovered = new Set(IGNORED_PATH_PREFIXES)
  for (const name of gitignoredDirs) {
    if (alreadyCovered.has(name)) continue
    globs.push(`${workspaceDir}/${name}`)
    globs.push(`${workspaceDir}/${name}/**`)
    globs.push(`**/${name}`)
    globs.push(`**/${name}/**`)
  }
  // Noisy file shapes (SQLite sidecars, lock files, editor swaps, OS
  // metadata, atomic-write temps). The per-event `isNoisyFileBasename`
  // check in `shouldIgnore` is the runtime backstop; these globs let
  // chokidar suppress the `add` event entirely so we never even reach
  // the awaitWriteFinish stat call that EPERMs on Windows.
  for (const p of NOISY_FILE_PATTERNS) {
    globs.push(p.glob)
  }
  return globs
}

/**
 * Sister to `fs-tree-walker.ts:loadIgnoreMatcher` — that one returns a
 * full `ignore` matcher (predicate-based), which is the right shape for
 * the recursive walker but the WRONG shape for chokidar (predicate-form
 * `ignored` doesn't short-circuit traversal — see `buildIgnoreGlobs`).
 *
 * Here we want a list of directory *basenames* we can convert to chokidar
 * globs that DO short-circuit. So we parse `.gitignore` / `.shogoignore`
 * by hand and keep only the patterns that are unambiguous bare-directory
 * matches. The 90% case the user actually cares about — `target/`,
 * `vendor/`, `Pods/`, `bazel-out/`, `coverage/`, `__pycache__/`, `.venv/`,
 * `.idea/`, `.vscode/`, etc. — all parse cleanly under these rules:
 *
 *   - skip empty + comment lines
 *   - skip negations (`!foo`) — keeping them un-ignored is the whole
 *     point of the negation; we'd rather over-watch than mis-suppress
 *   - skip patterns containing `*`, `?`, or `[` — chokidar can match
 *     these via globs but the conversion isn't trivial (especially
 *     `**` semantics differ between gitignore and micromatch). File-
 *     level wildcards aren't watch-quota problems anyway.
 *   - skip path-anchored patterns (`/foo`, `foo/bar`) — they're rare in
 *     project root .gitignore files and converting them to globs that
 *     short-circuit cleanly requires duplicating gitignore's anchoring
 *     rules; not worth the complexity for the marginal coverage.
 *
 * Everything else (with optional trailing `/`) is treated as a bare
 * directory name and fed into `buildIgnoreGlobs`. The walker's full
 * `ignore`-lib matcher in `fs-tree-walker.ts` still handles the complex
 * patterns at request time, so the IDE tree stays accurate; this is
 * purely about not setting up inotify watches we'll never need.
 *
 * Read errors swallow silently (file absent / unreadable) — symmetric
 * with `loadIgnoreMatcher`'s behavior.
 */
async function loadSimpleIgnoredDirsFromGitignore(
  workspaceDir: string,
): Promise<string[]> {
  const files = ['.gitignore', '.shogoignore']
  const dirs = new Set<string>()
  for (const file of files) {
    let content: string
    try {
      content = await fsp.readFile(joinPath(workspaceDir, file), 'utf8')
    } catch {
      continue
    }
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      if (line.startsWith('!')) continue
      if (line.includes('*') || line.includes('?') || line.includes('[')) continue
      const trimmed = line.endsWith('/') ? line.slice(0, -1) : line
      if (!trimmed) continue
      // Path-anchored (root-anchored `/foo` or nested `foo/bar`): skip.
      // A pattern with a slash anywhere other than as a trailing dir
      // marker is path-shape, not a bare name.
      if (trimmed.includes('/')) continue
      dirs.add(trimmed)
    }
  }
  return [...dirs]
}

/**
 * Internal helpers — exported only so the test suite can exercise the
 * `.gitignore` → chokidar-glob pipeline without standing up a real
 * chokidar instance + a real workspace + a synthetic fs-event stream
 * (chokidar's own readiness window makes that approach flaky on CI).
 *
 * @internal — not part of the package's public API. Do not import from
 *             outside `packages/agent-runtime/src/__tests__/`.
 */
export const __testInternals = {
  buildIgnoreGlobs,
  loadSimpleIgnoredDirsFromGitignore,
  shouldIgnore,
  isNoisyFileBasename,
}

export type CanvasEvent =
  | { type: 'init' }
  | { type: 'reload' }
  | { type: 'file.changed'; path: string; mtime: number }
  | { type: 'file.deleted'; path: string }

export class CanvasFileWatcher {
  private static instance: CanvasFileWatcher | null = null

  static getInstance(workspaceDir: string): CanvasFileWatcher {
    if (!CanvasFileWatcher.instance) {
      CanvasFileWatcher.instance = new CanvasFileWatcher(workspaceDir)
    }
    return CanvasFileWatcher.instance
  }

  private subscribers = new Set<(event: CanvasEvent) => void>()
  private workspaceDir: string
  private onRebuildCallback: (() => void) | null = null
  /**
   * LSP bridge: receives every disk-side file event so the workspace
   * language server can `workspace/didChangeWatchedFiles` instead of
   * spinning up its own native inotify watcher (~44k watches per pod
   * before delegation; saturated the per-uid kernel quota in staging
   * 2026-05-19). Wired in by gateway.ts after the LSP manager is up.
   *
   * The bridge is a simple callback rather than a typed reference to
   * avoid pulling shared-runtime types into this module (and to keep
   * the watcher testable in isolation).
   */
  private lspBridge: ((absPath: string, kind: 'created' | 'changed' | 'deleted') => void) | null = null

  /** Dedupe guard: `${type}:${path}` -> timestamp (ms). */
  private recentEvents = new Map<string, number>()
  private readonly DEDUPE_WINDOW_MS = 120

  private chokidar: FSWatcher | null = null

  constructor(workspaceDir: string) {
    this.workspaceDir = resolvePath(workspaceDir)
    // Fire-and-forget: the watcher boots on the next tick after we've
    // loaded `.gitignore` / `.shogoignore`. The startup gap (≤ ~5 ms on
    // a typical workspace, dominated by the two `fsp.readFile` calls) is
    // shorter than chokidar's own internal `ready` window, so callers
    // adding subscribers immediately after construction don't miss
    // anything they wouldn't already have missed.
    void this.startChokidar()
  }

  /**
   * Start a chokidar watcher on the workspace root. Best-effort: if chokidar
   * fails to start (unusual, usually permission issues), we silently fall
   * back to the explicit gateway-tools path and log to stderr.
   *
   * Async because we read the workspace's `.gitignore` + `.shogoignore`
   * up front and feed the user-declared ignored-dir basenames into the
   * chokidar `ignored` globs — same recursion-short-circuiting trick as
   * the hard-coded `IGNORED_PATH_PREFIXES` list, just sourced from the
   * project instead of the watcher. This is the runtime/preview-watcher
   * complement to the .gitignore awareness we already added to the
   * `walkFilesTree` walker (commit 3de4aac9 on
   * feat/open-folder-functionality-enhancement). Without it, a Rust
   * workspace's `target/`, an iOS project's `Pods/`, a Python venv's
   * `.venv/` — anything the user .gitignored but the watcher didn't
   * know about — would keep accumulating inotify watches and
   * re-triggering rebuilds on every build artefact.
   */
  private async startChokidar(): Promise<void> {
    try {
      const gitignoredDirs = await loadSimpleIgnoredDirsFromGitignore(this.workspaceDir)
      // Glob form (NOT predicate form) — see `buildIgnoreGlobs` for why
      // this matters for inotify quota. The per-event `shouldIgnore`
      // call in `handleChokidarFileEvent` below is kept as a defensive
      // net for any event chokidar still routes through (e.g. a file
      // at the workspace root whose name happens to match an
      // `IGNORED_PATH_PREFIXES` entry).
      this.chokidar = chokidarWatch(this.workspaceDir, {
        ignoreInitial: true,
        persistent: true,
        followSymlinks: false,
        depth: 30,
        awaitWriteFinish: {
          stabilityThreshold: 60,
          pollInterval: 20,
        },
        ignored: buildIgnoreGlobs(this.workspaceDir, gitignoredDirs),
      })

      this.chokidar.on('add', (absPath) => this.handleChokidarFileEvent('add', absPath))
      this.chokidar.on('change', (absPath) => this.handleChokidarFileEvent('change', absPath))
      this.chokidar.on('unlink', (absPath) => this.handleChokidarFileEvent('unlink', absPath))
      this.chokidar.on('error', (err) => {
        console.warn('[CanvasFileWatcher] chokidar error:', (err as Error).message)
      })
    } catch (err) {
      console.warn('[CanvasFileWatcher] chokidar init failed — live edits limited to gateway-tools path:', (err as Error).message)
      this.chokidar = null
    }
  }

  private handleChokidarFileEvent(op: 'add' | 'change' | 'unlink', absPath: string): void {
    const rel = relative(this.workspaceDir, absPath)
    if (shouldIgnore(rel)) return
    const path = rel.split('\\').join('/')

    if (op === 'unlink') {
      // LSP bridge fires regardless of dedupe — the deletion event is
      // routed off the canvas dedupe map (which is per `${type}:${path}`)
      // and into a separate LSP send path. The TSLanguageServer side
      // does its own filtering against registered globs.
      this.notifyLspBridge(absPath, 'deleted')
      if (this.shouldDedupe('file.deleted', path)) return
      this.broadcast({ type: 'file.deleted', path })
      if (isBuildableFile(path)) this.onRebuildCallback?.()
      return
    }

    let mtime = Date.now()
    try {
      const s = statSync(absPath)
      mtime = Math.floor(s.mtimeMs)
    } catch {
      /* deleted mid-race, fall back to Date.now() */
    }
    this.notifyLspBridge(absPath, op === 'add' ? 'created' : 'changed')
    if (this.shouldDedupe('file.changed', path)) return
    this.broadcast({ type: 'file.changed', path, mtime })
    if (isBuildableFile(path)) this.onRebuildCallback?.()
  }

  private notifyLspBridge(absPath: string, kind: 'created' | 'changed' | 'deleted'): void {
    const bridge = this.lspBridge
    if (!bridge) return
    try {
      bridge(absPath, kind)
    } catch (err) {
      console.warn('[CanvasFileWatcher] LSP bridge threw:', (err as Error).message)
    }
  }

  private shouldDedupe(type: string, path: string): boolean {
    const key = `${type}:${path}`
    const now = Date.now()
    const last = this.recentEvents.get(key) ?? 0
    if (now - last < this.DEDUPE_WINDOW_MS) return true
    this.recentEvents.set(key, now)
    // Garbage-collect stale entries opportunistically so the map doesn't
    // grow unbounded under heavy traffic.
    if (this.recentEvents.size > 2048) {
      const cutoff = now - this.DEDUPE_WINDOW_MS * 10
      for (const [k, t] of this.recentEvents) {
        if (t < cutoff) this.recentEvents.delete(k)
      }
    }
    return false
  }

  setOnRebuild(callback: () => void): void {
    this.onRebuildCallback = callback
  }

  /**
   * Install (or replace) the LSP bridge — see `lspBridge` field comment.
   * Pass `null` to detach. Called once from gateway.ts after the
   * `WorkspaceLSPManager` is ready.
   */
  setLspBridge(bridge: ((absPath: string, kind: 'created' | 'changed' | 'deleted') => void) | null): void {
    this.lspBridge = bridge
  }

  /**
   * Explicit notifier used by gateway-tools.ts. Runs synchronously before
   * the tool call returns — redundant with chokidar but faster (no debounce
   * or filesystem stat) and survives watcher init failures.
   */
  onFileChanged(relativePath: string, _absolutePath: string): void {
    const path = relativePath.split('\\').join('/')
    if (this.shouldDedupe('file.changed', path)) return
    this.broadcast({ type: 'file.changed', path, mtime: Date.now() })
    if (isBuildableFile(path)) {
      this.onRebuildCallback?.()
    }
  }

  onFileDeleted(relativePath: string): void {
    const path = relativePath.split('\\').join('/')
    if (this.shouldDedupe('file.deleted', path)) return
    this.broadcast({ type: 'file.deleted', path })
    if (isBuildableFile(path)) {
      this.onRebuildCallback?.()
    }
  }

  broadcastReload(): void {
    this.broadcast({ type: 'reload' })
  }

  getInitEvent(): CanvasEvent {
    return { type: 'init' }
  }

  subscribe(fn: (event: CanvasEvent) => void): void {
    this.subscribers.add(fn)
  }

  unsubscribe(fn: (event: CanvasEvent) => void): void {
    this.subscribers.delete(fn)
  }

  broadcast(event: CanvasEvent): void {
    for (const fn of this.subscribers) {
      try { fn(event) } catch { /* subscriber crashed — isolate */ }
    }
  }

  /** Test-only: stop the chokidar watcher. */
  close(): void {
    this.chokidar?.close().catch(() => {})
    this.chokidar = null
  }
}
