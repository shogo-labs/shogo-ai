// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Diagnostics API Routes
 *
 * Powers the IDE's Problems tab. Aggregates diagnostics from three sources:
 *   - TypeScript (`tsc --noEmit`) — type errors
 *   - ESLint (`eslint --format json`) — lint errors and warnings
 *   - Vite build errors — captured at runtime via a build-error bridge
 *     and read here from a per-project ring buffer
 *
 * Endpoints (relative to the router; mounted under `/api/projects/:projectId/`
 * by the API and under `/diagnostics` by the agent-runtime pod):
 *
 *   GET  /projects/:projectId/diagnostics
 *        Query: ?source=ts|eslint|build|all (default `all`)
 *               ?since=<iso-timestamp>   (optional, return delta only)
 *        Returns: { diagnostics, lastRunAt, sources, fromCache }
 *
 *   POST /projects/:projectId/diagnostics/refresh
 *        Body: { sources?: ("ts"|"eslint"|"build")[] }
 *        Force a re-run (bypass cache). Returns the fresh result inline.
 *
 * Architecture notes:
 *   - This factory is reused by the agent-runtime pod via
 *     `runtime-diagnostics-routes.ts`. The API also mounts it directly
 *     in local-dev mode. Same source of truth, no drift.
 *   - Cache is keyed by projectId with a 30s TTL plus an mtime invalidation
 *     hash over `src/**` (cheap to compute, kills the cache as soon as any
 *     source file changes).
 *   - Concurrent-run guard: if a tsc/eslint pass is in flight for the same
 *     project, additional callers await the same promise instead of
 *     spawning a duplicate process.
 *   - All spawned processes are bounded by a hard timeout so a wedged
 *     compiler can't pin pod memory forever.
 */

import { Hono } from "hono"
import { spawn } from "child_process"
import { existsSync, readdirSync, statSync } from "fs"
import { join, relative, isAbsolute } from "path"
import { getBuildErrors } from "./diagnostics-build-buffer"
import { pkg } from "./platform-pkg"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DiagnosticSource = "ts" | "eslint" | "build"
export type DiagnosticSeverity = "error" | "warning" | "info" | "hint"

export interface Diagnostic {
  /** Stable id derived from (file, line, column, code, message) — used for de-dupe and React keys. */
  id: string
  source: DiagnosticSource
  severity: DiagnosticSeverity
  /** Workspace-relative POSIX path. */
  file: string
  /** 1-based line number. */
  line: number
  /** 1-based column number. */
  column: number
  endLine?: number
  endColumn?: number
  /** Compiler / rule code, e.g. `TS2304` or `no-unused-vars`. */
  code?: string
  message: string
  /** Optional URL to rule documentation (eslint). */
  ruleUri?: string
}

export interface DiagnosticsResult {
  diagnostics: Diagnostic[]
  /** ISO timestamp of when the diagnostics were computed. */
  lastRunAt: string
  /** Which sources contributed to this result. */
  sources: DiagnosticSource[]
  /** True iff this response was served from cache. */
  fromCache: boolean
  /** Per-source error notes (e.g. "tsc not installed"). UI surfaces these as banners. */
  notes?: { source: DiagnosticSource; message: string }[]
}

export interface DiagnosticsRoutesConfig {
  /** Workspaces root directory. The router resolves `${workspacesDir}/${projectId}`. */
  workspacesDir: string
  /** Cache TTL in milliseconds (default 30s). */
  cacheTtlMs?: number
  /** Max time a single tsc / eslint invocation is allowed to run (default 60s). */
  toolTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// Cache + concurrent-run guard
// ---------------------------------------------------------------------------

interface CacheEntry {
  result: DiagnosticsResult
  /** mtime hash at the moment we computed this result; lets us invalidate when files change. */
  mtimeHash: string
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<DiagnosticsResult>>()
// Separate map for force=true callers — see `getOrCompute` for the rationale.
const inflightForce = new Map<string, Promise<DiagnosticsResult>>()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stable hash of mtimes for source files we care about. Cheap O(N) walk
 * over the workspace root excluding node_modules / build artefacts.
 *
 * If the hash is unchanged since the last run we can serve from cache even
 * if the TTL hasn't expired — and conversely, an edit invalidates the
 * cache instantly without waiting for the TTL. Best of both worlds.
 *
 * Notes on coverage:
 *   - Depth cap raised from 6 → 12 so deep monorepo workspaces still
 *     invalidate. Cap is still defensive against runaway symlink loops.
 *   - File extensions cover the JS/TS variants TS/ESLint actually parse,
 *     plus `.vue` / `.svelte` so framework users see invalidation too.
 *   - Top-level config files (eslint, prettier, tsconfig) are folded in so a
 *     rule edit also kicks the cache.
 *   - Folded into a 32-bit FNV-1a-ish hash — it's the file count + mtime
 *     fingerprint, not a security primitive. Collision = at-most-one extra
 *     re-run.
 */
function computeMtimeHash(projectDir: string): string {
  const SKIP = new Set([
    "node_modules", ".git", "dist", "build", ".next", ".vite",
    "out", ".turbo", ".cache", "coverage", ".shogo",
  ])
  // We hash extension-mtime pairs into a rolling number to avoid the O(N²)
  // string-concat that the previous implementation paid for on every poll.
  let h = 2166136261 >>> 0 // FNV offset basis
  let count = 0
  function mix(s: string): void {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619) >>> 0
    }
  }
  function walk(dir: string, depth: number) {
    if (depth > 12) return
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      if (SKIP.has(name)) continue
      const p = join(dir, name)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) {
        walk(p, depth + 1)
      } else if (st.isFile()) {
        // Source files we care about *and* any top-level rule/config file
        // whose change should bust the cache.
        const isSource = /\.(ts|tsx|js|jsx|cjs|mjs|cts|mts|json|vue|svelte)$/.test(name)
        const isConfig = depth === 0 && (
          name === "tsconfig.json"
          || name === "package.json"
          || /^eslint\.config\.(js|mjs|cjs|ts)$/.test(name)
          || /^\.eslintrc(\.|$)/.test(name)
          || name === ".prettierrc" || /^\.prettierrc\./.test(name)
        )
        if (!isSource && !isConfig) continue
        mix(p)
        mix(":")
        mix(String(st.mtimeMs))
        mix("|")
        count++
      }
    }
  }
  walk(projectDir, 0)
  return `${h.toString(36)}:${count}`
}

function diagnosticId(d: Omit<Diagnostic, "id">): string {
  // Cross-source dedup relies on this id being source-INDEPENDENT — when both
  // tsc and eslint flag the same unused-import on the same line we keep one
  // (preferring whichever was emitted first; tsc precedes eslint in the
  // aggregator). The `source` field still comes through on the Diagnostic
  // for the UI badge.
  return `${d.file}:${d.line}:${d.column}:${d.code ?? ""}:${d.message.slice(0, 80)}`
}

function makeDiagnostic(d: Omit<Diagnostic, "id">): Diagnostic {
  return { ...d, id: diagnosticId(d) }
}

/**
 * Spawn a child process and capture stdout/stderr. Hard-bounded by `timeoutMs`;
 * a timeout returns whatever was captured so far plus a `timedOut: true` flag.
 *
 * We deliberately DON'T reject on non-zero exit — tsc and eslint both exit
 * with code 1 when they find errors, which is the *expected* path. Callers
 * inspect the parsed output instead.
 */
function runTool(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false

    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString() })

    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill("SIGTERM") } catch {}
      setTimeout(() => { try { child.kill("SIGKILL") } catch {} }, 2000)
    }, timeoutMs)

    function done(code: number | null) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, code, timedOut })
    }

    child.on("close", (code) => done(code))
    child.on("error", () => done(null))
  })
}

// ---------------------------------------------------------------------------
// TypeScript runner
// ---------------------------------------------------------------------------

/**
 * Parse a single `tsc --pretty false` output line. Format:
 *   <file>(<line>,<col>): error TS<code>: <message>
 * Severity is whatever word follows the location — `error` | `message` | `info`.
 */
const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s+(\w+)\s+(TS\d+):\s+(.*)$/

export function parseTscOutput(stdout: string, projectDir: string): Diagnostic[] {
  const out: Diagnostic[] = []
  const lines = stdout.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line) continue
    const m = TSC_LINE.exec(line)
    if (!m) continue
    const [, file, ln, col, sevWord, code, message] = m
    const absOrRel = file
    let rel = absOrRel
    if (isAbsolute(absOrRel)) {
      rel = relative(projectDir, absOrRel)
    }
    rel = rel.replaceAll("\\", "/")
    const severity: DiagnosticSeverity =
      sevWord === "error" ? "error"
      : sevWord === "warning" ? "warning"
      : sevWord === "message" ? "info"
      : "hint"
    out.push(makeDiagnostic({
      source: "ts",
      severity,
      file: rel,
      line: Number(ln),
      column: Number(col),
      code,
      message,
    }))
  }
  return out
}

async function runTsc(projectDir: string, timeoutMs: number): Promise<{ diags: Diagnostic[]; note?: string }> {
  if (!existsSync(join(projectDir, "tsconfig.json"))) {
    return { diags: [], note: "tsc skipped — no tsconfig.json" }
  }
  const { stdout, stderr, timedOut } = await runTool(
    pkg.bunBinary,
    ["x", "--bun", "tsc", "--noEmit", "--pretty", "false"],
    projectDir,
    timeoutMs,
  )
  if (timedOut) {
    return { diags: parseTscOutput(stdout, projectDir), note: "tsc timed out — partial results" }
  }
  // Some setups print to stderr (e.g. "Cannot find name 'tsc'"). Detect and surface as a note.
  if (stderr && /command not found|cannot find module|not installed/i.test(stderr) && !stdout) {
    return { diags: [], note: `tsc unavailable: ${stderr.trim().slice(0, 200)}` }
  }
  return { diags: parseTscOutput(stdout, projectDir) }
}

// ---------------------------------------------------------------------------
// ESLint runner
// ---------------------------------------------------------------------------

interface EslintMessage {
  ruleId: string | null
  severity: 1 | 2
  message: string
  line: number
  column: number
  endLine?: number
  endColumn?: number
  messageId?: string
}

interface EslintFileResult {
  filePath: string
  messages: EslintMessage[]
}

export function parseEslintOutput(stdout: string, projectDir: string): Diagnostic[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  let parsed: EslintFileResult[]
  try {
    parsed = JSON.parse(trimmed) as EslintFileResult[]
  } catch {
    // ESLint can prefix the JSON with a deprecation warning on stderr — that's
    // fine because we only read stdout — but very old configs sometimes write
    // a warning into stdout too. Try to recover the JSON array.
    const start = trimmed.indexOf("[")
    const end = trimmed.lastIndexOf("]")
    if (start === -1 || end === -1) return []
    try { parsed = JSON.parse(trimmed.slice(start, end + 1)) as EslintFileResult[] }
    catch { return [] }
  }
  const out: Diagnostic[] = []
  for (const file of parsed) {
    const rel = (isAbsolute(file.filePath) ? relative(projectDir, file.filePath) : file.filePath).replaceAll("\\", "/")
    for (const msg of file.messages) {
      const code = msg.ruleId ?? msg.messageId ?? undefined
      out.push(makeDiagnostic({
        source: "eslint",
        severity: msg.severity === 2 ? "error" : "warning",
        file: rel,
        line: msg.line ?? 1,
        column: msg.column ?? 1,
        endLine: msg.endLine,
        endColumn: msg.endColumn,
        code,
        message: msg.message,
        ruleUri: code && /^[a-z@][\w-/]*$/i.test(code) && !code.startsWith("@")
          ? `https://eslint.org/docs/latest/rules/${code}`
          : undefined,
      }))
    }
  }
  return out
}

function hasEslintConfig(projectDir: string): boolean {
  return [
    "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts",
    ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml",
  ].some(f => existsSync(join(projectDir, f)))
}

async function runEslint(projectDir: string, timeoutMs: number): Promise<{ diags: Diagnostic[]; note?: string }> {
  if (!hasEslintConfig(projectDir)) {
    return { diags: [], note: "eslint skipped — no config" }
  }
  const { stdout, stderr, timedOut } = await runTool(
    pkg.bunBinary,
    ["x", "--bun", "eslint", ".", "--format", "json", "--no-error-on-unmatched-pattern"],
    projectDir,
    timeoutMs,
  )
  if (timedOut) {
    return { diags: parseEslintOutput(stdout, projectDir), note: "eslint timed out — partial results" }
  }
  if (!stdout && stderr && /command not found|cannot find module|not installed/i.test(stderr)) {
    return { diags: [], note: `eslint unavailable: ${stderr.trim().slice(0, 200)}` }
  }
  return { diags: parseEslintOutput(stdout, projectDir) }
}

// ---------------------------------------------------------------------------
// Build (Vite) errors
// ---------------------------------------------------------------------------

async function readBuildErrors(projectId: string, projectDir: string): Promise<{ diags: Diagnostic[]; note?: string }> {
  try {
    const errors = getBuildErrors(projectId)
    if (!errors.length) return { diags: [] }
    return {
      diags: errors.map((e): Diagnostic => makeDiagnostic({
        source: "build",
        severity: "error",
        file: e.file
          ? (isAbsolute(e.file) ? relative(projectDir, e.file) : e.file).replaceAll("\\", "/")
          : "(build)",
        line: e.line ?? 1,
        column: e.column ?? 1,
        code: e.code,
        message: e.message,
      })),
    }
  } catch (err: any) {
    return { diags: [], note: `build errors unavailable: ${err?.message ?? "unknown"}` }
  }
}

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

async function computeDiagnostics(
  projectId: string,
  projectDir: string,
  sources: DiagnosticSource[],
  toolTimeoutMs: number,
): Promise<DiagnosticsResult> {
  const wantTs = sources.includes("ts")
  const wantEs = sources.includes("eslint")
  const wantBd = sources.includes("build")

  type ToolResult = { diags: Diagnostic[]; note?: string }
  const empty: ToolResult = { diags: [] }
  const [tsRes, esRes, bdRes] = await Promise.all<ToolResult>([
    wantTs ? runTsc(projectDir, toolTimeoutMs) : Promise.resolve(empty),
    wantEs ? runEslint(projectDir, toolTimeoutMs) : Promise.resolve(empty),
    wantBd ? readBuildErrors(projectId, projectDir) : Promise.resolve(empty),
  ])

  const notes: { source: DiagnosticSource; message: string }[] = []
  if (tsRes.note) notes.push({ source: "ts", message: tsRes.note })
  if (esRes.note) notes.push({ source: "eslint", message: esRes.note })
  if (bdRes.note) notes.push({ source: "build", message: bdRes.note })

  // De-dupe across sources by id (eslint + tsc occasionally surface the same
  // unused-import on the same line).
  const seen = new Set<string>()
  const all: Diagnostic[] = []
  for (const d of [...tsRes.diags, ...esRes.diags, ...bdRes.diags]) {
    if (seen.has(d.id)) continue
    seen.add(d.id)
    all.push(d)
  }

  return {
    diagnostics: all,
    lastRunAt: new Date().toISOString(),
    sources,
    fromCache: false,
    notes: notes.length ? notes : undefined,
  }
}

async function getOrCompute(
  projectId: string,
  projectDir: string,
  sources: DiagnosticSource[],
  cfg: { cacheTtlMs: number; toolTimeoutMs: number },
  force: boolean,
): Promise<DiagnosticsResult> {
  const sourcesKey = [...sources].sort().join(",")
  const key = `${projectId}::${sourcesKey}`
  const now = Date.now()
  const mtimeHash = computeMtimeHash(projectDir)

  if (!force) {
    const hit = cache.get(key)
    if (hit && hit.expiresAt > now && hit.mtimeHash === mtimeHash) {
      return { ...hit.result, fromCache: true }
    }
    // Coalesce concurrent non-force callers onto a single inflight promise.
    const existing = inflight.get(key)
    if (existing) return existing
  }
  // `force=true` MUST NOT return an inflight promise that started before the
  // user clicked Refresh — the user's mental model is "give me fresh results
  // including everything I just edited". Latch onto a separate "force inflight"
  // map so a force call always spawns its own pass while still coalescing
  // multiple force calls that arrive together.
  if (force) {
    const existingForce = inflightForce.get(key)
    if (existingForce) return existingForce
  }

  const p = (async () => {
    try {
      const result = await computeDiagnostics(projectId, projectDir, sources, cfg.toolTimeoutMs)
      cache.set(key, {
        result,
        mtimeHash,
        expiresAt: Date.now() + cfg.cacheTtlMs,
      })
      return result
    } finally {
      if (force) inflightForce.delete(key)
      else inflight.delete(key)
    }
  })()
  if (force) inflightForce.set(key, p)
  else inflight.set(key, p)
  return p
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

function parseSourcesQuery(raw: string | undefined): DiagnosticSource[] {
  if (!raw || raw === "all") return ["ts", "eslint", "build"]
  const parts = raw.split(",").map(s => s.trim()).filter(Boolean)
  const valid: DiagnosticSource[] = []
  for (const p of parts) {
    if (p === "ts" || p === "eslint" || p === "build") valid.push(p)
  }
  return valid.length ? valid : ["ts", "eslint", "build"]
}

export function diagnosticsRoutes(config: DiagnosticsRoutesConfig) {
  const { workspacesDir } = config
  const cacheTtlMs = config.cacheTtlMs ?? 30_000
  const toolTimeoutMs = config.toolTimeoutMs ?? 60_000
  const router = new Hono()

  router.get("/projects/:projectId/diagnostics", async (c) => {
    const projectId = c.req.param("projectId")
    const projectDir = join(workspacesDir, projectId)
    if (!existsSync(projectDir)) {
      return c.json(
        { error: { code: "project_not_found", message: "Project not found" } },
        404,
      )
    }
    const sources = parseSourcesQuery(c.req.query("source"))
    const since = c.req.query("since")

    try {
      const result = await getOrCompute(projectId, projectDir, sources, { cacheTtlMs, toolTimeoutMs }, false)
      // `since` does an opportunistic shortcut: if the last run is older than
      // `since`, the client already has at least as fresh a snapshot —
      // return `unchanged: true` and skip the payload. The client polls
      // with `since=lastRunAt` so most polls are tiny.
      if (since && new Date(result.lastRunAt).getTime() <= new Date(since).getTime()) {
        return c.json({ unchanged: true, lastRunAt: result.lastRunAt }, 200)
      }
      return c.json(result, 200)
    } catch (err: any) {
      console.error("[diagnostics] compute failed:", err)
      return c.json(
        { error: { code: "diagnostics_failed", message: err?.message ?? "Failed to compute diagnostics" } },
        500,
      )
    }
  })

  router.post("/projects/:projectId/diagnostics/refresh", async (c) => {
    const projectId = c.req.param("projectId")
    const projectDir = join(workspacesDir, projectId)
    if (!existsSync(projectDir)) {
      return c.json(
        { error: { code: "project_not_found", message: "Project not found" } },
        404,
      )
    }
    let body: { sources?: DiagnosticSource[] } = {}
    try { body = (await c.req.json()) ?? {} } catch { /* empty body is fine */ }
    const sources = body.sources && body.sources.length
      ? body.sources.filter((s): s is DiagnosticSource => s === "ts" || s === "eslint" || s === "build")
      : ["ts", "eslint", "build"] as DiagnosticSource[]

    try {
      const result = await getOrCompute(projectId, projectDir, sources, { cacheTtlMs, toolTimeoutMs }, true)
      return c.json(result, 200)
    } catch (err: any) {
      console.error("[diagnostics] refresh failed:", err)
      return c.json(
        { error: { code: "diagnostics_failed", message: err?.message ?? "Failed to refresh diagnostics" } },
        500,
      )
    }
  })

  return router
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

/** Clears the in-process cache. Exposed for tests. */
export function _clearDiagnosticsCacheForTests(): void {
  cache.clear()
  inflight.clear()
  inflightForce.clear()
}

export default diagnosticsRoutes
