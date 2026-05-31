// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace file-tree walker — shared between the HTTP agent-runtime server
 * (`server.ts`) and the Electron desktop IPC fast-path (`apps/desktop/src/
 * fs-ipc.ts`). Keeping a single source of truth here means the IDE Monaco
 * file tree behaves the same whether it's hitting the cloud agent-runtime
 * over HTTP or going through the local Electron preload bridge.
 *
 * This module uses `node:fs/promises` + `node:path` + the `ignore` package
 * (gitignore parser used by VS Code, Cursor, ESLint, Prettier). The walker
 * is bundled into the Electron main process via `scripts/bundle-main.mjs`,
 * which symlinks `@shogo/agent-runtime` so this module's deps resolve.
 *
 * ── 2026-05-25 rewrite ───────────────────────────────────────────────────
 * Previously this was a synchronous `readdirSync` + `statSync` recursion
 * that blocked the Electron main thread on opening a folder. On a polyglot
 * monorepo (target/, vendor/, Pods/, bazel-out/, __generated__/, etc.) it
 * would freeze the UI for 3–15 seconds because:
 *   (a) every fs syscall was synchronous, and
 *   (b) the only short-circuit was a hardcoded LAZY_DIRS set, so any
 *       ignored-but-unlisted directory was walked to completion.
 *
 * Both problems are fixed at the root here:
 *   1. Walk is async (`fs.promises.readdir/stat`) → main thread stays free.
 *   2. `.gitignore` + `.shogoignore` at the workspace root are parsed and
 *      respected — gitignored directories become `lazy: true` (visible in
 *      the tree but children not walked unless the user expands them),
 *      gitignored files are hidden entirely. Same semantic as Cursor.
 *   3. Defensive caps (max entries / max depth / time budget) so a
 *      pathological tree (symlink cycle, 1M-file repo) can't hang the UI
 *      even if the ignore rules are wrong.
 *
 * Policy (VS Code defaults — see vs_code_file_tree plan §"Refined behavior"):
 *
 *   HIDDEN_DIRS  — Never returned. VCS metadata. VS Code's `files.exclude`
 *                  defaults: .git / .svn / .hg / CVS.
 *
 *   LAZY_DIRS    — Returned as a directory entry with `lazy: true` and no
 *                  `children`. Callers fetch children on demand. Mirrors the
 *                  watcher's `IGNORED_PATH_PREFIXES` in
 *                  `canvas-file-watcher.ts` so the invariant "shown in the
 *                  tree, ignored by the watcher" holds by construction.
 *                  Now also covers anything matched by the workspace's
 *                  `.gitignore` / `.shogoignore` (directories only — files
 *                  matched by gitignore are hidden completely).
 *
 *   HIDDEN_FILES — Never returned. OS junk only.
 *
 * Product-UX filtering (hiding `package.json`, `AGENTS.md`, the four pinned
 * `*.md` shortcuts, etc.) does NOT happen here — that lives client-side in
 * `apps/mobile/components/project/panels/files-browser-filter.ts`. The IDE
 * Monaco file tree needs to see configs + dotfiles; the agent-files panel
 * doesn't. Do not re-introduce product-UX excludes server-side: they'll
 * silently break the IDE.
 */

import { promises as fsp } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import ignore, { type Ignore } from 'ignore'

export const WORKSPACE_TREE_HIDDEN_DIRS: ReadonlySet<string> = new Set([
  '.git', '.svn', '.hg', 'CVS',
])

export const WORKSPACE_TREE_LAZY_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist', 'build',
  'dist.canvas.staging', 'dist.staging', 'dist.prev',
  '.next', '.cache', '.turbo', '.parcel-cache',
  'coverage', '.nyc_output',
  '__pycache__', '.venv', 'venv',
])

export const WORKSPACE_TREE_HIDDEN_FILES: ReadonlySet<string> = new Set([
  '.DS_Store', 'Thumbs.db', 'desktop.ini',
  '.virtfs_metadata',
])

/**
 * Names of ignore files (relative to the workspace root) whose patterns are
 * layered into a single matcher. Order matters: later files can re-negate
 * earlier ones via `!pattern`, matching how Git composes nested ignores.
 */
export const WORKSPACE_TREE_IGNORE_FILES: readonly string[] = [
  '.gitignore',
  '.shogoignore',
]

/**
 * Defensive caps. These are intentionally generous — they exist to keep a
 * runaway walk (symlink cycle, mis-mounted FUSE, 10⁶-file repo) from
 * hanging the UI, NOT to enforce a product limit. When tripped, the walker
 * returns the partial tree silently; the user sees what it managed to
 * scan and lazy-expansion still works for the rest.
 */
const DEFAULT_MAX_ENTRIES = 50_000
const DEFAULT_MAX_DEPTH = 24
const DEFAULT_TIME_BUDGET_MS = 5_000

/**
 * Node shape returned by `walkFilesTree`. Matches the `FileNode` interface
 * exposed by `@shogo-ai/sdk/agent` (kept structural so we don't need a
 * package dep from this low-level module — the SDK reshapes if needed).
 */
export interface WorkspaceTreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  /** Last-modified time as a Unix epoch in milliseconds. */
  modified: number
  /** File size in bytes; only set for files. */
  size?: number
  /** Walked children; undefined for files and for `lazy: true` directories. */
  children?: WorkspaceTreeNode[]
  /**
   * True on directories whose children intentionally weren't walked. Covers
   * three cases: (a) member of `WORKSPACE_TREE_LAZY_DIRS`, (b) matched by
   * the workspace `.gitignore` / `.shogoignore`, (c) defensive caps tripped
   * mid-walk. Callers fetch children on demand by re-invoking
   * `walkFilesTree` rooted at the directory's absolute path.
   */
  lazy?: boolean
}

export interface WalkFilesTreeOptions {
  /** Override hidden dirs. Default: `WORKSPACE_TREE_HIDDEN_DIRS`. */
  hiddenDirs?: ReadonlySet<string>
  /** Override lazy dirs. Default: `WORKSPACE_TREE_LAZY_DIRS`. */
  lazyDirs?: ReadonlySet<string>
  /** Override hidden files. Default: `WORKSPACE_TREE_HIDDEN_FILES`. */
  hiddenFiles?: ReadonlySet<string>
  /**
   * Parse `.gitignore` / `.shogoignore` at the workspace root and apply
   * their rules. Default: `true`. Set `false` for tests that need to see
   * everything, or for "show ignored files" toggles in the UI.
   */
  respectGitignore?: boolean
  /**
   * Maximum depth (measured from the `dir` passed into `walkFilesTree`)
   * the walker descends eagerly. Directories *deeper* than this are
   * returned as `lazy: true` with no children — the IDE then fetches
   * them on demand by re-invoking the walker rooted at the expanded
   * directory.
   *
   * Default: `Infinity` (greedy walk, subject only to the other
   * defensive caps). Set to a small number — `1` is the VS Code
   * first-paint default, `2` is a friendlier middle ground for a
   * permanently-visible side panel — to keep first paints cheap on big
   * repos. The HTTP route and Electron IPC in this repo opt into
   * `eagerDepth: 1` (see `server.ts:GET /agent/workspace/tree` and
   * `apps/desktop/src/fs-ipc.ts:fs:listTree`).
   *
   * Independent of `maxDepth`: this is a UX control ("show lazy stubs
   * past this depth"), `maxDepth` is the safety net ("never recurse
   * past this depth at all").
   */
  eagerDepth?: number
  /** Hard cap on total entries (files + dirs) returned. Default: 50 000. */
  maxEntries?: number
  /** Hard cap on directory depth below `rootDir`. Default: 24. */
  maxDepth?: number
  /** Hard cap on wall-clock time in ms. Default: 5 000. */
  timeBudgetMs?: number
  /** Optional cancellation signal (web-standard `AbortSignal`). */
  signal?: AbortSignal
}

/**
 * One layer of the nested-ignore chain: a parsed `.gitignore`/`.shogoignore`
 * matcher together with the absolute directory it was loaded from. Entry
 * paths are tested *relative to `baseAbs`*, exactly as Git scopes a nested
 * ignore file to its own directory subtree.
 */
interface IgnoreLayer {
  baseAbs: string
  ig: Ignore
}

interface WalkState {
  rootDir: string
  hiddenDirs: ReadonlySet<string>
  lazyDirs: ReadonlySet<string>
  hiddenFiles: ReadonlySet<string>
  respectGitignore: boolean
  eagerDepth: number
  maxEntries: number
  maxDepth: number
  deadline: number
  signal?: AbortSignal
  entriesScanned: number
}

/**
 * Read every supported ignore file at `rootDir` and compose them into a
 * single `ignore` matcher. Returns `null` if there are no ignore files —
 * callers can then skip the per-entry match check entirely.
 *
 * Patterns are kept directory-relative, which is exactly the path shape the
 * walker passes to `.ignores()` (paths relative to `dir`) — so a
 * `node_modules` line correctly matches `node_modules`, `node_modules/lodash`,
 * `nested/node_modules`, etc. via the lib's standard gitignore semantics.
 *
 * Nested ignore files ARE now supported (see `loadAncestorChain` +
 * `walkInner`): each directory's own `.gitignore`/`.shogoignore` is layered
 * on as the walk descends, scoped to that directory's subtree. This matters
 * for the merged workspace tree, where the parent `workspaces/` dir has no
 * ignores but each `<projectId>/` subfolder carries its own (`.env`, build
 * dirs, generated output, …). Returns `null` when `dir` has no ignore files.
 */
async function loadIgnoreMatcher(dir: string): Promise<Ignore | null> {
  let matcher: Ignore | null = null
  for (const file of WORKSPACE_TREE_IGNORE_FILES) {
    let content: string
    try {
      content = await fsp.readFile(join(dir, file), 'utf8')
    } catch {
      continue // file absent or unreadable — fine, just skip
    }
    if (!matcher) matcher = ignore()
    matcher.add(content)
  }
  return matcher
}

/**
 * Build the ignore-layer chain for every ancestor directory from `rootDir`
 * down to (but NOT including) `startDir` — `walkInner` loads `startDir`'s
 * own ignore file itself. When `startDir === rootDir` the chain is empty.
 *
 * This is what makes a *lazy re-fetch* honour nested ignores: when the IDE
 * expands `<projectId>/src`, the walker is re-invoked rooted at that subdir,
 * so the `<projectId>/.gitignore` (an ancestor) must be reconstructed from
 * disk — it isn't carried over from the initial walk.
 */
async function loadAncestorChain(rootDir: string, startDir: string): Promise<IgnoreLayer[]> {
  const root = resolve(rootDir)
  const start = resolve(startDir)
  if (start === root) return []
  const rel = relative(root, start)
  // start outside root (shouldn't happen — callers validate) → no chain.
  if (!rel || rel.startsWith('..')) return []
  const parts = rel.split(sep).filter(Boolean)
  const layers: IgnoreLayer[] = []
  let cur = root
  // root itself, then each ancestor up to parent(startDir).
  const rootIg = await loadIgnoreMatcher(cur)
  if (rootIg) layers.push({ baseAbs: cur, ig: rootIg })
  for (let i = 0; i < parts.length - 1; i++) {
    cur = join(cur, parts[i])
    const ig = await loadIgnoreMatcher(cur)
    if (ig) layers.push({ baseAbs: cur, ig })
  }
  return layers
}

/**
 * True if any layer in the chain ignores `absPath`. Each layer tests the
 * path *relative to its own base dir* (with a trailing slash for dirs, per
 * the `ignore` lib's directory-only-pattern convention). OR-ing layers is a
 * deliberate, slightly-conservative approximation of Git's deepest-wins
 * negation semantics: it can't *re-include* a path a shallower layer hid via
 * a deeper `!pattern`, but that cross-file negation is vanishingly rare and
 * this is still strictly more correct than the old root-only behaviour.
 */
function chainIgnores(chain: IgnoreLayer[], absPath: string, isDir: boolean): boolean {
  for (const layer of chain) {
    const relRaw = relative(layer.baseAbs, absPath)
    if (!relRaw || relRaw.startsWith('..')) continue
    const rel = relRaw.split(sep).join('/')
    if (layer.ig.ignores(isDir ? `${rel}/` : rel)) return true
  }
  return false
}

function withinBudget(state: WalkState): boolean {
  if (state.entriesScanned >= state.maxEntries) return false
  if (Date.now() >= state.deadline) return false
  if (state.signal?.aborted) return false
  return true
}

/**
 * Recursive walk helper. Returns the children of `dir`. `depth` is measured
 * from the original `dir` passed to the public `walkFilesTree` call so the
 * `maxDepth` cap applies symmetrically whether the caller started at the
 * workspace root or expanded into a subdir.
 */
async function walkInner(
  dir: string,
  depth: number,
  state: WalkState,
  chain: IgnoreLayer[],
): Promise<WorkspaceTreeNode[]> {
  if (depth > state.maxDepth) return []

  // Layer this directory's own ignore file(s) onto the chain before
  // scanning its entries, scoped to this subtree. Carried into recursion so
  // descendants inherit every ancestor's rules (merged-tree per-project
  // ignores).
  let localChain = chain
  if (state.respectGitignore) {
    const ownIg = await loadIgnoreMatcher(dir)
    if (ownIg) localChain = [...chain, { baseAbs: dir, ig: ownIg }]
  }
  // Type inferred from the overload — `withFileTypes: true` returns
  // `Dirent<string>[]`. Explicitly annotating with
  // `Awaited<ReturnType<typeof fsp.readdir>>` would pick the broadest
  // overload (Dirent<NonSharedBuffer>) and break downstream string usage.
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    // Path missing, permission denied, or raced with a delete — return
    // empty rather than bubbling. Matches the legacy `existsSync` guard
    // but is robust against the entire family of fs errors.
    return []
  }
  const results: WorkspaceTreeNode[] = []
  for (const entry of entries) {
    if (!withinBudget(state)) break
    const absPath = join(dir, entry.name)
    // Always emit POSIX-style separators so Windows runtimes don't surface
    // `tools\foo\bar.ts` (which the IDE would then URL-encode as `%5C`).
    const relPath = absPath.slice(state.rootDir.length + 1).replace(/\\/g, '/')
    let stat
    try {
      stat = await fsp.stat(absPath)
    } catch {
      // Broken symlink or race with a concurrent delete — skip rather than
      // 500-ing the whole tree.
      continue
    }
    state.entriesScanned++
    const isDir = entry.isDirectory()
    // The `ignore` lib treats trailing-slash patterns as directory-only,
    // so we append a slash for directory paths before checking — matches
    // how `git check-ignore` reads `.gitignore`. Tested against every layer
    // (root → this dir) so per-project nested ignores are honoured.
    const isGitignored = localChain.length > 0
      ? chainIgnores(localChain, absPath, isDir)
      : false
    if (isDir) {
      if (state.hiddenDirs.has(entry.name)) continue
      // Four ways a directory becomes a lazy stub:
      //   1. Member of LAZY_DIRS (built-artifact dirs)
      //   2. Matched by .gitignore / .shogoignore
      //   3. We're at or past `eagerDepth` — the UX cap that keeps first
      //      paints cheap on big repos. The IDE re-invokes the walker
      //      rooted at the expanded dir when the user clicks the chevron,
      //      which fetches the next level the same way.
      //   4. (implicit) `maxDepth` exceeded — handled at the top of the
      //      next recursion call; we keep the dir visible by emitting
      //      `lazy: true` here so the user can still try to expand it.
      if (
        state.lazyDirs.has(entry.name) ||
        isGitignored ||
        depth >= state.eagerDepth
      ) {
        // Visible in the tree but children not walked. Callers fetch
        // children on demand by re-invoking the walker rooted here.
        results.push({
          name: entry.name,
          path: relPath,
          type: 'directory',
          modified: stat.mtimeMs,
          lazy: true,
        })
        continue
      }
      results.push({
        name: entry.name,
        path: relPath,
        type: 'directory',
        modified: stat.mtimeMs,
        children: await walkInner(absPath, depth + 1, state, localChain),
      })
    } else {
      if (state.hiddenFiles.has(entry.name)) continue
      if (isGitignored) continue
      results.push({
        name: entry.name,
        path: relPath,
        type: 'file',
        size: stat.size,
        modified: stat.mtimeMs,
      })
    }
  }
  return results
}

/**
 * Walk a directory recursively, applying the hidden/lazy/hidden-files
 * policy plus root-level `.gitignore` / `.shogoignore`.
 *
 * `dir` is the absolute starting directory. `rootDir` is the absolute
 * workspace root — used to make emitted `path` fields workspace-relative
 * and as the location for ignore-file lookup.
 *
 * Returns the children of `dir`, NOT a node for `dir` itself. Returns an
 * empty array if `dir` doesn't exist or can't be read. Never throws on
 * filesystem errors — those are absorbed into an empty/partial result so
 * one bad path doesn't take down the whole tree.
 */
export async function walkFilesTree(
  dir: string,
  rootDir: string,
  options: WalkFilesTreeOptions = {},
): Promise<WorkspaceTreeNode[]> {
  const respectGitignore = options.respectGitignore !== false
  const state: WalkState = {
    rootDir,
    hiddenDirs: options.hiddenDirs ?? WORKSPACE_TREE_HIDDEN_DIRS,
    lazyDirs: options.lazyDirs ?? WORKSPACE_TREE_LAZY_DIRS,
    hiddenFiles: options.hiddenFiles ?? WORKSPACE_TREE_HIDDEN_FILES,
    respectGitignore,
    eagerDepth: options.eagerDepth ?? Number.POSITIVE_INFINITY,
    maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    deadline: Date.now() + (options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS),
    signal: options.signal,
    entriesScanned: 0,
  }
  // Seed the chain with every ancestor ignore between rootDir and dir so a
  // lazy re-fetch rooted deep in the tree still honours nested ignores it
  // didn't load directly. `walkInner` then adds `dir`'s own layer.
  const ancestorChain = respectGitignore ? await loadAncestorChain(rootDir, dir) : []
  return walkInner(dir, 0, state, ancestorChain)
}
