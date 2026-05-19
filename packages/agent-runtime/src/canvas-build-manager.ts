// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CanvasBuildManager — Drives the workspace's Metro/Expo bundler on file
 * changes and atomically promotes the result into `dist/`.
 *
 * Scope today: **Metro stacks only** (`expo-app`, `expo-three`). Invokes
 * `expo export --platform web --output-dir dist.canvas.staging` and
 * commits via `build-output-commit.ts`'s atomic swap.
 *
 * Why not Vite stacks anymore:
 *
 * Vite stacks used to go through this path too — `vite build --outDir
 * dist.canvas.staging --emptyOutDir` followed by atomic swap into
 * `dist/`. That worked on POSIX but collided fatally with
 * `PreviewManager`'s `vite build --watch` on Windows: both builders
 * react to the same source-file changes, and both write to (or
 * eventually rename into) the same `dist/`. The race is intrinsic:
 *
 *   - PreviewManager's vite-watch holds rolling open handles in `dist/`
 *     for in-place chunk rewrites (`--emptyOutDir false`).
 *   - CanvasBuildManager finishes its one-shot vite build, tries to
 *     `renameSync(dist, dist.prev)` — fails because of the vite-watch
 *     handles. Force-replace deletes `dist/` out from under vite-watch
 *     (whose internal rollup chokidar then emits an `ENOENT … mkdir
 *     dist/assets/` chain that's visible in `.build.log`).
 *   - Subsequent `renameSync(dist.canvas.staging, dist)` then fails
 *     EPERM because vite-watch's rollup watcher noticed `dist/`
 *     disappear and immediately recreated it with new open handles
 *     before our second rename could land.
 *
 * `scratch/repro-eperm.ts` reproduces the race deterministically at
 * ~13% of attempts under a deliberately throttled writer; in production
 * with vite rebuilding every ~1s the rate is much higher. There's no
 * retry budget or chokidar tuning that fixes it because the two
 * builders are doing the same job from the same trigger — they're
 * actively breaking each other.
 *
 * Resolution: Vite stacks now build exclusively through PreviewManager's
 * vite-watch. The atomic-swap property we lose isn't actually needed for
 * vite — `--emptyOutDir false` rewrites files in place, so a failed
 * incremental build leaves the previous good `dist/` untouched (the
 * exact safety property `build-output-commit.ts` was created to
 * provide). The reload-toast signal that used to come from
 * `onBuildComplete` is now driven by PreviewManager parsing
 * vite-watch's `built in N ms` stdout line; see
 * `preview-manager.ts`'s `onBuildComplete` callback.
 *
 * Why `dist.canvas.staging/` and not the shared `dist.staging/`:
 * `PreviewManager.runExpoExportWeb` also builds into a staging dir at
 * boot to seed `dist/` for the runtime's preview iframe. That call runs
 * in parallel with `CanvasBuildManager.start()`'s first build, and both
 * call `cleanupStagingOutput` (a recursive `rmSync`) before spawning
 * their bundler. With a shared staging name, one builder's cleanup can
 * wipe the other's in-progress output mid-copy — surfaces as `ENOENT …
 * copyfile 'public/<asset>' -> 'dist.staging/<asset>'` from CopyFileW
 * when the destination directory disappears under a large-file copy
 * (e.g. a multi-megabyte GLB in `public/`). Giving the canvas builder
 * its own staging dir keeps both managers' cleanups disjoint.
 *
 * Builds are debounced so rapid file writes don't cause build storms.
 */

import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { resolveBinInvocation } from '@shogo/shared-runtime'
import {
  commitBuildOutputAsync,
  cleanupStagingOutput,
} from './build-output-commit'

/**
 * Staging directory name owned exclusively by `CanvasBuildManager`.
 *
 * Distinct from `DEFAULT_STAGING_DIR` (`dist.staging/`) which is owned
 * by `PreviewManager`. See the file-level docstring for the race this
 * separation prevents. Must stay in sync with the gitignore /
 * UNTRACK_IF_TRACKED entries in `apps/api/src/services/git.service.ts`
 * — otherwise it'd get checkpointed on every chat turn.
 */
const CANVAS_STAGING_DIR = 'dist.canvas.staging'

const BUILD_DEBOUNCE_MS = 500
const LOG_PREFIX = '[CanvasBuildManager]'

type BundlerKind = 'expo'

/**
 * Bundler binaries we know how to drive directly. Limited to Metro/Expo
 * — Vite stacks are handled exclusively by PreviewManager's
 * `vite build --watch` (see the file-level docstring for why parallel
 * vite-build paths collide fatally on Windows).
 *
 * `.tech-stack` (when present and known) overrides this scan order —
 * see `resolveBundler()` and `STACK_TO_BUNDLER`. The scan-order fallback
 * exists for marker-less workspaces (legacy projects, ad-hoc evals);
 * since vite isn't in the list a workspace with only a vite bin will
 * skip the canvas build entirely, which is the correct outcome — its
 * vite-watch in PreviewManager already covers rebuilds-on-change.
 */
const KNOWN_BUNDLERS: readonly BundlerKind[] = ['expo'] as const

/**
 * Tech-stack id (as written to `<workspace>/.tech-stack` by
 * `seedTechStack`) → bundler this manager will drive. Vite stacks are
 * deliberately absent: they are owned by PreviewManager's vite-watch.
 * A marker that maps to nothing here falls through to `KNOWN_BUNDLERS`
 * scan order, which for vite-only workspaces ultimately resolves to
 * `null` (no build), and that's intentional — see file docstring.
 *
 * Source of truth for the id list lives in
 * `packages/agent-runtime/tech-stacks/<id>/stack.json` (`runtime.devServer`).
 * Keep this map in sync when adding a new first-party stack.
 */
const STACK_TO_BUNDLER: Readonly<Record<string, BundlerKind>> = {
  'expo-app': 'expo',
  'expo-three': 'expo',
}

export interface CanvasBuildCallbacks {
  onBuildComplete: () => void
  onBuildError: (error: string) => void
  /**
   * Optional gate awaited before each `runBuild()` spawns the bundler.
   * Used by AgentGateway to block canvas builds until
   * `PreviewManager.installDepsIfNeeded()` has settled.
   *
   * Without this gate, VM-isolated sessions on macOS hosts crash
   * deterministically: the host installs `node_modules` with only the
   * Darwin rollup native, the linux guest 9p-mounts it, vite's config
   * loader requires `@rollup/rollup-linux-<arch>-gnu`, fails, and
   * surfaces as `error during build: undefined`. See PreviewManager's
   * `depsReady` for the full chain.
   *
   * The wait is bounded by `WAIT_FOR_DEPS_TIMEOUT_MS` to prevent a
   * misconfigured environment (no preview manager wired, deferred
   * never resolves) from hanging the build forever — the build then
   * proceeds anyway and reports whatever real error it hits.
   */
  waitForDeps?: () => Promise<void>
}

/**
 * How long `runBuild()` will wait on `waitForDeps()` before giving up
 * and proceeding anyway. 120s is comfortably longer than a cold
 * `bun install` on a fresh VM-9p mount (observed up to ~40s in
 * main.log), without making the user wait forever if the gate is
 * broken.
 */
const WAIT_FOR_DEPS_TIMEOUT_MS = 120_000

/**
 * Bundler stderr/stdout slice ceiling for error reporting. The
 * historical 200-char limit cut the actual error off mid-frame on
 * vite/rollup native-binding failures (the friendly message lives at
 * the bottom of a 30+ line trace), which is what made
 * `error during build: undefined` so common — most of the useful
 * text never made it into the log line. 4000 is enough for the full
 * vite friendly-error block and a short stack tail.
 */
const ERROR_SLICE_LIMIT = 4000

export class CanvasBuildManager {
  private workspaceDir: string
  private outDir: string
  private callbacks: CanvasBuildCallbacks
  private buildTimer: ReturnType<typeof setTimeout> | null = null
  private building = false
  private pendingBuild = false
  private buildCount = 0
  private _started = false

  constructor(
    workspaceDir: string,
    callbacks: CanvasBuildCallbacks,
  ) {
    this.workspaceDir = workspaceDir
    this.outDir = join(workspaceDir, 'dist')
    this.callbacks = callbacks
  }

  async start(): Promise<void> {
    await this.runBuild()
    this._started = true
  }

  triggerRebuild(): void {
    if (this.buildTimer) clearTimeout(this.buildTimer)
    this.buildTimer = setTimeout(() => {
      this.runBuild()
    }, BUILD_DEBOUNCE_MS)
  }

  get started(): boolean {
    return this._started
  }

  /** True while a build is in flight. Used by the runtime's static handler
   *  to render a "Building..." placeholder when neither `dist/` nor a
   *  prior build is available. */
  get isBuilding(): boolean {
    return this.building
  }

  isReady(): boolean {
    return this._started && existsSync(join(this.outDir, 'index.html'))
  }

  getOutDir(): string {
    return this.outDir
  }

  /**
   * Resolve the bundler binary to invoke. Picks the platform-correct
   * shim (`.CMD` on Windows, no-extension on POSIX).
   *
   * Selection order:
   *   1. `.tech-stack` marker, when it names a stack we recognize in
   *      `STACK_TO_BUNDLER` (Expo stacks only post-2026-05 — see file
   *      docstring on the vite removal). The corresponding bin must
   *      actually exist under `node_modules/.bin/`; otherwise we
   *      return null (no fallthrough to scan order). This guards the
   *      cloud Expo cold-start: warm pods used to have a stale `vite`
   *      bin around that scan order would pick first; we now never
   *      build vite, but the marker→null bail also covers
   *      `expo bin not yet installed` so the build retries after deps
   *      land.
   *   2. Scan `KNOWN_BUNDLERS` for marker-less workspaces. Today this
   *      is just `['expo']`.
   *
   * Returns `null` when no known bundler is installed, when the
   * workspace's marker resolves to a bundler this manager no longer
   * drives (vite stacks), or when the resolved bundler's bin isn't
   * present yet.
   */
  private resolveBundler(): { kind: BundlerKind; bin: string } | null {
    const binDir = join(this.workspaceDir, 'node_modules', '.bin')
    const isWindows = process.platform === 'win32'

    const findBin = (kind: BundlerKind): string | undefined => {
      const candidates = isWindows
        ? [join(binDir, `${kind}.CMD`), join(binDir, `${kind}.cmd`), join(binDir, `${kind}.exe`)]
        : [join(binDir, kind)]
      return candidates.find((p) => existsSync(p))
    }

    // Vite stacks are owned by PreviewManager; bail without falling
    // through to scan order so a workspace that ships both `vite` and
    // `expo` bins (rare but possible) still gets the marker-driven
    // verdict (skip).
    if (this.markerNamesViteStack()) return null

    const preferred = this.preferredBundlerFromMarker()
    if (preferred) {
      const bin = findBin(preferred)
      if (bin) return { kind: preferred, bin }
      return null
    }

    for (const kind of KNOWN_BUNDLERS) {
      const bin = findBin(kind)
      if (bin) return { kind, bin }
    }
    return null
  }

  /**
   * Read `<workspace>/.tech-stack` (written by `seedTechStack`) and
   * map it through `STACK_TO_BUNDLER`. Returns `null` for missing,
   * unreadable, or unrecognized markers — caller falls back to
   * `KNOWN_BUNDLERS` scan order in that case. Vite stack ids resolve
   * to `null` here because `STACK_TO_BUNDLER` deliberately omits them.
   */
  private preferredBundlerFromMarker(): BundlerKind | null {
    try {
      const markerPath = join(this.workspaceDir, '.tech-stack')
      if (!existsSync(markerPath)) return null
      const stackId = readFileSync(markerPath, 'utf-8').trim()
      return STACK_TO_BUNDLER[stackId] ?? null
    } catch {
      return null
    }
  }

  /**
   * Returns true when `.tech-stack` explicitly names a Vite stack.
   * Used by `resolveBundler` to bail without falling through to
   * `KNOWN_BUNDLERS` scan order — PreviewManager's vite-watch owns
   * those workspaces. Kept as a tight string-set check so adding a
   * new vite-flavored stack id only requires one edit (here).
   */
  private markerNamesViteStack(): boolean {
    try {
      const markerPath = join(this.workspaceDir, '.tech-stack')
      if (!existsSync(markerPath)) return false
      const stackId = readFileSync(markerPath, 'utf-8').trim()
      return stackId === 'react-app' || stackId === 'threejs-game' || stackId === 'phaser-game'
    } catch {
      return false
    }
  }

  /**
   * Build args that route output into `CANVAS_STAGING_DIR` instead of
   * `dist/` so we can atomically swap on success.
   */
  private buildArgsFor(_kind: BundlerKind): string[] {
    return ['export', '--platform', 'web', '--output-dir', CANVAS_STAGING_DIR]
  }

  private async runBuild(): Promise<void> {
    if (this.building) {
      this.pendingBuild = true
      return
    }

    if (!existsSync(join(this.workspaceDir, 'package.json'))) {
      return
    }
    const bundler = this.resolveBundler()
    if (!bundler) {
      return
    }

    this.building = true

    // Block the build on `PreviewManager.depsReady` if a gate is wired
    // in. Critical for VM-isolated sessions on macOS hosts; harmless
    // (resolves immediately) for cloud/k8s where the install has
    // already completed by the time the gateway boots.
    if (this.callbacks.waitForDeps) {
      try {
        await Promise.race([
          this.callbacks.waitForDeps(),
          new Promise<void>((_, reject) => {
            setTimeout(
              () => reject(new Error(`waitForDeps timed out after ${WAIT_FOR_DEPS_TIMEOUT_MS}ms`)),
              WAIT_FOR_DEPS_TIMEOUT_MS,
            )
          }),
        ])
      } catch (err: any) {
        console.warn(
          `${LOG_PREFIX} waitForDeps gate did not settle (${err?.message ?? err}) — building anyway, expect platform-native errors if node_modules is incomplete`,
        )
      }
    }

    // Wipe any leftover staging dir from a prior crashed build so the
    // bundler starts from a clean slate. Only touches our own
    // `CANVAS_STAGING_DIR`; PreviewManager's `dist.staging/` is its
    // problem to clean up.
    cleanupStagingOutput(this.workspaceDir, CANVAS_STAGING_DIR)

    const isWindows = process.platform === 'win32'
    // Route through bundled `bun` when the system has no `node` on PATH
    // — the .bin shim's `#!/usr/bin/env node` shebang otherwise exits
    // 127 with `env: node: No such file or directory`, breaking every
    // canvas rebuild on Shogo Desktop bundles. Falls back to direct
    // spawn when the helper can't readlink the shim. See
    // resolveBinInvocation() for the full rationale.
    const invocation = resolveBinInvocation(this.workspaceDir, bundler.kind) ?? {
      cmd: bundler.bin,
      argsPrefix: [],
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const cmd = isWindows ? `"${invocation.cmd}"` : invocation.cmd
        const proc: ChildProcess = spawn(
          cmd,
          [...invocation.argsPrefix, ...this.buildArgsFor(bundler.kind)],
          {
            cwd: this.workspaceDir,
            stdio: ['ignore', 'pipe', 'pipe'],
            // `.CMD` shims must go through cmd.exe on Windows. Mirrors the
            // shape of the spawn calls in PreviewManager.
            shell: isWindows,
            env: {
              ...process.env,
              NODE_ENV: 'development',
              // Keep Expo non-interactive so a missing dep doesn't deadlock
              // the spawn waiting on stdin.
              CI: '1',
            },
          },
        )

        let stderr = ''
        let stdout = ''
        proc.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
        })
        proc.stdout?.on('data', (chunk: Buffer) => {
          // Vite/rollup emit the friendly-error block on stdout, with
          // the actual error message in stderr only as a one-liner
          // (and sometimes empty). Capturing both is the difference
          // between "error during build: undefined" and a usable
          // diagnostic.
          stdout += chunk.toString()
        })

        proc.on('close', (code) => {
          if (code === 0) {
            resolve()
            return
          }
          // Prefer stderr; fall back to stdout when the bundler
          // wrote its useful output there (vite does this for
          // config-loader failures). Never throw an `Error` with an
          // empty message — that's what produced
          // `error during build: undefined` in main.log.
          const errText = stderr.trim() || stdout.trim() || `Build exited with code ${code}`
          reject(new Error(errText))
        })
        proc.on('error', reject)
      })

      // Bundler succeeded — promote the staging dir into `dist/` atomically.
      // Routes through the workspace-scoped commit mutex so PreviewManager's
      // boot-time expo/vite seed and our own canvas builds can't race on
      // `dist.prev/` rotation. A swap failure (e.g. a locked file on
      // Windows that outlasted the retry budget AND the force-replace
      // fallback) is non-fatal: the previous `dist/` keeps serving and the
      // next rebuild will retry.
      const committed = await commitBuildOutputAsync(this.workspaceDir, CANVAS_STAGING_DIR)
      if (!committed) {
        console.warn(
          `${LOG_PREFIX} Build succeeded but commit into dist/ failed — previous build remains live`,
        )
      }

      this.buildCount++
      console.log(`${LOG_PREFIX} Build #${this.buildCount} (${bundler.kind}) complete → ${this.outDir}`)
      this.callbacks.onBuildComplete()
    } catch (err: any) {
      // Failed build: drop the partial staging output so it doesn't
      // poison the next swap, and leave `dist/` untouched.
      cleanupStagingOutput(this.workspaceDir, CANVAS_STAGING_DIR)
      const message = String(err?.message ?? err ?? '(no error message)')
      // Slice generously — see ERROR_SLICE_LIMIT comment. The 200-char
      // cap dropped vite/rollup's actual error frame, which is what
      // made cross-arch native binding failures unreadable in main.log.
      console.error(`${LOG_PREFIX} Build error:`, message.slice(0, ERROR_SLICE_LIMIT))
      this.callbacks.onBuildError(message)
    } finally {
      this.building = false
      if (this.pendingBuild) {
        this.pendingBuild = false
        this.runBuild()
      }
    }
  }

  stop(): void {
    if (this.buildTimer) {
      clearTimeout(this.buildTimer)
      this.buildTimer = null
    }
  }
}
