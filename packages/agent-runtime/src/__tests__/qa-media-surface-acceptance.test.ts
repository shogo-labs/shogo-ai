// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-81 acceptance — the agent surface a media turn actually reads.
 *
 * Retiring fal deleted `upscale_image` and `remove_background` from the tool
 * registry, but the prompt that *advertises* tools to a media subagent kept
 * listing them, so the model called two tools that no longer existed and burned
 * a turn on "tool not found". Fixing that line fixed today; this file is what
 * stops it coming back, and it is the gate for any future tool removal: every
 * name a prompt advertises has to be a tool the runtime really registers and
 * actually hands to the subagent.
 *
 *   bun test ./packages/agent-runtime/src/__tests__/qa-media-surface-acceptance.test.ts
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createTools, type ToolContext } from '../gateway-tools'
import { MEDIA_SUBAGENT_PROMPT, getBuiltinSubagentConfig } from '../subagent'

const SRC = join(import.meta.dir, '..')

function createCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workspaceDir: join(import.meta.dir, '../../../../_tmp/qa-media-surface'),
    channels: new Map(),
    config: { channels: [], model: { provider: 'anthropic', name: 'claude-sonnet-4-5' } },
    projectId: 'test',
    ...overrides,
  }
}

/** Tool names the `## Available Tools` section of a prompt advertises. */
function advertisedTools(prompt: string): string[] {
  const section = prompt.split('## Available Tools')[1]
  if (!section) return []
  const body = section.split('\n## ')[0]
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes(' — '))
    .flatMap((line) => line.split(' — ')[0].split(','))
    .map((name) => name.trim())
    .filter((name) => /^[a-z][a-z0-9_]+$/.test(name))
}

/** Every runtime source file, tests excluded — where a prompt could hide. */
function runtimeSources(dir = SRC, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) runtimeSources(path, found)
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) found.push(path)
  }
  return found
}

const registered = new Set(createTools(createCtx()).map((tool) => tool.name))
const mediaSubagent = getBuiltinSubagentConfig('media', createCtx(), createTools(createCtx()))
const subagentToolNames: string[] = (mediaSubagent as any)?.toolNames ?? []

describe('SHO-81 — every advertised media tool exists', () => {
  test('the media subagent prompt only names tools the runtime registers', () => {
    const advertised = advertisedTools(MEDIA_SUBAGENT_PROMPT)
    // The prompt does advertise tools, so an empty parse cannot make this pass.
    expect(advertised.length).toBeGreaterThanOrEqual(6)
    expect(advertised).toContain('generate_image')
    expect(advertised).toContain('generate_video')
    expect(advertised).toContain('transcribe_audio')

    // Advertised but unregistered is the bug this file exists for.
    expect(advertised.filter((name) => !registered.has(name))).toEqual([])
  })

  test('everything the prompt promises is also handed to the subagent', () => {
    // A tool the prompt names but the factory does not pass is just as
    // unreachable as one that was deleted outright.
    expect(advertisedTools(MEDIA_SUBAGENT_PROMPT).filter((name) => !subagentToolNames.includes(name))).toEqual([])
    expect(subagentToolNames).toContain('generate_image')
    expect(subagentToolNames).toContain('transcribe_audio')
  })

  test('the retired post-processing tools are gone from the whole runtime', () => {
    const files = runtimeSources()
    expect(files.length).toBeGreaterThan(50)
    const offenders = files.filter((path) => {
      const source = readFileSync(path, 'utf8')
      return source.includes('upscale_image') || source.includes('remove_background')
    })
    expect(offenders).toEqual([])
  })

  test('neither tool is registered, and the media tool set is what it claims to be', () => {
    const names = createTools(createCtx()).map((tool) => tool.name)
    expect(names).not.toContain('upscale_image')
    expect(names).not.toContain('remove_background')
    for (const name of subagentToolNames) expect(names).toContain(name)
  })

  test('no media prompt still offers fal as a provider', () => {
    const offenders = runtimeSources().filter((path) => {
      const source = readFileSync(path, 'utf8')
      return /fal\.ai|FAL_KEY|fal-media/i.test(source)
    })
    expect(offenders).toEqual([])
  })

  test('the capability docs do not advertise the retired tools', () => {
    // The docs table is what a user reads before turning `imageGenEnabled` on,
    // so a stale row promises two tools that answer "tool not found".
    const docs = readFileSync(
      join(import.meta.dir, '../../../../apps/docs/docs/features/capabilities.md'),
      'utf8'
    )
    const imageRow = docs.split('\n').filter((line) => line.includes('`imageGenEnabled` |'))
    expect(imageRow).toHaveLength(1)
    expect(imageRow[0]).toContain('`generate_image`')
    expect(docs).not.toContain('upscale_image')
    expect(docs).not.toContain('remove_background')
  })
})
