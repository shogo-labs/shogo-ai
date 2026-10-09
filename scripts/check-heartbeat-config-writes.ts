// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Guard: the heartbeat schedule has exactly one writer.
 *
 * Background
 * ----------
 * `agent_configs.heartbeatEnabled / heartbeatInterval / nextHeartbeatAt` used
 * to be written from ~8 places, each re-implementing "compute the next run".
 * Several forgot to (project import, marketplace install, the internal
 * runtime route), leaving rows that were `enabled` but never scheduled, which
 * the scheduler silently skipped. `apps/api/src/services/heartbeat-config.service.ts`
 * is now the only writer; this check keeps it that way.
 *
 * Rules (scanned over non-test files in `apps/api/src`)
 * -----------------------------------------------------
 *  1. A Prisma `agentConfig.create | createMany | update | updateMany | upsert`
 *     call whose argument mentions a schedule field (`heartbeatEnabled`,
 *     `heartbeatInterval`, `nextHeartbeatAt`) is a violation, unless the file
 *     is on the allowlist below.
 *  2. A Prisma `agentConfig.create | createMany` call (or the `create:` arm of
 *     an upsert) must build its data with `buildAgentConfigCreateData(...)`
 *     so new rows always carry a valid `nextHeartbeatAt`.
 *  3. Raw SQL that `UPDATE`s `agent_configs` and sets a schedule column is a
 *     violation, unless the file is on the allowlist below.
 *
 * Usage: `bun scripts/check-heartbeat-config-writes.ts` (exit 1 on violations).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..')
const SCAN_ROOT = join(REPO_ROOT, 'apps/api/src')

const SCHEDULE_FIELDS = /\b(heartbeatEnabled|heartbeatInterval|nextHeartbeatAt)\b/
const SCHEDULE_COLUMNS = /"?(heartbeatEnabled|heartbeatInterval|nextHeartbeatAt)"?\s*=/

/**
 * Files allowed to write schedule fields directly, with the reason.
 * Paths are relative to the repo root, with forward slashes.
 */
export const ALLOWLIST: Record<string, string> = {
  'apps/api/src/services/heartbeat-config.service.ts': 'the single heartbeat config writer',
  'apps/api/src/lib/base-heartbeat-scheduler.ts':
    'advances nextHeartbeatAt after a run and repairs rows with a missing nextHeartbeatAt',
  'apps/api/src/lib/heartbeat-scheduler.ts':
    'atomic CTE claim: advances nextHeartbeatAt for the rows it hands to the trigger',
}

export interface Violation {
  file: string
  line: number
  rule: 1 | 2 | 3
  message: string
}

const WRITE_CALL = /\bagentConfig\s*\.\s*(createMany|create|updateMany|update|upsert)\s*\(/g

/** Return the text of the balanced `( ... )` that starts at `openIdx`. */
function balancedArgs(src: string, openIdx: number): string {
  let depth = 0
  let quote: string | null = null
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return src.slice(openIdx, i + 1)
    }
  }
  return src.slice(openIdx)
}

function lineOf(src: string, idx: number): number {
  let line = 1
  for (let i = 0; i < idx; i++) if (src.charCodeAt(i) === 10) line++
  return line
}

/** Pure scanner over one file's source. `relPath` uses forward slashes. */
export function findViolations(relPath: string, src: string): Violation[] {
  if (relPath in ALLOWLIST) return []
  const out: Violation[] = []
  const builderVars = [...src.matchAll(/\b(\w+)\s*=\s*(?:await\s+)?buildAgentConfigCreateData\b/g)].map((m) => m[1])

  for (const m of src.matchAll(WRITE_CALL)) {
    const method = m[1]
    const args = balancedArgs(src, m.index! + m[0].length - 1)
    const line = lineOf(src, m.index!)

    // Data built by the helper (inline, or via a variable assigned from it) is
    // the sanctioned way to create rows; fields passed *into* the helper are
    // fine, so skip the field check for those calls.
    const usesBuilder =
      args.includes('buildAgentConfigCreateData') ||
      builderVars.some((v) => new RegExp(`\\b${v}\\b`).test(args))
    if (usesBuilder) continue

    if (SCHEDULE_FIELDS.test(args)) {
      out.push({
        file: relPath,
        line,
        rule: 1,
        message: `agentConfig.${method} writes a heartbeat schedule field; use updateHeartbeatConfig() from heartbeat-config.service.ts`,
      })
      continue
    }
    const creates = method === 'create' || method === 'createMany' || method === 'upsert'
    if (creates) {
      // A bare upsert/create that only carries model fields still creates a
      // row, and that row must be schedule-consistent from birth.
      out.push({
        file: relPath,
        line,
        rule: 2,
        message: `agentConfig.${method} must build its create data with buildAgentConfigCreateData() (or go through updateHeartbeatConfig({ createIfMissing }))`,
      })
    }
  }

  // Raw SQL updates of agent_configs schedule columns.
  for (const m of src.matchAll(/UPDATE\s+"?agent_configs"?[\s\S]{0,600}?(?=`|;|$)/gi)) {
    if (SCHEDULE_COLUMNS.test(m[0])) {
      out.push({
        file: relPath,
        line: lineOf(src, m.index!),
        rule: 3,
        message: 'raw SQL updates agent_configs schedule columns; use updateHeartbeatConfig()',
      })
    }
  }
  return out
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'generated' || name === '__tests__') continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) yield* walk(full)
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) yield full
  }
}

export function scanRepo(root = SCAN_ROOT): Violation[] {
  const all: Violation[] = []
  for (const file of walk(root)) {
    const rel = relative(REPO_ROOT, file).split(sep).join('/')
    all.push(...findViolations(rel, readFileSync(file, 'utf-8')))
  }
  return all
}

if (import.meta.main) {
  const violations = scanRepo()
  if (violations.length === 0) {
    console.log('check-heartbeat-config-writes: OK (heartbeat schedule has a single writer)')
    process.exit(0)
  }
  console.error('check-heartbeat-config-writes: FAILED\n')
  for (const v of violations) console.error(`  ${v.file}:${v.line}  [rule ${v.rule}] ${v.message}`)
  console.error(
    '\nThe heartbeat schedule must only be written through apps/api/src/services/heartbeat-config.service.ts.',
  )
  process.exit(1)
}
