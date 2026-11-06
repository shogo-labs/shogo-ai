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
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, sep } from 'node:path'
import ignore from 'ignore'

const execFileAsync = promisify(execFile)

/** Directories that never belong in a build archive, at any depth. */
const ALWAYS_EXCLUDED_DIRS = new Set(['node_modules', '.shogo', '.git', '.expo', 'ios', 'android'])

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
  /** Build env the API should hand to EAS (`EXPO_PUBLIC_*` only). */
  publicEnv?: Record<string, string>
  /** Absolute paths (project-relative) the caller wants excluded on top. */
  extraExcludes?: string[]
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
 */
export function buildEasJson(opts: { projectId: string; owner?: string }): Record<string, unknown> {
  return {
    cli: { version: '>= 16.0.0', appVersionSource: 'remote', requireCommit: false },
    build: {
      'shogo-test': {
        distribution: 'internal',
        developmentClient: false,
        withoutCredentials: true,
        android: { buildType: 'apk' },
        ios: { simulator: true },
      },
      'shogo-store': {
        distribution: 'store',
        autoIncrement: true,
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
}): Record<string, unknown> {
  return {
    extra: { eas: { projectId: opts.easProjectId } },
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
 * Write the archive.
 *
 * The project is copied into a staging tree, the generated `eas.json` and app
 * config overlay are written *there*, and the staging tree is what gets tarred.
 * The project directory is only ever read — that is what makes "the working tree
 * is byte-identical before and after a release" true rather than hopeful.
 */
export async function writeProjectArchive(
  opts: ArchiveOptions & { outFile: string; easyProjectId?: string; updatesUrl?: string },
): Promise<{ bytes: number; files: number; publicEnv: Record<string, string> }> {
  const { create } = await import('tar')
  const { cp, mkdir, readdir, stat } = await import('node:fs/promises')

  const ignoreFiles = await readIgnoreFiles(opts.projectDir)
  const excluded = buildIgnoreMatcher(opts.projectDir, ignoreFiles)
  const extra = new Set((opts.extraExcludes ?? []).map(archivePath))

  const files: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      const rel = archivePath(abs.slice(opts.projectDir.length + 1))
      if (excluded(rel) || extra.has(rel)) continue
      if (entry.isDirectory()) {
        await walk(abs)
        continue
      }
      if (entry.isFile()) files.push(rel)
    }
  }
  await walk(opts.projectDir)

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

    await writeFile(
      join(staging, 'eas.json'),
      JSON.stringify(buildEasJson({ projectId: opts.projectId, owner: opts.owner }), null, 2),
      'utf8',
    )
    files.push('eas.json')

    if (opts.easyProjectId) {
      const overlay = buildAppConfigOverlay({
        easProjectId: opts.easyProjectId,
        updatesUrl: opts.updatesUrl,
      })
      const appJsonPath = join(staging, 'app.json')
      if (existsSync(appJsonPath)) {
        const parsed = JSON.parse(await readFile(appJsonPath, 'utf8')) as Record<string, any>
        const root = parsed.expo ?? parsed
        root.extra = { ...(root.extra ?? {}), ...(overlay.extra ?? {}) }
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
}

export interface RunNativeReleaseInput {
  projectId: string
  projectDir: string
  platforms: ('ios' | 'android')[]
  track: 'internal' | 'testflight' | 'production'
  /** Result of `hasMaestroFlows(projectDir)` — whether a test stage exists. */
  hasMaestroFlows: boolean
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

  const failed = release.testOutcome === 'failed'
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
    // What the agent says to the user, so a failed test run is never reported
    // as a shipped app.
    summary:
      release.status === 'done'
        ? release.kind === 'update'
          ? 'Update published to existing installs.'
          : 'Submitted to the store.'
        : failed
          ? 'The test build or Maestro flow failed, so nothing was sent to the store.'
          : `In progress: ${release.step ?? release.status}.`,
  }
}
