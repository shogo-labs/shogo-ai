// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `AGENT_MODEL=<provider>:<model>` pins every model pick (SHO-418).
 *
 * A standalone runtime has exactly one model endpoint, so a single env var has
 * to outrank every selection path: Auto tiers, the summarizer, heartbeats,
 * subagent tiers / built-ins / caller overrides, and the project's
 * `config.json` model. The last test is a guard: it fails when a new selection
 * site appears that has not been taught about the pin.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { __resetStandaloneForTests } from '@shogo/shared-runtime/standalone'
import { resolveSummarizerModel, resolveTurnModelAliasFor } from '../gateway'
import { resolveHeartbeatModel } from '../heartbeat-model'
import { resolveModelTier, resolveSubagentModel } from '../subagent'
import { resolveAutoTierModelId } from '../available-models'

const PIN = { provider: 'local', id: 'qwen3-coder' }
const originalEnv = { ...process.env }

beforeEach(() => {
  process.env = { ...originalEnv }
  process.env.AGENT_MODEL = `${PIN.provider}:${PIN.id}`
  // A cloud tier map and summarizer are present on purpose: the pin has to win
  // over them, not merely fill a gap.
  process.env.AGENT_AUTO_TIER_MAP = JSON.stringify({
    economy: { id: 'gpt-5.4-nano', provider: 'openai' },
    standard: { id: 'claude-haiku-4-5', provider: 'anthropic' },
    premium: { id: 'claude-sonnet-4-6', provider: 'anthropic' },
  })
  process.env.AGENT_SUMMARIZER_MODEL = JSON.stringify({ id: 'claude-haiku-4-5', provider: 'anthropic' })
  __resetStandaloneForTests()
})

afterEach(() => {
  process.env = { ...originalEnv }
  __resetStandaloneForTests()
})

describe('AGENT_MODEL pins every selection path', () => {
  test('the turn alias ignores the session override and config.json', () => {
    expect(resolveTurnModelAliasFor('claude-sonnet-4-6', 'auto')).toBe(PIN.id)
    expect(resolveTurnModelAliasFor(undefined, 'claude-opus-4-6')).toBe(PIN.id)
    expect(resolveTurnModelAliasFor('auto', 'auto')).toBe(PIN.id)
  })

  test('the summarizer ignores AGENT_SUMMARIZER_MODEL and the Haiku fallback', () => {
    expect(resolveSummarizerModel(process.env.AGENT_SUMMARIZER_MODEL)).toEqual(PIN)
    expect(resolveSummarizerModel(undefined)).toEqual(PIN)
  })

  test('heartbeats ignore the project model and the hoshi-2-0 fallback', () => {
    expect(
      resolveHeartbeatModel({
        agentModelName: 'claude-sonnet-4-6',
        agentModelProvider: 'anthropic',
        runtimeModel: { name: 'claude-opus-4-6', provider: 'anthropic' },
        economyTier: { id: 'gpt-5.4-nano', provider: 'openai' },
      }),
    ).toEqual({ id: PIN.id, provider: PIN.provider, source: 'pinned' })
    expect(resolveHeartbeatModel({})).toEqual({ id: PIN.id, provider: PIN.provider, source: 'pinned' })
  })

  test('subagent tiers resolve to the pin', () => {
    expect(resolveModelTier('fast', 'claude-sonnet-4-6')).toBe(PIN.id)
    expect(resolveModelTier('capable', 'claude-sonnet-4-6')).toBe(PIN.id)
    expect(resolveModelTier('default', 'claude-sonnet-4-6')).toBe(PIN.id)
    expect(resolveModelTier(undefined, 'claude-sonnet-4-6')).toBe(PIN.id)
  })

  test('a subagent caller override and a built-in default both lose to the pin', async () => {
    const explicit = await resolveSubagentModel(
      'explore',
      null,
      null,
      'claude-opus-4-6',
      'anthropic',
      'auto',
      undefined,
    )
    expect(explicit).toEqual({ model: PIN.id, provider: PIN.provider, source: 'pinned' })

    const builtin = await resolveSubagentModel('explore', null, null, undefined, undefined, 'auto', undefined)
    expect(builtin).toEqual({ model: PIN.id, provider: PIN.provider, source: 'pinned' })
  })

  test('Auto tiers resolve to the pin', () => {
    expect(resolveAutoTierModelId('economy')).toBe(PIN.id)
    expect(resolveAutoTierModelId('standard')).toBe(PIN.id)
    expect(resolveAutoTierModelId('premium')).toBe(PIN.id)
  })

  test('off the pin, every path keeps its old answer', () => {
    delete process.env.AGENT_MODEL
    expect(resolveTurnModelAliasFor('claude-sonnet-4-6', 'auto')).toBe('claude-sonnet-4-6')
    expect(resolveTurnModelAliasFor(undefined, 'auto')).toBe('auto')
    expect(resolveSummarizerModel(undefined)).toEqual({ id: 'claude-haiku-4-5', provider: 'anthropic' })
    expect(resolveHeartbeatModel({}).id).toBe('hoshi-2-0')
    expect(resolveModelTier('fast', 'claude-sonnet-4-6')).toBe('gpt-5.4-nano')
    expect(resolveAutoTierModelId('premium')).toBe('claude-sonnet-4-6')
  })
})

// ---------------------------------------------------------------------------
// Guard: a new selection site must be taught about the pin
// ---------------------------------------------------------------------------

const SRC = join(import.meta.dir, '..')

/** Every function that decides which model a request goes to. */
const SELECTION_SITES: Array<{ file: string; fn: string }> = [
  { file: 'gateway.ts', fn: 'resolveTurnModelAliasFor' },
  { file: 'gateway.ts', fn: 'resolveSummarizerModel' },
  { file: 'heartbeat-model.ts', fn: 'resolveHeartbeatModel' },
  { file: 'subagent.ts', fn: 'resolveModelTier' },
  { file: 'subagent.ts', fn: 'resolveSubagentModel' },
  { file: 'available-models.ts', fn: 'resolveAutoTierModelId' },
]

/** Files allowed to name a model-selection primitive. */
const SELECTION_FILES = new Set([
  'gateway.ts',
  'heartbeat-model.ts',
  'subagent.ts',
  'available-models.ts',
  'model-router.ts',
  'agent-model-config.ts',
  'agent-model-pin.ts',
  // Resolves a teammate's model through `resolveAutoTierModelId`, so the pin
  // reaches it transitively.
  'teammate-loop.ts',
])

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'evals') continue
      out.push(...sourceFiles(full))
      continue
    }
    if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

/** The body of a top-level function, from its declaration to the closing brace. */
function functionBody(source: string, fn: string): string | null {
  const start = source.search(new RegExp(`(export )?(async )?function ${fn}\\b`))
  if (start === -1) return null
  // `\n}` at column 0 is the body's closing brace; `\n}>` (a return-type
  // object) and indented `\n  }` blocks do not match.
  const end = source.indexOf('\n}\n', start)
  return end === -1 ? source.slice(start) : source.slice(start, end + 2)
}

describe('model-selection guard', () => {
  test.each(SELECTION_SITES)('$file $fn consults the pin', ({ file, fn }) => {
    const body = functionBody(readFileSync(join(SRC, file), 'utf-8'), fn)
    expect(body).not.toBeNull()
    expect(body!).toContain('pinnedAgentModel')
  })

  test('no new file picks a model without being listed here', () => {
    const primitives = /resolveAutoTierModelId|FALLBACK_SUMMARIZER_MODEL|PLATFORM_DEFAULT_HEARTBEAT_MODEL|buildAutoTierMap/
    const offenders = sourceFiles(SRC)
      .filter((path) => primitives.test(readFileSync(path, 'utf-8')))
      .map((path) => path.slice(SRC.length + 1))
      .filter((rel) => !SELECTION_FILES.has(rel))
    expect(offenders).toEqual([])
  })
})
