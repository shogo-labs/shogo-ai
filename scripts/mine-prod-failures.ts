#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Production failure-mining harness (read-only).
 *
 * Mines `tool_call_logs` + `chat_messages` + `chat_sessions` to surface the
 * REAL tool-call failure picture that `tool_call_logs.status` hides: most
 * failures are persisted as `status='complete'` with an error payload in
 * `result`, so the raw status column under-reports by ~50x.
 *
 * Why one region (not all three): the platform DB is a single logical-
 * replicated CNPG cluster (US/EU/India all converge to identical rows — see
 * scripts/check-multiregion-cron-locks.ts). Summing across regions would
 * triple-count. We query ONE region and fail over only if it's unreachable.
 *
 * All access is read-only (SELECT via `kubectl exec … psql`). No mutation.
 *
 * Usage:
 *   bun run scripts/mine-prod-failures.ts                # india, last 7d, summary
 *   bun run scripts/mine-prod-failures.ts --region us --since 2026-06-01
 *   bun run scripts/mine-prod-failures.ts --provider     # per-provider breakdown
 *   bun run scripts/mine-prod-failures.ts --export       # write redacted fixtures
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// --- Region -> kube context (mirrors AGENTS.md; re-derive if clusters drift) -
const REGIONS: Record<string, { context: string; endpoint: string }> = {
  us: { context: 'context-cp7l2tcj76q', endpoint: '141.148.74.224' },
  india: { context: 'context-c4w44igvdfa', endpoint: '80.225.223.127' },
  eu: { context: 'context-cbbetkypxva', endpoint: '132.226.198.27' },
}
const FAILOVER_ORDER = ['india', 'us', 'eu']
const SYSTEM_NS = 'shogo-production-system'

// --- Token-shaped secret redaction (kept in sync with apps/api crypto-util) -
const SECRET_PATTERNS: RegExp[] = [
  /\bgh[opsu]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bya29\.[A-Za-z0-9._-]{20,}\b/g,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/gi,
]
function redact(text: string): string {
  let out = text
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted-secret]')
  return out
}

// --- Failure signature classification (mirrors the eval failure clusters) ---
const FAILURE_CLUSTERS: { kind: string; test: RegExp }[] = [
  { kind: 'unbound_tool', test: /not found|unable to retrieve tool|does not exist/i },
  { kind: 'auth', test: /unauthor|401|invalid_grant|token expired|oauth|not properly authorized|authentication failed/i },
  { kind: 'permission', test: /forbidden|403|access denied|insufficient (scope|permission)/i },
  { kind: 'validation', test: /validation failed|invalid request data|must have required|value error|invalid .*format/i },
  { kind: 'truncation', test: /truncat/i },
  { kind: 'timeout', test: /timeout|timed out|etimedout/i },
  { kind: 'ratelimit', test: /rate limit|429|too many requests/i },
  { kind: 'notfound_resource', test: /404|"not found"/i },
  { kind: 'generic_error', test: /error|exception|fail/i },
]
function classify(resultText: string): string {
  for (const c of FAILURE_CLUSTERS) if (c.test.test(resultText)) return c.kind
  return 'ok'
}

// Decide if a tool call genuinely FAILED. Classification happens in TS (not
// SQL) because `tool_call_logs.result` is double-JSON-encoded (`\"error\":\"`),
// which makes SQL regex matching of the error envelope fragile. We unescape
// first, then test the envelope so we don't count benign rows that merely
// contain the word "error" (e.g. `"error":null`, the `error?: string` usage
// hint in connect's message, or a successful read_lints run that *found* and
// reported type errors).
function unescape(text: string): string {
  return text.replace(/\\(["\\/])/g, '$1')
}
function isFailure(status: string, resultText: string): boolean {
  if (status === 'error') return true
  const t = unescape(resultText)
  if (/"ok"\s*:\s*false/i.test(t)) return true
  if (/"successful"\s*:\s*false/i.test(t)) return true
  if (/"error"\s*:\s*"[^"]/i.test(t)) return true // non-empty top-level error string
  if (/(unauthorized|forbidden|invalid_grant|token expired|not properly authorized|rate limit|too many requests|validation failed|unable to retrieve tool|not found)/i.test(t)) return true
  return false
}

// --- CLI args -----------------------------------------------------------------
function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return def
  const next = process.argv[i + 1]
  return next && !next.startsWith('--') ? next : 'true'
}

const sinceArg = arg('since', isoDaysAgo(7))!
const wantProvider = arg('provider') === 'true'
const wantExport = arg('export') === 'true'
const explicitRegion = arg('region')

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86400_000)
  return d.toISOString().slice(0, 10)
}

// --- psql exec (read-only) ----------------------------------------------------
function pgPod(context: string): string | null {
  const r = spawnSync('kubectl', ['--context', context, '-n', SYSTEM_NS, 'get', 'pods', '-o', 'name'], { encoding: 'utf-8' })
  if (r.status !== 0) return null
  const line = r.stdout.split('\n').find((l) => /platform-pg-\d+/.test(l))
  return line ? line.replace('pod/', '').trim() : null
}

/** Run a SELECT and return rows as arrays of column strings (TSV, tuples-only). */
function query(context: string, pod: string, sql: string): string[][] | null {
  const r = spawnSync(
    'kubectl',
    ['--context', context, '-n', SYSTEM_NS, 'exec', pod, '-c', 'postgres', '--',
      'psql', '-U', 'postgres', '-d', 'shogo', '-At', '-F', '\t', '-P', 'pager=off', '-c', sql],
    { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (r.status !== 0) {
    console.error(`[mine] psql error: ${(r.stderr || '').slice(0, 300)}`)
    return null
  }
  return r.stdout.split('\n').filter(Boolean).map((l) => l.split('\t'))
}

function resolveRegion(): { region: string; context: string; pod: string } {
  const order = explicitRegion ? [explicitRegion, ...FAILOVER_ORDER.filter((r) => r !== explicitRegion)] : FAILOVER_ORDER
  for (const region of order) {
    const meta = REGIONS[region]
    if (!meta) continue
    const pod = pgPod(meta.context)
    if (pod) {
      if (region !== order[0]) console.error(`[mine] primary region unreachable; failed over to ${region}`)
      return { region, context: meta.context, pod }
    }
  }
  console.error('[mine] no reachable region Postgres pod (need kubectl access)')
  process.exit(1)
}

// --- Main ---------------------------------------------------------------------
const { region, context, pod } = resolveRegion()
console.log(`\n=== Production failure mine — region=${region} since=${sinceArg} (data is global/replicated) ===\n`)

// Single read-only pull; all classification happens in TS. result is cleaned
// of whitespace (so it stays one TSV cell) and capped to keep the payload sane.
const rows = query(context, pod, `
  SELECT "toolName", status, coalesce(left(regexp_replace(result::text,'\\s+',' ','g'), 600), '')
  FROM tool_call_logs
  WHERE "createdAt" >= '${sinceArg}';`)

if (!rows) { console.error('[mine] query failed'); process.exit(1) }

const PROVIDERS = ['github', 'jira', 'youtube', 'shopify', 'stripe', 'slack', 'instagram', 'tiktok', 'gmail', 'notion']
const perTool = new Map<string, { total: number; fails: number }>()
const clusterCounts = new Map<string, number>()
const clusterByProvider = new Map<string, Map<string, number>>()
const fixtures: { tool: string; cluster: string; provider: string; sample: string }[] = []

for (const [tool, status, result] of rows) {
  const t = perTool.get(tool) ?? { total: 0, fails: 0 }
  t.total++
  if (isFailure(status, result || '')) {
    t.fails++
    // classify() can fall through to 'ok' on a row isFailure() flagged via an
    // envelope signal (e.g. "successful":false) with no cluster keyword — bucket
    // those as generic_error so failure totals reconcile.
    const k = classify(unescape(result || ''))
    const kind = k === 'ok' ? 'generic_error' : k
    clusterCounts.set(kind, (clusterCounts.get(kind) ?? 0) + 1)
    const provider = PROVIDERS.find((p) => tool.toLowerCase().includes(p) || (result || '').toLowerCase().includes(p)) ?? 'core'
    if (!clusterByProvider.has(provider)) clusterByProvider.set(provider, new Map())
    const m = clusterByProvider.get(provider)!
    m.set(kind, (m.get(kind) ?? 0) + 1)
    if (wantExport && fixtures.filter((f) => f.cluster === kind).length < 8) {
      fixtures.push({ tool, cluster: kind, provider, sample: redact(result || '') })
    }
  }
  perTool.set(tool, t)
}

console.log('Tool                                              total   fails  true_success%')
console.log('-'.repeat(80))
for (const [name, { total, fails }] of [...perTool.entries()].filter(([, v]) => v.total >= 5).sort((a, b) => b[1].fails - a[1].fails).slice(0, 40)) {
  const pct = total > 0 ? (100 * (total - fails) / total).toFixed(1) : '—'
  console.log(`${name.slice(0, 48).padEnd(48)}${String(total).padStart(6)}  ${String(fails).padStart(6)}  ${pct.padStart(8)}`)
}

console.log('\nFailure clusters (ranked by volume):')
console.log('-'.repeat(40))
for (const [kind, n] of [...clusterCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${kind.padEnd(22)}${String(n).padStart(8)}`)
}

// 3) Optional per-provider breakdown (Shopify/YouTube focus).
if (wantProvider && clusterByProvider.size > 0) {
  console.log('\nPer-provider failure breakdown:')
  console.log('-'.repeat(50))
  for (const [provider, m] of [...clusterByProvider.entries()].sort(
    (a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0),
  )) {
    const parts = [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ')
    console.log(`${provider.padEnd(12)} ${parts}`)
  }
}

// 4) Optional fixture export (redacted) for regression evals.
if (wantExport) {
  const dir = join(import.meta.dir, '..', 'packages', 'agent-runtime', 'src', 'evals', 'fixtures', 'prod-failures')
  mkdirSync(dir, { recursive: true })
  const out = join(dir, `failures-${region}-${sinceArg}.json`)
  writeFileSync(out, JSON.stringify({ region, since: sinceArg, generatedAt: new Date().toISOString(), fixtures }, null, 2))
  console.log(`\nWrote ${fixtures.length} redacted fixtures -> ${out}`)
}

console.log('\nDone (read-only).\n')
