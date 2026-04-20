// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integration tests for the unified skill system.
 *
 * Tests:
 * - loadSkillsFromDir() filesystem discovery
 * - loadAllSkills() multi-source loading
 * - migrateFromLegacySkills() migration
 * - SKILL.md frontmatter parsing
 * - $ARGUMENTS / $0 / $1 / ${CLAUDE_SKILL_DIR} / ${SKILL_DIR} substitution
 * - buildSkillsPromptSection() budget enforcement + script annotations
 * - skill tool execution (inline + fork + run_script modes)
 * - edit_file, glob, grep, ls, todo_write, ask_user tools
 * - read_file offset/limit support
 * - subagent config resolution
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'fs'
import { join } from 'path'
import {
  loadSkillsFromDir,
  loadAllSkills,
  migrateFromLegacySkills,
  buildSkillsPromptSection,
  matchSkill,
  type Skill,
} from '../skills'
import {
  createTools,
  type ToolContext,
  setLoadedSkills,
  getLoadedSkills,
} from '../gateway-tools'
import {
  getBuiltinSubagentConfig,
  loadCustomAgents,
} from '../subagent'

// Use realpathSync to resolve macOS /tmp → /private/tmp symlink,
// which otherwise breaks assertWithinWorkspace's realpathSync check.
mkdirSync('/tmp/test-claude-skill-compat', { recursive: true })
const TEST_DIR = realpathSync('/tmp/test-claude-skill-compat')

function createCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    },
    projectId: 'test',
    ...overrides,
  }
}

function getTool(ctx: ToolContext, name: string) {
  const tools = createTools(ctx)
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`Tool not found: ${name}`)
  return tool
}

async function exec(ctx: ToolContext, name: string, params: Record<string, any>) {
  const tool = getTool(ctx, name)
  const result = await tool.execute('test-call', params)
  return result.details
}

describe('Unified Skill System', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  // -----------------------------------------------------------------------
  // Skill Loading (.shogo/skills/ primary path)
  // -----------------------------------------------------------------------

  describe('loadSkillsFromDir', () => {
    test('discovers skills from .shogo/skills/<name>/SKILL.md', () => {
      const skillDir = join(TEST_DIR, '.shogo', 'skills', 'deploy-helper')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), `---
name: deploy-helper
description: Helps deploy applications
allowed-tools: Read, Grep, Bash
argument-hint: <environment>
trigger: "deploy|ship it"
---

Deploy the application to $ARGUMENTS environment.

1. Read the deploy config
2. Run the deploy script
`)
      const skills = loadSkillsFromDir(TEST_DIR, '.shogo/skills')
      expect(skills).toHaveLength(1)
      expect(skills[0].name).toBe('deploy-helper')
      expect(skills[0].description).toBe('Helps deploy applications')
      expect(skills[0].allowedTools).toEqual(['Read', 'Grep', 'Bash'])
      expect(skills[0].argumentHint).toBe('<environment>')
      expect(skills[0].trigger).toBe('deploy|ship it')
      expect(skills[0].content).toContain('Deploy the application')
    })

    test('uses directory name as fallback for missing name', () => {
      const skillDir = join(TEST_DIR, '.shogo', 'skills', 'my-skill')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), `---
description: A skill without a name field
---

Do something useful.
`)
      const skills = loadSkillsFromDir(TEST_DIR, '.shogo/skills')
      expect(skills).toHaveLength(1)
      expect(skills[0].name).toBe('my-skill')
    })

    test('parses disable-model-invocation and user-invocable flags', () => {
      const skillDir = join(TEST_DIR, '.shogo', 'skills', 'internal')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), `---
name: internal-only
description: Not for model invocation
disable-model-invocation: true
user-invocable: false
---

Internal instructions.
`)
      const skills = loadSkillsFromDir(TEST_DIR, '.shogo/skills')
      expect(skills[0].disableModelInvocation).toBe(true)
      expect(skills[0].userInvocable).toBe(false)
    })

    test('parses context: fork and agent fields', () => {
      const skillDir = join(TEST_DIR, '.shogo', 'skills', 'forked')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), `---
name: forked-skill
description: Runs in a fork
context: fork
agent: explore
---

Search for patterns.
`)
      const skills = loadSkillsFromDir(TEST_DIR, '.shogo/skills')
      expect(skills[0].context).toBe('fork')
      expect(skills[0].agent).toBe('explore')
    })

    test('parses setup and runtime fields', () => {
      const skillDir = join(TEST_DIR, '.shogo', 'skills', 'scripted')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), `---
name: scripted
description: Skill with scripts
setup: pip install -r requirements.txt
runtime: python3
---

Run scripts.
`)
      const skills = loadSkillsFromDir(TEST_DIR, '.shogo/skills')
      expect(skills[0].setup).toBe('pip install -r requirements.txt')
      expect(skills[0].runtime).toBe('python3')
    })

    test('auto-discovers scripts in scripts/ subdirectory', () => {
      const skillDir = join(TEST_DIR, '.shogo', 'skills', 'with-scripts')
      mkdirSync(join(skillDir, 'scripts'), { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), `---
name: with-scripts
description: Skill with scripts
---

Instructions.
`)
      writeFileSync(join(skillDir, 'scripts', 'score.py'), 'print("hello")')
      writeFileSync(join(skillDir, 'scripts', 'utils.js'), 'module.exports = {}')
      const skills = loadSkillsFromDir(TEST_DIR, '.shogo/skills')
      expect(skills[0].scripts).toEqual(['score.py', 'utils.js'])
    })

    test('returns empty array when directory does not exist', () => {
      const skills = loadSkillsFromDir(TEST_DIR, '.shogo/skills')
      expect(skills).toHaveLength(0)
    })

    test('skips directories without SKILL.md', () => {
      const skillDir = join(TEST_DIR, '.shogo', 'skills', 'incomplete')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'README.md'), '# Not a skill')

      const skills = loadSkillsFromDir(TEST_DIR, '.shogo/skills')
      expect(skills).toHaveLength(0)
    })

    test('loads multiple skills', () => {
      for (const name of ['alpha', 'beta', 'gamma']) {
        const dir = join(TEST_DIR, '.shogo', 'skills', name)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'SKILL.md'), `---
name: ${name}
description: Skill ${name}
---

Instructions for ${name}.
`)
      }
      const skills = loadSkillsFromDir(TEST_DIR, '.shogo/skills')
      expect(skills).toHaveLength(3)
      const names = skills.map(s => s.name).sort()
      expect(names).toEqual(['alpha', 'beta', 'gamma'])
    })
  })

  // -----------------------------------------------------------------------
  // loadAllSkills (multi-source with priority)
  // -----------------------------------------------------------------------

  describe('loadAllSkills', () => {
    test('.shogo/skills/ takes priority over .claude/skills/', () => {
      const shogoDir = join(TEST_DIR, '.shogo', 'skills', 'dup')
      mkdirSync(shogoDir, { recursive: true })
      writeFileSync(join(shogoDir, 'SKILL.md'), `---
name: dup
description: Shogo version
---

Shogo.
`)
      const claudeDir = join(TEST_DIR, '.claude', 'skills', 'dup')
      mkdirSync(claudeDir, { recursive: true })
      writeFileSync(join(claudeDir, 'SKILL.md'), `---
name: dup
description: Claude version
---

Claude.
`)
      const all = loadAllSkills(TEST_DIR)
      expect(all).toHaveLength(1)
      expect(all[0].description).toBe('Shogo version')
    })

    test('merges skills from all sources', () => {
      for (const [path, name] of [
        ['.shogo/skills/s1', 's1'],
        ['.claude/skills/s2', 's2'],
        ['.agents/skills/s3', 's3'],
      ] as const) {
        const dir = join(TEST_DIR, path)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'SKILL.md'), `---
name: ${name}
description: Skill ${name}
---

Content.
`)
      }
      const all = loadAllSkills(TEST_DIR)
      expect(all).toHaveLength(3)
    })
  })

  // -----------------------------------------------------------------------
  // Legacy Migration
  // -----------------------------------------------------------------------

  describe('migrateFromLegacySkills', () => {
    test('migrates skills/*.md to .shogo/skills/<name>/SKILL.md', () => {
      const legacyDir = join(TEST_DIR, 'skills')
      mkdirSync(legacyDir, { recursive: true })
      writeFileSync(join(legacyDir, 'old-skill.md'), `---
name: old-skill
trigger: "old|legacy"
description: A legacy skill
---

Old instructions.
`)
      migrateFromLegacySkills(TEST_DIR)

      expect(existsSync(join(TEST_DIR, '.shogo', 'skills', 'old-skill', 'SKILL.md'))).toBe(true)
      const content = readFileSync(join(TEST_DIR, '.shogo', 'skills', 'old-skill', 'SKILL.md'), 'utf-8')
      expect(content).toContain('old-skill')
    })

    test('does not migrate if .shogo/skills/ already exists', () => {
      mkdirSync(join(TEST_DIR, '.shogo', 'skills'), { recursive: true })
      mkdirSync(join(TEST_DIR, 'skills'), { recursive: true })
      writeFileSync(join(TEST_DIR, 'skills', 'should-skip.md'), 'content')

      migrateFromLegacySkills(TEST_DIR)
      expect(existsSync(join(TEST_DIR, '.shogo', 'skills', 'should-skip'))).toBe(false)
    })

    test('does nothing when skills/ does not exist', () => {
      migrateFromLegacySkills(TEST_DIR)
      expect(existsSync(join(TEST_DIR, '.shogo', 'skills'))).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // Trigger Matching
  // -----------------------------------------------------------------------

  describe('matchSkill', () => {
    test('matches skill by trigger phrase', () => {
      const skills: Skill[] = [{
        name: 'test',
        description: 'Test',
        content: '',
        skillDir: '',
        trigger: 'hello|hi there',
        disableModelInvocation: false,
        userInvocable: true,
      }]
      expect(matchSkill(skills, 'say hello to me')).not.toBeNull()
      expect(matchSkill(skills, 'hi there friend')).not.toBeNull()
      expect(matchSkill(skills, 'goodbye')).toBeNull()
    })

    test('skips skills without trigger', () => {
      const skills: Skill[] = [{
        name: 'no-trigger',
        description: 'No trigger',
        content: '',
        skillDir: '',
        disableModelInvocation: false,
        userInvocable: true,
      }]
      expect(matchSkill(skills, 'anything')).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // Skill Prompt Section
  // -----------------------------------------------------------------------

  describe('buildSkillsPromptSection', () => {
    test('generates markdown listing of invocable skills', () => {
      const skills: Skill[] = [
        {
          name: 'test-skill',
          description: 'Does testing',
          content: 'Instructions',
          skillDir: '/tmp/skills/test-skill',
          disableModelInvocation: false,
          userInvocable: true,
          argumentHint: '<file>',
        },
      ]
      const section = buildSkillsPromptSection(skills)
      expect(section).toContain('## Available Skills')
      expect(section).toContain('test-skill')
      expect(section).toContain('Does testing')
      expect(section).toContain('(args: <file>)')
    })

    test('excludes skills with disable-model-invocation: true', () => {
      const skills: Skill[] = [
        {
          name: 'visible',
          description: 'Visible',
          content: '',
          skillDir: '',
          disableModelInvocation: false,
          userInvocable: true,
        },
        {
          name: 'hidden',
          description: 'Hidden',
          content: '',
          skillDir: '',
          disableModelInvocation: true,
          userInvocable: true,
        },
      ]
      const section = buildSkillsPromptSection(skills)
      expect(section).toContain('visible')
      expect(section).not.toContain('hidden')
    })

    test('returns empty string when no invocable skills', () => {
      const skills: Skill[] = [
        {
          name: 'hidden',
          description: 'Hidden',
          content: '',
          skillDir: '',
          disableModelInvocation: true,
          userInvocable: true,
        },
      ]
      const section = buildSkillsPromptSection(skills)
      expect(section).toBe('')
    })

    test('respects character budget', () => {
      const skills: Skill[] = Array.from({ length: 100 }, (_, i) => ({
        name: `skill-${i}`,
        description: 'A'.repeat(200),
        content: '',
        skillDir: '',
        disableModelInvocation: false,
        userInvocable: true,
      }))
      const section = buildSkillsPromptSection(skills, 500)
      expect(section.length).toBeLessThanOrEqual(550)
    })

    test('annotates skills with scripts', () => {
      const skills: Skill[] = [
        {
          name: 'scripted-skill',
          description: 'Has scripts',
          content: '',
          skillDir: '',
          disableModelInvocation: false,
          userInvocable: true,
          scripts: ['score.py', 'utils.js'],
        },
      ]
      const section = buildSkillsPromptSection(skills)
      expect(section).toContain('[scripts: score.py, utils.js]')
    })
  })

  // -----------------------------------------------------------------------
  // Skill Tool (inline mode)
  // -----------------------------------------------------------------------

  describe('skill tool', () => {
    test('returns error for unknown skill', async () => {
      setLoadedSkills([])
      const ctx = createCtx()
      const result = await exec(ctx, 'skill', { skill: 'nonexistent' })
      expect(result.error).toContain('not found')
    })

    test('returns content for inline skill', async () => {
      setLoadedSkills([{
        name: 'inline-test',
        description: 'Test skill',
        content: 'Follow these instructions carefully.',
        skillDir: '/tmp/test-skills/inline-test',
        disableModelInvocation: false,
        userInvocable: true,
      }])
      const ctx = createCtx()
      const result = await exec(ctx, 'skill', { skill: 'inline-test' })
      expect(result.mode).toBe('inline')
      expect(result.content).toContain('Follow these instructions carefully.')
    })

    test('substitutes $ARGUMENTS in skill content', async () => {
      setLoadedSkills([{
        name: 'greet',
        description: 'Greeting skill',
        content: 'Say hello to $ARGUMENTS in a friendly way.',
        skillDir: '/tmp/test-skills/greet',
        disableModelInvocation: false,
        userInvocable: true,
      }])
      const ctx = createCtx()
      const result = await exec(ctx, 'skill', { skill: 'greet', args: 'Alex' })
      expect(result.content).toContain('Say hello to Alex')
    })

    test('substitutes positional $0, $1 arguments', async () => {
      setLoadedSkills([{
        name: 'refactor',
        description: 'Refactoring skill',
        content: 'Rename $0 to $1 across the codebase.',
        skillDir: '/tmp/test-skills/refactor',
        disableModelInvocation: false,
        userInvocable: true,
      }])
      const ctx = createCtx()
      const result = await exec(ctx, 'skill', { skill: 'refactor', args: 'oldName newName' })
      expect(result.content).toContain('Rename oldName to newName')
    })

    test('substitutes ${CLAUDE_SKILL_DIR} and ${SKILL_DIR}', async () => {
      setLoadedSkills([{
        name: 'templates',
        description: 'Template skill',
        content: 'Copy templates from ${SKILL_DIR}/templates/ to the project.',
        skillDir: '/tmp/test-skills/templates',
        disableModelInvocation: false,
        userInvocable: true,
      }])
      const ctx = createCtx()
      const result = await exec(ctx, 'skill', { skill: 'templates' })
      expect(result.content).toContain('/tmp/test-skills/templates/templates/')
    })

    test('clears unmatched $ARGUMENTS when no args provided', async () => {
      setLoadedSkills([{
        name: 'optional-args',
        description: 'Skill with optional args',
        content: 'Do work on $ARGUMENTS files.',
        skillDir: '/tmp/test-skills/optional-args',
        disableModelInvocation: false,
        userInvocable: true,
      }])
      const ctx = createCtx()
      const result = await exec(ctx, 'skill', { skill: 'optional-args' })
      expect(result.content).toBe('Do work on  files.')
    })
  })

  // -----------------------------------------------------------------------
  // New Developer Tools
  // -----------------------------------------------------------------------

  describe('edit_file', () => {
    test('replaces unique occurrence', async () => {
      writeFileSync(join(TEST_DIR, 'src.ts'), 'const x = 1;\nconst y = 2;\n')
      const ctx = createCtx()
      const result = await exec(ctx, 'edit_file', {
        path: 'src.ts',
        old_string: 'const x = 1;',
        new_string: 'const x = 42;',
      })
      expect(result.ok).toBe(true)
      expect(result.replacements).toBe(1)
      const content = readFileSync(join(TEST_DIR, 'src.ts'), 'utf-8')
      expect(content).toContain('const x = 42;')
      expect(content).toContain('const y = 2;')
    })

    test('errors on non-unique match without replace_all', async () => {
      writeFileSync(join(TEST_DIR, 'dup.ts'), 'foo\nfoo\nbar\n')
      const ctx = createCtx()
      const result = await exec(ctx, 'edit_file', {
        path: 'dup.ts',
        old_string: 'foo',
        new_string: 'baz',
      })
      expect(result.error).toContain('2 times')
    })

    test('replace_all replaces all occurrences', async () => {
      writeFileSync(join(TEST_DIR, 'multi.ts'), 'foo\nfoo\nbar\n')
      const ctx = createCtx()
      const result = await exec(ctx, 'edit_file', {
        path: 'multi.ts',
        old_string: 'foo',
        new_string: 'baz',
        replace_all: true,
      })
      expect(result.ok).toBe(true)
      expect(result.replacements).toBe(2)
      expect(readFileSync(join(TEST_DIR, 'multi.ts'), 'utf-8')).toBe('baz\nbaz\nbar\n')
    })

    test('errors when old_string not found', async () => {
      writeFileSync(join(TEST_DIR, 'nope.ts'), 'hello world')
      const ctx = createCtx()
      const result = await exec(ctx, 'edit_file', {
        path: 'nope.ts',
        old_string: 'goodbye',
        new_string: 'hi',
      })
      expect(result.error).toContain('not found')
    })

    test('errors when old_string equals new_string', async () => {
      writeFileSync(join(TEST_DIR, 'same.ts'), 'hello')
      const ctx = createCtx()
      const result = await exec(ctx, 'edit_file', {
        path: 'same.ts',
        old_string: 'hello',
        new_string: 'hello',
      })
      expect(result.error).toContain('must differ')
    })
  })

  describe('glob', () => {
    test('finds files matching pattern', async () => {
      mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
      writeFileSync(join(TEST_DIR, 'src', 'index.ts'), '')
      writeFileSync(join(TEST_DIR, 'src', 'utils.ts'), '')
      writeFileSync(join(TEST_DIR, 'readme.md'), '')

      const ctx = createCtx()
      const result = await exec(ctx, 'glob', { pattern: '**/*.ts' })
      expect(result.count).toBe(2)
      expect(result.files).toContain('src/index.ts')
      expect(result.files).toContain('src/utils.ts')
    })

    test('respects path parameter', async () => {
      mkdirSync(join(TEST_DIR, 'a'), { recursive: true })
      mkdirSync(join(TEST_DIR, 'b'), { recursive: true })
      writeFileSync(join(TEST_DIR, 'a', 'file.ts'), '')
      writeFileSync(join(TEST_DIR, 'b', 'file.ts'), '')

      const ctx = createCtx()
      const result = await exec(ctx, 'glob', { pattern: '*.ts', path: 'a' })
      expect(result.count).toBe(1)
      expect(result.files).toContain('file.ts')
    })

    test('returns empty for no matches', async () => {
      const ctx = createCtx()
      const result = await exec(ctx, 'glob', { pattern: '**/*.xyz' })
      expect(result.count).toBe(0)
    })
  })

  describe('grep', () => {
    test('finds pattern in files', async () => {
      writeFileSync(join(TEST_DIR, 'code.ts'), 'function hello() {\n  return "world";\n}\n')
      const ctx = createCtx()
      const result = await exec(ctx, 'grep', { pattern: 'hello', path: 'code.ts' })
      expect(result.count).toBeGreaterThan(0)
      expect(result.matches[0].text).toContain('hello')
    })

    test('returns empty for no matches', async () => {
      writeFileSync(join(TEST_DIR, 'empty.ts'), 'nothing here')
      const ctx = createCtx()
      const result = await exec(ctx, 'grep', { pattern: 'zzzznotfound', path: 'empty.ts' })
      expect(result.count).toBe(0)
    })
  })

  describe('ls', () => {
    test('lists workspace root', async () => {
      writeFileSync(join(TEST_DIR, 'a.txt'), '')
      mkdirSync(join(TEST_DIR, 'subdir'), { recursive: true })
      writeFileSync(join(TEST_DIR, 'subdir', 'b.txt'), '')

      const ctx = createCtx()
      const result = await exec(ctx, 'ls', {})
      expect(result.entries.some((e: any) => e.name === 'a.txt')).toBe(true)
      expect(result.entries.some((e: any) => e.name === 'subdir' && e.type === 'directory')).toBe(true)
    })

    test('lists subdirectory', async () => {
      mkdirSync(join(TEST_DIR, 'nested'), { recursive: true })
      writeFileSync(join(TEST_DIR, 'nested', 'file.ts'), '')

      const ctx = createCtx()
      const result = await exec(ctx, 'ls', { path: 'nested' })
      expect(result.entries.some((e: any) => e.name === 'file.ts')).toBe(true)
    })

    test('recursive listing', async () => {
      mkdirSync(join(TEST_DIR, 'deep', 'nested'), { recursive: true })
      writeFileSync(join(TEST_DIR, 'deep', 'a.ts'), '')
      writeFileSync(join(TEST_DIR, 'deep', 'nested', 'b.ts'), '')

      const ctx = createCtx()
      const result = await exec(ctx, 'ls', { path: 'deep', recursive: true })
      expect(result.entries.some((e: any) => e.name === 'b.ts')).toBe(true)
    })

    test('skips node_modules', async () => {
      mkdirSync(join(TEST_DIR, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(join(TEST_DIR, 'node_modules', 'pkg', 'index.js'), '')

      const ctx = createCtx()
      const result = await exec(ctx, 'ls', { recursive: true })
      expect(result.entries.some((e: any) => e.name === 'node_modules')).toBe(false)
    })
  })

  describe('todo_write', () => {
    test('stores and returns todos', async () => {
      const ctx = createCtx()
      const result = await exec(ctx, 'todo_write', {
        todos: [
          { id: '1', content: 'First task', status: 'pending' },
          { id: '2', content: 'Second task', status: 'in_progress' },
        ],
      })
      expect(result.ok).toBe(true)
      expect(result.count).toBe(2)
      expect(result.todos[0].id).toBe('1')
      expect(result.todos[1].status).toBe('in_progress')
    })
  })

  describe('ask_user', () => {
    test('returns questions structure', async () => {
      const ctx = createCtx()
      const result = await exec(ctx, 'ask_user', {
        questions: [{
          id: 'q1',
          prompt: 'Which framework?',
          options: [
            { id: 'react', label: 'React' },
            { id: 'vue', label: 'Vue' },
          ],
        }],
      })
      expect(result.type).toBe('ask_user')
      expect(result.questions).toHaveLength(1)
      expect(result.questions[0].options).toHaveLength(2)
    })
  })

  describe('read_file with offset/limit', () => {
    test('reads full file without offset/limit', async () => {
      writeFileSync(join(TEST_DIR, 'lines.txt'), 'line1\nline2\nline3\nline4\nline5\n')
      const ctx = createCtx()
      const result = await exec(ctx, 'read_file', { path: 'lines.txt' })
      expect(result.content).toBe('line1\nline2\nline3\nline4\nline5\n')
    })

    test('reads partial file with offset and limit', async () => {
      writeFileSync(join(TEST_DIR, 'lines.txt'), 'line1\nline2\nline3\nline4\nline5\n')
      const ctx = createCtx()
      const result = await exec(ctx, 'read_file', { path: 'lines.txt', offset: 2, limit: 2 })
      expect(result.totalLines).toBe(6) // 5 lines + trailing empty
      expect(result.startLine).toBe(2)
      expect(result.endLine).toBe(3)
      expect(result.content).toContain('2|line2')
      expect(result.content).toContain('3|line3')
      expect(result.content).not.toContain('line1')
      expect(result.content).not.toContain('line4')
    })

    test('reads from offset to end when no limit', async () => {
      writeFileSync(join(TEST_DIR, 'lines.txt'), 'a\nb\nc\nd\n')
      const ctx = createCtx()
      const result = await exec(ctx, 'read_file', { path: 'lines.txt', offset: 3 })
      expect(result.content).toContain('3|c')
      expect(result.content).toContain('4|d')
      expect(result.content).not.toContain('1|a')
    })
  })

  // -----------------------------------------------------------------------
  // Subagent Config Resolution
  // -----------------------------------------------------------------------

  describe('subagent configs', () => {
    test('code_agent is no longer a builtin subagent', () => {
      const ctx = createCtx()
      const tools = createTools(ctx)
      const config = getBuiltinSubagentConfig('code_agent', ctx, tools)
      expect(config).toBeNull()
    })

    test('canvas_agent is no longer a builtin subagent', () => {
      const ctx = createCtx()
      const tools = createTools(ctx)
      const config = getBuiltinSubagentConfig('canvas_agent', ctx, tools)
      expect(config).toBeNull()
    })

    test('explore agent is read-only with haiku model', () => {
      const ctx = createCtx()
      const tools = createTools(ctx)
      const config = getBuiltinSubagentConfig('explore', ctx, tools)
      expect(config).not.toBeNull()
      expect(config!.model).toBe('claude-haiku-4-5')
      expect(config!.maxTurns).toBe(5)
      expect(config!.toolNames).toContain('read_file')
      expect(config!.toolNames).toContain('glob')
      expect(config!.toolNames).not.toContain('write_file')
      expect(config!.toolNames).not.toContain('exec')
    })

    test('general-purpose disallows task and code_agent', () => {
      const ctx = createCtx()
      const tools = createTools(ctx)
      const config = getBuiltinSubagentConfig('general-purpose', ctx, tools)
      expect(config).not.toBeNull()
      expect(config!.disallowedTools).toContain('task')
      expect(config!.disallowedTools).toContain('code_agent')
    })

    test('unknown agent returns null', () => {
      const ctx = createCtx()
      const tools = createTools(ctx)
      const config = getBuiltinSubagentConfig('unknown-type', ctx, tools)
      expect(config).toBeNull()
    })

    test('browser_qa agent is canvas-first with browser + web + file tools and gpt-5.4-nano model', () => {
      const ctx = createCtx()
      const tools = createTools(ctx)
      const config = getBuiltinSubagentConfig('browser_qa', ctx, tools)
      expect(config).not.toBeNull()
      expect(config!.name).toBe('browser_qa')
      expect(config!.model).toBe('gpt-5.4-nano')
      expect(config!.provider).toBe('openai')
      expect(config!.maxTurns).toBeUndefined()
      expect(config!.toolNames).toEqual(['browser', 'web', 'read_file', 'write_file', 'edit_file'])
      expect(config!.disallowedTools).toContain('task')
      expect(config!.disallowedTools).toContain('skill')
      expect(config!.systemPrompt).toContain('QA engineer')
      expect(config!.systemPrompt).toContain('timing and UX')
      expect(config!.systemPrompt).toContain('NEED_URL')
      // Canvas-first markers
      expect(config!.systemPrompt).toContain('canvas/src/surfaces/QaRun.data.json')
      expect(config!.systemPrompt).toContain('canvas/src/surfaces/QaRun.tsx')
      expect(config!.systemPrompt).toContain('canvas/src/App.tsx')
      expect(config!.systemPrompt).toContain('live view')
      // Markdown fallback still required
      expect(config!.systemPrompt).toContain('.shogo/reports/qa-')
    })
  })

  // -----------------------------------------------------------------------
  // Custom Agent Loader
  // -----------------------------------------------------------------------

  describe('custom agents', () => {
    test('loads .shogo/agents/<name>.md files', () => {
      const agentsDir = join(TEST_DIR, '.shogo', 'agents')
      mkdirSync(agentsDir, { recursive: true })
      writeFileSync(join(agentsDir, 'reviewer.md'), `---
name: reviewer
description: Code review agent
tools: [read_file, grep, glob]
model: claude-haiku-4-5
maxTurns: 5
---

You are a code reviewer. Read the code and provide feedback.
Focus on:
- Code quality
- Potential bugs
- Performance issues
`)
      const agents = loadCustomAgents(TEST_DIR)
      expect(agents).toHaveLength(1)
      expect(agents[0].name).toBe('reviewer')
      expect(agents[0].description).toBe('Code review agent')
      expect(agents[0].tools).toEqual(['read_file', 'grep', 'glob'])
      expect(agents[0].model).toBe('claude-haiku-4-5')
      expect(agents[0].maxTurns).toBe(5)
      expect(agents[0].systemPrompt).toContain('code reviewer')
    })

    test('returns empty when .shogo/agents/ does not exist', () => {
      const agents = loadCustomAgents(TEST_DIR)
      expect(agents).toHaveLength(0)
    })

    test('skips agents without name or description', () => {
      const agentsDir = join(TEST_DIR, '.shogo', 'agents')
      mkdirSync(agentsDir, { recursive: true })
      writeFileSync(join(agentsDir, 'incomplete.md'), `---
name: incomplete
---

Missing description.
`)
      const agents = loadCustomAgents(TEST_DIR)
      expect(agents).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // Tool Registration
  // -----------------------------------------------------------------------

  describe('tool registration', () => {
    test('all new tools are present in createTools()', () => {
      const ctx = createCtx()
      const tools = createTools(ctx)
      const names = tools.map(t => t.name)
      for (const name of ['edit_file', 'glob', 'grep', 'ls', 'todo_write', 'ask_user', 'task', 'skill']) {
        expect(names).toContain(name)
      }
    })

  })
})
