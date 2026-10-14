// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Guard: the only model a shipped default, template, or agent-visible prompt
 * source may name is `auto`. Concrete ids come from the workspace model list
 * the API serves (see available-models.ts). If this fails, a pinned model was
 * reintroduced; switch it to `auto` or read it from the API instead.
 */
import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

const RUNTIME_ROOT = join(__dirname, '..', '..')
const TEMPLATES_DIR = join(RUNTIME_ROOT, 'templates')

/** Concrete model ids: Anthropic, OpenAI, and Hoshi families. */
const MODEL_ID_LITERAL = /['"`](claude-[a-z0-9.-]+|gpt-[0-9][a-z0-9.-]*|hoshi-[a-z0-9.-]+)['"`]/

/**
 * Agent-visible sources: anything whose text reaches the model (defaults,
 * tool descriptions, prompts, manifests generated for projects). Comment lines
 * are skipped, so doc examples do not trip the guard.
 */
const AGENT_VISIBLE_SOURCES = [
  'src/workspace-defaults.ts',
  'src/template-loader.ts',
  'src/template-generator/generator.ts',
  'src/subagent.ts',
  'src/shogo-sdk-prompt.ts',
  'src/gateway-tools.ts',
  'src/project-tools.ts',
  'src/eng-pod-manifest-gen.ts',
  'src/issue-pipeline-manifest-gen.ts',
  'src/teammate-loop.ts',
  'entrypoint.sh',
  'swe-entrypoint.sh',
]

/**
 * Deliberate exceptions. Each must say why `auto` cannot be used there.
 * (The summarizer fallback is in gateway.ts, which is not in the list above.)
 */
const ALLOWED_LITERALS = new Set<string>([])

function walk(dir: string, match: (p: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, match, out)
    else if (match(p)) out.push(p)
  }
  return out
}

function isCommentLine(line: string): boolean {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#')
}

/** Collect `modelName` and `model.name` values from any JSON document. */
function modelValuesIn(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) modelValuesIn(item, found)
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'modelName' && typeof value === 'string') found.push(value)
      if (key === 'model' && value && typeof value === 'object' && typeof (value as any).name === 'string') {
        found.push((value as any).name)
      }
      modelValuesIn(value, found)
    }
  }
  return found
}

describe('bundled templates pin only auto', () => {
  const jsonFiles = walk(TEMPLATES_DIR, (p) => p.endsWith('.json') && !p.includes('node_modules'))

  test('every template model setting is auto', () => {
    const offenders: string[] = []
    for (const file of jsonFiles) {
      let doc: unknown
      try {
        doc = JSON.parse(readFileSync(file, 'utf-8'))
      } catch {
        continue
      }
      for (const value of modelValuesIn(doc)) {
        if (value !== 'auto') offenders.push(`${relative(RUNTIME_ROOT, file)} -> ${value}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('every shogo-system.yaml agent model is auto', () => {
    const yamlFiles = walk(TEMPLATES_DIR, (p) => p.endsWith('shogo-system.yaml'))
    const offenders: string[] = []
    for (const file of yamlFiles) {
      for (const line of readFileSync(file, 'utf-8').split('\n')) {
        const m = /^\s*model:\s*(\S+)\s*$/.exec(line)
        if (m && m[1] !== 'auto') offenders.push(`${relative(RUNTIME_ROOT, file)} -> ${m[1]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('every agent frontmatter model is auto', () => {
    const mdFiles = walk(TEMPLATES_DIR, (p) => p.endsWith('.md'))
    const offenders: string[] = []
    for (const file of mdFiles) {
      const m = /^model:\s*(\S+)\s*$/m.exec(readFileSync(file, 'utf-8'))
      if (m && m[1] !== 'auto') offenders.push(`${relative(RUNTIME_ROOT, file)} -> ${m[1]}`)
    }
    expect(offenders).toEqual([])
  })
})

describe('agent-visible sources contain no concrete model ids', () => {
  for (const rel of AGENT_VISIBLE_SOURCES) {
    test(rel, () => {
      const lines = readFileSync(join(RUNTIME_ROOT, rel), 'utf-8').split('\n')
      const hits = lines
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => !isCommentLine(line))
        .filter(({ line }) => {
          const m = MODEL_ID_LITERAL.exec(line)
          return !!m && !ALLOWED_LITERALS.has(m[1])
        })
        .map(({ line, n }) => `${rel}:${n}: ${line.trim()}`)
      expect(hits).toEqual([])
    })
  }
})
