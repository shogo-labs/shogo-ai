// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Ship an Expo project to the App Store / Google Play — from the pod, with
 * nothing secret in it.
 *
 * The runner is the half of native release that touches the user's files, and it
 * is deliberately powerless: it has no Expo token and no store credentials, and
 * the only remote calls it makes are to the Shogo API. It computes the job,
 * tars the project and PUTs the archive to a signed URL; the API holds the token,
 * starts the test workflow and the store build, and pays for them.
 *
 * Two rules are load-bearing, and both are tested:
 *
 * 1. **The archive never carries a secret.** Any `.env*` file is excluded
 *    outright, along with `node_modules`, `.shogo`, `.git` and build output. A
 *    public `EXPO_PUBLIC_*` value may be passed as build env instead.
 * 2. **The working tree is untouched.** `eas.json`, `owner`, `extra.eas.projectId`
 *    and `updates.url` are written *into the archive*, never to disk, so a
 *    release leaves no trace in the project and a second run starts from the
 *    same bytes.
 */

import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, sep } from 'node:path'
import ignore from 'ignore'
// `node:child_process` directly would flash a console window on Windows — every
// spawn in this repo goes through the windowsHide wrapper.
import { execFile } from '@shogo/shared-runtime/child-process'
import { decodePng, generateStoreAssets, type StoreAssets } from './native-release-assets'
import {
  RELEASE_ONLY_FACTS,
  hasCustomStoreIcon,
  nativeNextStep,
  type NativeNextStep,
  type NativeReleaseFacts,
} from './native-release-state'

const execFileAsync = promisify(execFile)

/** Directories that never belong in a build archive, at any depth. */
const ALWAYS_EXCLUDED_DIRS = new Set(['node_modules', '.shogo', '.git', '.expo', 'ios', 'android'])

/**
 * Heavy directories that are not part of the app.
 *
 * Samsara's tree was 1.3 GB — content, media, research and reports from the
 * project's life as a Shogo workspace — and EAS rejected it. A store build needs
 * the app source, its assets and its config; everything else is bytes on the
 * wire and minutes on the builder. Excluded at the **top level only**, so an
 * `app/src/scripts` or a package's own `data` folder is untouched: the rule is
 * about the workspace, not about the word.
 */
export const NON_APP_TOP_LEVEL_DIRS = new Set([
  'content',
  'media',
  'research',
  'data',
  'dist',
  'docs',
  'reports',
  'tests',
  'scripts',
  'shots',
  'coverage',
])

/** Above this, the release stops and names what is large instead of uploading. */
export const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024

/** Files that could carry a secret, or that we generate into the archive instead. */
const ALWAYS_EXCLUDED_FILES = new Set(['eas.json', 'easignore'])

/**
 * Is this project-relative path excluded from the archive?
 *
 * `.env` and every `.env.*` variant are refused by name rather than by ignore
 * rule, because the one time an ignore rule is wrong the customer's Apple key
 * ships inside their app bundle. `.env.example` is the only exception: it is a
 * template with placeholders, and projects commit it on purpose.
 */
export function isExcludedFromArchive(relPath: string): boolean {
  const normalized = relPath.split(sep).join('/').replace(/^\.\//, '')
  const parts = normalized.split('/')
  const base = parts[parts.length - 1] ?? ''

  if (parts.some((part) => ALWAYS_EXCLUDED_DIRS.has(part))) return true
  if (parts.length > 1 && NON_APP_TOP_LEVEL_DIRS.has(parts[0]!)) return true
  if (ALWAYS_EXCLUDED_FILES.has(base)) return true
  if (base === '.env.example' || base === '.env.sample') return false
  if (base === '.env' || base.startsWith('.env.')) return true
  return false
}

/** The `EXPO_PUBLIC_*` values from a project `.env`, to send as build env. */
export function publicEnvFrom(dotEnv: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of dotEnv.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    if (!key.startsWith('EXPO_PUBLIC_')) continue
    out[key] = line
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

export interface ArchiveOptions {
  projectDir: string
  /** The Shogo project id, recorded in the generated `eas.json`. */
  projectId: string
  owner?: string
  /** Identifiers the store build must carry, whatever the project's config says. */
  identifier?: {
    slug?: string
    scheme?: string
    iosBundleIdentifier?: string
    androidPackage?: string
  }
  /** Build env the API should hand to EAS (`EXPO_PUBLIC_*` only). */
  publicEnv?: Record<string, string>
  /** Absolute paths (project-relative) the caller wants excluded on top. */
  extraExcludes?: string[]
  /**
   * Store artwork generated from the user's logo. Written into the archive only —
   * the working tree stays byte-identical.
   */
  storeAssets?: StoreAssets
}

/**
 * The file list for the archive: honours `.easignore` then `.gitignore`, minus
 * everything `isExcludedFromArchive` refuses.
 *
 * `ignore` is the same library EAS CLI uses, so a project's ignore files mean
 * here what they mean there — the difference is only the hard exclusions.
 */
export function buildIgnoreMatcher(projectDir: string, ignoreFiles: { name: string; content: string }[]): (rel: string) => boolean {
  const matcher = ignore()
  for (const file of ignoreFiles) {
    matcher.add(file.content)
  }
  return (rel: string) => {
    const normalized = rel.split(sep).join('/').replace(/^\.\//, '')
    if (!normalized) return true
    if (isExcludedFromArchive(normalized)) return true
    return matcher.ignores(normalized)
  }
}

/** Read the ignore files a project has, in the order EAS applies them. */
export async function readIgnoreFiles(projectDir: string): Promise<{ name: string; content: string }[]> {
  const files: { name: string; content: string }[] = []
  for (const name of ['.gitignore', '.easignore']) {
    const path = join(projectDir, name)
    if (!existsSync(path)) continue
    files.push({ name, content: await readFile(path, 'utf8') })
  }
  return files
}

/**
 * A stable fingerprint of the project tree.
 *
 * Prefers the Expo toolchain (`@expo/fingerprint` through the project's own
 * `node_modules`), which is what decides the OTA/build question on the server.
 * When a project has no Expo tooling installed — a fresh checkout, a cloud pod
 * that has not installed yet — it falls back to a content hash of the tracked
 * file list. A fallback fingerprint therefore differs from Expo's, which means
 * the release is treated as a build rather than an update: safe, only slower.
 */
export async function computeFingerprint(
  projectDir: string,
  files: string[] = [],
  readFileImpl: (path: string) => Promise<string> = (p) => readFile(p, 'utf8'),
): Promise<string> {
  const expoBin = join(projectDir, 'node_modules', '.bin', 'expo')
  if (existsSync(expoBin)) {
    try {
      const { stdout } = await execFileAsync(
        expoBin,
        ['config', '--json', '--type', 'fingerprint'],
        { cwd: projectDir, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
      )
      const parsed = JSON.parse(stdout) as { hash?: string }
      if (parsed.hash) return parsed.hash
    } catch {
      // Fall through: a project with a broken config must still be shippable
      // once the build itself reports the real error.
    }
  }

  const hash = createHash('sha256')
  for (const rel of [...files].sort()) {
    hash.update(rel)
    hash.update('\0')
    try {
      hash.update(await readFileImpl(join(projectDir, rel)))
    } catch {
      hash.update('missing')
    }
    hash.update('\0')
  }
  return `shogo-hash-${hash.digest('hex').slice(0, 32)}`
}

/**
 * The `eas.json` we generate. It never lands in the working tree; it is written
 * into the archive and removed with the temp directory.
 *
 * `resourceClass` is always pinned, never left to Expo's default. A profile that
 * omits it runs on `default`, whose concrete class is platform-dependent — and
 * the meter prices these builds from the class *we* asked for, so "unset" means
 * the quote and the invoice can disagree. The value comes from the API
 * (`NativeReleaseState.testResourceClass`), which is also the side that prices
 * the build, so there is one owner for the number rather than a copy here.
 */
export function buildEasJson(opts: {
  projectId: string
  owner?: string
  /** eas.json's short enum (`default` | `medium` | `large`), per profile. */
  resourceClass?: {
    test?: { ios?: string; android?: string }
    store?: { ios?: string; android?: string }
  }
}): Record<string, unknown> {
  const testIos = opts.resourceClass?.test?.ios ?? 'medium'
  const testAndroid = opts.resourceClass?.test?.android ?? 'medium'
  const storeIos = opts.resourceClass?.store?.ios ?? testIos
  const storeAndroid = opts.resourceClass?.store?.android ?? testAndroid
  return {
    cli: { version: '>= 16.0.0', appVersionSource: 'remote', requireCommit: false },
    build: {
      'shogo-test': {
        distribution: 'internal',
        developmentClient: false,
        withoutCredentials: true,
        android: { buildType: 'apk', resourceClass: testAndroid },
        ios: { simulator: true, resourceClass: testIos },
      },
      'shogo-store': {
        distribution: 'store',
        autoIncrement: true,
        android: { resourceClass: storeAndroid },
        ios: { resourceClass: storeIos },
      },
    },
    ...(opts.owner ? { owner: opts.owner } : {}),
  }
}

/**
 * The app-config overlay, applied inside the archive. A static `app.json` is
 * patched; a dynamic `app.config.*` gets a generated `app.config.js` that merges
 * these over the project's own config.
 */
export function buildAppConfigOverlay(opts: {
  easProjectId: string
  updatesUrl?: string
  identifier?: ArchiveOptions['identifier']
  storeAssets?: Pick<StoreAssets, 'backgroundColor'>
}): Record<string, unknown> {
  const id = opts.identifier ?? {}
  const bg = opts.storeAssets?.backgroundColor

  // One `android` object, built in one place: two spreads of the same key is how
  // the generated adaptive icon silently loses to the bare package name.
  const android: Record<string, unknown> = {
    ...(id.androidPackage ? { package: id.androidPackage } : {}),
    ...(bg
      ? {
          adaptiveIcon: {
            foregroundImage: './assets/images/adaptive-icon.png',
            backgroundColor: bg,
          },
        }
      : {}),
  }

  return {
    extra: { eas: { projectId: opts.easProjectId } },
    // The same keys on both platforms: iOS carries the flat icon, Android the
    // adaptive pair plus the splash both of them use.
    ...(bg
      ? {
          icon: './assets/images/icon.png',
          splash: {
            image: './assets/images/splash-icon.png',
            resizeMode: 'contain',
            backgroundColor: bg,
          },
        }
      : {}),
    // The stores read these from the built app, not from eas.json, and Samsara's
    // tree had none of them: `slug` and `scheme` are also what `expo-router`
    // deep links resolve against.
    ...(id.slug ? { slug: id.slug } : {}),
    ...(id.scheme ? { scheme: id.scheme } : {}),
    ...(id.iosBundleIdentifier ? { ios: { bundleIdentifier: id.iosBundleIdentifier } } : {}),
    ...(Object.keys(android).length ? { android } : {}),
    ...(opts.updatesUrl ? { updates: { url: opts.updatesUrl } } : {}),
  }
}

/** Entry for the generated `app.config.js` wrapper, kept as text for the test. */
export function buildDynamicConfigWrapper(overlay: Record<string, unknown>): string {
  return `// Generated by Shogo for this build only; not written to the project.
const base = require('./app.json')
module.exports = ({ config }) => ({
  ...(base.expo ?? base),
  ...config,
  ...${JSON.stringify(overlay)},
  extra: { ...((base.expo ?? base).extra ?? {}), ...(config.extra ?? {}), ...${JSON.stringify(overlay.extra ?? {})} },
})
`
}

/**
 * The largest top-level directories in an archive, for a refusal that names what
 * is large instead of saying "too large".
 */
export function largestTopLevelDirs(
  sizes: Map<string, number>,
  limit = 3,
): { dir: string; bytes: number }[] {
  return [...sizes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([dir, bytes]) => ({ dir, bytes }))
}

/**
 * Pin the package manager to the one this runtime builds with.
 *
 * Samsara only installed under `bun`; EAS picks npm/yarn/bun from the lockfile
 * and `package.json`, and the agent had to work that out by hand. Writing
 * `packageManager` into the **archive's** copy fixes it for every release without
 * touching the project.
 */
export function packageManagerPin(opts: {
  files: string[]
  bunVersion?: string | null
}): string | null {
  const hasBunLock = opts.files.some((f) => f === 'bun.lock' || f === 'bun.lockb')
  if (!hasBunLock) return null
  const version = String(opts.bunVersion ?? process.versions.bun ?? '').trim()
  return version ? `bun@${version}` : null
}

/**
 * Write the archive.
 *
 * The project is copied into a staging tree, the generated `eas.json` and app
 * config overlay are written *there*, and the staging tree is what gets tarred.
 * The project directory is only ever read — that is what makes "the working tree
 * is byte-identical before and after a release" true rather than hopeful.
 */
export async function writeProjectArchive(
  opts: ArchiveOptions & {
    outFile: string
    easyProjectId?: string
    updatesUrl?: string
    resourceClass?: {
      test?: { ios?: string; android?: string }
      store?: { ios?: string; android?: string }
    }
  },
): Promise<{ bytes: number; files: number; publicEnv: Record<string, string> }> {
  const { create } = await import('tar')
  const { cp, mkdir, readdir, stat } = await import('node:fs/promises')

  const ignoreFiles = await readIgnoreFiles(opts.projectDir)
  const excluded = buildIgnoreMatcher(opts.projectDir, ignoreFiles)
  const extra = new Set((opts.extraExcludes ?? []).map(archivePath))

  const files: string[] = []
  const dirBytes = new Map<string, number>()
  let totalBytes = 0
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      const rel = archivePath(abs.slice(opts.projectDir.length + 1))
      if (excluded(rel) || extra.has(rel)) continue
      if (entry.isDirectory()) {
        await walk(abs)
        continue
      }
      if (entry.isFile()) {
        files.push(rel)
        const size = (await stat(abs)).size
        totalBytes += size
        const top = rel.split('/')[0] ?? rel
        dirBytes.set(top, (dirBytes.get(top) ?? 0) + size)
      }
    }
  }
  await walk(opts.projectDir)

  // A cap that names what is large. Uploading a 1.3 GB workspace costs the user
  // minutes before EAS refuses it anyway — Samsara's tree was exactly that.
  if (totalBytes > MAX_ARCHIVE_BYTES) {
    const largest = largestTopLevelDirs(dirBytes)
    const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`
    throw new Error(
      `This project is ${mb(totalBytes)}, over the ${mb(MAX_ARCHIVE_BYTES)} a store build accepts. ` +
        `Largest: ${largest.map((d) => `${d.dir} (${mb(d.bytes)})`).join(', ')}. ` +
        'Move those out of the app or add them to .easignore, then ship again.',
    )
  }

  let publicEnv: Record<string, string> = {}
  const envPath = join(opts.projectDir, '.env')
  if (existsSync(envPath)) publicEnv = publicEnvFrom(await readFile(envPath, 'utf8'))

  const staging = await mkdtemp(join(tmpdir(), 'shogo-native-'))
  try {
    for (const rel of files) {
      const target = join(staging, rel)
      await mkdir(join(target, '..'), { recursive: true })
      await cp(join(opts.projectDir, rel), target)
    }

    if (opts.storeAssets) {
      for (const [rel, bytes] of Object.entries(opts.storeAssets.files)) {
        const target = join(staging, rel)
        await mkdir(join(target, '..'), { recursive: true })
        await writeFile(target, bytes)
        if (!files.includes(rel)) files.push(rel)
      }
    }

    await writeFile(
      join(staging, 'eas.json'),
      JSON.stringify(
        buildEasJson({
          projectId: opts.projectId,
          owner: opts.owner,
          resourceClass: opts.resourceClass,
        }),
        null,
        2,
      ),
      'utf8',
    )
    files.push('eas.json')

    // EAS installs with whichever package manager the project's lockfile implies;
    // Samsara needed bun and the agent had to find that out at build time.
    const pin = packageManagerPin({ files })
    const pkgPath = join(staging, 'package.json')
    if (pin && existsSync(pkgPath)) {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as Record<string, any>
      if (!pkg.packageManager) {
        pkg.packageManager = pin
        await writeFile(pkgPath, JSON.stringify(pkg, null, 2), 'utf8')
      }
    }

    if (opts.easyProjectId) {
      const overlay = buildAppConfigOverlay({
        easProjectId: opts.easyProjectId,
        updatesUrl: opts.updatesUrl,
        identifier: opts.identifier,
        storeAssets: opts.storeAssets,
      })
      const appJsonPath = join(staging, 'app.json')
      if (existsSync(appJsonPath)) {
        const parsed = JSON.parse(await readFile(appJsonPath, 'utf8')) as Record<string, any>
        const root = parsed.expo ?? parsed
        root.extra = { ...(root.extra ?? {}), ...(overlay.extra ?? {}) }
        for (const key of ['slug', 'scheme'] as const) {
          if (overlay[key]) root[key] = overlay[key]
        }
        if (overlay.ios) root.ios = { ...(root.ios ?? {}), ...(overlay.ios as object) }
        if (overlay.android) root.android = { ...(root.android ?? {}), ...(overlay.android as object) }
        if (overlay.updates) root.updates = { ...(root.updates ?? {}), ...(overlay.updates as object) }
        await writeFile(appJsonPath, JSON.stringify(parsed, null, 2), 'utf8')
      } else {
        await writeFile(
          join(staging, 'app.config.js'),
          buildDynamicConfigWrapper(overlay),
          'utf8',
        )
        files.push('app.config.js')
      }
    }

    await create({ file: opts.outFile, cwd: staging, gzip: true }, files)
    return { bytes: (await stat(opts.outFile)).size, files: files.length, publicEnv }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/** Write the generated artwork under `.shogo/store-assets/` and return those paths. */
export async function stageStoreAssets(projectDir: string, assets: StoreAssets): Promise<string[]> {
  const { mkdir } = await import('node:fs/promises')
  const written: string[] = []
  for (const [rel, bytes] of Object.entries(assets.files)) {
    const name = rel.split('/').pop()!
    const target = join(projectDir, '.shogo', 'store-assets', name)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, bytes)
    written.push(`.shogo/store-assets/${name}`)
  }
  return written
}

/** Exposed so callers and tests use the same normalisation for paths. */
export function archivePath(rel: string): string {
  return posix.normalize(rel.split(sep).join('/'))
}

/** Write a generated file into a staging dir (used for `eas.json` overlays). */
export async function stageGeneratedFile(dir: string, name: string, content: string): Promise<string> {
  await writeFile(join(dir, name), content, 'utf8')
  return join(dir, name)
}

// ---------------------------------------------------------------------------
// The release itself.
// ---------------------------------------------------------------------------

export interface NativeReleaseResult {
  ok: boolean
  /** Set when the project has no bundle id yet, so the agent asks first. */
  needs_bundle_id?: boolean
  default_bundle_identifier?: string
  release_id?: string
  kind?: 'build' | 'update'
  status?: string
  mode?: string
  plan_gate?: boolean
  test_stage?: 'scheduled' | 'skipped'
  error?: string
  code?: string
  /**
   * The generated store artwork, written under `.shogo/store-assets/` so the user
   * can commit it. `.shogo` is the runtime's own directory and is excluded from
   * the archive, so this does not change the project's source.
   */
  store_assets?: string[]
  store_background_color?: string
  /** The one thing to do next, and the sentence to say. See native-release-state. */
  state?: string
  next_action?: string
  user_message?: string
  links?: Record<string, string>
}

export interface RunNativeReleaseInput {
  projectId: string
  projectDir: string
  platforms: ('ios' | 'android')[]
  track: 'internal' | 'testflight' | 'production'
  /** Result of `hasMaestroFlows(projectDir)` — whether a test stage exists. */
  hasMaestroFlows: boolean
  /**
   * A logo the user supplied (`publish({ icon })`). The four store images are
   * generated from it; without one a project that has no artwork stops at
   * `needs_icon` rather than shipping a listing with no icon.
   */
  iconPath?: string
  /** Injected so a test (and the relay path) can stand in for the API. */
  api?: {
    state: (projectId: string) => Promise<{ ok: boolean; status?: number; data?: any; error?: string; code?: string }>
    start: (projectId: string, input: any) => Promise<{ ok: boolean; status?: number; data?: any; error?: string; code?: string }>
    sources: (projectId: string, releaseId: string, input: any) => Promise<{ ok: boolean; status?: number; data?: any; error?: string; code?: string }>
  }
  upload?: (url: string, body: Uint8Array) => Promise<void>
  tmpDir?: string
}

/** Does the project have Maestro flows? Decides whether a test stage runs. */
export async function hasMaestroFlows(projectDir: string): Promise<boolean> {
  const dir = join(projectDir, '.maestro')
  if (!existsSync(dir)) return false
  const { readdir } = await import('node:fs/promises')
  try {
    const entries = await readdir(dir, { recursive: true })
    return entries.some((name) => String(name).endsWith('.yml') || String(name).endsWith('.yaml'))
  } catch {
    return false
  }
}

/**
 * Does the project run its own backend?
 *
 * A Shogo project with a server answers `/api/...` relative to the origin the app
 * is served from — which on a device is nothing. Samsara is the reference case:
 * it built, installed, and could not load a single request.
 */
export function hasServerFiles(files: string[]): boolean {
  return files.some(
    (rel) =>
      rel === 'server.tsx' ||
      rel === 'server.ts' ||
      rel === 'custom-routes.ts' ||
      rel === 'custom-routes.tsx' ||
      rel === 'prisma/schema.prisma' ||
      rel === 'src/server.tsx' ||
      rel === 'src/server.ts',
  )
}

/**
 * The facts the state machine needs: what the API reports (connections, backend,
 * identifiers) plus what only the runner can see (the file list).
 */
export function factsFromState(
  stateData: any,
  files: string[],
  opts: { iconProvided?: boolean } = {},
): NativeReleaseFacts {
  const connections = stateData?.connections ?? {}
  const app = stateData?.app ?? {}
  return {
    needsBundleId: Boolean(stateData?.needsBundleId),
    hasServerFiles: hasServerFiles(files),
    backend: {
      published: Boolean(stateData?.backend?.published),
      url: stateData?.backend?.url ?? null,
    },
    connections: {
      play: {
        keyAvailable: Boolean(connections.play?.keyAvailable),
        publisherEmail: connections.play?.publisherEmail ?? null,
        firstUploadDone: Boolean(connections.play?.firstUploadDone),
      },
      asc: {
        keyAvailable: Boolean(connections.asc?.keyAvailable),
        appRecord: Boolean(connections.asc?.appRecord),
      },
    },
    hasStoreIcon: Boolean(opts.iconProvided) || hasCustomStoreIcon({ files }),
    bundleIdentifier: app.bundleIdentifier ?? stateData?.defaultBundleIdentifier ?? '',
    androidPackage: app.androidPackage ?? stateData?.defaultAndroidPackage ?? '',
  }
}

function toResultFields(step: NativeNextStep): Pick<
  NativeReleaseResult,
  'state' | 'next_action' | 'user_message' | 'links'
> {
  return {
    state: step.state,
    next_action: step.next_action,
    user_message: step.user_message,
    links: step.links,
  }
}

/**
 * Run one release. Returns the shape the agent reports from — deliberately
 * small, because the release is asynchronous: the agent gets a `release_id` and
 * polls it, rather than holding the turn open for a 20-minute build.
 */
export async function runNativeRelease(input: RunNativeReleaseInput): Promise<NativeReleaseResult> {
  const api = input.api ?? (await defaultNativeApi())

  const state = await api.state(input.projectId)
  if (!state.ok || !state.data) {
    return { ok: false, error: state.error ?? 'Could not read the native app state.', code: state.code }
  }

  if (state.data.needsBundleId) {
    return {
      ok: true,
      needs_bundle_id: true,
      default_bundle_identifier: state.data.defaultBundleIdentifier,
      mode: state.data.mode,
      ...toResultFields(
        nativeNextStep({
          facts: factsFromState(state.data, []),
          platforms: input.platforms,
        }),
      ),
    }
  }

  const ignoreFiles = await readIgnoreFiles(input.projectDir)
  const excluded = buildIgnoreMatcher(input.projectDir, ignoreFiles)
  const { readdir } = await import('node:fs/promises')
  const tracked: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      const rel = archivePath(abs.slice(input.projectDir.length + 1))
      if (excluded(rel)) continue
      if (entry.isDirectory()) await walk(abs)
      else if (entry.isFile()) tracked.push(rel)
    }
  }
  await walk(input.projectDir)

  // The logo is the one input that has to be turned into files before the gate
  // runs: with `iconPath` the project does have artwork, it just is not written
  // down yet.
  let storeAssets: StoreAssets | undefined
  let stagedAssetPaths: string[] = []
  if (input.iconPath) {
    const iconAbs = join(input.projectDir, input.iconPath)
    if (!existsSync(iconAbs)) {
      return { ok: false, error: `There is no file at ${input.iconPath}.`, code: 'native_icon_missing' }
    }
    try {
      storeAssets = generateStoreAssets(decodePng(await readFile(iconAbs)))
      // Offered to the user, not committed for them: these are their brand
      // assets and they may want to adjust the crops.
      stagedAssetPaths = await stageStoreAssets(input.projectDir, storeAssets)
    } catch (err) {
      return {
        ok: false,
        error: `Could not use ${input.iconPath} as the store icon: ${(err as Error).message}`,
        code: 'native_icon_invalid',
      }
    }
  }

  // Everything the flow needs is known before a build is charged: a missing
  // bundle id, a backend that is not published, an uninvited publisher account, a
  // Play package Google has never seen, an App Store Connect app record that does
  // not exist, or no store icon. Each of those is one sentence to the user, and
  // none of them is discoverable after a 20-minute build.
  const step = nativeNextStep({
    facts: factsFromState(state.data, tracked, { iconProvided: Boolean(storeAssets) }),
    platforms: input.platforms,
  })
  if (step.next_action !== 'building') {
    return {
      ok: true,
      mode: state.data.mode,
      ...(stagedAssetPaths.length
        ? { store_assets: stagedAssetPaths, store_background_color: storeAssets?.backgroundColor }
        : {}),
      ...toResultFields(step),
    }
  }

  const fingerprint = await computeFingerprint(input.projectDir, tracked)

  const started = await api.start(input.projectId, {
    platforms: input.platforms,
    track: input.track,
    fingerprint,
    hasMaestroFlows: input.hasMaestroFlows,
  })
  if (!started.ok || !started.data) {
    return {
      ok: false,
      error: started.error ?? 'The release was refused.',
      code: started.code,
      plan_gate: started.status === 402,
    }
  }

  const { releaseId, kind, uploads, mode } = started.data as {
    releaseId: string
    kind: 'build' | 'update'
    mode: string
    uploads: { kind: string; url: string; bucketKey: string }[]
  }

  // An update uploads nothing here: `expo export` output goes through the API.
  if (kind === 'update') {
    return { ok: true, release_id: releaseId, kind, status: 'exporting', mode }
  }

  const slot = uploads.find((u) => u.kind === 'source')
  if (!slot) {
    return { ok: false, release_id: releaseId, error: 'The API returned no source upload slot.' }
  }

  const outFile = join(input.tmpDir ?? (await mkdtemp(join(tmpdir(), 'shogo-native-out-'))), 'project.tar.gz')
  let archive: { bytes: number; files: number }
  try {
    archive = await writeProjectArchive({
      projectId: input.projectId,
      projectDir: input.projectDir,
      outFile,
      easyProjectId: (state.data.app?.easAppId as string | undefined) ?? undefined,
      resourceClass: state.data.pinnedResourceClass,
      storeAssets,
      // The store build carries the identifiers we confirmed with the user, not
      // whatever the project's config happened to say.
      identifier: {
        slug: state.data.defaultSlug ?? undefined,
        scheme: String(state.data.defaultSlug ?? '')
          .replace(/[^a-z0-9]+/gi, '')
          .toLowerCase() || undefined,
        iosBundleIdentifier:
          (state.data.app?.bundleIdentifier as string | undefined) ??
          (state.data.defaultBundleIdentifier as string | undefined),
        androidPackage:
          (state.data.app?.androidPackage as string | undefined) ??
          (state.data.defaultAndroidPackage as string | undefined),
      },
    })
  } catch (err) {
    return { ok: false, release_id: releaseId, error: `Could not archive the project: ${String((err as Error)?.message ?? err)}` }
  }

  const put = input.upload ?? defaultUpload
  try {
    await put(slot.url, new Uint8Array(await readFile(outFile)))
  } catch (err) {
    return { ok: false, release_id: releaseId, error: `Upload failed: ${String((err as Error)?.message ?? err)}` }
  }

  const sources = await api.sources(input.projectId, releaseId, { bucketKey: slot.bucketKey })
  if (!sources.ok) {
    return { ok: false, release_id: releaseId, error: sources.error ?? 'The uploaded archive was refused.', code: sources.code }
  }

  return {
    ok: true,
    release_id: releaseId,
    kind,
    status: (sources.data as { status?: string })?.status ?? 'uploaded',
    mode,
    test_stage: (sources.data as { workflowRunId?: string })?.workflowRunId ? 'scheduled' : 'skipped',
    ...(stagedAssetPaths.length
      ? { store_assets: stagedAssetPaths, store_background_color: storeAssets?.backgroundColor }
      : {}),
    ...(archive.files ? {} : {}),
  }
}

async function defaultUpload(url: string, body: Uint8Array): Promise<void> {
  const res = await fetch(url, {
    method: 'PUT',
    // Bun accepts a typed-array body; TS's `BodyInit` only admits an
    // `ArrayBuffer`-backed view, so the cast is type-level only.
    body: body as unknown as BodyInit,
    headers: { 'content-type': 'application/gzip' },
    signal: AbortSignal.timeout(300_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

async function defaultNativeApi(): Promise<NonNullable<RunNativeReleaseInput['api']>> {
  const api = await import('./internal-api')
  const shape = <T>(res: { ok: boolean; status?: number; data?: T; error?: string; code?: string }) => ({
    ok: res.ok,
    status: res.status,
    data: res.data,
    error: res.error,
    code: res.code,
  })
  return {
    state: async (projectId) => shape(await api.getNativeReleaseState(projectId)),
    start: async (projectId, input) => shape(await api.startNativeRelease(projectId, input)),
    sources: async (projectId, releaseId, input) => shape(await api.uploadNativeSources(projectId, releaseId, input)),
  }
}

/**
 * Poll one release. The release is asynchronous by design — a store build takes
 * 15-30 minutes — so the agent reports the step and comes back rather than
 * holding the turn open.
 */
export async function nativeReleaseStatus(
  projectId: string,
  releaseId: string,
  api?: { status: (projectId: string, releaseId: string) => Promise<{ ok: boolean; data?: any; error?: string; code?: string }> },
): Promise<Record<string, unknown>> {
  const fetchStatus =
    api?.status ??
    (async (id: string, rid: string) => {
      const mod = await import('./internal-api')
      const res = await mod.getNativeRelease(id, rid)
      return { ok: res.ok, data: res.data, error: res.error, code: res.code }
    })

  const res = await fetchStatus(projectId, releaseId)
  if (!res.ok || !res.data?.release) {
    return { ok: false, error: res.error ?? 'Unknown release.', code: res.code }
  }

  const release = res.data.release as {
    status: string
    step: string | null
    error: string | null
    kind: string
    track: string
    platforms?: ('ios' | 'android')[]
    testOutcome: string | null
    builds: { platform: string; purpose: string; status: string; resourceClass: string | null; submissionStatus: string | null }[]
  }

  const builds = (release.builds ?? []).map((b) => ({
    platform: b.platform,
    purpose: b.purpose,
    status: b.status,
    resource_class: b.resourceClass,
    submission_status: b.submissionStatus,
  }))

  // The same state machine the start path uses, so a poll cannot say something
  // different from the call that started the release.
  const step = nativeNextStep({
    facts: RELEASE_ONLY_FACTS,
    // The release row carries the platforms it was started for; both when a
    // caller hands us an older payload that predates the field.
    platforms: (release.platforms as ('ios' | 'android')[] | undefined) ?? ['ios', 'android'],
    release: {
      status: release.status,
      step: release.step,
      testOutcome: release.testOutcome,
      kind: release.kind,
      error: release.error,
    },
  })

  return {
    ok: true,
    release_id: releaseId,
    kind: release.kind,
    track: release.track,
    status: release.status,
    step: release.step,
    test_outcome: release.testOutcome,
    builds,
    error: release.error ?? undefined,
    ...toResultFields(step),
    // Kept for callers that only render one line, and so a failed test run is
    // never reported as a shipped app.
    summary: step.user_message,
  }
}
