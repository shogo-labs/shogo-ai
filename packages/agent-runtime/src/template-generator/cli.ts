#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Template Generator CLI
 *
 * Reads bundled skills, groups them via Claude, generates template
 * directories, and updates the cache.
 *
 * Usage:
 *   bun run src/template-generator/cli.ts [--force] [--dry-run]
 *
 * Flags:
 *   --force    Ignore cache, reprocess all skills
 *   --dry-run  Show what would happen without calling Claude or writing files
 */

import { readBundledSkills } from './skill-reader'
import { TemplateCache } from './cache'
import { groupSkills } from './grouper'
import { generateAllTemplates } from './generator'

const args = new Set(process.argv.slice(2))
const force = args.has('--force')
const dryRun = args.has('--dry-run')

async function main() {
  console.log('=== Skill-to-Template Generator ===')
  if (dryRun) console.log('  (dry-run mode — no writes)')
  if (force) console.log('  (force mode — ignoring cache)')
  console.log()

  // 1. Read all bundled skills
  const allSkills = readBundledSkills()
  console.log(`[cli] Found ${allSkills.length} bundled skills`)

  if (allSkills.length === 0) {
    console.log('[cli] No skills found. Nothing to do.')
    return
  }

  // 2. Check cache
  const cache = new TemplateCache()
  let skillsToProcess = force
    ? allSkills.map(s => ({ name: s.name, contentHash: s.contentHash }))
    : cache.getNewOrChanged(allSkills.map(s => ({ name: s.name, contentHash: s.contentHash })))

  console.log(`[cli] ${skillsToProcess.length} new/changed skills to process`)

  if (skillsToProcess.length === 0) {
    console.log('[cli] All skills are cached. Nothing to do. Use --force to reprocess.')
    cache.close()
    return
  }

  // When processing, include all skills for full context in grouping
  const skillNamesToProcess = new Set(skillsToProcess.map(s => s.name))

  // 3. Group skills
  const groups = await groupSkills(allSkills, { dryRun })

  if (dryRun) {
    console.log('\n[cli] Would create these template groups:')
    for (const g of groups) {
      console.log(`  ${g.templateId}: ${g.name} (${g.skillNames.join(', ')})`)
    }
    cache.close()
    return
  }

  if (groups.length === 0) {
    console.log('[cli] No groups generated.')
    cache.close()
    return
  }

  console.log(`\n[cli] Generated ${groups.length} template groups:`)
  for (const g of groups) {
    console.log(`  ${g.templateId}: ${g.name} [${g.skillNames.join(', ')}]`)
  }
  console.log()

  // 4. Generate templates
  await generateAllTemplates(groups, allSkills, { dryRun })

  // 5. Update cache
  for (const group of groups) {
    for (const skillName of group.skillNames) {
      const skill = allSkills.find(s => s.name === skillName)
      if (skill) {
        cache.markProcessed(skill.name, skill.contentHash, group.templateId)
      }
    }
  }

  console.log(`\n[cli] Done! Generated ${groups.length} templates.`)
  cache.close()
}

main().catch(err => {
  console.error('[cli] Fatal error:', err)
  process.exit(1)
})
