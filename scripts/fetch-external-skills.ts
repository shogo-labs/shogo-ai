#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Fetch external Claude Code skills from the skill registry.
 *
 * Reads skill-registry.json, shallow-clones each repo, validates every
 * SKILL.md it finds, and copies validated skills into
 * packages/agent-runtime/src/bundled-claude-skills/<source>/<skill>/SKILL.md.
 *
 * Also writes a manifest.json used by the runtime registry API.
 *
 * Run:  bun run scripts/fetch-external-skills.ts
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, cpSync, rmSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { execSync } from 'child_process'
import { tmpdir } from 'os'

const ROOT = join(import.meta.dir, '..')
const REGISTRY_PATH = join(ROOT, 'packages/agent-runtime/src/skill-registry.json')
const OUTPUT_DIR = join(ROOT, 'packages/agent-runtime/src/bundled-claude-skills')

interface RegistrySource {
  id: string
  repo: string
  branch: string
  skillsPath: string
  description: string
}

interface ManifestEntry {
  name: string
  description: string
  source: string
  sourceDescription: string
  dirName: string
}

function parseFrontmatter(raw: string): Record<string, string> {
  const match = raw.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const metadata: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) continue
    const key = line.substring(0, colonIndex).trim()
    if (!key || key.startsWith(' ')) continue
    let value = line.substring(colonIndex + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    metadata[key] = value
  }
  return metadata
}

function discoverSkills(baseDir: string, skillsPath: string): Array<{ dirPath: string; dirName: string }> {
  const searchDir = skillsPath === '.' ? baseDir : join(baseDir, skillsPath)
  if (!existsSync(searchDir)) return []

  const results: Array<{ dirPath: string; dirName: string }> = []
  function scan(dir: string, depth: number) {
    if (depth > 2) return
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.')) continue
        const entryPath = join(dir, entry.name)
        const skillMd = join(entryPath, 'SKILL.md')
        if (existsSync(skillMd)) {
          results.push({ dirPath: entryPath, dirName: entry.name })
        } else {
          scan(entryPath, depth + 1)
        }
      }
    } catch { /* unreadable */ }
  }
  scan(searchDir, 0)
  return results
}

function copySkillDir(srcDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true })
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, entry.name)
    const destPath = join(destDir, entry.name)
    if (entry.isDirectory()) {
      cpSync(srcPath, destPath, { recursive: true })
    } else {
      const content = readFileSync(srcPath)
      writeFileSync(destPath, content)
    }
  }
}

async function main() {
  console.log('[fetch-external-skills] Reading registry...')
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8')) as { sources: RegistrySource[] }

  if (existsSync(OUTPUT_DIR)) {
    rmSync(OUTPUT_DIR, { recursive: true })
  }
  mkdirSync(OUTPUT_DIR, { recursive: true })

  const manifest: ManifestEntry[] = []
  const seenNames = new Set<string>()
  let totalSkills = 0
  let totalErrors = 0

  for (const source of registry.sources) {
    console.log(`\n[fetch-external-skills] Processing ${source.id} (${source.repo})...`)

    const tmpDir = join(tmpdir(), `shogo-skills-${source.id}-${Date.now()}`)
    try {
      execSync(
        `git clone --depth 1 --branch ${source.branch} https://github.com/${source.repo}.git "${tmpDir}"`,
        { stdio: 'pipe', timeout: 60_000 },
      )
    } catch (err: any) {
      console.error(`[fetch-external-skills] Failed to clone ${source.repo}: ${err.message}`)
      totalErrors++
      continue
    }

    const skills = discoverSkills(tmpDir, source.skillsPath)
    console.log(`[fetch-external-skills] Found ${skills.length} skills in ${source.id}`)

    for (const { dirPath, dirName } of skills) {
      const skillMdPath = join(dirPath, 'SKILL.md')
      let raw: string
      try {
        raw = readFileSync(skillMdPath, 'utf-8')
      } catch {
        console.warn(`[fetch-external-skills] Cannot read ${skillMdPath}, skipping`)
        totalErrors++
        continue
      }

      const metadata = parseFrontmatter(raw)
      const name = metadata.name || dirName
      const description = metadata.description || ''

      if (!name) {
        console.warn(`[fetch-external-skills] Skipping ${dirName}: no name in frontmatter`)
        totalErrors++
        continue
      }
      if (!description) {
        console.warn(`[fetch-external-skills] Skipping ${dirName}: no description in frontmatter`)
        totalErrors++
        continue
      }

      if (seenNames.has(name)) {
        console.warn(`[fetch-external-skills] Duplicate skill name "${name}" from ${source.id}/${dirName}, skipping`)
        continue
      }
      seenNames.add(name)

      const destDir = join(OUTPUT_DIR, source.id, dirName)
      copySkillDir(dirPath, destDir)

      manifest.push({
        name,
        description,
        source: source.id,
        sourceDescription: source.description,
        dirName,
      })
      totalSkills++
    }

    try { rmSync(tmpDir, { recursive: true }) } catch { /* cleanup best-effort */ }
  }

  writeFileSync(join(OUTPUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))

  console.log(`\n[fetch-external-skills] Done: ${totalSkills} skills from ${registry.sources.length} sources (${totalErrors} errors)`)
  if (totalErrors > 0) {
    console.warn('[fetch-external-skills] Some skills had validation errors; see warnings above.')
  }
}

main().catch((err) => {
  console.error('[fetch-external-skills] Fatal error:', err)
  process.exit(1)
})
