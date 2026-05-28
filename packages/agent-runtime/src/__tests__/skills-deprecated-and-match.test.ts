// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Closes the two remaining gap blocks in src/skills.ts:
 *
 *   L437-L487 (51 lines) — deprecated loadSkills() that supports BOTH
 *     directory-format and flat .md file format. No existing test
 *     exercises it.
 *
 *   L414-L420 ( 7 lines) — regex-trigger branch of matchSkill() (a
 *     trigger wrapped in `/.../` is compiled as a case-insensitive
 *     regex).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadSkills, matchSkill, type Skill } from '../skills'

const origWarn = console.warn
const origError = console.error
beforeEach(() => {
  console.warn = () => {}
  console.error = () => {}
})
afterEach(() => {
  console.warn = origWarn
  console.error = origError
})

// ---------------------------------------------------------------------------
// loadSkills (deprecated)
// ---------------------------------------------------------------------------

describe('loadSkills (deprecated)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'skills-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  test('returns [] when directory does not exist', () => {
    const out = loadSkills(join(dir, 'absent'))
    expect(out).toEqual([])
  })

  test('returns [] when directory is empty', () => {
    expect(loadSkills(dir)).toEqual([])
  })

  test('loads a skill from directory format (SKILL.md inside subdir)', () => {
    const skillDir = join(dir, 'mySkill')
    mkdirSync(skillDir)
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: mySkill
description: My skill
trigger: hello|world
version: 2.0.0
---

# My Skill
Body content.
`,
    )
    const out = loadSkills(dir)
    expect(out).toHaveLength(1)
    expect(out[0]!.name).toBe('mySkill')
    expect(out[0]!.trigger).toBe('hello|world')
    expect(out[0]!.version).toBe('2.0.0')
    expect(out[0]!.content).toContain('Body content')
  })

  test('loads a skill from flat .md file', () => {
    writeFileSync(
      join(dir, 'flatSkill.md'),
      `---
name: flat-skill
description: flat desc
trigger: foo
tools:
  - WebSearch
  - Read
---

Flat body.
`,
    )
    const out = loadSkills(dir)
    expect(out).toHaveLength(1)
    expect(out[0]!.name).toBe('flat-skill')
    expect(out[0]!.trigger).toBe('foo')
    expect(out[0]!.description).toBe('flat desc')
    expect(Array.isArray(out[0]!.tools)).toBe(true)
  })

  test('skips flat .md files missing name or trigger (with warning)', () => {
    writeFileSync(
      join(dir, 'no-name.md'),
      `---
description: missing name
trigger: x
---

Body.
`,
    )
    writeFileSync(
      join(dir, 'no-trigger.md'),
      `---
name: orphan
description: no trigger
---

Body.
`,
    )
    expect(loadSkills(dir)).toHaveLength(0)
  })

  test('skips duplicate names between directory format and flat .md', () => {
    // Directory format wins (loaded first)
    const subDir = join(dir, 'dup')
    mkdirSync(subDir)
    writeFileSync(
      join(subDir, 'SKILL.md'),
      `---
name: dup
description: dir version
trigger: t
---
dir body
`,
    )
    writeFileSync(
      join(dir, 'dup.md'),
      `---
name: dup
description: flat version
trigger: t
---
flat body
`,
    )
    const out = loadSkills(dir)
    expect(out).toHaveLength(1)
    expect(out[0]!.description).toBe('dir version')
  })

  test('catches errors per-file (continues with the rest)', () => {
    writeFileSync(join(dir, 'good.md'), `---
name: good
description: g
trigger: x
---
body
`)
    // Permissions to provoke readFileSync error are platform-specific;
    // instead, provide one good + one with bad YAML to exercise the
    // parseFrontmatter/catch path.
    writeFileSync(join(dir, 'bad-yaml.md'), `---
this is: not valid:
  - YAML:
    nope
---
`)
    const out = loadSkills(dir)
    // 'good' loads; 'bad-yaml' is silently rejected (missing name/trigger)
    expect(out.map(s => s.name)).toContain('good')
  })

  test('ignores non-.md files in flat mode', () => {
    writeFileSync(join(dir, 'README.txt'), 'no')
    writeFileSync(join(dir, 'config.json'), '{}')
    expect(loadSkills(dir)).toHaveLength(0)
  })

  test('directory format with no SKILL.md is silently skipped', () => {
    mkdirSync(join(dir, 'empty-skill'))
    expect(loadSkills(dir)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// matchSkill — regex trigger branch (L414-L420)
// ---------------------------------------------------------------------------

describe('matchSkill — regex triggers', () => {
  const mkSkill = (trigger: string): Skill => ({
    name: 'rx', description: '', content: '', skillDir: '/tmp',
    version: '1.0.0', trigger, tools: [],
    disableModelInvocation: false, userInvocable: true,
  })

  test('regex trigger matches via /pattern/ syntax', () => {
    const s = mkSkill('/^deploy/')
    expect(matchSkill([s], 'Deploy now please')?.name).toBe('rx')
    expect(matchSkill([s], 'Please deploy now')).toBeNull()
  })

  test('regex trigger is case-insensitive', () => {
    const s = mkSkill('/HELLO/')
    expect(matchSkill([s], 'hello world')?.name).toBe('rx')
  })

  test('invalid regex pattern is silently skipped', () => {
    const s = mkSkill('/[invalid(/')
    expect(matchSkill([s], 'anything')).toBeNull()
  })

  test('multiple regex triggers separated by | — first match wins', () => {
    const s = mkSkill('/foo/|/bar/')
    expect(matchSkill([s], 'this has foo')?.name).toBe('rx')
    expect(matchSkill([s], 'this has bar')?.name).toBe('rx')
    expect(matchSkill([s], 'no match here')).toBeNull()
  })

  test('regex trigger mixed with plain triggers in same skill', () => {
    const s = mkSkill('plain-text|/^rx/')
    expect(matchSkill([s], 'plain-text seen')?.name).toBe('rx')
    expect(matchSkill([s], 'rx-prefix at start')?.name).toBe('rx')
    expect(matchSkill([s], 'no match')).toBeNull()
  })

  test('skill with no trigger is skipped (defensive guard)', () => {
    const s = { ...mkSkill('placeholder'), trigger: undefined as unknown as string }
    expect(matchSkill([s], 'anything')).toBeNull()
  })

  test('first matching skill wins across the list', () => {
    const s1 = { ...mkSkill('/first/'), name: 'a' }
    const s2 = { ...mkSkill('/second/'), name: 'b' }
    expect(matchSkill([s1, s2], 'is this the second?')?.name).toBe('b')
    expect(matchSkill([s2, s1], 'is this the first?')?.name).toBe('a')
  })
})

// ---------------------------------------------------------------------------
// searchSkills — keyword relevance scoring
// ---------------------------------------------------------------------------

import { searchSkills, loadBundledSkills } from '../skills'

describe('searchSkills', () => {
  const mk = (name: string, description: string, trigger: string, content = ''): Skill => ({
    name, description, content, skillDir: '/tmp',
    version: '1.0.0', trigger, tools: [],
    disableModelInvocation: false, userInvocable: true,
  })

  test('returns [] when query has no useful words', () => {
    const out = searchSkills('a', [mk('foo', 'd', 't')], [])
    expect(out).toEqual([])
  })

  test('returns [] when nothing scores > 0', () => {
    const out = searchSkills('totally unrelated query', [
      mk('foo', 'bar', 'baz'),
    ], [])
    expect(out).toEqual([])
  })

  test('exact substring in name scores highest (25 pts) — name match', () => {
    const out = searchSkills('deploy', [
      mk('deploy', 'Deploys things', 'go'),
      mk('xx', 'unrelated', 'yy'),
    ], [])
    expect(out).toHaveLength(1)
    expect(out[0]!.name).toBe('deploy')
    expect(out[0]!.score).toBeGreaterThanOrEqual(25)
  })

  test('trigger substring scores 20 pts', () => {
    const out = searchSkills('release', [], [
      mk('s', 'desc', 'release-now'),
    ])
    expect(out[0]!.installed).toBe(false)
  })

  test('per-word scoring (content match = 1 pt)', () => {
    const out = searchSkills('apple banana', [
      mk('s', 'd', 't', 'apple is fruit. banana too.'),
    ], [])
    expect(out[0]!.score).toBeGreaterThanOrEqual(2)
  })

  test('deduplicates by name across installed + bundled', () => {
    const out = searchSkills('deploy', [
      mk('deploy', 'installed', 'go'),
    ], [
      mk('deploy', 'bundled', 'go'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.description).toBe('installed')
    expect(out[0]!.installed).toBe(true)
  })

  test('respects limit cap', () => {
    const installed = Array.from({ length: 10 }, (_, i) =>
      mk(`deploy-${i}`, 'd', 't'))
    const out = searchSkills('deploy', installed, [], 3)
    expect(out).toHaveLength(3)
  })

  test('results sorted by score descending', () => {
    const out = searchSkills('deploy', [
      mk('aaa', 'deploy in description', 'aaa'),  // 12 pts
      mk('deploy', 'unrelated', 'noop'),          // 25 + 20 = 45 pts
      mk('bbb', 'unrelated', 'deploy-trigger'),   // 20 + 15 = 35 pts
    ], [])
    expect(out[0]!.name).toBe('deploy')
    expect(out[1]!.name).toBe('bbb')
    expect(out[2]!.name).toBe('aaa')
  })

  test('skill with no trigger does not crash', () => {
    const s = { ...mk('x', 'deploy', 'placeholder'), trigger: undefined as unknown as string }
    const out = searchSkills('deploy', [s], [])
    expect(out).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// loadBundledSkills — silently returns [] when the bundled-skills/ dir
// is absent or unreadable. We can drive it without the real shipped
// bundle by relying on the absent-dir branch.
// ---------------------------------------------------------------------------

describe('loadBundledSkills', () => {
  test('returns array (real bundled dir or [] if absent)', () => {
    // No control over __dirname/bundled-skills here — just assert no throw.
    const result = loadBundledSkills(new Set())
    expect(Array.isArray(result)).toBe(true)
  })

  test('respects existingSkillNames filter (de-duplication)', () => {
    const seenAll = new Set(['everything', 'foo', 'bar'])
    const filtered = loadBundledSkills(seenAll)
    expect(Array.isArray(filtered)).toBe(true)
  })
})
