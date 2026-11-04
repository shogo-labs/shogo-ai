// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Export real compaction fixtures from local session stores (SHO-327).
 *
 *   bun scripts/export-compaction-fixtures.ts
 *   bun scripts/export-compaction-fixtures.ts --min-tokens 120000 --limit 40
 *
 * Every `.workspace-roots/<id>/.shogo/sessions.db` on this machine is opened
 * **read-only**. For a session that crossed the compaction cap
 * it records three things:
 *   1. the messages as they stood when a compaction fired (or would fire),
 *   2. the real next user message,
 *   3. the real next tool calls, as ground truth for `nextActionMatch`.
 *
 * Probes are derived from the transcript without a model call — files touched,
 * tools used, the last error line and the person's last instruction — so an
 * export costs nothing and its ground truth cannot drift from the transcript.
 *
 * Output goes to `packages/agent-runtime/src/evals/fixtures/compaction/*.json`,
 * which is **gitignored and never committed**: it is real workspace content.
 * Secrets are redacted with the same pattern list `mine-prod-failures.ts` uses.
 */
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from '@mariozechner/pi-ai'
import { collectCompactionFacts } from '../packages/agent-runtime/src/compaction-facts'
import type { CompactionFixture, CompactionProbe } from '../packages/agent-runtime/src/evals/compaction/types'
import { redactSecretText } from './lib/redact-secrets'

const REPO_ROOT = resolve(import.meta.dir, '..')
const OUT_DIR = join(REPO_ROOT, 'packages', 'agent-runtime', 'src', 'evals', 'fixtures', 'compaction')
const ROOTS_DIR = join(homedir(), 'Library', 'Application Support', 'Shogo', 'data', 'workspaces.noindex', '.workspace-roots')

/** The autocompact cap (`AGENT_AUTOCOMPACT_TOKENS`), in tokens. */
const CAP_TOKENS = Number(process.env.AGENT_AUTOCOMPACT_TOKENS ?? 235_000)
/** Chars-per-token ruler the session manager uses. */
const CHARS_PER_TOKEN = 4

function argNum(name: string, fallback: number): number {
  const idx = process.argv.indexOf(`--${name}`)
  const value = idx >= 0 ? Number(process.argv[idx + 1]) : NaN
  return Number.isFinite(value) ? value : fallback
}

interface SessionRow {
  id: string
  data: string
}

function textOf(msg: Message): string {
  const content = (msg as { content: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b: any) => (b?.type === 'text' ? b.text : b?.type === 'thinking' ? b.thinking : ''))
    .filter(Boolean)
    .join('\n')
}

function tokensOf(messages: readonly Message[]): number {
  return Math.ceil(JSON.stringify(messages).length / CHARS_PER_TOKEN)
}

function callKey(call: ToolCall): string {
  return JSON.stringify(call.arguments ?? {})
}

function firstPath(args: Record<string, any> | undefined): string | undefined {
  for (const key of ['path', 'file_path', 'target_file', 'filePath']) {
    const value = args?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/** Redact every string in a message tree, keeping its shape. */
function redactMessages(messages: Message[]): Message[] {
  const walk = (value: any): any => {
    if (typeof value === 'string') return redactSecretText(value)
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      const out: Record<string, any> = {}
      for (const [k, v] of Object.entries(value)) out[k] = walk(v)
      return out
    }
    return value
  }
  return walk(messages) as Message[]
}

/** Probes derived from the transcript itself — no model call, no cost. */
function deriveProbes(history: Message[], constraint: string | null): CompactionProbe[] {
  const facts = collectCompactionFacts(history)
  const probes: CompactionProbe[] = []

  const files = facts.files.map((f) => f.path).slice(0, 3)
  if (files.length > 0) {
    probes.push({
      id: 'files',
      kind: 'file-location',
      question: 'Which files did you read or edit? List their paths exactly.',
      expected: files,
      grader: 'string',
    })
  }

  const tools = facts.tools.map((t) => t.name).slice(0, 3)
  if (tools.length > 0) {
    probes.push({
      id: 'tools',
      kind: 'next-step',
      question: 'Which tools did you use? Name them exactly.',
      expected: tools,
      grader: 'string',
    })
  }

  if (facts.lastError) {
    probes.push({
      id: 'last-error',
      kind: 'error-fix',
      question: 'What was the last error you hit? Quote its first line.',
      expected: [facts.lastError.slice(0, 80)],
      grader: 'string',
    })
  }

  if (constraint) {
    const words = constraint
      .split(/\s+/)
      .filter((w) => w.length > 4)
      .slice(0, 4)
      .join(' ')
    if (words) {
      probes.push({
        id: 'instruction',
        kind: 'user-value',
        question: 'What did the person ask you to do most recently in this session?',
        expected: [words],
        grader: 'string',
      })
    }
  }

  return probes
}

/**
 * Split a stored session into (history, continuation). The continuation starts
 * at the last user message, so the history is everything a compaction would
 * have folded away.
 */
function splitSession(messages: Message[]): { history: Message[]; continuation: Message[] } | null {
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUser = i
      break
    }
  }
  if (lastUser <= 0) return null
  return { history: messages.slice(0, lastUser), continuation: messages.slice(lastUser) }
}

function continuationCalls(messages: Message[]): Array<{ tool: string; targetPath?: string; argsKey?: string }> {
  const calls: Array<{ tool: string; targetPath?: string; argsKey?: string }> = []
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    for (const block of (msg as AssistantMessage).content ?? []) {
      if (block?.type !== 'toolCall') continue
      const call = block as ToolCall
      calls.push({
        tool: call.name,
        targetPath: firstPath(call.arguments as Record<string, any>),
        argsKey: callKey(call),
      })
      if (calls.length >= 3) return calls
    }
  }
  return calls
}


/**
 * Qualifying fixtures from one store. `skip` ignores the first N that qualify so
 * a caller can take one per round and spread a limited budget across projects.
 */
function fixturesFromRoot(
  root: { id: string; db: string },
  opts: { minTokens: number; skip: number; want: number },
  counters: { examined: number; crossedCap: number },
): CompactionFixture[] {
  const out: CompactionFixture[] = []
  let db: Database
  try {
    // Read-only handle: bun:sqlite rejects a `?immutable=1` suffix (it is not a
    // URI filename), and `readonly: true` is the same guarantee — nothing here
    // ever runs a write statement against a live store.
    db = new Database(root.db, { readonly: true })
  } catch {
    return out
  }

  let rows: SessionRow[] = []
  try {
    rows = db.query('SELECT id, data FROM sessions').all() as SessionRow[]
  } catch {
    db.close()
    return out
  }

  let qualified = 0
  for (const row of rows) {
    if (out.length >= opts.want) break
    counters.examined++
    let parsed: { messages?: Message[]; compactedSummary?: string | null }
    try {
      parsed = JSON.parse(row.data)
    } catch {
      continue
    }
    const messages = Array.isArray(parsed.messages) ? parsed.messages : []
    if (messages.length < 4) continue

    const compactedBefore = Boolean(parsed.compactedSummary)
    if (!compactedBefore && tokensOf(messages) < opts.minTokens) continue
    if (compactedBefore) counters.crossedCap++

    const split = splitSession(messages)
    if (!split) continue
    if (!compactedBefore && tokensOf(split.history) < opts.minTokens) continue
    if (split.continuation.length === 0) continue
    // The summarizer only runs at a turn boundary. A session that is one single
    // turn (one prompt, 40 tool rounds) takes the *fold* path instead and never
    // calls the summarizer, so it cannot measure one. Keep at least two turns in
    // the history.
    if (split.history.filter((m) => m.role === 'user').length < 2) continue

    const nextUserMessage = textOf(split.continuation[0]).slice(0, 2_000)
    if (!nextUserMessage.trim()) continue

    if (qualified++ < opts.skip) continue

    const calls = continuationCalls(split.continuation)
    const lastUserInstruction = [...split.history].reverse().find((m) => m.role === 'user')

    out.push({
      id: `real-${root.id.replace(/^proj-/, '').slice(0, 8)}-${row.id.slice(0, 8)}`,
      source: 'real',
      project: root.id,
      messages: redactMessages(split.history),
      nextUserMessage: redactSecretText(nextUserMessage),
      nextAction: calls[0] ?? null,
      continuationCalls: calls,
      probes: deriveProbes(
        split.history,
        lastUserInstruction ? redactSecretText(textOf(lastUserInstruction)).slice(0, 400) : null,
      ),
      tools: [
        ...new Set([
          'read_file',
          'edit_file',
          'write_file',
          'exec',
          'grep',
          'web',
          ...collectCompactionFacts(split.history).tools.map((t) => t.name),
        ]),
      ],
    })
  }
  db.close()
  return out
}

function main(): void {
  const minTokens = argNum('min-tokens', Math.floor(CAP_TOKENS / 2))
  const limit = argNum('limit', 400)

  if (!existsSync(ROOTS_DIR)) {
    console.error(`No workspace roots at ${ROOTS_DIR}`)
    process.exit(1)
  }
  const roots = readdirSync(ROOTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ id: d.name, db: join(ROOTS_DIR, d.name, '.shogo', 'sessions.db') }))
    .filter((r) => existsSync(r.db))

  const counters = { examined: 0, crossedCap: 0 }
  const candidates = new Map<string, CompactionFixture>()
  // One session per store per round, then a second and third pass: a single
  // pass would give one fixture per project at most, and the eval wants a mix
  // of planner, dev, QA and content sessions rather than one project's.
  for (let round = 0; round < 6 && candidates.size < limit; round++) {
    for (const root of roots) {
      if (candidates.size >= limit) break
      for (const fixture of fixturesFromRoot(
        root,
        { minTokens, skip: round, want: 1 },
        counters,
      )) {
        candidates.set(fixture.id, fixture)
      }
    }
  }

  mkdirSync(OUT_DIR, { recursive: true })
  for (const fixture of [...candidates.values()].slice(0, limit)) {
    writeFileSync(join(OUT_DIR, `${fixture.id}.json`), JSON.stringify(fixture), 'utf8')
  }
  const examined = counters.examined
  const crossedCap = counters.crossedCap
  const written = Math.min(candidates.size, limit)

  console.log(`Examined ${examined} session(s); ${crossedCap} were already compacted.`)
  console.log(`Wrote ${written} real fixture(s) -> ${OUT_DIR}`)
  console.log('That directory is gitignored: never commit its contents.')
  if (written < 24) {
    console.warn(
      `Only ${written} fixtures — the eval wants at least 24. Lower --min-tokens or run on a machine with more sessions.`,
    )
  }
}

main()
