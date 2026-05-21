// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { AgentClient, type WorkspaceBundle } from '@shogo-ai/sdk/agent'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { spawn } from 'node:child_process'
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import { createS3SyncForProject, isMacOSJunkName } from '@shogo/shared-runtime'
import { prisma } from '../lib/prisma'
import type { AuthContext } from '../middleware/auth'
import {
  encryptSecrets,
  decryptSecrets,
  parseEnvFile,
  type EncryptedSecretsBlob,
} from '../lib/bundle-crypto'
import { deriveRuntimeToken } from '../lib/runtime-token'

const PROJECT_ROOT = resolve(import.meta.dir, '../../../..')
const WORKSPACES_DIR = process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
const isKubernetes = () => !!process.env.KUBERNETES_SERVICE_HOST

// `dist/` and `build/` are intentionally NOT excluded here — we want the prebuilt
// app output in the bundle so an imported project can serve its preview
// immediately (preview-manager treats `project/dist/index.html` as "ready").
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.cache',
  '.next',
  '.turbo',
  '.expo',
])

// Volatile, per-machine, or generated files we never want in a portable bundle:
//   *-wal / *-shm  — SQLite write-ahead log + shared memory; volatile and may be
//                    inconsistent if the writer hadn't checkpointed (`PRAGMA
//                    wal_checkpoint`). The main `.db` is shipped on its own.
//   .install-ok*   — per-machine install-state markers.
//   .shogo-cwd-*   — transient shell-cwd markers leaked from preview tooling.
const EXCLUDED_FILE_PATTERNS: RegExp[] = [
  /-wal$/i,
  /-shm$/i,
  /^\.install-ok/,
  /^\.shogo-cwd-/,
]

// Per-workspace-relative paths that must NEVER round-trip through a
// bundle. These are install/build markers whose meaning is bound to
// the EXPORTING machine's `node_modules/`; trusting them on a fresh
// machine causes silent dependency-state mismatches.
//
//   .shogo/install-marker — sha256(package.json) recorded after the
//     exporter's last successful `bun install`. If we let it ride
//     into the cloud, `ensureWorkspaceDeps` and
//     `PreviewManager.installDepsIfNeeded` both find it matches the
//     (also-imported) package.json hash, conclude "deps are good",
//     and skip install — leaving the cloud pod's pre-seeded Vite
//     `node_modules/` in place for what's actually an Expo workspace.
//     Surfaced as the 2026-05-12 "imported Expo never rebuilds"
//     report (project 5a9304ff in staging).
const EXCLUDED_RELATIVE_PATHS = new Set<string>([
  '.shogo/install-marker',
])

const isExcludedFile = (name: string): boolean =>
  EXCLUDED_FILE_PATTERNS.some((re) => re.test(name))

/**
 * Path-aware exclusion check. Use for the workspace bundle's relative
 * paths (e.g. `.shogo/install-marker`, `prisma/dev.db-wal`); falls
 * back to basename matching for the legacy `EXCLUDED_FILE_PATTERNS`
 * list so callers don't need to remember to check both.
 */
const isExcludedRelPath = (relPath: string): boolean => {
  if (EXCLUDED_RELATIVE_PATHS.has(relPath)) return true
  const baseName = relPath.split('/').pop() || ''
  return isExcludedFile(baseName)
}

// Bundle format. Bumped to 1.1 with: manifest.json, requiredCredentials,
// sanitized (secret-stripped) channels, defensive path normalisation, and
// volatile-file exclusion. Importer accepts both 1.0 and 1.1.
const BUNDLE_FORMAT_VERSION = '1.1'
const SUPPORTED_BUNDLE_VERSIONS = new Set(['1.0', '1.1'])

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB per file
const MAX_TOTAL_SIZE = 200 * 1024 * 1024 // 200 MB total bundle

// Heuristic: any object key matching this pattern in `agentConfig.channels`
// or any `.env*` file is treated as a secret — redacted from the export and
// surfaced through `requiredCredentials` so the importer can fill it in
// post-import. The pattern covers:
//   - explicit secret words: token / secret / apikey / api_key / password / passwd
//   - personal access tokens: PAT, GITHUB_PAT, ACCOUNT_PAT (anchored on word boundary)
//   - OAuth flow tokens: bearer / client_secret / refresh_token / access_token
//   - connection strings that typically embed credentials:
//       DATABASE_URL, REDIS_URL, MONGO_URL, *_CONNECTION_STRING
//   - private keys & SSH:  private_key / ssh_key / pem
//   - signing & encryption: signing_secret / encryption_key
const SECRET_KEY_PATTERN =
  /token|secret|apikey|api_key|password|passwd|(^|_)pat$|webhook.*url|bearer|client[_-]?secret|refresh[_-]?token|access[_-]?token|database[_-]?url|redis[_-]?url|mongo[_-]?url|connection[_-]?string|private[_-]?key|ssh[_-]?key|signing[_-]?secret|encryption[_-]?key|\.pem$/i

const isSecretKey = (key: string): boolean => SECRET_KEY_PATTERN.test(key)

interface RequiredCredential {
  channel: string
  field: string
  label: string
}

/**
 * Returns a copy of `rawChannels` with all secret-looking string values
 * replaced with `null`, plus a flat list of credentials the importer must
 * provide post-import. Accepts the channels JSON in either parsed (array)
 * or stringified form (Prisma SQLite returns Json columns as strings).
 */
function sanitizeChannelsForExport(rawChannels: unknown): {
  sanitized: any[]
  required: RequiredCredential[]
} {
  let parsed: any = rawChannels
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      parsed = []
    }
  }
  if (!Array.isArray(parsed)) return { sanitized: [], required: [] }

  const required: RequiredCredential[] = []
  const sanitized = parsed.map((entry, idx) => {
    if (!entry || typeof entry !== 'object') return entry
    const channelType = entry.type || entry.channel || `channel-${idx}`
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(entry)) {
      if (typeof v === 'string' && v.length > 0 && isSecretKey(k)) {
        out[k] = null
        required.push({
          channel: String(channelType),
          field: k,
          label: `${channelType}.${k}`,
        })
      } else {
        out[k] = v
      }
    }
    return out
  })
  return { sanitized, required }
}

function collectWorkspaceFiles(
  dir: string,
  baseDir: string,
  skipped: Array<{ path: string; reason: string }> = [],
): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {}
  if (!existsSync(dir)) return files

  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue
    // macOS detritus: `._*` AppleDouble sidecars crash Metro's Babel parser
    // on import. Drop the whole subtree for junk dirs like `__MACOSX/`.
    if (isMacOSJunkName(entry.name)) continue

    const fullPath = join(dir, entry.name)
    const relPath = relative(baseDir, fullPath).replace(/\\/g, '/')

    if (entry.isDirectory()) {
      Object.assign(files, collectWorkspaceFiles(fullPath, baseDir, skipped))
    } else if (entry.isFile()) {
      if (isExcludedRelPath(relPath)) {
        skipped.push({ path: relPath, reason: 'excluded-pattern' })
        continue
      }
      try {
        const stat = statSync(fullPath)
        if (stat.size > MAX_FILE_SIZE) {
          skipped.push({ path: relPath, reason: `size>${MAX_FILE_SIZE}` })
          continue
        }
        files[relPath] = new Uint8Array(readFileSync(fullPath))
      } catch (err: any) {
        skipped.push({
          path: relPath,
          reason: `read-error:${err?.message || 'unknown'}`,
        })
      }
    }
  }
  return files
}

// ─── Import internals ──────────────────────────────────────────
// Factored out so both the JSON and SSE endpoints share the exact same logic.

type ImportEvent =
  | { phase: 'parse' }
  | { phase: 'createProject' }
  | { phase: 'writeFiles'; done: number; total: number }
  | { phase: 'importChats'; done: number; total: number }
  // Push the imported workspace from the API pod's local disk up to S3 so
  // the warm-pool runtime pod can `downloadAll()` it on first assignment.
  // K8s-only — local dev mounts the same workspace dir directly.
  | {
      phase: 'syncToS3'
      status: 'running' | 'ok' | 'failed' | 'skipped'
      bytes?: number
      durationMs?: number
      message?: string
    }
  | {
      phase: 'done'
      project: { id: string; name: string; description: string | null }
      stats: {
        filesWritten: number
        filesSkipped: number
        chatsImported: number
        chatsSkipped: number
      }
      // Populated when the bundle ships a `manifest.json` (v1.1+) or has
      // requiredCredentials in `project.json`. Lets the import modal render
      // a Setup Checklist instead of dumping the user into a broken agent.
      requiredCredentials?: RequiredCredential[]
      warnings?: string[]
      // True when the bundle had `encryptedSecrets` AND we successfully
      // decrypted with the supplied passphrase — the importer's UI uses this
      // to skip the manual "fill in tokens" step.
      secretsAutoFilled?: boolean
    }
  | { phase: 'error'; message: string; fatal: boolean }

interface ProjectBundle {
  version: string
  project: {
    name: string
    description?: string | null
    tier?: string
    status?: string
    settings?: any
    category?: string | null
    schemas?: string[]
    accessLevel?: string
    siteTitle?: string | null
    siteDescription?: string | null
  }
  agentConfig?: {
    heartbeatInterval?: number
    heartbeatEnabled?: boolean
    modelProvider?: string
    modelName?: string
    channels?: any
    quietHoursStart?: string | null
    quietHoursEnd?: string | null
    quietHoursTimezone?: string | null
  } | null
  requiredCredentials?: RequiredCredential[]
  encryptedSecrets?: EncryptedSecretsBlob
}

interface BundleManifest {
  bundleVersion?: string
  generatedAt?: string
  sourceMode?: string
  warnings?: string[]
  files?: {
    count?: number
    totalBytes?: number
    byCategory?: Record<string, number>
    skipped?: Array<{ path: string; reason: string }>
  }
  requiredCredentialsCount?: number
  // Names of the Context Files (e.g. "AGENTS.md") that were materialised at
  // export time because they did not exist at the workspace root. Diagnostic
  // only — the bundle is still a valid, self-contained project bundle.
  contextFilesSeeded?: string[]
}

type ImportResult =
  | {
      ok: true
      project: { id: string; name: string; description: string | null }
      stats: {
        filesWritten: number
        filesSkipped: number
        chatsImported: number
        chatsSkipped: number
      }
      requiredCredentials: RequiredCredential[]
      warnings: string[]
      secretsAutoFilled: boolean
    }
  | { ok: false; status: 400 | 401 | 403 | 413 | 500; error: string }

export async function runImport(
  zipBuffer: Uint8Array,
  workspaceId: string,
  userId: string,
  options: { includeChats: boolean; passphrase?: string; runBootstrap?: boolean },
  emit: (ev: ImportEvent) => void | Promise<void>,
): Promise<ImportResult> {
  // Verify user has access to the target workspace
  const member = await prisma.member.findFirst({
    where: { userId, workspaceId },
  })
  if (!member) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    })
    if (user?.role !== 'super_admin') {
      return { ok: false, status: 403, error: 'Access denied to this workspace' }
    }
  }

  let unzipped: Record<string, Uint8Array>
  try {
    unzipped = unzipSync(zipBuffer)
  } catch {
    return { ok: false, status: 400, error: 'Invalid or corrupt ZIP file' }
  }

  const projectJsonData = unzipped['project.json']
  if (!projectJsonData) {
    return { ok: false, status: 400, error: 'Invalid bundle: missing project.json' }
  }

  let bundle: ProjectBundle
  try {
    bundle = JSON.parse(strFromU8(projectJsonData))
  } catch {
    return { ok: false, status: 400, error: 'Invalid project.json in bundle' }
  }

  // Read manifest.json (v1.1+). Surface its warnings to the importer so they
  // see, in real time, *why* a file was missing or skipped — instead of
  // discovering the breakage at first run.
  const importWarnings: string[] = []
  let manifest: BundleManifest | null = null
  if (unzipped['manifest.json']) {
    try {
      manifest = JSON.parse(strFromU8(unzipped['manifest.json'])) as BundleManifest
      if (Array.isArray(manifest.warnings)) {
        for (const w of manifest.warnings) {
          importWarnings.push(w)
          await emit({
            phase: 'error',
            message: `[bundle warning] ${w}`,
            fatal: false,
          })
        }
      }
    } catch {
      importWarnings.push('manifest.json present but unparseable')
    }
  }

  // Bundle-version negotiation: warn (don't fail) on unknown formats so older
  // clients can still try to import bundles produced by future API builds.
  if (bundle.version && !SUPPORTED_BUNDLE_VERSIONS.has(bundle.version)) {
    const msg = `Bundle format ${bundle.version} is not officially supported (this server understands ${[...SUPPORTED_BUNDLE_VERSIONS].join(', ')}); attempting import anyway.`
    importWarnings.push(msg)
    await emit({ phase: 'error', message: msg, fatal: false })
  }

  await emit({ phase: 'parse' })

  const bp = bundle.project
  const project = await prisma.project.create({
    data: {
      name: bp.name || 'Imported Project',
      description: bp.description ?? null,
      workspaceId,
      createdBy: userId,
      tier: (bp.tier as any) || 'starter',
      status: (bp.status as any) || 'draft',
      accessLevel: (bp.accessLevel as any) || 'anyone',
      schemas: bp.schemas ?? [],
      category: (bp.category as any) ?? null,
      siteTitle: bp.siteTitle ?? null,
      siteDescription: bp.siteDescription ?? null,
      settings: bp.settings
        ? typeof bp.settings === 'string'
          ? bp.settings
          : JSON.stringify(bp.settings)
        : JSON.stringify({
            activeMode: 'none',
            canvasEnabled: false,
          }),
    },
  })

  // ─── Decrypt opt-in secrets ──────────────────────────────────────
  // If the bundle ships an `encryptedSecrets` blob and the importer supplied
  // a passphrase, unlock it and use it to: (a) re-merge channel tokens, and
  // (b) restore secret values inside `.env*` files after they're written.
  // Both are best-effort — wrong passphrase becomes a non-fatal warning, and
  // the importer can still complete via the manual Setup Checklist.
  let decryptedSecrets:
    | {
        version: number
        channels: Array<{ channel: string; field: string; value: string }>
        env: Record<string, Record<string, string>>
      }
    | null = null
  let secretsAutoFilled = false
  if (bundle.encryptedSecrets && options.passphrase) {
    try {
      decryptedSecrets = await decryptSecrets(bundle.encryptedSecrets, options.passphrase)
      secretsAutoFilled = true
    } catch (err: any) {
      await emit({
        phase: 'error',
        message: err?.message || 'Could not decrypt encryptedSecrets — passphrase may be wrong.',
        fatal: false,
      })
      importWarnings.push(
        'encryptedSecrets present but passphrase did not unlock — you will need to fill in credentials manually.',
      )
    }
  } else if (bundle.encryptedSecrets && !options.passphrase) {
    importWarnings.push(
      'Bundle ships encryptedSecrets but no passphrase was provided — credentials will need to be configured manually.',
    )
  }

  {
    const ac = bundle.agentConfig
    // v1.0 bundles double-encoded `channels` as a JSON string ("[]"); v1.1
    // emits a real array. Parse strings here so the DB column stores an
    // array, not a stringified array.
    let channelsValue: any = ac?.channels ?? []
    if (typeof channelsValue === 'string') {
      try {
        channelsValue = JSON.parse(channelsValue)
      } catch {
        channelsValue = []
      }
    }
    if (!Array.isArray(channelsValue)) channelsValue = []

    // Splice decrypted channel secrets back in by matching channel.type+field.
    if (decryptedSecrets?.channels?.length) {
      for (const secret of decryptedSecrets.channels) {
        const target = channelsValue.find((ch: any) => {
          const t = ch?.type || ch?.channel
          return t === secret.channel
        })
        if (target && target[secret.field] === null) {
          target[secret.field] = secret.value
        }
      }
    }

    const agentData: Record<string, any> = {
      projectId: project.id,
      heartbeatInterval: ac?.heartbeatInterval ?? 1800,
      heartbeatEnabled: ac?.heartbeatEnabled ?? false,
      modelProvider: ac?.modelProvider ?? 'anthropic',
      modelName: ac?.modelName ?? 'claude-haiku-4-5',
      channels: channelsValue,
    }
    // PG-only fields — include only when present in the bundle
    if (ac) {
      for (const key of ['quietHoursStart', 'quietHoursEnd', 'quietHoursTimezone']) {
        if ((ac as any)[key] !== undefined) agentData[key] = (ac as any)[key]
      }
    }
    await prisma.agentConfig.create({ data: agentData as any })
  }

  await emit({ phase: 'createProject' })

  // Extract workspace files
  const projectDir = join(WORKSPACES_DIR, project.id)
  mkdirSync(projectDir, { recursive: true })

  const workspaceEntries = Object.entries(unzipped).filter(([path]) =>
    path.startsWith('workspace/'),
  )
  const totalFiles = workspaceEntries.length
  let filesWritten = 0
  let filesSkipped = 0

  await emit({ phase: 'writeFiles', done: 0, total: totalFiles })

  for (let i = 0; i < workspaceEntries.length; i++) {
    const [path, data] = workspaceEntries[i]
    // Normalise backslashes — v1.0 bundles produced by old runtime pods used
    // Windows-style separators that, written verbatim, became literal-
    // backslash filenames on disk and broke memory/, .shogo/, src/ etc.
    const relPath = path.slice('workspace/'.length).replace(/\\/g, '/')
    if (
      !relPath ||
      relPath.includes('..') ||
      relPath.startsWith('/') ||
      /^[a-zA-Z]:\//.test(relPath) // reject Windows drive-absolute paths
    ) {
      filesSkipped++
      await emit({
        phase: 'error',
        message: `Skipped unsafe path: ${path}`,
        fatal: false,
      })
      continue
    }
    // Drop volatile / per-machine files that should never have shipped (in
    // case an old or third-party bundle includes them, or one was generated
    // by an exporter on a Shogo build that pre-dates the export-side
    // exclusion of `.shogo/install-marker`).
    if (isExcludedRelPath(relPath)) {
      filesSkipped++
      continue
    }

    try {
      const destPath = join(projectDir, relPath)
      const destDir = join(destPath, '..')
      mkdirSync(resolve(destDir), { recursive: true })
      writeFileSync(destPath, data)
      filesWritten++
    } catch (err: any) {
      filesSkipped++
      await emit({
        phase: 'error',
        message: `Failed to write ${relPath}: ${err?.message || 'unknown error'}`,
        fatal: false,
      })
    }

    // Emit incremental progress every 25 files and on the final file so the
    // client gets a smooth progress bar without flooding the SSE stream.
    if ((i + 1) % 25 === 0 || i === workspaceEntries.length - 1) {
      await emit({ phase: 'writeFiles', done: i + 1, total: totalFiles })
    }
  }

  // ─── Restore decrypted .env values ────────────────────────────────
  // The bundle's `.env*` files were sanitised at export time (secret values
  // blanked). When we successfully decrypted the secrets blob, splice the
  // original values back into the on-disk `.env*` files now that they exist.
  if (decryptedSecrets?.env) {
    for (const [zipPath, kv] of Object.entries(decryptedSecrets.env)) {
      // zipPath is like `workspace/.env` — convert to a real on-disk path.
      const rel = zipPath.replace(/^workspace\//, '').replace(/\\/g, '/')
      const fullPath = join(projectDir, rel)
      if (!existsSync(fullPath)) continue
      try {
        const text = readFileSync(fullPath, 'utf8')
        const lines = parseEnvFile(text)
        const restored = lines.map((line) => {
          if (line.isComment || !line.key) return line.raw
          if (kv[line.key] !== undefined) return `${line.key}=${kv[line.key]}`
          return line.raw
        })
        writeFileSync(fullPath, restored.join('\n'))
      } catch (err: any) {
        await emit({
          phase: 'error',
          message: `Could not restore secrets into ${rel}: ${err?.message || 'unknown'}`,
          fatal: false,
        })
      }
    }
  }

  // Import chat history (optional — client toggle)
  let chatsImported = 0
  let chatsSkipped = 0

  if (options.includeChats) {
    const chatEntries = Object.entries(unzipped).filter(
      ([path]) => path.startsWith('chat-history/') && path.endsWith('.json'),
    )
    const totalChats = chatEntries.length

    await emit({ phase: 'importChats', done: 0, total: totalChats })

    for (let i = 0; i < chatEntries.length; i++) {
      const [path, data] = chatEntries[i]
      try {
        const sessionBundle = JSON.parse(strFromU8(data)) as {
          session: {
            name?: string | null
            inferredName: string
            contextType: string
            phase?: string | null
            createdAt: string
            updatedAt: string
            lastActiveAt: string
          }
          messages: Array<{
            role: string
            content: string
            parts?: string | null
            createdAt: string
          }>
        }

        const s = sessionBundle.session
        const chatSession = await prisma.chatSession.create({
          data: {
            name: s.name ?? null,
            inferredName: s.inferredName || 'Imported session',
            contextType: 'project',
            contextId: project.id,
            phase: s.phase ?? null,
            createdAt: new Date(s.createdAt),
            updatedAt: new Date(s.updatedAt),
            lastActiveAt: new Date(s.lastActiveAt),
          },
        })

        if (sessionBundle.messages.length > 0) {
          await prisma.chatMessage.createMany({
            data: sessionBundle.messages.map((m) => ({
              sessionId: chatSession.id,
              role: m.role as any,
              content: m.content,
              parts: m.parts ?? null,
              createdAt: new Date(m.createdAt),
              agent: 'technical',
            })),
          })
        }
        chatsImported++
      } catch (err: any) {
        chatsSkipped++
        await emit({
          phase: 'error',
          message: `Failed to import chat ${path}: ${err?.message || 'malformed'}`,
          fatal: false,
        })
      }

      if ((i + 1) % 5 === 0 || i === chatEntries.length - 1) {
        await emit({ phase: 'importChats', done: i + 1, total: totalChats })
      }
    }
  } else {
    // Count what we skipped due to the toggle so the summary is honest.
    chatsSkipped = Object.keys(unzipped).filter(
      (p) => p.startsWith('chat-history/') && p.endsWith('.json'),
    ).length
  }

  const stats = { filesWritten, filesSkipped, chatsImported, chatsSkipped }
  const projectSummary = {
    id: project.id,
    name: project.name,
    description: project.description,
  }

  // Surface the requiredCredentials carried in project.json (v1.1+) so the
  // import modal can render a Setup Checklist instead of leaving the user
  // with an agent that can't talk to Telegram / OpenAI / etc.
  const requiredCredentials = Array.isArray(bundle.requiredCredentials)
    ? bundle.requiredCredentials
    : []

  // Post-import sanity checks → warnings. These are the things the user is
  // most likely to discover at first run: no memory, no skills, no .env.
  const projectDirAbs = resolve(projectDir)
  // Since the exporter now seeds a placeholder MEMORY.md when the source
  // workspace never wrote one, mere existence is no longer a useful signal —
  // a seeded stub is functionally empty. Warn when the file is missing OR
  // when its content is the seed stub / blank.
  const memoryPaths = [
    join(projectDirAbs, 'memory', 'MEMORY.md'),
    join(projectDirAbs, 'MEMORY.md'),
  ]
  const memoryIsEmpty = (() => {
    for (const p of memoryPaths) {
      if (!existsSync(p)) continue
      try {
        const body = readFileSync(p, 'utf8').trim()
        if (body.length === 0) return true
        // Treat the export-time seed stub as "empty" for warning purposes.
        if (/^#\s*MEMORY\.md\s*$/im.test(body) && body.length < 200 && /not been populated yet/i.test(body)) {
          return true
        }
        return false
      } catch {
        return false
      }
    }
    return true
  })()
  if (memoryIsEmpty) {
    importWarnings.push(
      'No MEMORY.md content found in workspace — agent will start with empty memory.',
    )
  }
  // If we successfully auto-filled secrets, the items they covered no longer
  // need to appear on the Setup Checklist.
  let pendingCredentials = requiredCredentials
  if (decryptedSecrets) {
    const filled = new Set<string>()
    for (const s of decryptedSecrets.channels || []) filled.add(`${s.channel}.${s.field}`)
    for (const [zipPath, kv] of Object.entries(decryptedSecrets.env || {})) {
      for (const k of Object.keys(kv)) filled.add(`${zipPath.replace(/^workspace\//, '')}.${k}`)
    }
    pendingCredentials = requiredCredentials.filter((c) => !filled.has(c.label))
  }
  if (pendingCredentials.length > 0) {
    importWarnings.push(
      `${pendingCredentials.length} credential(s) need to be configured: ${pendingCredentials.map((c) => c.label).join(', ')}.`,
    )
  }

  // ─── Push imported workspace to S3 (k8s only) ──────────────────────
  // In k8s mode, the API pod and the warm-pool runtime pod do NOT share a
  // filesystem. If we stop after writing `projectDir/` to the API pod's
  // local disk, the warm pod's `S3Sync.downloadAll()` finds NOTHING at
  // `s3://${S3_WORKSPACES_BUCKET}/<projectId>/project-src.tar.gz` and
  // silently seeds the warm-pool default template — which the user then
  // sees instead of their import. Push to S3 here so the assignment path
  // finds the real archive.
  //
  // This is a hard failure: if S3 upload fails we delete the project row
  // and return 500 so the importer sees a real error instead of
  // navigating into an empty hello-world. The 200-with-empty-project
  // outcome is the bug we are explicitly fixing.
  if (isKubernetes() && process.env.S3_WORKSPACES_BUCKET) {
    await emit({ phase: 'syncToS3', status: 'running' })
    const syncStart = Date.now()
    const sync = createS3SyncForProject(projectDir, project.id)
    if (!sync) {
      // Misconfiguration (e.g. bucket env truthy but empty string). Treat
      // as fatal — see comment above.
      await emit({
        phase: 'syncToS3',
        status: 'failed',
        message: 'S3 sync not configured (bucket/projectId missing)',
      })
      try {
        await prisma.project.delete({ where: { id: project.id } })
      } catch (cleanupErr: any) {
        console.error(
          `[project-import] Could not roll back project ${project.id} after S3 misconfig:`,
          cleanupErr?.message || cleanupErr,
        )
      }
      return {
        ok: false,
        status: 500,
        error: 'S3 sync not configured for k8s mode — refusing to create an unreachable project',
      }
    }
    try {
      const stats = await sync.uploadAll(false)
      const durationMs = Date.now() - syncStart
      if (stats.errors && stats.errors.length > 0) {
        throw new Error(stats.errors.join('; '))
      }
      const bytes = stats.archiveSize ?? 0
      console.log(
        `[project-import] S3 upload ok for ${project.id} in ${durationMs}ms (bytes=${bytes})`,
      )
      await emit({
        phase: 'syncToS3',
        status: 'ok',
        bytes,
        durationMs,
      })

      // Once the workspace is durably in S3, the API pod's local copy is
      // dead weight on ephemeral storage (we evicted api-00242 with this
      // exact failure mode three days ago). Default to cleanup, but allow
      // disabling via PURGE_LOCAL_AFTER_S3=false in case we get burned by
      // a follow-up read.
      if (process.env.PURGE_LOCAL_AFTER_S3 !== 'false') {
        try {
          rmSync(projectDir, { recursive: true, force: true })
        } catch (cleanupErr: any) {
          console.warn(
            `[project-import] Local cleanup failed for ${project.id} (non-fatal):`,
            cleanupErr?.message || cleanupErr,
          )
        }
      }
    } catch (err: any) {
      const durationMs = Date.now() - syncStart
      const message = err?.message || 'unknown S3 sync error'
      console.error(
        `[project-import] S3 upload FAILED for ${project.id} after ${durationMs}ms:`,
        message,
      )
      await emit({
        phase: 'syncToS3',
        status: 'failed',
        durationMs,
        message,
      })
      try {
        await prisma.project.delete({ where: { id: project.id } })
      } catch (cleanupErr: any) {
        console.error(
          `[project-import] Could not roll back project ${project.id} after S3 failure:`,
          cleanupErr?.message || cleanupErr,
        )
      }
      return {
        ok: false,
        status: 500,
        error: `S3 sync failed: ${message}`,
      }
    }
  } else if (isKubernetes()) {
    // K8s but no bucket configured — the warm pod can't find the workspace
    // and will spin up a default template. Surface this as a non-fatal
    // warning rather than a hard fail; some environments may intentionally
    // run without S3 (e.g. all-in-one dev cluster).
    importWarnings.push(
      'S3_WORKSPACES_BUCKET not configured — imported workspace will not be visible to the runtime pod.',
    )
    await emit({
      phase: 'syncToS3',
      status: 'skipped',
      message: 'S3_WORKSPACES_BUCKET not configured',
    })
  }

  // ─── Done before bootstrap ─────────────────────────────────────────
  // Emit `done` *before* kicking off the auto-bootstrap so the importer can
  // navigate to the new project immediately. Bootstrap (`bun install`,
  // `bun run generate`, etc.) takes 1-3 minutes on a fresh project —
  // gating "Open project" on it is the worst version of this flow. Project
  // files and chats are on disk and the project row exists in Postgres;
  // the project is openable.
  await emit({
    phase: 'done',
    project: projectSummary,
    stats,
    requiredCredentials: pendingCredentials,
    warnings: importWarnings,
    secretsAutoFilled,
  })

  // ─── No post-import bootstrap ──────────────────────────────────────
  // The API used to run `bun install` / `bun run generate` / preview boot
  // / health probe synchronously after import. That was both noise (it
  // surfaced work the user doesn't need to watch) and asymmetric with
  // k8s (where the agent pod has always owned its own lifecycle). It now
  // matches k8s in every mode: the runtime (`PreviewManager` in pod, Vite
  // dev server in local) installs deps lazily on first preview boot. The
  // import response returns the moment files are written.

  return {
    ok: true,
    project: projectSummary,
    stats,
    requiredCredentials: pendingCredentials,
    warnings: importWarnings,
    secretsAutoFilled,
  }
}

export function projectExportImportRoutes() {
  const app = new Hono()

  // GET /:projectId/export
  // Auth is handled by the requireProjectAccess middleware applied to /api/projects/:projectId/*
  app.get('/:projectId/export', async (c) => {
    const projectId = c.req.param('projectId')
    // Default to including chats; only "false" disables.
    const includeChats = c.req.query('includeChats') !== 'false'
    // Encrypted-secrets opt-in. When `passphrase` is supplied, channel tokens
    // and `.env` secret values are bundled inside an `encryptedSecrets` blob
    // (AES-256-GCM, PBKDF2-derived key) instead of being dropped entirely.
    const passphrase = c.req.query('passphrase') || ''
    const includeSecrets = !!passphrase
    // `.env` policy. Default = smart-split (redact secrets, ship `.env.example`
    // showing keys only). `?includeEnv=true` falls back to passthrough — the
    // raw .env files travel verbatim. Only respected when paired with a
    // passphrase OR when the operator explicitly opts in.
    const includeEnvRaw = c.req.query('includeEnv') === 'true'

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { agentConfig: true },
    })
    if (!project) {
      return c.json({ error: 'Project not found' }, 404)
    }

    const chatSessions = includeChats
      ? await prisma.chatSession.findMany({
          where: { contextType: 'project', contextId: projectId },
          include: {
            messages: {
              where: { agent: 'technical' },
              orderBy: { createdAt: 'asc' },
            },
          },
        })
      : []

    let settings: any = null
    if (project.settings) {
      try {
        settings =
          typeof project.settings === 'string'
            ? JSON.parse(project.settings)
            : project.settings
      } catch {
        settings = project.settings
      }
    }

    // Parse channels: Prisma SQLite returns Json columns as strings, while
    // Postgres returns parsed values. Strip secrets and capture them as
    // requiredCredentials so the importer is told what to fill in.
    const { sanitized: sanitizedChannels, required: requiredCredentials } =
      sanitizeChannelsForExport(project.agentConfig?.channels)

    const agentConfigExport: Record<string, any> | null = project.agentConfig
      ? {
          heartbeatInterval: project.agentConfig.heartbeatInterval,
          heartbeatEnabled: project.agentConfig.heartbeatEnabled,
          modelProvider: project.agentConfig.modelProvider,
          modelName: project.agentConfig.modelName,
          channels: sanitizedChannels,
        }
      : null

    // Include optional PG-only fields when present
    if (agentConfigExport && project.agentConfig) {
      const ac = project.agentConfig as Record<string, any>
      for (const key of ['quietHoursStart', 'quietHoursEnd', 'quietHoursTimezone']) {
        if (ac[key] !== undefined) agentConfigExport[key] = ac[key]
      }
    }

    const projectJson = {
      version: BUNDLE_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      includedChats: includeChats,
      project: {
        name: project.name,
        description: project.description,
        tier: project.tier,
        status: project.status,
        settings,
        category: project.category,
        schemas: project.schemas,
        accessLevel: project.accessLevel,
        siteTitle: project.siteTitle,
        siteDescription: project.siteDescription,
      },
      agentConfig: agentConfigExport,
      requiredCredentials,
    }

    const zipContents: Record<string, Uint8Array> = {}

    zipContents['project.json'] = strToU8(JSON.stringify(projectJson, null, 2))

    // Track export hygiene for the manifest (and so `done`/import can surface
    // it). `sourceMode` records whether files came from the live agent pod
    // (k8s) or directly from disk (local), and `fileSkipped` lists what we
    // intentionally dropped.
    const fileSkipped: Array<{ path: string; reason: string }> = []
    const exportWarnings: string[] = []
    let sourceMode: 'k8s' | 'k8s-fallback-empty' | 'local' = 'local'

    if (isKubernetes()) {
      sourceMode = 'k8s'
      try {
        const { getProjectPodUrl } = await import('../lib/knative-project-manager')
        const podUrl = await getProjectPodUrl(projectId)
        // Pod-side workspace endpoints require the per-project runtime token —
        // matches warm-pool-controller / heartbeat-scheduler / voice-context.
        // Without this header the pod returns 401, the catch below flips
        // sourceMode to `k8s-fallback-empty`, and the export ships with no
        // workspace/* entries (including AGENTS.md / TOOLS.md / STACK.md /
        // HEARTBEAT.md / MEMORY.md — the "Context Files").
        const agent = new AgentClient({
          baseUrl: podUrl,
          headers: { 'x-runtime-token': deriveRuntimeToken(projectId) },
        })
        const bundle: WorkspaceBundle = await agent.getWorkspaceBundle()
        const bundleFiles =
          bundle && typeof bundle === 'object' && bundle.files && typeof bundle.files === 'object'
            ? bundle.files
            : {}
        if (Object.keys(bundleFiles).length === 0) {
          exportWarnings.push(
            'Runtime pod returned an empty workspace bundle; the agent may be cold-starting or have no files yet.',
          )
        }

        // Defensive normalisation: older runtime pods returned Windows-style
        // backslash paths (e.g. `memory\2026-04-09.md`) which, when zipped
        // verbatim, became literal-backslash filenames after extraction —
        // breaking memory/, .shogo/, src/ etc. on the importer's machine.
        // The runtime is fixed (server.ts collectBundleFiles), but old pods
        // may still be live: normalise here so the bundle is always sane.
        let backslashCount = 0
        for (const [rawRelPath, base64Data] of Object.entries(bundleFiles)) {
          const relPath = rawRelPath.replace(/\\/g, '/')
          if (relPath !== rawRelPath) backslashCount++

          if (isExcludedRelPath(relPath)) {
            fileSkipped.push({ path: relPath, reason: 'excluded-pattern' })
            continue
          }
          zipContents[`workspace/${relPath}`] = new Uint8Array(
            Buffer.from(base64Data, 'base64'),
          )
        }
        if (backslashCount > 0) {
          exportWarnings.push(
            `Runtime pod returned ${backslashCount} workspace path(s) with backslash separators; normalised on the API side. The pod build may be outdated.`,
          )
        }
      } catch (err: any) {
        sourceMode = 'k8s-fallback-empty'
        exportWarnings.push(
          `Could not reach agent pod for workspace files: ${err?.message || 'unknown error'}`,
        )
        console.warn(
          `[Export] Could not reach agent pod for workspace files: ${err.message}`,
        )
      }
    } else {
      const workspaceDir = join(WORKSPACES_DIR, projectId)
      const workspaceFiles = collectWorkspaceFiles(
        workspaceDir,
        workspaceDir,
        fileSkipped,
      )
      for (const [relPath, data] of Object.entries(workspaceFiles)) {
        zipContents[`workspace/${relPath}`] = data
      }
    }

    // ─── Context Files seed ────────────────────────────────────────────
    // The 5 Context Files surfaced in the Studio Status panel must always
    // be present in the bundle, even when the source workspace never wrote
    // one (the runtime materialises them lazily on first use — TOOLS.md
    // when a tool is installed, MEMORY.md on first persist, etc.). If we
    // shipped without them, a freshly-imported project would start with
    // partial agent identity until the runtime regenerated the missing
    // ones — which never happens for files the agent simply never touches.
    //
    // Rules:
    //   • Never overwrite an existing entry (a 0-byte file is intentional).
    //   • Skip if the path is shadowed by a directory of the same name.
    //   • Prefer the workspace/.shogo/<name>.md template if it travelled
    //     in the bundle (this is what the runtime would copy on first
    //     write). Otherwise emit a minimal honest stub.
    //   • Record what we seeded in manifest.contextFilesSeeded so the
    //     reason a Context File looks generic is answerable from the zip
    //     alone, without spelunking through pod logs.
    const CONTEXT_FILES = ['AGENTS.md', 'TOOLS.md', 'STACK.md', 'HEARTBEAT.md', 'MEMORY.md']
    const contextFilesSeeded: string[] = []
    for (const name of CONTEXT_FILES) {
      const key = `workspace/${name}`
      if (zipContents[key] !== undefined) continue
      // Defensive: don't seed if the workspace shipped a *directory* with
      // this name (would produce two entries with conflicting types in the
      // zip). Extremely unlikely but cheap to guard.
      const shadowed = Object.keys(zipContents).some((k) => k.startsWith(`${key}/`))
      if (shadowed) continue

      const templateKey = `workspace/.shogo/${name}`
      const template = zipContents[templateKey]
      if (template !== undefined && template.byteLength > 0) {
        zipContents[key] = template
      } else {
        const stub = `# ${name}\n\n_This Context File has not been populated yet._\n`
        zipContents[key] = strToU8(stub)
      }
      contextFilesSeeded.push(name)
    }

    // ─── .env smart-split ──────────────────────────────────────────────
    // Walk every workspace/.env* file we just bundled. For each one:
    //   - If the user opted into raw .env passthrough, leave it untouched.
    //   - Otherwise redact every secret-looking key, ship a sanitised copy
    //     under the same path, and add the redacted keys to requiredCredentials
    //     so the importer is told what's missing. The original *values* are
    //     captured into `envSecretsByFile` so they can travel inside the
    //     optional encryptedSecrets blob (when a passphrase is supplied).
    const envSecretsByFile: Record<string, Record<string, string>> = {}
    if (!includeEnvRaw) {
      const envPaths = Object.keys(zipContents).filter((k) => {
        if (!k.startsWith('workspace/')) return false
        const base = k.split('/').pop() || ''
        return base === '.env' || base.startsWith('.env.')
      })
      for (const zipPath of envPaths) {
        const text = strFromU8(zipContents[zipPath])
        const lines = parseEnvFile(text)
        const fileSecrets: Record<string, string> = {}
        const sanitised: string[] = []
        for (const line of lines) {
          if (line.isComment || !line.key) {
            sanitised.push(line.raw)
            continue
          }
          if (isSecretKey(line.key) && line.value.length > 0) {
            fileSecrets[line.key] = line.value
            sanitised.push(`${line.key}=`)
            requiredCredentials.push({
              channel: zipPath.replace(/^workspace\//, ''),
              field: line.key,
              label: `env.${line.key}`,
            })
          } else {
            sanitised.push(line.raw)
          }
        }
        zipContents[zipPath] = strToU8(sanitised.join('\n'))
        if (Object.keys(fileSecrets).length > 0) {
          envSecretsByFile[zipPath] = fileSecrets
          // Also ship a `.env.example` next to the original — values blanked,
          // keys preserved — so the importer has a one-glance reference.
          const exampleLines = lines.map((l) =>
            l.isComment || !l.key ? l.raw : `${l.key}=`,
          )
          const examplePath = `${zipPath}.example`
          if (!zipContents[examplePath]) {
            zipContents[examplePath] = strToU8(exampleLines.join('\n'))
          }
        }
      }
    }

    // ─── Encrypted secrets blob (opt-in) ───────────────────────────────
    // When a passphrase is supplied, restore the *original* channel tokens and
    // the redacted .env values (which we kept in memory only) inside an
    // AES-GCM-encrypted blob attached to project.json. The importer can unlock
    // it with the same passphrase to auto-fill credentials.
    if (includeSecrets) {
      // Re-derive the original channel secrets — we need them BEFORE
      // sanitizeChannelsForExport stripped them. Parse the raw JSON again.
      let rawChannels: any = project.agentConfig?.channels
      if (typeof rawChannels === 'string') {
        try { rawChannels = JSON.parse(rawChannels) } catch { rawChannels = [] }
      }
      const channelSecrets: Array<{ channel: string; field: string; value: string }> = []
      if (Array.isArray(rawChannels)) {
        rawChannels.forEach((entry: any, idx: number) => {
          if (!entry || typeof entry !== 'object') return
          const channelType = entry.type || entry.channel || `channel-${idx}`
          for (const [k, v] of Object.entries(entry)) {
            if (typeof v === 'string' && v.length > 0 && isSecretKey(k)) {
              channelSecrets.push({ channel: String(channelType), field: k, value: v })
            }
          }
        })
      }

      const secretsPayload = {
        version: 1,
        channels: channelSecrets,
        env: envSecretsByFile,
      }
      try {
        const blob: EncryptedSecretsBlob = await encryptSecrets(
          secretsPayload,
          passphrase,
        )
        ;(projectJson as any).encryptedSecrets = blob
        // Re-emit project.json with the new field.
        zipContents['project.json'] = strToU8(JSON.stringify(projectJson, null, 2))
      } catch (err: any) {
        exportWarnings.push(
          `Encrypted-secrets opt-in failed (${err?.message || 'unknown'}); bundle shipped without secrets.`,
        )
      }
    }

    for (const session of chatSessions) {
      const sessionData = {
        session: {
          name: session.name,
          inferredName: session.inferredName,
          contextType: session.contextType,
          phase: session.phase,
          createdAt: session.createdAt.toISOString(),
          updatedAt: session.updatedAt.toISOString(),
          lastActiveAt: session.lastActiveAt.toISOString(),
        },
        messages: session.messages.map((m) => ({
          role: m.role,
          content: m.content,
          parts: m.parts,
          createdAt: m.createdAt.toISOString(),
        })),
      }
      zipContents[`chat-history/${session.id}.json`] = strToU8(
        JSON.stringify(sessionData, null, 2),
      )
    }

    // ─── Bundle manifest ────────────────────────────────────────────
    // Self-describing inventory + warnings + provenance. Lives at the bundle
    // root so the importer can show a setup summary and so future bug reports
    // ("file X went missing") are diagnosable from the bundle alone.
    const inventory: Record<string, number> = {}
    let totalBytes = 0
    for (const [path, data] of Object.entries(zipContents)) {
      totalBytes += data.byteLength
      const top = path.startsWith('workspace/')
        ? 'workspace'
        : path.startsWith('chat-history/')
          ? 'chat-history'
          : path === 'project.json'
            ? 'project-meta'
            : 'other'
      inventory[top] = (inventory[top] || 0) + 1
    }

    const manifest = {
      bundleVersion: BUNDLE_FORMAT_VERSION,
      generatedAt: new Date().toISOString(),
      sourceMode,
      files: {
        count: Object.keys(zipContents).length + 1, // +1 for manifest itself
        totalBytes,
        byCategory: inventory,
        skipped: fileSkipped,
      },
      chats: {
        included: chatSessions.length,
      },
      requiredCredentialsCount: requiredCredentials.length,
      hasEncryptedSecrets: includeSecrets && !!(projectJson as any).encryptedSecrets,
      envPolicy: includeEnvRaw ? 'passthrough' : 'smart-split',
      warnings: exportWarnings,
      contextFilesSeeded,
    }
    zipContents['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))

    const zipped = zipSync(zipContents, { level: 6 })

    const safeName = project.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)
    const filename = `${safeName}.shogo-project`

    const body = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer
    return new Response(body, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(zipped.byteLength),
      },
    })
  })

  // POST /import
  // No requireProjectAccess middleware here (no projectId). Auth checked manually.
  //
  // When the client sends `Accept: text/event-stream`, we stream progress as SSE:
  //   event: progress     data: { phase, ... }
  //   event: error        data: { message, fatal }       (non-fatal per-file/per-chat)
  //   event: done         data: { project, stats }
  //   event: fatal        data: { message }              (terminal failure)
  // Otherwise, we return the original JSON `{ project: {...} }` response so
  // existing non-streaming clients / tests keep working unchanged.
  app.post('/import', async (c) => {
    const authCtx = (c as any).get('auth') as AuthContext | undefined
    if (!authCtx?.isAuthenticated || !authCtx.userId) {
      return c.json(
        { error: { code: 'unauthorized', message: 'Authentication required' } },
        401,
      )
    }
    const userId = authCtx.userId

    const contentType = c.req.header('content-type') || ''
    const acceptsSSE = (c.req.header('accept') || '').includes('text/event-stream')

    let zipBuffer: Uint8Array
    let workspaceId: string
    let includeChats: boolean
    let passphrase: string
    let runBootstrap: boolean

    if (contentType.includes('multipart/form-data')) {
      const formData = await c.req.formData()
      const file = formData.get('file') as File | null
      workspaceId = (formData.get('workspaceId') as string) || ''
      const includeChatsRaw = (formData.get('includeChats') as string | null) ?? 'true'
      includeChats = includeChatsRaw !== 'false'
      passphrase = (formData.get('passphrase') as string | null) || ''
      // Bootstrap defaults ON; client can opt out with `runBootstrap=false`.
      const bootstrapRaw = (formData.get('runBootstrap') as string | null) ?? 'true'
      runBootstrap = bootstrapRaw !== 'false'

      if (!file) {
        return c.json({ error: 'Missing file in form data' }, 400)
      }
      if (!workspaceId) {
        return c.json({ error: 'Missing workspaceId in form data' }, 400)
      }

      const arrayBuf = await file.arrayBuffer()
      if (arrayBuf.byteLength > MAX_TOTAL_SIZE) {
        return c.json({ error: 'File too large' }, 413)
      }
      zipBuffer = new Uint8Array(arrayBuf)
    } else {
      return c.json(
        { error: 'Expected multipart/form-data with file upload' },
        400,
      )
    }

    if (acceptsSSE) {
      return streamSSE(c, async (stream) => {
        try {
          const result = await runImport(
            zipBuffer,
            workspaceId,
            userId,
            { includeChats, passphrase, runBootstrap },
            async (ev) => {
              if (ev.phase === 'error') {
                await stream.writeSSE({
                  event: ev.fatal ? 'fatal' : 'error',
                  data: JSON.stringify({ message: ev.message, fatal: ev.fatal }),
                })
              } else if (ev.phase === 'done') {
                await stream.writeSSE({
                  event: 'done',
                  data: JSON.stringify({
                    project: ev.project,
                    stats: ev.stats,
                    requiredCredentials: ev.requiredCredentials ?? [],
                    warnings: ev.warnings ?? [],
                    secretsAutoFilled: ev.secretsAutoFilled ?? false,
                  }),
                })
              } else {
                await stream.writeSSE({
                  event: 'progress',
                  data: JSON.stringify(ev),
                })
              }
            },
          )

          if (!result.ok) {
            await stream.writeSSE({
              event: 'fatal',
              data: JSON.stringify({ message: result.error, status: result.status }),
            })
          }
        } catch (err: any) {
          await stream.writeSSE({
            event: 'fatal',
            data: JSON.stringify({
              message: err?.message || 'Import failed',
            }),
          })
        }
      })
    }

    // Non-streaming fallback — preserve existing JSON shape.
    try {
      const result = await runImport(
        zipBuffer,
        workspaceId,
        userId,
        { includeChats, passphrase, runBootstrap },
        () => {
          /* drop events */
        },
      )

      if (!result.ok) {
        if (result.status === 403) {
          return c.json(
            { error: { code: 'forbidden', message: result.error } },
            403,
          )
        }
        return c.json({ error: result.error }, result.status)
      }

      return c.json({
        project: result.project,
        stats: result.stats,
        requiredCredentials: result.requiredCredentials,
        warnings: result.warnings,
        secretsAutoFilled: result.secretsAutoFilled,
      })
    } catch (err: any) {
      return c.json({ error: err?.message || 'Import failed' }, 500)
    }
  })

  return app
}
