#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * sync-gstack.ts — detect drift between this template's ported SKILL.md files
 * and the current upstream gstack checkout.
 *
 * Never overwrites anything. It reports:
 *   • SKILLs whose upstream body differs from the ported body
 *   • New upstream SKILLs not yet ported
 *   • Ported SKILLs that no longer exist upstream
 *
 * Usage:
 *   bun run packages/agent-runtime/templates/virtual-engineering-team/scripts/sync-gstack.ts \
 *     [--gstack /tmp/gstack]
 *
 * To actually re-port after reviewing the diff, run port-gstack.ts.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const TEMPLATE_ROOT = resolve(__dirname, '..')
const SKILLS_ROOT = join(TEMPLATE_ROOT, '.shogo', 'skills')

function parseArgs(argv: string[]): { gstack: string } {
  let gstack = '/tmp/gstack'
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--gstack') gstack = argv[++i]
  }
  return { gstack }
}

function stripFrontmatter(text: string): string {
  // The port prepends a single YAML block: ---\n...\n---\n\n<body>
  // Strip from start through the closing --- and the single blank line.
  const firstDelim = text.indexOf('---\n')
  if (firstDelim !== 0) return text
  const secondDelim = text.indexOf('\n---\n', 4)
  if (secondDelim === -1) return text
  let bodyStart = secondDelim + 5
  if (text[bodyStart] === '\n') bodyStart++
  return text.slice(bodyStart)
}

function main() {
  const { gstack } = parseArgs(process.argv.slice(2))
  const repo = resolve(gstack)
  if (!existsSync(repo)) {
    console.error(`gstack checkout not found at ${repo}`)
    process.exit(1)
  }
  const upstreamSha = execSync(`git -C ${repo} rev-parse HEAD`, { encoding: 'utf-8' }).trim()

  // Manifest records the SHA we ported from
  const manifestPath = join(SKILLS_ROOT, 'gstack-manifest.json')
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf-8'))
    : { commit: 'unknown', skills: [] as Array<{ name: string }> }

  console.log(`Ported from:  ${manifest.commit}`)
  console.log(`Upstream now: ${upstreamSha}`)
  if (manifest.commit === upstreamSha) {
    console.log('Pinned commit matches upstream HEAD — content drift still possible if upstream is rewritten.')
  }
  console.log('')

  const portedDirs = existsSync(SKILLS_ROOT)
    ? readdirSync(SKILLS_ROOT, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name.startsWith('gstack-'))
        .map(d => d.name.slice('gstack-'.length))
    : []
  const upstreamDirs = readdirSync(repo, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
    .map(d => d.name)
    .filter(name => existsSync(join(repo, name, 'SKILL.md')))

  const drift: string[] = []
  const missingUpstream: string[] = []
  const newUpstream: string[] = []

  for (const name of portedDirs) {
    if (!upstreamDirs.includes(name)) {
      missingUpstream.push(name)
      continue
    }
    const portedBody = stripFrontmatter(readFileSync(join(SKILLS_ROOT, `gstack-${name}`, 'SKILL.md'), 'utf-8'))
    const upstreamBody = readFileSync(join(repo, name, 'SKILL.md'), 'utf-8')
    if (portedBody !== upstreamBody) drift.push(name)
  }
  for (const name of upstreamDirs) {
    if (!portedDirs.includes(name)) newUpstream.push(name)
  }

  const ok = drift.length === 0 && missingUpstream.length === 0 && newUpstream.length === 0
  if (ok) {
    console.log('✓ In sync. All ported SKILL.md bodies match upstream, no additions or removals.')
    return
  }
  if (drift.length) {
    console.log(`⚠ Drift in ${drift.length} ported skill(s):`)
    drift.forEach(n => console.log(`  • ${n}`))
  }
  if (newUpstream.length) {
    console.log(`+ ${newUpstream.length} new upstream skill(s) not yet ported:`)
    newUpstream.forEach(n => console.log(`  • ${n}`))
  }
  if (missingUpstream.length) {
    console.log(`− ${missingUpstream.length} ported skill(s) no longer exist upstream:`)
    missingUpstream.forEach(n => console.log(`  • ${n}`))
  }
  console.log('')
  console.log('Run scripts/port-gstack.ts to re-port after reviewing.')
  process.exitCode = 1
}

main()
