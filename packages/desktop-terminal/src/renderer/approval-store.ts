// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Per-workspace allowlist / denylist for agent-run commands.
 *
 * Backs the Phase-0 decision "(c) headless + approval gate": the agent
 * proposes a command, the host calls `evaluate(cmd, cwd)`, and one of
 * three things happens:
 *
 *   - `'allow'`  → an existing allow rule matches; run silently.
 *   - `'deny'`   → an existing deny rule matches; block + tell agent.
 *   - `'ask'`    → no rule matches; surface a confirmation dialog.
 *
 * Storage uses the same `KeyValueStore` abstraction Phase 5's
 * ProfilesStore did, so tests use the in-memory backend and the
 * Electron main-process implementation backs by a JSON file under
 * `userData/approval/<workspaceHash>.json`.
 *
 * Rule precedence: deny WINS over allow. Within a kind, later rules
 * win over earlier (last-added preempts via simple linear scan from
 * the END of the array).
 *
 * Patterns are stored as **string** regexes (so they survive JSON
 * round-trip) and compiled on read. Bad patterns are silently dropped
 * — a corrupt user file shouldn't kill the agent.
 */

import { MemoryKeyValueStore, type KeyValueStore } from './profiles-store'

// ─── public types ─────────────────────────────────────────────────

export type ApprovalKind = 'allow' | 'deny'
export type ApprovalVerdict = 'allow' | 'deny' | 'ask'

export interface ApprovalRule {
  kind: ApprovalKind
  /** Regex source, compiled with case-sensitive flags. */
  pattern: string
  /** Optional human-readable note (e.g. "Always allow status reads"). */
  reason?: string
  /** ms epoch when the rule was created. */
  createdAt: number
}

export interface ApprovalDocument {
  /** Schema version — bump on incompatible changes. */
  version: 1
  /** Stable workspace identifier (e.g. hash of repo path). */
  workspaceHash: string
  /** Ordered list, last-added wins on ties. */
  rules: ApprovalRule[]
}

export interface EvaluatedRule {
  rule: ApprovalRule
  /** The text of the actual match (for telemetry). */
  match: string
}

export interface ApprovalDecision {
  verdict: ApprovalVerdict
  /** The rule that produced the verdict, when not 'ask'. */
  rule: ApprovalRule | null
  /** Echo of the input command. */
  command: string
}

// ─── options ──────────────────────────────────────────────────────

export interface ApprovalStoreOptions {
  /** Stable per-workspace key (typically a path hash). */
  workspaceHash: string
  storage?: KeyValueStore
  /** Override storage key prefix. */
  storageKeyPrefix?: string
  /** Seed with safe defaults on first open (default true). */
  seedSafeDefaults?: boolean
  /** Inject a clock for tests. */
  now?: () => number
}

// ─── store ────────────────────────────────────────────────────────

const KEY_PREFIX = 'shogo.terminal.approval.v1:'

export class ApprovalStore {
  private readonly storage: KeyValueStore
  private readonly key: string
  private readonly workspaceHash: string
  private readonly now: () => number
  private cache: ApprovalDocument | null = null
  /** Compiled rule cache keyed by pattern string. */
  private compiled = new Map<string, RegExp | null>()
  private listeners = new Set<(doc: ApprovalDocument) => void>()

  constructor(opts: ApprovalStoreOptions) {
    if (!opts.workspaceHash) throw new Error('ApprovalStore: workspaceHash required')
    this.workspaceHash = opts.workspaceHash
    this.storage = opts.storage ?? new MemoryKeyValueStore()
    this.key = `${opts.storageKeyPrefix ?? KEY_PREFIX}${opts.workspaceHash}`
    this.now = opts.now ?? Date.now
    if (opts.seedSafeDefaults ?? true) this.ensureSeeded()
  }

  /** Load + memoise. Returns a fresh empty doc if storage is empty. */
  load(): ApprovalDocument {
    if (this.cache) return this.cache
    const raw = this.storage.get(this.key)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as ApprovalDocument
        if (parsed && parsed.version === 1 && Array.isArray(parsed.rules)) {
          this.cache = parsed
          return parsed
        }
      } catch { /* fall through */ }
    }
    this.cache = { version: 1, workspaceHash: this.workspaceHash, rules: [] }
    return this.cache
  }

  /**
   * Evaluate a command against the rule table. Returns the verdict
   * plus the matching rule for telemetry.
   *
   * Decision order:
   *   1. Walk rules from END to START (last-added wins).
   *   2. If any DENY rule matches → deny.
   *   3. Else if any ALLOW rule matches → allow.
   *   4. Else → ask.
   *
   * We compute deny + allow matches in one pass so we don't iterate
   * the table twice for the common case.
   */
  evaluate(command: string): ApprovalDecision {
    const doc = this.load()
    let denyHit: ApprovalRule | null = null
    let allowHit: ApprovalRule | null = null
    for (let i = doc.rules.length - 1; i >= 0; i--) {
      const r = doc.rules[i]!
      const re = this.compileSafe(r.pattern)
      if (!re || !re.test(command)) continue
      if (r.kind === 'deny' && denyHit === null) denyHit = r
      else if (r.kind === 'allow' && allowHit === null) allowHit = r
      if (denyHit && allowHit) break // already have both; we're done
    }
    if (denyHit) return { verdict: 'deny', rule: denyHit, command }
    if (allowHit) return { verdict: 'allow', rule: allowHit, command }
    return { verdict: 'ask', rule: null, command }
  }

  /**
   * Append a rule. Returns the persisted rule (with createdAt
   * stamped). Idempotent on (kind, pattern) — re-adding the same
   * pattern updates the createdAt + reason but doesn't duplicate.
   */
  addRule(kind: ApprovalKind, pattern: string, reason?: string): ApprovalRule {
    if (pattern.length === 0) throw new Error('ApprovalStore: pattern required')
    if (!this.compileSafe(pattern)) throw new Error(`ApprovalStore: invalid regex /${pattern}/`)
    const doc = this.load()
    const existing = doc.rules.findIndex((r) => r.kind === kind && r.pattern === pattern)
    const rule: ApprovalRule = { kind, pattern, reason, createdAt: this.now() }
    const next = [...doc.rules]
    if (existing >= 0) next.splice(existing, 1, rule)
    else next.push(rule)
    this.commit({ version: 1, workspaceHash: doc.workspaceHash, rules: next })
    return rule
  }

  /** Remove the rule with the matching (kind, pattern). Returns true on hit. */
  removeRule(kind: ApprovalKind, pattern: string): boolean {
    const doc = this.load()
    const next = doc.rules.filter((r) => !(r.kind === kind && r.pattern === pattern))
    if (next.length === doc.rules.length) return false
    this.commit({ version: 1, workspaceHash: doc.workspaceHash, rules: next })
    return true
  }

  /** Return all rules of a kind (defensive copy). */
  list(kind?: ApprovalKind): ApprovalRule[] {
    const doc = this.load()
    return kind ? doc.rules.filter((r) => r.kind === kind) : [...doc.rules]
  }

  /** Subscribe to changes; returns an unsubscribe fn. */
  on(listener: (doc: ApprovalDocument) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Clear all rules (test helper / "Reset"). */
  reset(): void {
    this.cache = null
    this.compiled.clear()
    this.storage.delete(this.key)
  }

  // ─── internals ──────────────────────────────────────────────

  private ensureSeeded(): void {
    const doc = this.load()
    if (doc.rules.length > 0) return
    const seeded: ApprovalRule[] = SAFE_DEFAULTS.map((p) => ({
      kind: 'allow',
      pattern: p,
      reason: 'safe default',
      createdAt: this.now(),
    }))
    this.commit({ version: 1, workspaceHash: this.workspaceHash, rules: seeded })
  }

  private commit(doc: ApprovalDocument): void {
    this.cache = doc
    this.compiled.clear()
    this.storage.set(this.key, JSON.stringify(doc))
    for (const l of this.listeners) { try { l(doc) } catch { /* */ } }
  }

  private compileSafe(pattern: string): RegExp | null {
    if (this.compiled.has(pattern)) return this.compiled.get(pattern) ?? null
    try {
      const re = new RegExp(pattern)
      this.compiled.set(pattern, re)
      return re
    } catch {
      this.compiled.set(pattern, null)
      return null
    }
  }
}

// ─── safe defaults ────────────────────────────────────────────────

/**
 * Anchored patterns matching only read-only commands the agent can
 * run without bothering the user. Tuned to be conservative — `git
 * log` is in; `git push` is not. Each entry is a regex source.
 */
export const SAFE_DEFAULTS: readonly string[] = [
  '^ls(\\s|$)',
  '^pwd\\s*$',
  '^echo(\\s|$)',
  '^which(\\s|$)',
  '^cat\\s+[^|;><]+$',                          // cat without pipes/redirects
  '^head(\\s|$)',
  '^tail(\\s|$)',
  '^cd(\\s|$)',
  '^git\\s+(status|log|diff|show|branch|remote)(\\s|$)',
  '^npm\\s+(list|run\\s+--help|--version)(\\s|$)',
  '^node\\s+--version(\\s|$)',
  '^bun\\s+--version(\\s|$)',
] as const

/**
 * Conservative deny set hosts can opt into via `addRule`. Not seeded
 * by default — these are real footguns the user may legitimately
 * want to run themselves.
 */
export const DESTRUCTIVE_DENIES: readonly string[] = [
  '^rm\\s+-rf?\\s+/',                            // rm -rf /
  '^rm\\s+-rf?\\s+~',                            // rm -rf ~
  '^:\\(\\)\\{\\s*:\\|:&',                       // fork bomb prefix
  '\\bmkfs\\.',
  '\\bdd\\s+if=.*of=/dev/',
  '^sudo\\s+rm\\b',
] as const

// ─── helpers ──────────────────────────────────────────────────────

/**
 * Hash a workspace path into a filesystem-safe id. Stable across runs
 * for the same input. Hosts that already have a hash (e.g. git repo
 * root sha) should use that instead — this is just a fallback.
 */
export function workspaceHashOf(path: string): string {
  // 32-bit FNV-1a hash → hex. Good enough as a per-workspace id; not
  // a cryptographic hash. Stable on identical input across platforms.
  let h = 0x811c9dc5
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `ws-${h.toString(16).padStart(8, '0')}`
}
