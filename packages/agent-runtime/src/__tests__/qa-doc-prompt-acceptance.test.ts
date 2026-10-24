// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-101 acceptance — the prompt must never ask an agent to edit a channel doc.
 *
 * Russell's call (2026-10-20): the channel doc belongs to the people in the
 * channel. Agents read it for context and change it only when someone asks
 * them to. The old prompt said the opposite in two places — the always-on team
 * chat guide and the per-message doc block — which is why the doc kept
 * refilling to its 200k cap. This spec inspects the prompt an agent actually
 * receives (not just the constants), and pins the removal so a later prompt
 * edit cannot quietly bring the invitation back.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, relative, resolve } from 'path'
import { AgentGateway } from '../gateway'
import { buildTextResponse, createMockStreamFn } from './helpers/mock-anthropic'

const REPO_ROOT = resolve(import.meta.dir, '../../../..')

/** The wording that invited writes. None of it may appear in a prompt again. */
const RETIRED = [
  'record settled decisions',
  'long content there',
  'Update it with team_chat_doc_update',
  'settle something the team should keep',
  'prefer mode "patch_section" or "append"',
  'then mention the change briefly',
]

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', 'eval-outputs', 'coverage', 'test-results', 'playwright-report', '.turbo'])

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === '__mocks__') continue
      collect(full, out)
    } else if (/\.(ts|tsx|js|mjs|cjs|md|mdx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/** Every prompt-bearing source file: each package/app's `src`, plus the docs. */
function promptSources(): string[] {
  const files: string[] = []
  for (const group of ['packages', 'apps']) {
    const root = join(REPO_ROOT, group)
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const src = join(root, entry.name, 'src')
      if (existsSync(src)) collect(src, files)
    }
  }
  const docs = join(REPO_ROOT, 'apps/docs/docs')
  if (existsSync(docs)) collect(docs, files)
  return files
}

const SOURCES = promptSources()

function offenders(phrase: string): string[] {
  const hits: string[] = []
  for (const file of SOURCES) {
    if (readFileSync(file, 'utf8').includes(phrase)) hits.push(relative(REPO_ROOT, file))
  }
  return hits
}

const GATEWAY_DIR = '/tmp/qa-doc-prompt-gateway'

function setupWorkspace() {
  rmSync(GATEWAY_DIR, { recursive: true, force: true })
  mkdirSync(join(GATEWAY_DIR, 'memory'), { recursive: true })
  writeFileSync(
    join(GATEWAY_DIR, 'config.json'),
    JSON.stringify({
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
      // A team profile with a workspace is when the team chat guide is injected.
      capabilityProfile: 'team',
    }),
  )
  writeFileSync(
    join(GATEWAY_DIR, 'AGENTS.md'),
    '# Identity\nTest Agent\n\n# Personality\nBe helpful.\n\n# User\nTester\n\n# Operating Instructions\nYou are a test agent.',
  )
  writeFileSync(join(GATEWAY_DIR, 'MEMORY.md'), '# Memory\nNothing yet.')
}

describe('SHO-101: the prompt reads the channel doc, it does not ask for a write', () => {
  test('the source tree has prompt files to scan', () => {
    expect(SOURCES.length).toBeGreaterThan(500)
    expect(SOURCES.map((f) => relative(REPO_ROOT, f))).toContain('packages/agent-runtime/src/channel-tools.ts')
    expect(SOURCES.map((f) => relative(REPO_ROOT, f))).toContain('apps/api/src/services/conversation-agent-dispatcher.ts')
  })

  test('no prompt-bearing source asks an agent to write into the channel doc', () => {
    const found = RETIRED.flatMap((phrase) => offenders(phrase).map((file) => `${file} — ${phrase}`))
    expect(found).toEqual([])
  })

  test('the doc bullet exists once, and only as the read-only wording', () => {
    const hits = SOURCES.filter((file) => readFileSync(file, 'utf8').includes('Each channel can have a doc'))
    expect(hits.map((f) => relative(REPO_ROOT, f))).toEqual(['packages/agent-runtime/src/channel-tools.ts'])

    const guide = readFileSync(join(REPO_ROOT, 'packages/agent-runtime/src/channel-tools.ts'), 'utf8')
    expect(guide).toContain('kept by the people in it')
    expect(guide).toContain('Do not add to it or edit it on your own initiative')
    expect(guide).toContain('change it only when someone asks you to')
  })

  test('the #ideas pack keeps the doc instruction that is its own job', () => {
    // The one place an agent is told to touch a doc: the pack a person installed
    // to maintain that doc. Deleting it here would break the pack, not the bug.
    const pack = readFileSync(join(REPO_ROOT, 'packages/agent-runtime/src/pack-templates.ts'), 'utf8')
    expect(pack).toContain('Deduplicate against the #ideas channel doc')
  })

  describe('the composed system prompt a team agent receives', () => {
    let gateway: AgentGateway | undefined

    afterEach(async () => {
      if (gateway) await gateway.stop()
      gateway = undefined
      rmSync(GATEWAY_DIR, { recursive: true, force: true })
    })

    test('carries the read-only doc bullet, no invitation, and both doc tools', async () => {
      setupWorkspace()
      const savedWorkspace = process.env.WORKSPACE_ID
      process.env.WORKSPACE_ID = 'ws-qa-doc-prompt'
      let systemPrompt = ''
      let toolNames: string[] = []
      try {
        const mock = createMockStreamFn([buildTextResponse('The doc says we ship on Fridays.')])
        const capture: any = (model: any, context: any, options: any) => {
          systemPrompt = context.systemPrompt || context.system || systemPrompt
          const tools = Array.isArray(context.tools) ? context.tools : []
          toolNames = tools.map((tool: any) => tool?.name ?? tool?.function?.name ?? '')
          return mock(model, context, options)
        }
        gateway = new AgentGateway(GATEWAY_DIR, 'qa-doc-prompt')
        gateway.setStreamFn(capture)
        await gateway.start()
        await gateway.processChatMessage('what does the channel doc say?')
      } finally {
        if (savedWorkspace === undefined) delete process.env.WORKSPACE_ID
        else process.env.WORKSPACE_ID = savedWorkspace
      }

      // The guide really is in the prompt, so the absences below are not vacuous.
      expect(systemPrompt).toContain('## Team Chat')
      expect(systemPrompt).toContain('Each channel can have a doc')
      expect(systemPrompt).toContain('kept by the people in it')
      expect(systemPrompt).toContain('change it only when someone asks you to')

      for (const phrase of RETIRED) expect(systemPrompt).not.toContain(phrase)

      // Still able to edit: removing the invitation must not remove the tools.
      // The guide no longer names `team_chat_doc_update` — it is offered as a
      // tool instead, so that an agent a person asks can still make the change.
      // Since SHO-97 a registered tool is either advertised (schema sent) or
      // deferred (one line in the `## Deferred Tools` catalog, callable directly).
      const catalogStart = systemPrompt.indexOf('## Deferred Tools')
      const catalog = catalogStart === -1 ? '' : systemPrompt.slice(catalogStart)
      for (const name of ['team_chat_doc_read', 'team_chat_doc_update']) {
        const reachable = toolNames.includes(name) || catalog.includes(`- \`${name}\``)
        expect({ name, reachable }).toEqual({ name, reachable: true })
      }
    }, 30_000)
  })
})
