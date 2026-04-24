#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * port-gstack.ts — verbatim port of garrytan/gstack SKILL.md files.
 *
 * Reads every `<skill>/SKILL.md` in a local gstack checkout and writes a
 * byte-identical copy into this template's `.shogo/skills/gstack-<skill>/SKILL.md`
 * with only a YAML frontmatter block prepended (source URL, pinned commit, MIT
 * attribution). Also emits `.shogo/skills/gstack-manifest.json` so we can track
 * drift later via sync-gstack.ts.
 *
 * Usage:
 *   bun run packages/agent-runtime/templates/virtual-engineering-team/scripts/port-gstack.ts \
 *     [--gstack /tmp/gstack] [--commit <sha>] [--dry-run]
 *
 * Rules (do not change without discussing):
 *   1. The skill body below the frontmatter MUST be byte-identical to upstream.
 *   2. Only the frontmatter block is added on top; nothing inside the body
 *      is rewritten, normalized, or reformatted.
 *   3. `scripts/` inside gstack is not a skill — skip it.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const TEMPLATE_ROOT = resolve(__dirname, '..')
const SKILLS_ROOT = join(TEMPLATE_ROOT, '.shogo', 'skills')

// Directory name of a gstack skill → the role it maps to in this template.
// Entries marked `core` are wired into the 7-stage sprint pipeline.
// Every other SKILL.md under gstack/ is still ported but marked `optional`.
const CORE_ROLES: Record<string, { role: string; stage: string }> = {
  'office-hours':       { role: 'host',           stage: 'think'   },
  'plan-ceo-review':    { role: 'ceo',            stage: 'plan'    },
  'plan-eng-review':    { role: 'eng-mgr',        stage: 'plan'    },
  'plan-design-review': { role: 'designer',       stage: 'plan'    },
  'autoplan':           { role: 'autoplan',       stage: 'build'   },
  'review':             { role: 'reviewer',       stage: 'review'  },
  'codex':              { role: 'second-opinion', stage: 'review'  },
  'qa':                 { role: 'qa',             stage: 'test'    },
  'investigate':        { role: 'investigate',    stage: 'test'    },
  'cso':                { role: 'cso',            stage: 'test'    },
  'ship':               { role: 'release',        stage: 'ship'    },
  'land-and-deploy':    { role: 'deploy',         stage: 'ship'    },
  'retro':              { role: 'retro',          stage: 'reflect' },
  'learn':              { role: 'memory',         stage: 'reflect' },
}

// Skills that ship with gstack but are not wired into the default pipeline.
// They are still ported verbatim and shown on the Skills Registry as
// "environment-specific" or "power tool".
const OPTIONAL_ROLE = 'optional'
const OPTIONAL_STAGE = 'optional'

function parseArgs(argv: string[]): { gstack: string; commit: string | null; dryRun: boolean } {
  let gstack = '/tmp/gstack'
  let commit: string | null = null
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--gstack') gstack = argv[++i]
    else if (a === '--commit') commit = argv[++i]
    else if (a === '--dry-run') dryRun = true
  }
  return { gstack, commit, dryRun }
}

function getCommitSha(repo: string): string {
  try {
    return execSync(`git -C ${repo} rev-parse HEAD`, { encoding: 'utf-8' }).trim()
  } catch {
    return 'unknown'
  }
}

function listSkillDirs(repo: string): string[] {
  return readdirSync(repo, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name => !name.startsWith('.') && name !== 'node_modules')
    .filter(name => existsSync(join(repo, name, 'SKILL.md')))
    .sort()
}

interface ManifestEntry {
  name: string
  role: string
  stage: string
  isCore: boolean
  sourceUrl: string
  sourceSha: string
  bodySha256: string
  portedAt: string
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function main() {
  const { gstack, commit: commitArg, dryRun } = parseArgs(process.argv.slice(2))
  const repo = resolve(gstack)
  if (!existsSync(repo)) {
    console.error(`gstack checkout not found at ${repo}. Clone it first:`)
    console.error(`  git clone https://github.com/garrytan/gstack.git ${repo}`)
    process.exit(1)
  }
  const sha = commitArg ?? getCommitSha(repo)
  const portedAt = new Date().toISOString().slice(0, 10)

  const skillDirs = listSkillDirs(repo)
  console.log(`Found ${skillDirs.length} gstack skills at ${repo} @ ${sha}`)

  if (!dryRun) mkdirSync(SKILLS_ROOT, { recursive: true })

  const manifest: ManifestEntry[] = []
  let wrote = 0

  for (const name of skillDirs) {
    const srcPath = join(repo, name, 'SKILL.md')
    const body = readFileSync(srcPath, 'utf-8')
    const meta = CORE_ROLES[name]
    const role = meta?.role ?? OPTIONAL_ROLE
    const stage = meta?.stage ?? OPTIONAL_STAGE
    const isCore = Boolean(meta)
    const sourceUrl = `https://github.com/garrytan/gstack/blob/${sha}/${name}/SKILL.md`

    const frontmatter = [
      '---',
      `source: ${sourceUrl}`,
      `commit: ${sha}`,
      `license: MIT (garrytan/gstack)`,
      `role: ${role}`,
      `stage: ${stage}`,
      `is_core: ${isCore}`,
      `ported_at: ${portedAt}`,
      `ported_by: shogo-template:virtual-engineering-team`,
      `note: Body below is byte-identical to upstream. Do not edit. Re-run port-gstack.ts to refresh.`,
      '---',
      '',
    ].join('\n')

    const outDir = join(SKILLS_ROOT, `gstack-${name}`)
    const outPath = join(outDir, 'SKILL.md')

    if (!dryRun) {
      mkdirSync(outDir, { recursive: true })
      writeFileSync(outPath, frontmatter + body)
      wrote++
    }

    manifest.push({
      name,
      role,
      stage,
      isCore,
      sourceUrl,
      sourceSha: sha,
      bodySha256: await sha256(body),
      portedAt,
    })
  }

  const manifestPath = join(SKILLS_ROOT, 'gstack-manifest.json')
  const manifestBody = JSON.stringify(
    {
      upstream: 'https://github.com/garrytan/gstack',
      commit: sha,
      license: 'MIT',
      portedAt,
      skillCount: manifest.length,
      coreCount: manifest.filter(m => m.isCore).length,
      skills: manifest,
    },
    null,
    2,
  )

  if (!dryRun) writeFileSync(manifestPath, manifestBody + '\n')

  console.log(`${dryRun ? '[dry-run] would write' : 'Wrote'} ${wrote} SKILL.md files`)
  console.log(`${dryRun ? '[dry-run] would write' : 'Wrote'} manifest: ${manifestPath}`)
  console.log(`Core roles:     ${manifest.filter(m => m.isCore).length}`)
  console.log(`Optional:       ${manifest.filter(m => !m.isCore).length}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
