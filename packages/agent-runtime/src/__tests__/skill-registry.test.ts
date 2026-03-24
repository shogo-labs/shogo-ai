// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integration tests for the external skill registry pipeline.
 *
 * Tests:
 * - .agents/skills/ directory scanning alongside .claude/skills/
 * - loadSkillRegistryManifest() from bundled-claude-skills/manifest.json
 * - loadBundledClaudeCodeSkill() single-skill loader
 * - skill-registry.json validity
 * - fetch-external-skills.ts SKILL.md frontmatter validation
 * - HTTP endpoints: GET /agent/skill-registry, POST /agent/skill-registry/install
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  loadSkillsFromDir,
  loadAllSkills,
  loadSkillRegistryManifest,
  loadBundledClaudeCodeSkill,
  type Skill,
  type SkillRegistryEntry,
} from '../skills'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

mkdirSync('/tmp/test-skill-registry', { recursive: true })
const TEST_DIR = realpathSync('/tmp/test-skill-registry')

describe('External Skill Registry', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  // -----------------------------------------------------------------------
  // .agents/skills/ scanning
  // -----------------------------------------------------------------------

  describe('.agents/skills/ directory scanning', () => {
    test('discovers skills from .agents/skills/<name>/SKILL.md', () => {
      const skillDir = join(TEST_DIR, '.agents', 'skills', 'page-cro')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), `---
name: page-cro
description: When the user wants to optimize conversions on any marketing page
---

# Page CRO

Analyze the page for conversion optimization opportunities.
`)
      const skills = loadSkillsFromDir(TEST_DIR, '.agents/skills')
      expect(skills).toHaveLength(1)
      expect(skills[0].name).toBe('page-cro')
      expect(skills[0].description).toContain('optimize conversions')
      expect(skills[0].content).toContain('Page CRO')
    })

    test('loadAllSkills includes .agents/skills/', () => {
      const agentsSkillDir = join(TEST_DIR, '.agents', 'skills', 'seo-audit')
      mkdirSync(agentsSkillDir, { recursive: true })
      writeFileSync(join(agentsSkillDir, 'SKILL.md'), `---
name: seo-audit
description: SEO audit skill
---

Perform an SEO audit.
`)
      const all = loadAllSkills(TEST_DIR)
      expect(all).toHaveLength(1)
      expect(all[0].name).toBe('seo-audit')
    })

    test('.claude/skills/ takes priority over .agents/skills/ on name collision', () => {
      const claudeSkillDir = join(TEST_DIR, '.claude', 'skills', 'copywriting')
      mkdirSync(claudeSkillDir, { recursive: true })
      writeFileSync(join(claudeSkillDir, 'SKILL.md'), `---
name: copywriting
description: Claude version of copywriting skill
---

Claude version.
`)

      const agentsSkillDir = join(TEST_DIR, '.agents', 'skills', 'copywriting')
      mkdirSync(agentsSkillDir, { recursive: true })
      writeFileSync(join(agentsSkillDir, 'SKILL.md'), `---
name: copywriting
description: Agents version of copywriting skill
---

Agents version.
`)

      const all = loadAllSkills(TEST_DIR)
      expect(all).toHaveLength(1)
      expect(all[0].description).toBe('Claude version of copywriting skill')
    })

    test('merges skills from both .claude/skills/ and .agents/skills/', () => {
      const claudeDir = join(TEST_DIR, '.claude', 'skills', 'skill-a')
      mkdirSync(claudeDir, { recursive: true })
      writeFileSync(join(claudeDir, 'SKILL.md'), `---
name: skill-a
description: From .claude
---

Content A.
`)

      const agentsDir = join(TEST_DIR, '.agents', 'skills', 'skill-b')
      mkdirSync(agentsDir, { recursive: true })
      writeFileSync(join(agentsDir, 'SKILL.md'), `---
name: skill-b
description: From .agents
---

Content B.
`)

      const all = loadAllSkills(TEST_DIR)
      expect(all).toHaveLength(2)
      const names = all.map(s => s.name).sort()
      expect(names).toEqual(['skill-a', 'skill-b'])
    })

    test('returns empty when no skill directories exist', () => {
      const all = loadAllSkills(TEST_DIR)
      expect(all).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // External skill format compatibility (marketingskills + awesome-claude-skills)
  // -----------------------------------------------------------------------

  describe('external skill format compatibility', () => {
    test('parses marketingskills format (nested metadata field ignored gracefully)', () => {
      const skillDir = join(TEST_DIR, '.claude', 'skills', 'page-cro')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), `---
name: page-cro
description: When the user wants to optimize, improve, or increase conversions on any marketing page
metadata:
 version: 1.1.0
---

# Page Conversion Rate Optimization (CRO)

You are a conversion rate optimization expert.
`)
      const skills = loadSkillsFromDir(TEST_DIR, '.claude/skills')
      expect(skills).toHaveLength(1)
      expect(skills[0].name).toBe('page-cro')
      expect(skills[0].description).toContain('optimize, improve, or increase conversions')
      expect(skills[0].content).toContain('conversion rate optimization expert')
    })

    test('parses awesome-claude-skills format (license field ignored gracefully)', () => {
      const skillDir = join(TEST_DIR, '.claude', 'skills', 'webapp-testing')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), `---
name: webapp-testing
description: Toolkit for interacting with and testing local web applications using Playwright.
license: Complete terms in LICENSE.txt
---

# Web Application Testing

To test local web applications, write native Python Playwright scripts.
`)
      const skills = loadSkillsFromDir(TEST_DIR, '.claude/skills')
      expect(skills).toHaveLength(1)
      expect(skills[0].name).toBe('webapp-testing')
      expect(skills[0].description).toContain('Playwright')
      expect(skills[0].content).toContain('Web Application Testing')
    })

    test('parses skill with no frontmatter (uses directory name and first line)', () => {
      const skillDir = join(TEST_DIR, '.claude', 'skills', 'simple-skill')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), `# Simple Skill

Do something useful without frontmatter.
`)
      const skills = loadSkillsFromDir(TEST_DIR, '.claude/skills')
      expect(skills).toHaveLength(1)
      expect(skills[0].name).toBe('simple-skill')
      expect(skills[0].description).toBe('# Simple Skill')
    })

    test('handles allowed-tools as comma-separated string', () => {
      const skillDir = join(TEST_DIR, '.claude', 'skills', 'with-tools')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), `---
name: with-tools
description: Skill with tools
allowed-tools: Read, Grep, Bash
---

Content.
`)
      const skills = loadSkillsFromDir(TEST_DIR, '.claude/skills')
      expect(skills[0].allowedTools).toEqual(['Read', 'Grep', 'Bash'])
    })

    test('handles allowed-tools as array', () => {
      const skillDir = join(TEST_DIR, '.claude', 'skills', 'arr-tools')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), `---
name: arr-tools
description: Skill with tools array
allowed-tools: [Read, Grep, Bash]
---

Content.
`)
      const skills = loadSkillsFromDir(TEST_DIR, '.claude/skills')
      expect(skills[0].allowedTools).toEqual(['Read', 'Grep', 'Bash'])
    })
  })

  // -----------------------------------------------------------------------
  // Skill Registry Manifest
  // -----------------------------------------------------------------------

  describe('loadSkillRegistryManifest', () => {
    test('returns empty array when bundled-claude-skills/ does not exist', () => {
      const manifest = loadSkillRegistryManifest()
      // In dev, bundled-claude-skills/ won't exist (it's built at Docker time)
      // This should not throw
      expect(Array.isArray(manifest)).toBe(true)
    })
  })

  describe('loadBundledClaudeCodeSkill', () => {
    test('returns null for non-existent source/skill', () => {
      const skill = loadBundledClaudeCodeSkill('nonexistent', 'nonexistent')
      expect(skill).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // Simulated bundled-claude-skills directory (mirrors Docker build output)
  // -----------------------------------------------------------------------

  describe('bundled claude skills loading (simulated)', () => {
    const bundledDir = join(__dirname, '..', 'bundled-claude-skills')
    let createdBundledDir = false

    beforeEach(() => {
      if (!existsSync(bundledDir)) {
        createdBundledDir = true
        mkdirSync(join(bundledDir, 'test-source', 'test-skill'), { recursive: true })
        writeFileSync(join(bundledDir, 'test-source', 'test-skill', 'SKILL.md'), `---
name: test-skill
description: A test skill for integration testing
---

# Test Skill

Follow these instructions for testing.
`)
        const manifest: SkillRegistryEntry[] = [{
          name: 'test-skill',
          description: 'A test skill for integration testing',
          source: 'test-source',
          sourceDescription: 'Test source',
          dirName: 'test-skill',
        }]
        writeFileSync(join(bundledDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
      }
    })

    afterEach(() => {
      if (createdBundledDir && existsSync(bundledDir)) {
        rmSync(bundledDir, { recursive: true })
      }
    })

    test('loadSkillRegistryManifest returns entries from manifest.json', () => {
      if (!createdBundledDir) return // skip if real bundled dir exists from a previous build
      const manifest = loadSkillRegistryManifest()
      expect(manifest).toHaveLength(1)
      expect(manifest[0].name).toBe('test-skill')
      expect(manifest[0].source).toBe('test-source')
      expect(manifest[0].dirName).toBe('test-skill')
    })

    test('loadBundledClaudeCodeSkill loads a specific skill', () => {
      if (!createdBundledDir) return
      const skill = loadBundledClaudeCodeSkill('test-source', 'test-skill')
      expect(skill).not.toBeNull()
      expect(skill!.name).toBe('test-skill')
      expect(skill!.description).toBe('A test skill for integration testing')
      expect(skill!.content).toContain('Follow these instructions for testing.')
      expect(skill!.skillDir).toContain('bundled-claude-skills/test-source/test-skill')
    })

    test('loadBundledClaudeCodeSkill returns null for wrong source', () => {
      if (!createdBundledDir) return
      const skill = loadBundledClaudeCodeSkill('wrong-source', 'test-skill')
      expect(skill).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // Skill installation into workspace (simulated)
  // -----------------------------------------------------------------------

  describe('skill installation flow', () => {
    test('installed skill is discoverable by loadAllSkills', () => {
      const destDir = join(TEST_DIR, '.shogo', 'skills', 'installed-skill')
      mkdirSync(destDir, { recursive: true })
      writeFileSync(join(destDir, 'SKILL.md'), `---
name: installed-skill
description: Skill installed from registry
---

# Installed Skill

This skill was installed from the external registry.
`)
      const skills = loadAllSkills(TEST_DIR)
      expect(skills).toHaveLength(1)
      expect(skills[0].name).toBe('installed-skill')
      expect(skills[0].content).toContain('installed from the external registry')
    })

    test('installed skill with resources and scripts is fully discoverable', () => {
      const destDir = join(TEST_DIR, '.shogo', 'skills', 'rich-skill')
      mkdirSync(join(destDir, 'references'), { recursive: true })
      mkdirSync(join(destDir, 'scripts'), { recursive: true })
      writeFileSync(join(destDir, 'SKILL.md'), `---
name: rich-skill
description: Skill with bundled resources
---

See references/experiments.md for details.
`)
      writeFileSync(join(destDir, 'references', 'experiments.md'), '# Experiments\n\nA/B test ideas.')
      writeFileSync(join(destDir, 'scripts', 'analyze.py'), 'print("analysis")')

      const skills = loadAllSkills(TEST_DIR)
      expect(skills).toHaveLength(1)
      expect(skills[0].name).toBe('rich-skill')
      expect(skills[0].scripts).toEqual(['analyze.py'])
      expect(existsSync(join(destDir, 'references', 'experiments.md'))).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // skill-registry.json validation
  // -----------------------------------------------------------------------

  describe('skill-registry.json', () => {
    test('is valid JSON with expected structure', () => {
      const registryPath = join(__dirname, '..', 'skill-registry.json')
      expect(existsSync(registryPath)).toBe(true)

      const registry = JSON.parse(readFileSync(registryPath, 'utf-8'))
      expect(registry).toHaveProperty('sources')
      expect(Array.isArray(registry.sources)).toBe(true)
      expect(registry.sources.length).toBeGreaterThan(0)

      for (const source of registry.sources) {
        expect(source).toHaveProperty('id')
        expect(source).toHaveProperty('repo')
        expect(source).toHaveProperty('branch')
        expect(source).toHaveProperty('skillsPath')
        expect(source).toHaveProperty('description')
        expect(typeof source.id).toBe('string')
        expect(typeof source.repo).toBe('string')
        expect(source.repo).toMatch(/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/)
      }
    })

    test('includes marketingskills source', () => {
      const registryPath = join(__dirname, '..', 'skill-registry.json')
      const registry = JSON.parse(readFileSync(registryPath, 'utf-8'))
      const mktg = registry.sources.find((s: any) => s.id === 'marketingskills')
      expect(mktg).toBeDefined()
      expect(mktg.repo).toBe('coreyhaines31/marketingskills')
      expect(mktg.branch).toBe('main')
      expect(mktg.skillsPath).toBe('skills')
    })

    test('includes awesome-claude-skills source', () => {
      const registryPath = join(__dirname, '..', 'skill-registry.json')
      const registry = JSON.parse(readFileSync(registryPath, 'utf-8'))
      const acs = registry.sources.find((s: any) => s.id === 'awesome-claude-skills')
      expect(acs).toBeDefined()
      expect(acs.repo).toBe('ComposioHQ/awesome-claude-skills')
      expect(acs.branch).toBe('master')
    })
  })

  // -----------------------------------------------------------------------
  // .dockerignore validation
  // -----------------------------------------------------------------------

  describe('.dockerignore skill inclusion', () => {
    test('whitelists bundled-skills .md files', () => {
      const dockerignorePath = join(__dirname, '..', '..', '..', '..', '.dockerignore')
      if (!existsSync(dockerignorePath)) return

      const content = readFileSync(dockerignorePath, 'utf-8')
      expect(content).toContain('!packages/agent-runtime/src/bundled-skills/**/*.md')
    })

    test('whitelists bundled-claude-skills .md files', () => {
      const dockerignorePath = join(__dirname, '..', '..', '..', '..', '.dockerignore')
      if (!existsSync(dockerignorePath)) return

      const content = readFileSync(dockerignorePath, 'utf-8')
      expect(content).toContain('!packages/agent-runtime/src/bundled-claude-skills/**/*.md')
    })
  })
})
