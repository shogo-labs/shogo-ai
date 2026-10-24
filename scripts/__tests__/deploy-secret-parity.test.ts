// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression coverage for the SHO-72 class: every job that builds the
 * `api-secrets` k8s secret must inject the *same* set of env names.
 *
 * SHO-40 added `HIGGSFIELD_API_KEY` to `deploy-us` and
 * `deploy-staging.yml` but not to `deploy-eu`. Nothing failed: the EU
 * overlay declares the var with `optional: true`, so pods booted fine
 * and every Higgsfield request resolved no key — media silently
 * unavailable in EU for weeks.
 *
 * The guard parses the `SECRET_ARGS` array each job feeds to
 * `kubectl create secret generic api-secrets` and asserts the three
 * name sets are identical. Adding a secret to one region only now
 * fails the required "Lint, Typecheck, Test" check.
 *
 * No YAML dependency: the workflows are read as text, same approach as
 * `api-image-contract.test.ts`.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'

const root = resolve(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

/** Workflows that build `api-secrets`. Keep in sync with the jobs below. */
const WORKFLOWS = ['.github/workflows/deploy.yml', '.github/workflows/deploy-staging.yml']

export type SecretBlock = {
  file: string
  /** Job key the `kubectl` line lives under, e.g. `deploy-eu`. */
  job: string
  /** 1-based line of the `kubectl create secret generic api-secrets` call. */
  line: number
  /** Env var names passed via `--from-literal=NAME=`. */
  names: string[]
}

/**
 * Find each `kubectl create secret generic api-secrets` call and collect
 * every `--from-literal=NAME=` between its `SECRET_ARGS=(` opening and the
 * call itself. The initial `ANTHROPIC_API_KEY` entry lives in the array
 * literal rather than an `if` line, so the scan must start at the opening.
 */
export function parseApiSecretBlocks(file: string, content: string): SecretBlock[] {
  const lines = content.split('\n')
  const jobsStart = lines.findIndex((l) => /^jobs:\s*$/.test(l))
  const blocks: SecretBlock[] = []

  lines.forEach((line, i) => {
    if (!/kubectl\s+create\s+secret\s+generic\s+api-secrets\b/.test(line)) return

    let start = -1
    let job = '<unknown job>'
    for (let j = i - 1; j > jobsStart; j--) {
      if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[j])) {
        job = lines[j].trim().replace(/:$/, '')
        break
      }
      if (start < 0 && /SECRET_ARGS=\(\s*$/.test(lines[j])) start = j
    }

    const region = start < 0 ? '' : lines.slice(start, i).join('\n')
    const names = [...region.matchAll(/--from-literal=([A-Z][A-Z0-9_]*)=/g)].map((m) => m[1])
    blocks.push({ file, job, line: i + 1, names })
  })

  return blocks
}

/**
 * Compare every block against the first one. Returns human-readable
 * problems naming the job and the missing/extra keys; empty means parity.
 */
export function secretParityProblems(blocks: SecretBlock[]): string[] {
  if (blocks.length === 0) return ['no `kubectl create secret generic api-secrets` block found in any workflow']

  const problems: string[] = []
  for (const block of blocks) {
    if (block.names.length === 0) {
      problems.push(`${block.job} (${block.file}) passed no --from-literal names — the parser found nothing`)
    }
  }

  const baseline = blocks[0]
  const baselineNames = new Set(baseline.names)
  for (const block of blocks.slice(1)) {
    const names = new Set(block.names)
    for (const name of baselineNames) {
      if (!names.has(name)) problems.push(`${block.job} is missing ${name}`)
    }
    for (const name of names) {
      if (!baselineNames.has(name)) problems.push(`${block.job} has ${name}, which ${baseline.job} does not`)
    }
  }
  return problems
}

describe('deploy api-secrets parity', () => {
  const blocks = WORKFLOWS.flatMap((file) => parseApiSecretBlocks(file, read(file)))

  it('finds the api-secrets block in every job that creates one', () => {
    expect(blocks.map((b) => `${b.file}:${b.job}`).sort()).toEqual([
      '.github/workflows/deploy-staging.yml:deploy',
      '.github/workflows/deploy.yml:deploy-eu',
      '.github/workflows/deploy.yml:deploy-us',
    ])
  })

  it('every job injects the same secret names (US / EU / staging)', () => {
    expect(secretParityProblems(blocks)).toEqual([])
  })

  it('each block carries the full set, including HIGGSFIELD_API_KEY', () => {
    for (const block of blocks) {
      expect(block.names.length).toBeGreaterThan(0)
      expect(block.names).toContain('ANTHROPIC_API_KEY')
      expect(block.names).toContain('HIGGSFIELD_API_KEY')
    }
  })
})

// Synthetic fixtures: prove the guard actually catches the SHO-72 shape and
// that a silent no-match cannot pass as parity.
const block = (names: string[], indent = '          ') =>
  [
    `${indent}SECRET_ARGS=(`,
    `${indent}  --from-literal=${names[0]}=x`,
    `${indent})`,
    ...names.slice(1).map((n) => `${indent}if [ -n "x" ]; then SECRET_ARGS+=(--from-literal=${n}=x); fi`),
    `${indent}kubectl create secret generic api-secrets \\`,
    `${indent}  --namespace=ns \\`,
    `${indent}  "\${SECRET_ARGS[@]}" \\`,
    `${indent}  --dry-run=client -o yaml | kubectl apply -f -`,
  ].join('\n')

const workflow = (jobs: Record<string, string>) =>
  [
    'name: ci',
    'on:',
    '  push:',
    'jobs:',
    ...Object.entries(jobs).flatMap(([job, body]) => [`  ${job}:`, '    steps:', '      - run: |', body]),
  ].join('\n')

describe('deploy api-secrets parity (fixtures)', () => {
  it('reports the region and the missing key when one job diverges', () => {
    const src = workflow({
      'deploy-us': block(['ANTHROPIC_API_KEY', 'HIGGSFIELD_API_KEY']),
      'deploy-eu': block(['ANTHROPIC_API_KEY']),
    })
    expect(secretParityProblems(parseApiSecretBlocks('fixture.yml', src))).toEqual(['deploy-eu is missing HIGGSFIELD_API_KEY'])
  })

  it('reports a key that exists in only the non-baseline job', () => {
    const src = workflow({
      'deploy-us': block(['ANTHROPIC_API_KEY']),
      'deploy-eu': block(['ANTHROPIC_API_KEY', 'EU_ONLY_KEY']),
    })
    expect(secretParityProblems(parseApiSecretBlocks('fixture.yml', src))).toEqual([
      'deploy-eu has EU_ONLY_KEY, which deploy-us does not',
    ])
  })

  it('collects the name declared in the SECRET_ARGS=( … ) literal, not just the if lines', () => {
    const [parsed] = parseApiSecretBlocks('fixture.yml', workflow({ 'deploy-eu': block(['ANTHROPIC_API_KEY', 'HIGGSFIELD_API_KEY']) }))
    expect(parsed.job).toBe('deploy-eu')
    expect(parsed.names).toEqual(['ANTHROPIC_API_KEY', 'HIGGSFIELD_API_KEY'])
  })

  it('refuses to treat an empty match as parity', () => {
    expect(secretParityProblems([])).toEqual(['no `kubectl create secret generic api-secrets` block found in any workflow'])
  })
})
