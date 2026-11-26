// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Generate the environment-variable table in `docs/STANDALONE_RUNTIME.md`.
 *
 * A partner running the runtime on their own cluster needs to know exactly
 * which env vars the process reads — no more, no less. Hand-maintaining that
 * list drifts within a week, so it is derived from the source: every
 * `process.env.X` (and `process.env['X']`) in `packages/agent-runtime/src` and
 * `packages/shared-runtime/src`, excluding tests and evals.
 *
 * The table is deterministic (sorted, no timestamps), so the drift test can
 * re-render it and compare byte for byte.
 *
 * Usage:
 *   bun run scripts/gen-runtime-env-doc.ts           # rewrite the table
 *   bun run scripts/gen-runtime-env-doc.ts --check   # exit 1 on drift
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'

const REPO_ROOT = resolve(import.meta.dir, '..')
export const DOC_PATH = join(REPO_ROOT, 'docs/STANDALONE_RUNTIME.md')

export const TABLE_BEGIN = '<!-- BEGIN GENERATED ENV TABLE -->'
export const TABLE_END = '<!-- END GENERATED ENV TABLE -->'

const SCAN_DIRS = ['packages/agent-runtime/src', 'packages/shared-runtime/src']
const SKIP_DIRS = new Set(['__tests__', 'evals', 'node_modules', 'dist'])

/** `required` — boot fails without it. `ignored` — read, but meaningless standalone. */
export type StandaloneStatus = 'required' | 'ignored' | 'off unless set' | 'optional'

/**
 * Required by `assertStandaloneEnv()`. The provider vars are required *for the
 * provider named in `AGENT_MODEL`*, which the doc spells out.
 */
const REQUIRED = new Set([
  'RUNTIME_AUTH_SECRET',
  'AGENT_MODEL',
  'OPENAI_BASE_URL',
  'LOCAL_LLM_BASE_URL',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
])

/** Read by the runtime, but only meaningful with a Shogo platform behind it. */
const IGNORED = new Set([
  'SHOGO_API_URL',
  'SHOGO_PUBLIC_API_URL',
  'API_URL',
  'AI_PROXY_URL',
  'AI_PROXY_TOKEN',
  'TOOLS_PROXY_URL',
  'SYSTEM_NAMESPACE',
  'KUBERNETES_SERVICE_HOST',
  'WARM_POOL_MODE',
  'WORKSPACE_RUNTIME_AUTH_SECRET',
  'WORKSPACE_ID',
  'ASSIGNED_PROJECT',
  'KNATIVE_SERVICE_NAME',
  'VM_WORKSPACE_MOUNTED',
  'SHOGO_HOST_WORKSPACES_ROOT',
  'SHOGO_POOL_STATE_DIR',
  'SHOGO_POOL_SENTINEL',
  'AGENT_AUTO_TIER_MAP',
  'AGENT_SUMMARIZER_MODEL',
  'AGENT_MODEL_REGISTRY',
  'AGENT_DEEPSEEK_MODEL_IDS',
])

const IGNORED_PREFIXES = ['S3_', 'AWS_', 'OTEL_', 'COMPOSIO_', 'PUBLISHED_', 'POOL_', 'SHOGO_POOL_']

/** Off unless the partner turns it on. */
const OFF_UNLESS_SET = new Set([
  'SHOGO_STANDALONE',
  'PREVIEW_BASE_PATH',
  'AGENT_EMBEDDING_MODEL',
  'AGENT_THINKING_LEVEL',
  'AGENT_BASIC_THINKING_LEVEL',
])

/** One line each for the variables that are part of the standalone contract. */
const PURPOSE: Record<string, string> = {
  SHOGO_STANDALONE: 'Set to `1` to run with no Shogo API. Turns off every platform-bound caller.',
  RUNTIME_AUTH_SECRET: 'The only accepted token on `/agent/*`. Sent as `Authorization: Bearer …` or `x-runtime-token`.',
  AGENT_MODEL: 'Pins every model pick to `<provider>:<model>`. See [Models](#models).',
  OPENAI_BASE_URL: 'Base URL of an OpenAI-compatible endpoint (used by the `local` and `openai` providers).',
  LOCAL_LLM_BASE_URL: 'Alternative to `OPENAI_BASE_URL` for a local endpoint. Also forces thinking off.',
  OPENAI_API_KEY: 'Key for the `openai` provider. A local endpoint usually accepts any non-empty value.',
  ANTHROPIC_API_KEY: 'Key for the `anthropic` provider.',
  ANTHROPIC_BASE_URL: 'Base URL override for the `anthropic` provider.',
  GOOGLE_API_KEY: 'Key for the `google` provider.',
  GEMINI_API_KEY: 'Alternative name for `GOOGLE_API_KEY`.',
  OPENROUTER_API_KEY: 'Key for the `openrouter` provider.',
  PREVIEW_BASE_PATH: 'Serve the built app under a path prefix (e.g. `/s/abc123`). See [Previews](#previews).',
  AGENT_EMBEDDING_MODEL: 'Embedding model your endpoint serves. Unset means the index and memory use FTS only.',
  WORKSPACE_DIR: 'The workspace root the agent reads and writes. Defaults to `/app/workspace`.',
  PORT: 'HTTP port. Defaults to `8080`.',
  HOST: 'Bind address. Defaults to Bun\'s default (all interfaces).',
  NODE_ENV: '`production` requires `RUNTIME_AUTH_SECRET`; anything else lets an unauthenticated runtime boot.',
  PROJECT_ID: 'Identity reported by `/health`. Defaults to `standalone` in standalone mode.',
  HOME: 'Home directory for tool config and caches. The image sets `/app`.',
  SCHEMAS_PATH: 'Where the runtime writes its JSON schemas. The image sets `/app/.schemas`.',
  MCP_SERVER_PATH: 'Path to the bundled MCP server entry point.',
  RUNTIME_TEMPLATE_DIR: 'Starter template the runtime seeds a new project from.',
  WORKING_MODE: '`managed` (Shogo owns the workspace) or `external` (a linked folder).',
  LINKED_FOLDERS: 'JSON array of extra roots the agent may touch.',
  READONLY_ROOTS: 'JSON array of roots mounted read-only.',
  AGENT_THINKING_LEVEL: 'Default reasoning effort for turns.',
  AGENT_BASIC_THINKING_LEVEL: 'Reasoning effort for `basic` agent mode.',
  SHOGO_RUNTIME_REVISION: 'Commit the image was built from. Baked in at build time.',
  DRAIN_TIMEOUT_MS: 'How long SIGTERM waits for in-flight streams. See [Lifecycle](#lifecycle).',
  SHOGO_LFS_CONCURRENT_TRANSFERS: 'In-flight `git lfs push` transfers. Defaults to `2` (capped at `16`) so a small VM does not buffer eight objects at once.',
  FFMPEG_PATH: 'Explicit path to `ffmpeg`, for an install that is not on `PATH`. It re-encodes a video read for a model that samples at a fixed rate.',
  FFPROBE_PATH: 'Explicit path to `ffprobe`. When neither it nor the MP4 box walk can read a clip, the read reports no frame count rather than guessing.',
  HOMEBREW_PREFIX: 'Homebrew root: `<prefix>/bin` is searched for `ffmpeg`/`ffprobe`. `/opt/homebrew/bin` is searched anyway.',
}

function walk(dir: string, out: string[]): void {
  // Sorted, because `extractDefault` takes the first file that spells a
  // fallback and two variables (`DATABASE_URL`, `WORKSPACE_ID`) spell more than
  // one. `readdirSync` order follows the directory's on-disk order, so without
  // this the rendered table — and the drift test — depends on the filesystem.
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue
      walk(full, out)
      continue
    }
    if (!entry.endsWith('.ts')) continue
    if (entry.endsWith('.test.ts') || entry.endsWith('.spec.ts')) continue
    out.push(full)
  }
}

const ENV_DOT = /process\.env\.([A-Z][A-Z0-9_]*)/g
const ENV_BRACKET = /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g

/** Every env var the runtime reads, mapped to the files that read it. */
export function collectRuntimeEnvVars(root: string = REPO_ROOT): Map<string, Set<string>> {
  const files: string[] = []
  for (const dir of SCAN_DIRS) walk(join(root, dir), files)

  const vars = new Map<string, Set<string>>()
  for (const file of files) {
    const source = readFileSync(file, 'utf-8')
    const rel = file.slice(join(root, 'packages').length + 1)
    for (const re of [ENV_DOT, ENV_BRACKET]) {
      re.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = re.exec(source)) !== null) {
        const name = match[1]
        if (!vars.has(name)) vars.set(name, new Set())
        vars.get(name)!.add(rel)
      }
    }
  }
  return vars
}

/** The literal a var falls back to, when the code spells one out. */
export function extractDefault(root: string, name: string): string | null {
  const files: string[] = []
  for (const dir of SCAN_DIRS) walk(join(root, dir), files)
  const pattern = new RegExp(
    `process\\.env\\.${name}\\s*(?:\\|\\||\\?\\?)\\s*'([^']*)'`,
  )
  for (const file of files) {
    const match = pattern.exec(readFileSync(file, 'utf-8'))
    if (match) return match[1]
  }
  return null
}

export function standaloneStatus(name: string): StandaloneStatus {
  if (REQUIRED.has(name)) return 'required'
  if (IGNORED.has(name) || IGNORED_PREFIXES.some((p) => name.startsWith(p))) return 'ignored'
  if (OFF_UNLESS_SET.has(name)) return 'off unless set'
  return 'optional'
}

/** Render the whole generated block, markers included. */
export function renderEnvTable(root: string = REPO_ROOT): string {
  const vars = collectRuntimeEnvVars(root)
  const names = [...vars.keys()].sort()
  const lines = [
    TABLE_BEGIN,
    '',
    `The runtime reads ${names.length} environment variables. This table is generated from the source by`,
    '`scripts/gen-runtime-env-doc.ts`; a test fails when the code and the table disagree.',
    '',
    '| Variable | Standalone | Default | Purpose |',
    '| --- | --- | --- | --- |',
  ]
  for (const name of names) {
    const status = standaloneStatus(name)
    const fallback = extractDefault(root, name)
    const purpose = PURPOSE[name] ?? ''
    lines.push(
      `| \`${name}\` | ${status} | ${fallback === null ? '—' : `\`${fallback}\``} | ${purpose || '—'} |`,
    )
  }
  lines.push('', TABLE_END)
  return lines.join('\n')
}

/** The generated block currently in the doc, or `null` when the markers are gone. */
export function extractDocTable(doc: string): string | null {
  const begin = doc.indexOf(TABLE_BEGIN)
  const end = doc.indexOf(TABLE_END)
  if (begin === -1 || end === -1 || end < begin) return null
  return doc.slice(begin, end + TABLE_END.length)
}

export interface EnvDocDrift {
  /** Read by the code, missing from the table. */
  missing: string[]
  /** Listed in the table, no longer read by the code. */
  stale: string[]
  /** The table exists but its rows differ (defaults, statuses, purposes). */
  changed: boolean
  /** The markers themselves are gone. */
  noMarkers: boolean
}

export function checkEnvDoc(root: string = REPO_ROOT, docPath: string = DOC_PATH): EnvDocDrift {
  const doc = readFileSync(docPath, 'utf-8')
  const current = extractDocTable(doc)
  const rendered = renderEnvTable(root)
  if (current === null) return { missing: [], stale: [], changed: true, noMarkers: true }

  const namesIn = (block: string) =>
    new Set([...block.matchAll(/^\| `([A-Z][A-Z0-9_]*)` \|/gm)].map((m) => m[1]))
  const documented = namesIn(current)
  const actual = namesIn(rendered)

  return {
    missing: [...actual].filter((n) => !documented.has(n)).sort(),
    stale: [...documented].filter((n) => !actual.has(n)).sort(),
    changed: current !== rendered,
    noMarkers: false,
  }
}

if (import.meta.main) {
  const check = process.argv.includes('--check')
  if (check) {
    const drift = checkEnvDoc()
    if (drift.noMarkers) {
      console.error(`[gen-runtime-env-doc] ${DOC_PATH} is missing the generated-table markers`)
      process.exit(1)
    }
    if (drift.missing.length || drift.stale.length || drift.changed) {
      if (drift.missing.length) console.error(`[gen-runtime-env-doc] not documented: ${drift.missing.join(', ')}`)
      if (drift.stale.length) console.error(`[gen-runtime-env-doc] no longer read: ${drift.stale.join(', ')}`)
      if (drift.changed) console.error('[gen-runtime-env-doc] the table is out of date')
      console.error('[gen-runtime-env-doc] run: bun run scripts/gen-runtime-env-doc.ts')
      process.exit(1)
    }
    console.log('[gen-runtime-env-doc] up to date')
    process.exit(0)
  }

  const doc = readFileSync(DOC_PATH, 'utf-8')
  const current = extractDocTable(doc)
  if (current === null) {
    console.error(`[gen-runtime-env-doc] ${DOC_PATH} is missing the generated-table markers`)
    process.exit(1)
  }
  writeFileSync(DOC_PATH, doc.replace(current, renderEnvTable()))
  console.log(`[gen-runtime-env-doc] wrote ${DOC_PATH}`)
}
