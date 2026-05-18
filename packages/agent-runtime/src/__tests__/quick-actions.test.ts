// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  loadQuickActions,
  saveQuickActions,
  addQuickAction,
  validateQuickActions,
  buildQuickActionsPromptSection,
} from '../quick-actions'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'qa-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const FILE_REL = '.shogo/quick-actions.json'
const filePath = () => join(dir, FILE_REL)

describe('loadQuickActions', () => {
  it('returns [] when the file does not exist', () => {
    expect(loadQuickActions(dir)).toEqual([])
  })

  it('returns [] when JSON is malformed', () => {
    mkdirSync(join(dir, '.shogo'))
    writeFileSync(filePath(), 'not-json')
    expect(loadQuickActions(dir)).toEqual([])
  })

  it('returns [] when "actions" is missing or not an array', () => {
    mkdirSync(join(dir, '.shogo'))
    writeFileSync(filePath(), JSON.stringify({ actions: 'oops' }))
    expect(loadQuickActions(dir)).toEqual([])
  })

  it('filters out entries with non-string label/prompt', () => {
    mkdirSync(join(dir, '.shogo'))
    writeFileSync(filePath(), JSON.stringify({
      actions: [
        { label: 'Good', prompt: 'do thing' },
        { label: 42, prompt: 'x' },
        { label: 'Bad', prompt: null },
      ],
    }))
    expect(loadQuickActions(dir)).toEqual([{ label: 'Good', prompt: 'do thing' }])
  })
})

describe('saveQuickActions', () => {
  it('creates the parent dir and writes pretty JSON with trailing newline', () => {
    saveQuickActions(dir, [{ label: 'A', prompt: 'p' }])
    expect(existsSync(filePath())).toBe(true)
    const raw = readFileSync(filePath(), 'utf-8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw)).toEqual({ actions: [{ label: 'A', prompt: 'p' }] })
  })

  it('round-trips through loadQuickActions', () => {
    const actions = [{ label: 'A', prompt: 'p' }, { label: 'B', prompt: 'q' }]
    saveQuickActions(dir, actions)
    expect(loadQuickActions(dir)).toEqual(actions)
  })
})

describe('addQuickAction', () => {
  it('appends to an empty store', () => {
    const r = addQuickAction(dir, { label: 'A', prompt: 'p' })
    expect(r.ok).toBe(true)
    expect(r.actions).toEqual([{ label: 'A', prompt: 'p' }])
  })

  it('replaces an existing action with the same label', () => {
    addQuickAction(dir, { label: 'A', prompt: 'old' })
    const r = addQuickAction(dir, { label: 'A', prompt: 'new' })
    expect(r.ok).toBe(true)
    expect(r.actions).toEqual([{ label: 'A', prompt: 'new' }])
  })

  it('rejects (returns existing) when validation fails', () => {
    // First fill the store to 10 actions
    for (let i = 0; i < 10; i++) addQuickAction(dir, { label: `L${i}`, prompt: 'p' })
    const r = addQuickAction(dir, { label: 'L11', prompt: 'p' })
    expect(r.ok).toBe(false)
    expect(r.actions).toHaveLength(10)
    expect(r.errors?.[0]).toMatch(/Too many actions/)
  })

  it('rejects labels over 20 chars', () => {
    const longLabel = 'x'.repeat(21)
    const r = addQuickAction(dir, { label: longLabel, prompt: 'p' })
    expect(r.ok).toBe(false)
    expect(r.errors?.[0]).toMatch(/exceeds 20 characters/)
  })

  it('rejects empty prompt', () => {
    const r = addQuickAction(dir, { label: 'A', prompt: '   ' })
    expect(r.ok).toBe(false)
    expect(r.errors?.[0]).toMatch(/prompt/)
  })
})

describe('validateQuickActions (file-level)', () => {
  it('flags invalid JSON', () => {
    const r = validateQuickActions('{not json')
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/Invalid JSON/)
  })

  it('flags non-object roots (array)', () => {
    const r = validateQuickActions('[]')
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/Root must be an object/)
  })

  it('flags non-object roots (null)', () => {
    const r = validateQuickActions('null')
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/Root must be an object/)
  })

  it('flags unexpected root keys but continues', () => {
    const r = validateQuickActions(JSON.stringify({ actions: [], extra: 1 }))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.includes('Unexpected root key "extra"'))).toBe(true)
  })

  it('flags actions that is not an array', () => {
    const r = validateQuickActions(JSON.stringify({ actions: 'nope' }))
    expect(r.valid).toBe(false)
    expect(r.errors).toContain('"actions" must be an array')
  })

  it('flags non-object entries', () => {
    const r = validateQuickActions(JSON.stringify({ actions: ['x', null] }))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.includes('actions[0]'))).toBe(true)
    expect(r.errors.some((e) => e.includes('actions[1]'))).toBe(true)
  })

  it('flags unexpected fields, missing label, missing prompt', () => {
    const r = validateQuickActions(JSON.stringify({
      actions: [{ label: '', prompt: '', bogus: 1 }],
    }))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.includes('unexpected field "bogus"'))).toBe(true)
    expect(r.errors.some((e) => e.includes('"label" must be a non-empty string'))).toBe(true)
    expect(r.errors.some((e) => e.includes('"prompt" must be a non-empty string'))).toBe(true)
  })

  it('flags duplicate labels', () => {
    const r = validateQuickActions(JSON.stringify({
      actions: [{ label: 'A', prompt: 'p' }, { label: 'A', prompt: 'q' }],
    }))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.includes('duplicate label "A"'))).toBe(true)
  })

  it('accepts a well-formed file', () => {
    const r = validateQuickActions(JSON.stringify({
      actions: [{ label: 'A', prompt: 'do A' }, { label: 'B', prompt: 'do B' }],
    }))
    expect(r.valid).toBe(true)
    expect(r.errors).toEqual([])
  })
})

describe('buildQuickActionsPromptSection', () => {
  it('returns null when no actions are registered', () => {
    expect(buildQuickActionsPromptSection([])).toBeNull()
  })

  it('renders a markdown section listing each action', () => {
    const out = buildQuickActionsPromptSection([
      { label: 'Commit', prompt: 'commit pending' },
      { label: 'Test', prompt: 'run tests' },
    ])
    expect(out).toContain('## Registered Quick Actions')
    expect(out).toContain('- **Commit**: "commit pending"')
    expect(out).toContain('- **Test**: "run tests"')
    expect(out).toContain('Do not re-register actions')
  })
})
