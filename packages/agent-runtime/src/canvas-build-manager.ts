// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CanvasBuildManager — Drives the workspace's web bundler on file changes.
 *
 * Stack-aware: works for any first-party stack whose bundler binary is in
 * `node_modules/.bin/`.
 *
 * Concretely today:
 *   - Vite stacks (`react-app`, `threejs-game`, `phaser-game`) — invokes
 *     `vite build --outDir dist.staging --emptyOutDir` and atomically
 *     swaps the result into `dist/`.
 *   - Metro stacks (`expo-app`, `expo-three`) — invokes
 *     `expo export --platform web --output-dir dist.staging` and atomically
 *     swaps the result into `dist/`.
 *
 * The historical implementation ran `bun run build` and let package.json
 * pick the command. That worked, but the templates' build scripts target
 * `dist/` directly — both `expo export` and `vite build` clear the output
 * dir before writing, so refreshes during a rebuild (and any failed
 * rebuild) left users staring at a 404. We now invoke the bundler
 * ourselves so we control the output dir and can promote it atomically;
 * see `build-output-commit.ts`.
 *
 * Builds are debounced so rapid file writes don't cause build storms.
 */

import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { resolveBinInvocation } from '@shogo/shared-runtime'
import {
  commitBuildOutput,
  cleanupStagingOutput,
  DEFAULT_STAGING_DIR,
} from './build-output-commit'

const BUILD_DEBOUNCE_MS = 500
const LOG_PREFIX = '[CanvasBuildManager]'

type BundlerKind = 'vite' | 'expo'

/**
 * Bundler binaries we know how to drive directly. When `.tech-stack`
 * doesn't pin a preference (legacy workspaces, unknown ids), the first
 * one we find under `node_modules/.bin/` decides the build command.
 * Vite is listed first as the historical default for Vite-and-Expo
 * hybrids that don't carry a marker.
 *
 * Note: `.tech-stack` (when present and known) overrides this scan
 * order — see `resolveBundler()` and `STACK_TO_BUNDLER`. This is what
 * fixes the cloud Expo rebuild bug: warm pods always have
 * `node_modules/.bin/vite` from the pre-seed, so plain scan order
 * picks Vite forever even after the workspace becomes Expo.
 */
const KNOWN_BUNDLERS: readonly BundlerKind[] = ['vite', 'expo'] as const

/**
 * Tech-stack id (as written to `<workspace>/.tech-stack` by
 * `seedTechStack`) → preferred bundler. Anything not in this map
 * falls back to `KNOWN_BUNDLERS` scan order, preserving today's
 * behavior for marker-less or third-party stacks.
 *
 * Source of truth for the id list lives in
 * `packages/agent-runtime/tech-stacks/<id>/stack.json` (`runtime.devServer`).
 * Keep this map in sync when adding a new first-party stack.
 */
const STACK_TO_BUNDLER: Readonly<Record<string, BundlerKind>> = {
  'react-app': 'vite',
  'threejs-game': 'vite',
  'phaser-game': 'vite',
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
   *      `STACK_TO_BUNDLER`. The corresponding bin must actually exist
   *      under `node_modules/.bin/`; otherwise we fall through.
   *   2. Scan `KNOWN_BUNDLERS` in declaration order and return the
   *      first hit. This is the historical (pre-marker) behavior and
   *      covers legacy workspaces with no marker, third-party stacks,
   *      and the agent-runtime's evals.
   *
   * Returns `null` when no known bundler is installed.
   *
   * Why marker-first: in cloud, warm pods always have
   * `node_modules/.bin/vite` from the pool pre-seed, so plain scan
   * order would pick Vite for every Expo workspace forever — see
   * `__tests__/expo-cloud-rebuild.test.ts` for the regression bar.
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

    const preferred = this.preferredBundlerFromMarker()
    if (preferred) {
      const bin = findBin(preferred)
      if (bin) return { kind: preferred, bin }
      // Marker says expo but no expo bin yet (deps still installing).
      // Falling through to scan order would pick the leftover vite
      // bin and rebuild dist/ with the wrong bundler — which is the
      // exact cloud bug. Bail instead so the next debounced rebuild
      // (after deps land) gets a clean shot.
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
   * `KNOWN_BUNDLERS` scan order in that case.
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
   * Build args that route output into `dist.staging/` instead of
   * `dist/` so we can atomically swap on success. `--emptyOutDir` is
   * passed to Vite explicitly to suppress its "outDir outside project
   * root" warning when users seed exotic vite.config.ts setups.
   */
  private buildArgsFor(kind: BundlerKind): string[] {
    if (kind === 'vite') {
      return ['build', '--outDir', DEFAULT_STAGING_DIR, '--emptyOutDir']
    }
    return ['export', '--platform', 'web', '--output-dir', DEFAULT_STAGING_DIR]
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
    // bundler starts from a clean slate.
    cleanupStagingOutput(this.workspaceDir, DEFAULT_STAGING_DIR)

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
        const proc: ChildProcess = spawn(
          invocation.cmd,
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
      // A swap failure (e.g. a locked file on Windows) is non-fatal: the
      // previous `dist/` keeps serving and the next rebuild will retry.
      const committed = commitBuildOutput(this.workspaceDir, DEFAULT_STAGING_DIR)
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
      cleanupStagingOutput(this.workspaceDir, DEFAULT_STAGING_DIR)
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
