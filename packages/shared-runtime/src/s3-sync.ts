// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * S3 Sync Module (Layered Archive)
 *
 * Provides bidirectional file synchronization between S3 and local filesystem.
 * Uses a TWO-LAYER archive strategy to make cold starts near-instant:
 *
 * Layer 1: deps archive (node_modules/)
 *   - Keyed by hash of bun.lock (content-addressed)
 *   - Only re-uploaded when dependencies change
 *   - Shared across pod restarts with same lockfile
 *   - ~150-200MB compressed, but rarely changes
 *
 * Layer 2: project archive (source + dist + config)
 *   - Everything EXCEPT node_modules
 *   - Small (~2-10MB), updated frequently
 *   - Fast to create and extract (<2s)
 *
 * Cold start performance:
 *   Before: Download 162MB tar.gz → Extract 37K files → 72s
 *   After:  Download ~5MB tar.gz → Extract ~300 files → <2s
 *           (node_modules cached by lockfile hash, usually already present)
 *
 * Features:
 * - Content-addressed deps caching (hash of bun.lock)
 * - Small project archive for fast sync
 * - Event-driven sync: file watcher triggers debounced upload on changes
 * - Explicit sync trigger via triggerSync() for critical write operations
 * - Backward compatible: reads legacy project.tar.gz if layered archives missing
 */

import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { watch } from 'fs'
import { readdir, readFile, writeFile, mkdir, stat, unlink, rm } from 'fs/promises'
import { join, relative, dirname } from 'path'
import { existsSync, statSync, mkdirSync } from 'fs'
import { createHash } from 'crypto'
import { spawn } from 'child_process'
import * as tar from 'tar'
import { isMacOSJunkName } from './macos-junk'

/**
 * Extract a `.tar.gz` archive without blocking the Node/Bun event loop.
 *
 * Why not `tar.extract` from `node-tar` directly?
 *   For large archives (~130 MB / 30k+ files) the JS-side gunzip plus the
 *   per-entry `writeFile` / `chmod` calls accumulate enough event-loop
 *   work to starve the readiness handler. The Knative queue-proxy probes
 *   `/ready` on a sub-second interval; a starved loop misses those probes
 *   and the activator marks the pod NotReady, leaving the activator in
 *   path with its hardcoded 5-minute request timeout — which was the root
 *   cause of the `eof-without-turn-complete` chats in staging.
 *
 *   Spawning the system `tar` binary as a child process moves all of the
 *   gunzip + write work off the JS thread; the parent only awaits the
 *   process exit. We fall back to `node-tar` when the system binary is
 *   missing (e.g. minimal containers).
 */
/**
 * tar stderr lines we consider benign — they don't indicate the archive
 * extracted incorrectly, only that `tar` couldn't perfectly mirror macOS
 * filesystem metadata into the Linux container.
 *
 * Seen in staging on 2026-05-13 for project 9e7ecdc7: the workspace archive
 * (created on a macOS host with `xattrs` and SIP provenance metadata)
 * extracted ALL file payloads correctly but `tar` exited code 2 because:
 *   1. `LIBARCHIVE.xattr.com.apple.provenance` PAX header was unrecognized,
 *   2. `Cannot utime / Cannot change mode: Operation not permitted` on the
 *      workspace root, because that dir is mounted with restricted perms.
 * The previous code rejected on any non-zero exit, then `initializeS3Sync`
 * swallowed the rejection into `stats.errors[]` and the pod kept booting
 * with a half-extracted workspace. The benign-pattern allowlist below
 * lets a "no real files failed" extract complete; anything outside the
 * allowlist still surfaces as a hard error.
 */
const BENIGN_TAR_STDERR_PATTERNS: RegExp[] = [
  /Ignoring unknown extended header keyword/i,
  /Cannot u?time/i,
  /Cannot change (mode|ownership)/i,
  /Cannot change owner/i,
  /Operation not permitted/i,
  /Exiting with failure status due to previous errors/i,
]

/**
 * Returns true if every non-empty line in `stderr` matches one of the
 * benign patterns above (i.e. tar exited non-zero but only complained
 * about cosmetic metadata it couldn't apply). Exported for tests.
 */
export function tarStderrIsBenign(stderr: string): boolean {
  const lines = stderr.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  if (lines.length === 0) return false
  return lines.every((line) => BENIGN_TAR_STDERR_PATTERNS.some((re) => re.test(line)))
}

/**
 * One-shot probe + memoize: is the system `zstd` (or `tar` with zstd
 * support) usable? Cached for the lifetime of the process so we don't
 * pay per-spawn overhead on every `uploadDepsIfNeeded`. Result is
 * conservative — any spawn error surfaces as `false`.
 */
let zstdProbed: boolean | null = null
async function isZstdAvailable(): Promise<boolean> {
  if (zstdProbed !== null) return zstdProbed
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn('zstd', ['--version'], { stdio: 'ignore' })
    child.once('error', () => resolve(false))
    child.once('exit', (code) => resolve(code === 0))
  })
  zstdProbed = ok
  return ok
}

/**
 * Create a `.tar.zst` archive via the system `tar` binary, piping
 * compression through `zstd -T0` for maximum throughput. Uses a
 * `-T <files-from-fd>` argument list to keep the command line short
 * even for ~30k node_modules paths.
 */
async function createTarZst(
  outPath: string,
  cwd: string,
  filesRelative: string[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'tar',
      [
        '--use-compress-program=zstd -T0',
        '-cf',
        outPath,
        '--no-xattrs',
        '-T', '-',
        '-C',
        cwd,
      ],
      {
        stdio: ['pipe', 'ignore', 'pipe'],
        env: { ...process.env, COPYFILE_DISABLE: '1' },
      },
    )
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) {
        resolve()
      } else if (tarStderrIsBenign(stderr)) {
        console.warn(
          `[S3Sync] tar --use-compress-program=zstd exited with code ${code} ` +
          `but only emitted benign metadata warnings; treating create as successful.`,
        )
        resolve()
      } else {
        reject(new Error(`tar create (zst) exited with code ${code}: ${stderr.trim()}`))
      }
    })
    child.stdin.end(filesRelative.join('\n') + '\n')
  })
}

export async function extractTarFastNonBlocking(
  archivePath: string,
  cwd: string,
): Promise<{ usedBinary: boolean }> {
  // Compression dispatch by extension. On a typical 133 MB node_modules
  // archive, zstd decompresses ~3-5× faster than gzip — biggest single
  // win for cold-start latency. We support both transparently:
  //   - .tar.zst → `--use-compress-program=unzstd`
  //   - .tar.gz  → `-z` (legacy and node-tar fallback)
  // Anything else falls through to gzip behavior to preserve the
  // historical contract.
  const isZstd = archivePath.endsWith('.tar.zst') || archivePath.endsWith('.tzst')
  const tarArgs = isZstd
    ? [
        '--use-compress-program=unzstd',
        '-xf',
        archivePath,
        '-C',
        cwd,
        '--no-same-owner',
        '--no-same-permissions',
      ]
    : [
        '-xzf',
        archivePath,
        '-C',
        cwd,
        // Don't try to restore the source machine's uid/gid/perms onto the
        // container's workspace. Otherwise tar attempts `chmod`/`chown` on
        // the destination root dir (which we don't own) and exits non-zero.
        // Both flags are supported by GNU tar (Linux) and BSD tar (macOS).
        '--no-same-owner',
        '--no-same-permissions',
        // NOTE: we used to also pass `--warning=no-unknown-keyword` here to
        // suppress macOS xattr PAX-header noise, but that's GNU-only and
        // BSD tar (macOS dev hosts) treats it as a fatal "unknown option".
        // The benign-stderr predicate downstream already accepts those
        // warnings, so we leave them to surface as logged stderr.
      ]
  const result = await new Promise<{ usedBinary: boolean }>((resolve, reject) => {
    const child = spawn(
      'tar',
      tarArgs,
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        // Prevent BSD `tar` on macOS from writing AppleDouble sidecars (`._*`)
        // when re-materializing extended attributes during extract. Belt-and-
        // braces alongside the post-extract scrub below.
        env: { ...process.env, COPYFILE_DISABLE: '1' },
      },
    )

    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })

    child.once('error', async (err: NodeJS.ErrnoException) => {
      // ENOENT: no `tar` binary available — fall back to node-tar.
      // node-tar handles gzip natively but NOT zstd; surfacing a clear
      // error there beats a confusing "unsupported algorithm" deep
      // inside the streaming gunzip path.
      if (err.code === 'ENOENT') {
        if (isZstd) {
          reject(new Error(
            `extractTarFastNonBlocking: system tar missing and node-tar cannot ` +
            `decompress zstd archives. Install tar+zstd in the runtime image, ` +
            `or fall back to a .tar.gz key.`,
          ))
          return
        }
        try {
          await tar.extract({ file: archivePath, cwd, strip: 0 })
          resolve({ usedBinary: false })
        } catch (fallbackErr) {
          reject(fallbackErr)
        }
        return
      }
      reject(err)
    })

    child.once('exit', (code) => {
      if (code === 0) {
        resolve({ usedBinary: true })
        return
      }
      // Non-zero exit, but only if stderr is exclusively the known-benign
      // macOS metadata noise do we let the extract complete. Anything else
      // (truncated archive, gzip corruption, missing disk space, etc.)
      // must surface — a half-extracted workspace is worse than a hard
      // failure because subsequent boot steps silently run against a
      // partial source tree.
      const flagLabel = isZstd ? 'tar --use-compress-program=unzstd' : 'tar -xzf'
      if (tarStderrIsBenign(stderr)) {
        console.warn(
          `[S3Sync] ${flagLabel} exited with code ${code} but only emitted benign ` +
            `macOS metadata warnings; treating extract as successful. ` +
            `First line: ${stderr.split('\n')[0]?.trim() ?? '(empty)'}`,
        )
        resolve({ usedBinary: true })
      } else {
        reject(new Error(`${flagLabel} exited with code ${code}: ${stderr.trim()}`))
      }
    })
  })

  // Scrub macOS detritus that may have been baked into legacy archives still
  // sitting in S3 (created before the export filters landed). AppleDouble
  // sidecars like `._\_layout.tsx` crash Metro's Babel parser if they survive
  // into the imported workspace, so this runs unconditionally — cheap because
  // it only walks the freshly-extracted project (no node_modules yet).
  try {
    await removeMacOSJunk(cwd)
  } catch (err) {
    // Non-fatal: failing to scrub is much better than failing the import.
    console.warn('[S3Sync] removeMacOSJunk failed:', err)
  }

  return result
}

/**
 * Recursively remove macOS-specific junk files/dirs from `dir`. Idempotent;
 * safe to call repeatedly. Junk directories are removed wholesale via `rm`
 * with recursive: true.
 */
async function removeMacOSJunk(dir: string): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (isMacOSJunkName(entry.name)) {
      try {
        if (entry.isDirectory()) {
          await rm(full, { recursive: true, force: true })
        } else {
          await unlink(full)
        }
      } catch {
        // ignore — best-effort cleanup
      }
      continue
    }
    if (entry.isDirectory()) {
      await removeMacOSJunk(full)
    }
  }
}

// =============================================================================
// Types
// =============================================================================

export interface S3SyncConfig {
  /** S3 bucket name */
  bucket: string
  /** S3 prefix (usually project ID) */
  prefix: string
  /** Local directory to sync */
  localDir: string
  /** S3 endpoint URL (for MinIO) */
  endpoint?: string
  /** AWS region */
  region?: string
  /** Force path-style URLs (for MinIO) */
  forcePathStyle?: boolean
  /** Patterns to exclude from sync (relative paths) */
  exclude?: string[]
  /** Sync interval in milliseconds (0 to disable periodic sync) */
  syncInterval?: number
  /** Enable file watcher for real-time sync */
  watchEnabled?: boolean
  /**
   * When true, the Layer 2 (`project-src.tar.gz`) uploader no-ops on every
   * code path: the file watcher's debounce trigger, the periodic interval,
   * and explicit `triggerSync()` calls. Layer 1 (deps cache) is unaffected.
   *
   * Used by `agent-runtime` in `git_only` mode: the per-turn diff is
   * pushed to the smart-HTTP backend via `GitWorkspaceSync`, and S3
   * stays armed only to write the final cold-start snapshot at evict
   * time (`flushAndShutdown({ forceProjectArchive: true })`) AND as an
   * automatic fallback when git fails (see `setSuppressProjectArchive`).
   */
  suppressProjectArchive?: boolean
}

export interface SyncStats {
  downloaded: number
  uploaded: number
  deleted: number
  errors: string[]
  lastSync: Date | null
  archiveSize?: number
  /** Whether deps were restored from cache */
  depsCacheHit?: boolean
  /** Time to extract project archive (ms) */
  projectExtractMs?: number
  /** Time to extract deps archive (ms) */
  depsExtractMs?: number
}

// =============================================================================
// S3 Sync Class (Layered Archive)
// =============================================================================

/** Default debounce delay for event-driven sync (ms) */
const SYNC_DEBOUNCE_MS = 3000

/** S3 key prefix for deps archives (shared across projects) */
const DEPS_CACHE_PREFIX = '_deps-cache'

export class S3Sync {
  private client: S3Client
  private config: Omit<Required<S3SyncConfig>, 'endpoint'> & { endpoint?: string }
  private stats: SyncStats = {
    downloaded: 0,
    uploaded: 0,
    deleted: 0,
    errors: [],
    lastSync: null,
  }
  private syncTimer: ReturnType<typeof setInterval> | null = null
  private watcher: ReturnType<typeof watch> | null = null
  private pendingUploads: Set<string> = new Set()
  private uploadDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private lastUploadHash: string = ''
  private isUploading: boolean = false
  private uploadRequestedDuringUpload: boolean = false
  /** Track the current lockfile hash to detect dep changes */
  private currentLockfileHash: string = ''
  /** Whether deps need to be uploaded (lockfile changed since last deps upload) */
  private depsNeedUpload: boolean = false
  /** Resolves when background deps restoration completes (or immediately if not needed) */
  private _depsReadyPromise: Promise<void> | null = null
  private _depsReadyResolve: (() => void) | null = null
  private _depsReady: boolean = true

  /**
   * Runtime-mutable suppression of Layer 2 (project archive) uploads.
   * Initialized from `S3SyncConfig.suppressProjectArchive`. Can be
   * toggled at any time via `setSuppressProjectArchive` — used by
   * `GitWorkspaceSync.onDegrade` to re-enable Layer 2 as a fallback
   * when git is unhealthy.
   */
  private suppressProjectArchive: boolean = false

  constructor(config: S3SyncConfig) {
    this.suppressProjectArchive = config.suppressProjectArchive ?? false
    this.config = {
      bucket: config.bucket,
      prefix: config.prefix,
      localDir: config.localDir,
      endpoint: config.endpoint || process.env.S3_ENDPOINT,
      region: config.region || process.env.S3_REGION || 'us-east-1',
      forcePathStyle: config.forcePathStyle ?? (process.env.S3_FORCE_PATH_STYLE === 'true'),
      // Exclude patterns - these won't be included in archives.
      //
      // Notes on coverage:
      //   - `node_modules` at any depth is already filtered by the
      //     `excludeDirs` arg passed to listLocalFiles() during archive
      //     creation (see uploadProjectArchive). Listing here as a
      //     belt-and-braces glob, but the dir-name filter is what
      //     actually gates inclusion.
      //   - Expo / Metro stash a large amount of build state under
      //     `.expo/` (manifest cache, prebuild artifacts) and Metro's
      //     own bundle cache under `.metro-cache/`. These are
      //     reproducible from `node_modules` + source, so excluding them
      //     matches our treatment of `dist/` and avoids ballooning the
      //     project archive on RN projects.
      exclude: config.exclude || [
        '.DS_Store',
        '*.log',
        'playwright-report',
        'test-results',
        'project/node_modules',
        '.bun',
        '.npm',
        '.cache',
        '.expo',
        '.metro-cache',
        '.expo-shared',
      ],
      syncInterval: config.syncInterval ?? 30000, // 30 seconds default
      watchEnabled: config.watchEnabled ?? true,
      suppressProjectArchive: config.suppressProjectArchive ?? false,
    }

    this.client = new S3Client({
      region: this.config.region,
      ...(this.config.endpoint && {
        endpoint: this.config.endpoint,
        forcePathStyle: true,
      }),
      credentials: process.env.AWS_ACCESS_KEY_ID ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      } : undefined,
    })

    console.log(`[S3Sync] Initialized for ${this.config.bucket}/${this.config.prefix}`)
    if (this.config.endpoint) {
      console.log(`[S3Sync] Using custom endpoint: ${this.config.endpoint}`)
    }
  }

  /**
   * Mark the current lockfile hash as already synced so the first upload
   * cycle won't try to create a deps archive. Call this when node_modules
   * were pre-seeded from a template (not restored from S3) to avoid an
   * expensive tar.gz of 37K+ files that can OOM small containers.
   */
  async markDepsPreSeeded(): Promise<void> {
    const hash = await this.computeLockfileHash()
    if (hash) {
      this.currentLockfileHash = hash
      this.depsNeedUpload = false
      console.log(`[S3Sync] Marked deps as pre-seeded (lockfile hash: ${hash})`)
    }
  }

  /**
   * Signal that the workspace's node_modules has just been re-installed
   * (typically by `ensureWorkspaceDeps` because the warm-pool template's
   * pre-seeded deps didn't match the user's `package.json`). Clears the
   * pre-seeded marker so the next `uploadDepsIfNeeded` actually tars and
   * uploads the new deps + writes the per-project pointer.
   *
   * Without this, a warm pool pod that came up with a Vite template and
   * then got re-installed for an Expo project would forever skip the
   * deps upload, leaving `_deps-cache/<hash>.tar.gz` + `deps-hash.txt`
   * unwritten in S3. Subsequent pool assignments for the same project
   * would then have to run a full `bun install` cold every time — which
   * is what fell over on the 2026-05-14 staging disk-pressure incident.
   */
  markDepsChanged(): void {
    this.currentLockfileHash = ''
    this.depsNeedUpload = true
    console.log('[S3Sync] Deps marked as changed; next periodic sync will re-upload deps + pointer')
  }

  /** Wait for background deps restoration to complete. Resolves immediately if deps are already ready. */
  async waitForDeps(): Promise<void> {
    if (this._depsReady) return
    if (this._depsReadyPromise) await this._depsReadyPromise
  }

  /** Check synchronously whether deps are available. */
  areDepsReady(): boolean {
    return this._depsReady
  }

  /** Create a pending deps-ready gate. Call resolveDepsReady() when deps are available. */
  private beginDepsRestore(): void {
    this._depsReady = false
    this._depsReadyPromise = new Promise<void>((resolve) => {
      this._depsReadyResolve = resolve
    })
  }

  /** Mark deps as ready, resolving any waiters. */
  private resolveDepsReady(): void {
    this._depsReady = true
    this._depsReadyResolve?.()
    this._depsReadyResolve = null
    this._depsReadyPromise = null
  }

  // ===========================================================================
  // S3 Key Helpers
  // ===========================================================================

  /** Legacy single-archive key (for backward compatibility) */
  private getLegacyArchiveKey(): string {
    return `${this.config.prefix}/project.tar.gz`
  }

  /** Project archive key (source + dist, no node_modules) */
  private getProjectArchiveKey(): string {
    return `${this.config.prefix}/project-src.tar.gz`
  }

  /**
   * Deps archive key (content-addressed by lockfile hash).
   *
   * Two extensions supported during the gzip → zstd transition:
   *   - .tar.zst (preferred, ~3-5× faster decompression)
   *   - .tar.gz  (legacy, still readable so existing cached archives
   *              and pods baked before the zstd switch keep working)
   *
   * Reads try `.tar.zst` first via `getDepsArchiveKeys`; writes always
   * produce `.tar.zst` when the system zstd binary is available, else
   * fall back to gzip.
   */
  private getDepsArchiveKey(lockfileHash: string, ext: 'zst' | 'gz' = 'zst'): string {
    return ext === 'zst'
      ? `${DEPS_CACHE_PREFIX}/${lockfileHash}.tar.zst`
      : `${DEPS_CACHE_PREFIX}/${lockfileHash}.tar.gz`
  }

  /** Both candidate keys, in read-preference order. */
  private getDepsArchiveKeys(lockfileHash: string): Array<{ key: string; ext: 'zst' | 'gz' }> {
    return [
      { key: this.getDepsArchiveKey(lockfileHash, 'zst'), ext: 'zst' },
      { key: this.getDepsArchiveKey(lockfileHash, 'gz'), ext: 'gz' },
    ]
  }

  /** Per-project pointer to the current deps hash */
  private getDepsPointerKey(): string {
    return `${this.config.prefix}/deps-hash.txt`
  }

  // ===========================================================================
  // Lockfile Hashing
  // ===========================================================================

  /** Compute SHA-256 hash of bun.lock (or package-lock.json / yarn.lock) */
  private async computeLockfileHash(): Promise<string> {
    const lockFiles = ['bun.lock', 'bun.lockb', 'package-lock.json', 'yarn.lock']
    
    for (const lockFile of lockFiles) {
      const lockPath = join(this.config.localDir, lockFile)
      try {
        const content = await readFile(lockPath)
        const hash = createHash('sha256').update(content).digest('hex').slice(0, 16)
        return hash
      } catch {
        // Try next lockfile
      }
    }
    
    // Fallback: hash package.json dependencies
    try {
      const pkgPath = join(this.config.localDir, 'package.json')
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'))
      const depsKey = JSON.stringify({
        dependencies: pkg.dependencies || {},
        devDependencies: pkg.devDependencies || {},
      })
      return createHash('sha256').update(depsKey).digest('hex').slice(0, 16)
    } catch {
      // No lockfile and no package.json — use a static key
      return 'no-lockfile'
    }
  }

  // ===========================================================================
  // Archive Existence Checks
  // ===========================================================================

  private async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      }))
      return true
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return false
      }
      throw error
    }
  }

  // ===========================================================================
  // Download (Layered)
  // ===========================================================================

  /**
   * Download and extract project from S3 using layered archives.
   * 
   * Strategy:
   * 1. Try to download project-src.tar.gz (new layered format)
   * 2. If found, also restore deps from content-addressed cache
   * 3. If not found, fall back to legacy project.tar.gz (full archive)
   * 
   * This provides backward compatibility while enabling fast cold starts
   * for projects that have been synced with the new format.
   */
  async downloadAll(): Promise<SyncStats> {
    const totalStart = Date.now()

    try {
      // Step 1: Try new layered format first
      const projectKey = this.getProjectArchiveKey()
      console.log(`[S3Sync] [downloadAll] Checking for layered archive: s3://${this.config.bucket}/${projectKey}`)
      const checkLayeredStart = Date.now()
      const hasLayeredArchive = await this.objectExists(projectKey)
      console.log(`[S3Sync] [downloadAll] Layered archive check: ${hasLayeredArchive ? 'EXISTS' : 'NOT FOUND'} (${Date.now() - checkLayeredStart}ms)`)

      if (hasLayeredArchive) {
        return await this.downloadLayered(totalStart)
      }

      // Step 2: Fall back to legacy format
      const legacyKey = this.getLegacyArchiveKey()
      console.log(`[S3Sync] [downloadAll] Checking for legacy archive: s3://${this.config.bucket}/${legacyKey}`)
      const checkLegacyStart = Date.now()
      const hasLegacyArchive = await this.objectExists(legacyKey)
      console.log(`[S3Sync] [downloadAll] Legacy archive check: ${hasLegacyArchive ? 'EXISTS' : 'NOT FOUND'} (${Date.now() - checkLegacyStart}ms)`)

      if (hasLegacyArchive) {
        console.log(`[S3Sync] Using legacy archive format (will migrate on next upload)`)
        return await this.downloadLegacy(totalStart)
      }

      // No archive at all — new project
      console.log(`[S3Sync] [downloadAll] No archive found in S3 (new project) — total check time: ${Date.now() - totalStart}ms`)
      return this.getStats()

    } catch (error: any) {
      console.error(`[S3Sync] [downloadAll] Download failed after ${Date.now() - totalStart}ms:`, error)
      this.stats.errors.push(`Download failed: ${error.message}`)
      return this.getStats()
    }
  }

  /**
   * Download using new layered format:
   * 1. Download project-src.tar.gz (small, always)
   * 2. Check deps-hash pointer → download cached deps archive if available
   */
  private async downloadLayered(totalStart: number): Promise<SyncStats> {
    console.log(`[S3Sync] [downloadLayered] ⚡ Using layered archive format (localDir=${this.config.localDir})`)

    if (!existsSync(this.config.localDir)) {
      mkdirSync(this.config.localDir, { recursive: true })
    }

    // Step 1: Download project archive (source + dist)
    const projectStart = Date.now()
    const projectKey = this.getProjectArchiveKey()
    console.log(`[S3Sync] [downloadLayered] Step 1/2: Downloading project archive from s3://${this.config.bucket}/${projectKey}`)

    const projectResponse = await this.client.send(new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: projectKey,
    }))
    const s3ResponseMs = Date.now() - projectStart
    console.log(`[S3Sync] [downloadLayered] S3 GetObject response received in ${s3ResponseMs}ms (contentLength=${projectResponse.ContentLength ?? 'unknown'})`)

    if (!projectResponse.Body) {
      console.log(`[S3Sync] [downloadLayered] Empty project archive response — aborting`)
      return this.getStats()
    }

    const streamStart = Date.now()
    const projectData = await projectResponse.Body.transformToByteArray()
    const streamMs = Date.now() - streamStart
    const projectDownloadMs = Date.now() - projectStart
    console.log(`[S3Sync] [downloadLayered] Project archive downloaded: ${this.formatBytes(projectData.length)} in ${projectDownloadMs}ms (stream read: ${streamMs}ms)`)

    // Extract project archive
    const extractStart = Date.now()
    const tempProject = join('/tmp', `project-${this.config.prefix}-src.tar.gz`)
    console.log(`[S3Sync] [downloadLayered] Writing temp file and extracting project archive...`)
    await writeFile(tempProject, projectData)
    const writeMs = Date.now() - extractStart
    const { usedBinary } = await extractTarFastNonBlocking(tempProject, this.config.localDir)
    const projectExtractMs = Date.now() - extractStart
    console.log(`[S3Sync] [downloadLayered] Project archive extracted in ${projectExtractMs}ms (write: ${writeMs}ms, tar extract: ${projectExtractMs - writeMs}ms, via=${usedBinary ? 'system-tar' : 'node-tar'})`)
    await unlink(tempProject).catch(() => {})
    this.stats.projectExtractMs = projectExtractMs

    // Step 2: Restore deps from cache (non-blocking)
    // Fire off deps restoration in the background so the pod can accept
    // requests immediately after source files are extracted. Callers that
    // need node_modules (canvas build, LSP, ensureWorkspaceDeps) should
    // await waitForDeps() before proceeding.
    this.beginDepsRestore()
    const depsStart = Date.now()
    console.log(`[S3Sync] [downloadLayered] Step 2/2: Restoring deps in background...`)
    this.restoreDeps()
      .then(() => {
        console.log(`[S3Sync] [downloadLayered] Background deps restore completed in ${Date.now() - depsStart}ms`)
      })
      .catch((err) => {
        console.error(`[S3Sync] [downloadLayered] Background deps restore failed (${Date.now() - depsStart}ms):`, err.message)
      })
      .finally(() => {
        this.resolveDepsReady()
      })

    const totalMs = Date.now() - totalStart
    const projectFileCount = await this.countFilesExcluding(this.config.localDir, ['node_modules'])
    
    this.stats.downloaded = projectFileCount
    this.stats.lastSync = new Date()
    this.stats.archiveSize = projectData.length

    console.log(`[S3Sync] [downloadLayered] ⚡ Source files ready in ${totalMs}ms — ${projectFileCount} source files (deps restoring in background)`)
    console.log(`[S3Sync] [downloadLayered] Breakdown: s3Response=${s3ResponseMs}ms, streamRead=${streamMs}ms, extract=${projectExtractMs}ms`)
    return this.getStats()
  }

  /**
   * Restore node_modules from content-addressed deps cache.
   */
  private async restoreDeps(): Promise<void> {
    const restoreStart = Date.now()
    const pointerKey = this.getDepsPointerKey()
    let lockfileHash: string | null = null

    console.log(`[S3Sync] [restoreDeps] Reading deps pointer: s3://${this.config.bucket}/${pointerKey}`)
    const pointerStart = Date.now()
    try {
      const pointerResponse = await this.client.send(new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: pointerKey,
      }))
      if (pointerResponse.Body) {
        lockfileHash = (await pointerResponse.Body.transformToString()).trim()
      }
      console.log(`[S3Sync] [restoreDeps] Deps pointer read in ${Date.now() - pointerStart}ms (hash=${lockfileHash ?? 'null'})`)
    } catch (error: any) {
      if (error.name !== 'NoSuchKey' && error.$metadata?.httpStatusCode !== 404) {
        console.warn(`[S3Sync] [restoreDeps] Error reading deps pointer (${Date.now() - pointerStart}ms):`, error.message)
      } else {
        console.log(`[S3Sync] [restoreDeps] Deps pointer not found (404) in ${Date.now() - pointerStart}ms`)
      }
    }

    if (!lockfileHash) {
      console.log(`[S3Sync] [restoreDeps] No deps cache pointer — will need bun install (total: ${Date.now() - restoreStart}ms)`)
      return
    }

    // Check if node_modules already exists and matches the expected lockfile hash
    const localHash = await this.computeLockfileHash()
    if ((localHash === lockfileHash) &&
        (existsSync(join(this.config.localDir, 'node_modules', '.package-lock.json')) ||
         existsSync(join(this.config.localDir, 'node_modules', '.cache')))) {
      console.log(`[S3Sync] [restoreDeps] node_modules already present and hash matches — skipping download`)
      this.stats.depsCacheHit = true
      this.currentLockfileHash = lockfileHash
      return
    }

    // Try .tar.zst first (faster), fall back to .tar.gz for archives
    // produced before the zstd switch landed.
    const depsCandidates = this.getDepsArchiveKeys(lockfileHash)
    let resolvedKey: { key: string; ext: 'zst' | 'gz' } | null = null
    for (const candidate of depsCandidates) {
      const existsStart = Date.now()
      const exists = await this.objectExists(candidate.key)
      console.log(
        `[S3Sync] [restoreDeps] Deps archive existence check (${candidate.ext}): ${exists} (${Date.now() - existsStart}ms) at s3://${this.config.bucket}/${candidate.key}`,
      )
      if (exists) {
        resolvedKey = candidate
        break
      }
    }

    if (!resolvedKey) {
      console.log(`[S3Sync] [restoreDeps] Deps cache miss (hash: ${lockfileHash}) — will need bun install (total: ${Date.now() - restoreStart}ms)`)
      return
    }

    console.log(`[S3Sync] [restoreDeps] ⚡ Deps cache hit (hash: ${lockfileHash}, ${resolvedKey.ext}) — downloading...`)
    const depsStart = Date.now()

    const depsResponse = await this.client.send(new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: resolvedKey.key,
    }))
    const s3ResponseMs = Date.now() - depsStart
    console.log(`[S3Sync] [restoreDeps] S3 GetObject response in ${s3ResponseMs}ms (contentLength=${depsResponse.ContentLength ?? 'unknown'})`)

    if (!depsResponse.Body) {
      console.log(`[S3Sync] [restoreDeps] Empty deps response — skipping`)
      return
    }

    const streamStart = Date.now()
    const depsData = await depsResponse.Body.transformToByteArray()
    const streamMs = Date.now() - streamStart
    const downloadMs = Date.now() - depsStart
    console.log(`[S3Sync] [restoreDeps] Downloaded deps archive: ${this.formatBytes(depsData.length)} in ${downloadMs}ms (stream read: ${streamMs}ms)`)

    // Extract deps. Uses spawn('tar') so the JS event loop stays free
    // while decompression + the ~30k file writes happen in a child
    // process — critical for keeping `/ready` probes responsive during
    // cold start. extractTarFastNonBlocking dispatches gz vs zst by
    // file extension, so the tempfile name matters.
    const extractStart = Date.now()
    const tempDeps = join('/tmp', `deps-${lockfileHash}.tar.${resolvedKey.ext}`)
    console.log(`[S3Sync] [restoreDeps] Extracting deps archive (${this.formatBytes(depsData.length)})...`)
    await writeFile(tempDeps, depsData)
    const writeMs = Date.now() - extractStart
    const { usedBinary } = await extractTarFastNonBlocking(tempDeps, this.config.localDir)
    const extractMs = Date.now() - extractStart
    console.log(`[S3Sync] [restoreDeps] Deps extracted in ${extractMs}ms (write: ${writeMs}ms, tar: ${extractMs - writeMs}ms, via=${usedBinary ? 'system-tar' : 'node-tar'})`)
    await unlink(tempDeps).catch(() => {})

    this.stats.depsCacheHit = true
    this.stats.depsExtractMs = extractMs
    this.currentLockfileHash = lockfileHash

    console.log(`[S3Sync] [restoreDeps] ⚡ COMPLETE in ${Date.now() - restoreStart}ms (download=${downloadMs}ms, extract=${extractMs}ms)`)
  }

  /**
   * Download using legacy single-archive format (backward compatibility).
   */
  private async downloadLegacy(totalStart: number): Promise<SyncStats> {
    const archiveKey = this.getLegacyArchiveKey()
    console.log(`[S3Sync] [downloadLegacy] Downloading legacy archive from s3://${this.config.bucket}/${archiveKey}`)

    const s3Start = Date.now()
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: archiveKey,
    }))
    const s3ResponseMs = Date.now() - s3Start
    console.log(`[S3Sync] [downloadLegacy] S3 GetObject response in ${s3ResponseMs}ms (contentLength=${response.ContentLength ?? 'unknown'})`)

    if (!response.Body) {
      console.log(`[S3Sync] [downloadLegacy] Empty response from S3 — aborting`)
      return this.getStats()
    }

    const streamStart = Date.now()
    const bodyArray = await response.Body.transformToByteArray()
    const streamMs = Date.now() - streamStart
    const downloadTime = Date.now() - s3Start
    console.log(`[S3Sync] [downloadLegacy] Downloaded archive: ${this.formatBytes(bodyArray.length)} in ${downloadTime}ms (stream read: ${streamMs}ms)`)

    if (!existsSync(this.config.localDir)) {
      mkdirSync(this.config.localDir, { recursive: true })
    }

    const extractStart = Date.now()
    const tempArchive = join('/tmp', `project-${this.config.prefix}.tar.gz`)
    console.log(`[S3Sync] [downloadLegacy] Extracting archive (${this.formatBytes(bodyArray.length)})...`)
    await writeFile(tempArchive, bodyArray)
    const writeMs = Date.now() - extractStart
    const { usedBinary } = await extractTarFastNonBlocking(tempArchive, this.config.localDir)
    const extractTime = Date.now() - extractStart
    console.log(`[S3Sync] [downloadLegacy] Extracted in ${extractTime}ms (write: ${writeMs}ms, tar: ${extractTime - writeMs}ms, via=${usedBinary ? 'system-tar' : 'node-tar'})`)
    await unlink(tempArchive).catch(() => {})

    const fileCount = await this.countFiles(this.config.localDir)
    this.stats.downloaded = fileCount
    this.stats.lastSync = new Date()
    this.stats.archiveSize = bodyArray.length

    const totalMs = Date.now() - totalStart
    console.log(`[S3Sync] [downloadLegacy] COMPLETE in ${totalMs}ms: ${fileCount} files (${this.formatBytes(bodyArray.length)})`)

    this.depsNeedUpload = true
    return this.getStats()
  }

  // ===========================================================================
  // Upload (Layered)
  // ===========================================================================

  /**
   * Upload project state to S3 using layered archives.
   *
   * Always uploads: project-src.tar.gz (source + dist, no node_modules)
   * Conditionally uploads: deps archive (only when lockfile hash changes)
   *
   * Uses an upload lock to prevent concurrent uploads.
   */
  async uploadAll(deleteOrphans: boolean = false, opts: { forceProjectArchive?: boolean } = {}): Promise<SyncStats> {
    // Prevent concurrent uploads
    if (this.isUploading) {
      console.log(`[S3Sync] Upload already in progress, will re-run after completion`)
      this.uploadRequestedDuringUpload = true
      return this.getStats()
    }

    this.isUploading = true
    this.uploadRequestedDuringUpload = false

    try {
      // Check if there are any files to upload
      const fileCount = await this.countFiles(this.config.localDir)
      if (fileCount === 0) {
        console.log(`[S3Sync] No files to upload`)
        return this.getStats()
      }

      // Upload project archive (source + dist, NO node_modules).
      // The optional force flag lets `flushAndShutdown` write a final
      // cold-start tarball even when Layer 2 is suppressed for the
      // session (git_only mode's normal steady state).
      await this.uploadProjectArchive(opts.forceProjectArchive ?? false)

      // Upload deps archive if lockfile changed
      await this.uploadDepsIfNeeded()

      this.stats.lastSync = new Date()

    } catch (error: any) {
      console.error(`[S3Sync] Upload failed:`, error)
      this.stats.errors.push(`Upload failed: ${error.message}`)
    } finally {
      this.isUploading = false

      // Re-run if changes occurred during upload
      if (this.uploadRequestedDuringUpload) {
        this.uploadRequestedDuringUpload = false
        console.log(`[S3Sync] Re-running upload (changes occurred during previous upload)`)
        setTimeout(() => this.uploadAll(false), 0)
      }
    }

    return this.getStats()
  }

  /**
   * Upload project-src.tar.gz (everything EXCEPT node_modules).
   * This is small (~2-10MB) and fast to create.
   * Skips the S3 upload if the archive hash hasn't changed since the last upload.
   *
   * `forceWriteWhenSuppressed=true` (used by `flushAndShutdown` in
   * `git_only` mode) overrides the suppression flag so the cold-start
   * snapshot always lands at evict, even when Layer 2 was disabled for
   * the duration of the session.
   */
  private async uploadProjectArchive(forceWriteWhenSuppressed: boolean = false): Promise<void> {
    if (this.suppressProjectArchive && !forceWriteWhenSuppressed) {
      // Honor the suppress flag: agent-runtime is in git_only mode and
      // owns Layer 2 via GitWorkspaceSync. No-op on every path that
      // would otherwise re-tar + PUT.
      return
    }
    const startTime = Date.now()
    const tempArchive = join('/tmp', `project-${this.config.prefix}-src-upload.tar.gz`)

    // List all files EXCLUDING node_modules + Expo/Metro caches.
    // Keep this in sync with the `exclude` glob list above; both gates
    // need to filter the same families of generated/cache directories.
    const filesToInclude = await this.listLocalFiles(undefined, [
      'node_modules',
      '.expo',
      '.metro-cache',
      '.expo-shared',
    ])

    if (filesToInclude.length === 0) {
      console.log(`[S3Sync] No project files to include after filtering`)
      return
    }

    // Clear pending uploads before archiving
    this.pendingUploads.clear()

    // Create archive
    await tar.create(
      {
        gzip: true,
        file: tempArchive,
        cwd: this.config.localDir,
        portable: true,
      },
      filesToInclude.map(f => relative(this.config.localDir, f))
    )

    const archiveTime = Date.now() - startTime
    const archiveContent = await readFile(tempArchive)
    const archiveSize = archiveContent.length
    console.log(`[S3Sync] Created project archive in ${archiveTime}ms (${this.formatBytes(archiveSize)})`)

    // Hash the archive and skip upload if unchanged
    const archiveHash = createHash('sha256').update(archiveContent).digest('hex')
    if (archiveHash === this.lastUploadHash) {
      console.log(`[S3Sync] Project archive unchanged (hash=${archiveHash.slice(0, 12)}), skipping upload`)
      await unlink(tempArchive).catch(() => {})
      return
    }

    // Check storage quota before uploading
    const quotaBytes = parseInt(process.env.S3_STORAGE_QUOTA_BYTES || '0', 10)
    if (quotaBytes > 0 && archiveSize > quotaBytes) {
      console.warn(`[S3Sync] Archive size (${this.formatBytes(archiveSize)}) exceeds storage quota (${this.formatBytes(quotaBytes)}), skipping upload`)
      await unlink(tempArchive).catch(() => {})
      return
    }

    // Upload to S3
    const archiveKey = this.getProjectArchiveKey()
    const uploadStart = Date.now()

    await this.client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: archiveKey,
      Body: archiveContent,
      ContentType: 'application/gzip',
    }))

    const uploadTime = Date.now() - uploadStart
    this.lastUploadHash = archiveHash
    console.log(`[S3Sync] Uploaded project archive in ${uploadTime}ms (hash=${archiveHash.slice(0, 12)})`)

    // Cleanup
    await unlink(tempArchive).catch(() => {})

    this.stats.uploaded = filesToInclude.length
    this.stats.archiveSize = archiveSize
  }

  /**
   * Upload deps archive (node_modules/) if lockfile has changed.
   * Uses content-addressed caching: the deps archive key includes the lockfile hash.
   * This means identical lockfiles across different projects share the same deps archive.
   */
  private async uploadDepsIfNeeded(): Promise<void> {
    const lockfileHash = await this.computeLockfileHash()

    // Check if deps already cached for this lockfile hash
    if (lockfileHash === this.currentLockfileHash && !this.depsNeedUpload) {
      // Same lockfile hash — deps archive already in S3
      return
    }

    // Check if either flavor of this deps archive already exists in S3.
    // .tar.zst is the new default; .tar.gz remains for legacy archives.
    let depsExist = false
    for (const candidate of this.getDepsArchiveKeys(lockfileHash)) {
      if (await this.objectExists(candidate.key)) {
        depsExist = true
        break
      }
    }

    if (depsExist && !this.depsNeedUpload) {
      // Already cached — just update the pointer
      console.log(`[S3Sync] Deps cache already exists for hash ${lockfileHash}, updating pointer`)
      await this.updateDepsPointer(lockfileHash)
      this.currentLockfileHash = lockfileHash
      this.depsNeedUpload = false
      return
    }

    // Check if node_modules exists
    const nodeModulesDir = join(this.config.localDir, 'node_modules')
    if (!existsSync(nodeModulesDir)) {
      return
    }

    // List only node_modules files
    const nodeModulesFiles = await this.listLocalFiles(nodeModulesDir)
    if (nodeModulesFiles.length === 0) return

    console.log(`[S3Sync] Deps archive: ${nodeModulesFiles.length} files`)

    // Probe for the system zstd binary. When present we PREFER writing
    // `.tar.zst` for ~3-5× faster restore on cold-start; if either the
    // probe says no, OR the system tar+zstd combo fails to produce a
    // valid archive (some BSD tars don't honor --use-compress-program),
    // we fall back to gzip via node-tar so production never silently
    // skips the deps cache write.
    const zstdAvailable = await isZstdAvailable()
    let writeExt: 'zst' | 'gz' = zstdAvailable ? 'zst' : 'gz'
    let tempArchive = join('/tmp', `deps-${lockfileHash}-upload.tar.${writeExt}`)
    const startTime = Date.now()
    const filesRel = nodeModulesFiles.map(f => relative(this.config.localDir, f))

    if (writeExt === 'zst') {
      try {
        await createTarZst(tempArchive, this.config.localDir, filesRel)
      } catch (err: any) {
        console.warn(`[S3Sync] zstd archive create failed (${err.message}) — falling back to gzip`)
        writeExt = 'gz'
        tempArchive = join('/tmp', `deps-${lockfileHash}-upload.tar.gz`)
        await tar.create(
          { gzip: true, file: tempArchive, cwd: this.config.localDir, portable: true },
          filesRel,
        )
      }
    } else {
      await tar.create(
        { gzip: true, file: tempArchive, cwd: this.config.localDir, portable: true },
        filesRel,
      )
    }

    const depsKey = this.getDepsArchiveKey(lockfileHash, writeExt)
    console.log(`[S3Sync] Uploading deps archive (lockfile hash: ${lockfileHash}, format: ${writeExt})`)

    const archiveTime = Date.now() - startTime
    const archiveStats = statSync(tempArchive)
    console.log(`[S3Sync] Created deps archive in ${archiveTime}ms (${this.formatBytes(archiveStats.size)})`)

    // Upload to S3 (content-addressed key)
    const uploadStart = Date.now()
    const archiveContent = await readFile(tempArchive)

    await this.client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: depsKey,
      Body: archiveContent,
      ContentType: writeExt === 'zst' ? 'application/zstd' : 'application/gzip',
    }))

    const uploadTime = Date.now() - uploadStart
    console.log(`[S3Sync] Uploaded deps archive in ${uploadTime}ms`)

    // Update the per-project pointer to this deps hash
    await this.updateDepsPointer(lockfileHash)

    // Cleanup
    await unlink(tempArchive).catch(() => {})

    this.currentLockfileHash = lockfileHash
    this.depsNeedUpload = false

    console.log(`[S3Sync] ⚡ Deps cache populated for hash ${lockfileHash}`)
  }

  /** Write the deps hash pointer so downloads know which deps archive to use */
  private async updateDepsPointer(lockfileHash: string): Promise<void> {
    const pointerKey = this.getDepsPointerKey()
    await this.client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: pointerKey,
      Body: lockfileHash,
      ContentType: 'text/plain',
    }))
  }

  // ===========================================================================
  // Sync Control
  // ===========================================================================

  /**
   * Start periodic sync (upload changes to S3).
   */
  startPeriodicSync(): void {
    if (this.config.syncInterval <= 0) {
      console.log(`[S3Sync] Periodic sync disabled (interval: 0)`)
      return
    }

    console.log(`[S3Sync] Starting periodic sync every ${this.config.syncInterval / 1000}s`)

    this.syncTimer = setInterval(async () => {
      console.log(`[S3Sync] Running periodic sync...`)
      await this.uploadAll(false)
    }, this.config.syncInterval)
  }

  /**
   * Stop periodic sync.
   */
  stopPeriodicSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer)
      this.syncTimer = null
      console.log(`[S3Sync] Periodic sync stopped`)
    }
  }

  /**
   * Start file watcher for detecting changes.
   *
   * The watcher triggers a debounced upload on every source file change.
   * This means files are synced to S3 within ~3 seconds of modification,
   * dramatically reducing the data-loss window compared to the 30s periodic sync.
   */
  startWatcher(): void {
    if (!this.config.watchEnabled) {
      console.log(`[S3Sync] File watcher disabled`)
      return
    }

    if (this.watcher) {
      console.log(`[S3Sync] File watcher already running`)
      return
    }

    try {
      const dirStat = statSync(this.config.localDir)
      if (!dirStat.isDirectory()) {
        console.warn(`[S3Sync] Cannot start watcher: ${this.config.localDir} is not a directory`)
        return
      }
    } catch (error: any) {
      console.warn(`[S3Sync] Cannot start watcher: ${this.config.localDir} does not exist`)
      return
    }

    console.log(`[S3Sync] Starting file watcher on ${this.config.localDir} (debounce: ${SYNC_DEBOUNCE_MS}ms)`)

    try {
      this.watcher = watch(
        this.config.localDir,
        { recursive: true },
        (eventType, filename) => {
          try {
            if (!filename || this.shouldExclude(filename)) return

            // Skip node_modules and dist changes for debounced sync triggers.
            // node_modules changes are handled by deps upload (lockfile hash change).
            // dist changes are included in the project archive by periodic sync.
            if (filename.startsWith('node_modules/') || filename.startsWith('dist/')) {
              // But flag deps upload if lockfile changed
              if (filename === 'bun.lock' || filename === 'bun.lockb' || 
                  filename === 'package-lock.json' || filename === 'yarn.lock') {
                this.depsNeedUpload = true
              }
              return
            }

            // Mark that we have pending changes
            this.pendingUploads.add(filename)

            // Debounced upload
            if (this.uploadDebounceTimer) {
              clearTimeout(this.uploadDebounceTimer)
            }
            this.uploadDebounceTimer = setTimeout(() => {
              const pendingCount = this.pendingUploads.size
              if (pendingCount > 0) {
                console.log(`[S3Sync] 📦 File changes detected (${pendingCount} files), triggering sync...`)
                this.uploadAll(false).catch(err => {
                  console.error(`[S3Sync] Debounced upload failed:`, err)
                })
              }
            }, SYNC_DEBOUNCE_MS)
          } catch (error: any) {
            // Ignore errors in watcher callback
          }
        }
      )

      this.watcher.on('error', (error: Error) => {
        console.warn(`[S3Sync] File watcher error (continuing without watcher):`, error.message)
        this.stopWatcher()
      })
    } catch (error: any) {
      console.warn(`[S3Sync] Failed to start file watcher:`, error.message)
    }
  }

  /**
   * Stop file watcher.
   */
  stopWatcher(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
      console.log(`[S3Sync] File watcher stopped`)
    }
  }

  /**
   * Explicitly trigger an S3 sync (debounced).
   */
  triggerSync(immediate: boolean = false): void {
    if (immediate) {
      console.log(`[S3Sync] 📦 Immediate sync triggered`)
      this.uploadAll(false).catch(err => {
        console.error(`[S3Sync] Immediate sync failed:`, err)
      })
      return
    }

    if (this.uploadDebounceTimer) {
      clearTimeout(this.uploadDebounceTimer)
    }
    this.uploadDebounceTimer = setTimeout(() => {
      console.log(`[S3Sync] 📦 Explicit sync triggered`)
      this.uploadAll(false).catch(err => {
        console.error(`[S3Sync] Explicit sync upload failed:`, err)
      })
    }, SYNC_DEBOUNCE_MS)
  }

  /**
   * Get sync statistics.
   */
  getStats(): SyncStats {
    return { ...this.stats }
  }

  /**
   * Check if there are pending changes waiting to be synced.
   */
  hasPendingChanges(): boolean {
    return this.pendingUploads.size > 0 || this.uploadDebounceTimer !== null
  }

  /**
   * Shutdown: stop all timers and watchers.
   */
  shutdown(): void {
    this.stopPeriodicSync()
    this.stopWatcher()
    if (this.uploadDebounceTimer) {
      clearTimeout(this.uploadDebounceTimer)
      this.uploadDebounceTimer = null
    }
  }

  /**
   * Flush any pending changes to S3, then shutdown.
   * Use this on SIGTERM to avoid losing recently-written files
   * (e.g., MCP server config) that are still in the debounce window.
   *
   * `forceProjectArchive` overrides `suppressProjectArchive` for this
   * one call only — used by `agent-runtime` in `git_only` mode to land
   * the cold-start snapshot tarball at evict regardless of whether
   * git was healthy during the session.
   *
   * Accepts either a number (legacy: timeout only) or an options object.
   */
  async flushAndShutdown(
    timeoutMsOrOpts: number | { timeoutMs?: number; forceProjectArchive?: boolean } = 10_000,
  ): Promise<void> {
    const opts = typeof timeoutMsOrOpts === 'number'
      ? { timeoutMs: timeoutMsOrOpts, forceProjectArchive: false }
      : { timeoutMs: timeoutMsOrOpts.timeoutMs ?? 10_000, forceProjectArchive: !!timeoutMsOrOpts.forceProjectArchive }

    this.stopPeriodicSync()
    this.stopWatcher()

    if (this.uploadDebounceTimer) {
      clearTimeout(this.uploadDebounceTimer)
      this.uploadDebounceTimer = null
    }

    // In `git_only` mode the suppress flag means triggerSync paths
    // never marked anything as pending — but we still want to land the
    // cold-start snapshot. The `forceProjectArchive` opt bypasses both
    // the "no pending changes" early-return and the suppress check.
    if (!opts.forceProjectArchive && !this.hasPendingChanges() && this.pendingUploads.size === 0) {
      console.log(`[S3Sync] flushAndShutdown: no pending changes`)
      return
    }

    console.log(
      `[S3Sync] flushAndShutdown: flushing pending changes to S3 (timeout ${opts.timeoutMs}ms, forceProjectArchive=${opts.forceProjectArchive})...`,
    )
    try {
      const uploadPromise = this.uploadAll(false, { forceProjectArchive: opts.forceProjectArchive })
      const timeoutPromise = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('flush timeout')), opts.timeoutMs)
      )
      await Promise.race([uploadPromise, timeoutPromise])
      console.log(`[S3Sync] flushAndShutdown: flush complete`)
    } catch (err: any) {
      console.error(`[S3Sync] flushAndShutdown: ${err.message}`)
    }
  }

  // ===========================================================================
  // git_only mode helpers
  // ===========================================================================

  /**
   * Toggle Layer 2 (`project-src.tar.gz`) uploads at runtime.
   *
   * Wired to `GitWorkspaceSync.onDegrade` so a stretch of failing git
   * pushes can re-enable the S3 fallback writer mid-session. On
   * recovery (`onRecovered`), the agent-runtime flips this back to
   * `true` so we return to the normal `git_only` steady state.
   */
  setSuppressProjectArchive(suppress: boolean): void {
    if (this.suppressProjectArchive === suppress) return
    this.suppressProjectArchive = suppress
    console.log(`[S3Sync] suppressProjectArchive=${suppress}`)
  }

  /** Read the current suppression state (useful for tests + diagnostics). */
  isProjectArchiveSuppressed(): boolean {
    return this.suppressProjectArchive
  }

  /**
   * Produce the cold-start tarball from `git archive HEAD` instead of
   * from the live workspace. Used at evict time when `GitWorkspaceSync`
   * is healthy and HEAD is therefore the authoritative tree.
   *
   * Falls back to throwing if `git` isn't available or the workspace
   * isn't a git repo — caller should catch and use the live-workspace
   * path (`flushAndShutdown({ forceProjectArchive: true })`) instead.
   */
  async snapshotProjectArchiveFromGit(): Promise<void> {
    const tempArchive = join('/tmp', `project-${this.config.prefix}-git-snapshot.tar.gz`)
    const startTime = Date.now()

    // `git archive HEAD --format=tar.gz` is equivalent to `git archive | gzip`
    // and respects the `.gitignore` (untracked files are excluded by
    // definition). We accept this trade-off: in git_only mode, the
    // gitignored files (`.shogo/` SQLite, `.canvas-state.json`) are
    // restored separately by the file-API path on cold-start.
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        'git',
        ['archive', '--format=tar.gz', '-o', tempArchive, 'HEAD'],
        { cwd: this.config.localDir, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let stderr = ''
      child.stderr.setEncoding('utf-8')
      child.stderr.on('data', (c) => { stderr += c })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`git archive exited ${code}: ${stderr.slice(0, 500)}`))
      })
    })

    const archiveContent = await readFile(tempArchive)
    const archiveSize = archiveContent.length
    console.log(
      `[S3Sync] snapshotFromGit: created ${this.formatBytes(archiveSize)} archive in ${Date.now() - startTime}ms`,
    )

    const archiveKey = this.getProjectArchiveKey()
    const uploadStart = Date.now()
    await this.client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: archiveKey,
      Body: archiveContent,
      ContentType: 'application/gzip',
    }))
    console.log(`[S3Sync] snapshotFromGit: uploaded to s3://${this.config.bucket}/${archiveKey} in ${Date.now() - uploadStart}ms`)

    await unlink(tempArchive).catch(() => { })

    // Update our hash tracker so a subsequent `uploadAll` doesn't
    // re-PUT an identical archive on top.
    this.lastUploadHash = createHash('sha256').update(archiveContent).digest('hex')
    this.stats.archiveSize = archiveSize
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * List local files, optionally excluding additional directory prefixes.
   */
  private async listLocalFiles(dir?: string, excludeDirs?: string[]): Promise<string[]> {
    const targetDir = dir || this.config.localDir
    const files: string[] = []

    try {
      const entries = await readdir(targetDir, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = join(targetDir, entry.name)
        const relativePath = relative(this.config.localDir, fullPath)

        if (this.shouldExclude(relativePath)) continue

        // Drop macOS-specific detritus (AppleDouble sidecars like `._foo.ts`,
        // `.DS_Store`, `__MACOSX/`, etc.). The existing glob list in
        // `shouldExclude` can't express the `._*` prefix, so handle it here.
        // Matching on basename also kills the entire subtree when the entry
        // is a junk directory (`.AppleDouble/`, `__MACOSX/`).
        if (isMacOSJunkName(entry.name)) continue

        // Skip excluded directories by name at any depth (e.g. 'node_modules' matches
        // both top-level and nested like 'project/node_modules' or '.npm/_npx/.../node_modules')
        if (excludeDirs && entry.isDirectory() && excludeDirs.includes(entry.name)) {
          continue
        }

        if (entry.isDirectory()) {
          const subFiles = await this.listLocalFiles(fullPath, excludeDirs)
          files.push(...subFiles)
        } else if (entry.isFile()) {
          files.push(fullPath)
        }
      }
    } catch (error) {
      // Directory may not exist yet
    }

    return files
  }

  private async countFiles(dir: string): Promise<number> {
    let count = 0
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          count += await this.countFiles(join(dir, entry.name))
        } else if (entry.isFile()) {
          count++
        }
      }
    } catch (error) {
      // Directory may not exist
    }
    return count
  }

  private async countFilesExcluding(dir: string, excludeDirs: string[]): Promise<number> {
    let count = 0
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (excludeDirs.includes(entry.name)) continue
        if (entry.isDirectory()) {
          count += await this.countFilesExcluding(join(dir, entry.name), excludeDirs)
        } else if (entry.isFile()) {
          count++
        }
      }
    } catch (error) {
      // Directory may not exist
    }
    return count
  }

  private shouldExclude(path: string): boolean {
    for (const pattern of this.config.exclude) {
      if (pattern.startsWith('*')) {
        const ext = pattern.slice(1)
        if (path.endsWith(ext)) return true
      } else {
        if (path === pattern || path.includes(`/${pattern}/`) || path.includes(`/${pattern}`) || path.startsWith(`${pattern}/`) || path.startsWith(pattern)) {
          return true
        }
      }
    }
    return false
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create an S3Sync instance from environment variables.
 */
export function createS3SyncFromEnv(
  localDir: string,
  opts: { suppressProjectArchive?: boolean } = {},
): S3Sync | null {
  const bucket = process.env.S3_WORKSPACES_BUCKET
  const prefix = process.env.PROJECT_ID

  if (!bucket || !prefix) {
    console.log(`[S3Sync] [createFromEnv] Not configured (bucket=${bucket ?? 'unset'}, prefix=${prefix ?? 'unset'})`)
    return null
  }

  const watchEnabled = process.env.S3_WATCH_ENABLED !== 'false'
  const region = process.env.S3_REGION
  const endpoint = process.env.S3_ENDPOINT

  console.log(`[S3Sync] [createFromEnv] Creating S3Sync instance (bucket=${bucket}, prefix=${prefix}, region=${region}, endpoint=${endpoint ?? 'default'}, localDir=${localDir}, suppressProjectArchive=${opts.suppressProjectArchive ?? false})`)

  return new S3Sync({
    bucket,
    prefix,
    localDir,
    endpoint,
    region,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    syncInterval: parseInt(process.env.S3_SYNC_INTERVAL || '30000', 10),
    watchEnabled,
    suppressProjectArchive: opts.suppressProjectArchive ?? false,
  })
}

/**
 * Create an S3Sync instance for a specific project, independent of process env.
 *
 * Used by the API server (which serves many projects) for one-shot operations
 * like seeding S3 immediately after a project import. Unlike createS3SyncFromEnv,
 * the projectId is passed explicitly rather than read from process.env.PROJECT_ID,
 * and the file watcher is disabled by default — this is intended for short-lived
 * "tar local dir, push to S3, done" usage, not a long-running sync.
 *
 * Returns null if S3_WORKSPACES_BUCKET is unset so callers can fall back to
 * local-only behavior in dev / unconfigured environments.
 */
export function createS3SyncForProject(localDir: string, projectId: string): S3Sync | null {
  const bucket = process.env.S3_WORKSPACES_BUCKET
  if (!bucket || !projectId) {
    console.log(`[S3Sync] [createForProject] Not configured (bucket=${bucket ?? 'unset'}, projectId=${projectId ?? 'unset'})`)
    return null
  }

  const region = process.env.S3_REGION
  const endpoint = process.env.S3_ENDPOINT

  console.log(`[S3Sync] [createForProject] Creating S3Sync instance (bucket=${bucket}, prefix=${projectId}, region=${region}, endpoint=${endpoint ?? 'default'}, localDir=${localDir})`)

  return new S3Sync({
    bucket,
    prefix: projectId,
    localDir,
    endpoint,
    region,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    syncInterval: 0,
    watchEnabled: false,
  })
}

/**
 * Initialize S3 sync: download archive and start background sync.
 * Returns null if S3 is not configured OR if initial download fails critically.
 *
 * CRITICAL: If the download fails for ANY reason (not just auth errors),
 * we must NOT start the uploader/watcher. Otherwise, the default template
 * files get uploaded to S3, overwriting the user's actual project data.
 */
export async function initializeS3Sync(
  localDir: string,
  opts: { suppressProjectArchive?: boolean } = {},
): Promise<{ sync: S3Sync, downloadSucceeded: boolean } | null> {
  const initStart = Date.now()
  console.log(`[S3Sync] [initializeS3Sync] Starting (localDir=${localDir})`)
  const sync = createS3SyncFromEnv(localDir, opts)

  if (!sync) {
    console.log(`[S3Sync] [initializeS3Sync] No sync instance created — returning null`)
    return null
  }

  console.log(`[S3Sync] [initializeS3Sync] Calling downloadAll()...`)
  const downloadStart = Date.now()
  const downloadStats = await sync.downloadAll()
  console.log(`[S3Sync] [initializeS3Sync] downloadAll() completed in ${Date.now() - downloadStart}ms (errors=${downloadStats.errors.length}, downloaded=${downloadStats.downloaded})`)

  // If there were ANY download errors, do NOT start uploading.
  if (downloadStats.errors.length > 0) {
    const totalMs = Date.now() - initStart
    console.warn(`[S3Sync] [initializeS3Sync] Download had errors (total: ${totalMs}ms) — sync in UPLOAD-ONLY-AFTER-DELAY mode`)
    console.warn('[S3Sync] [initializeS3Sync] Errors:', downloadStats.errors)

    const hasCriticalError = downloadStats.errors.some(err =>
      err.includes('AccessDenied') ||
      err.includes('NoSuchBucket') ||
      err.includes('InvalidAccessKeyId') ||
      err.includes('SignatureDoesNotMatch')
    )

    if (hasCriticalError) {
      console.warn(`[S3Sync] [initializeS3Sync] Critical auth/config error — S3 sync completely disabled (total: ${totalMs}ms)`)
      return null
    }

    console.warn(`[S3Sync] [initializeS3Sync] Non-critical download error — sync instance created but NOT started (total: ${totalMs}ms)`)
    return { sync, downloadSucceeded: false }
  }

  // Download succeeded — safe to start sync
  const isNewProject = downloadStats.downloaded === 0
  const totalMs = Date.now() - initStart

  sync.startPeriodicSync()
  sync.startWatcher()

  if (isNewProject) {
    console.log(`[S3Sync] [initializeS3Sync] New project — watcher will capture first file writes (total: ${totalMs}ms)`)
  } else {
    console.log(`[S3Sync] [initializeS3Sync] Existing project restored — sync started (${downloadStats.downloaded} files, total: ${totalMs}ms)`)
  }

  return { sync, downloadSucceeded: true }
}
