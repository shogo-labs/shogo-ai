import { describe, expect, test } from 'bun:test'
import {
  fallbackGenerateProjectName,
  parseTitleResponse,
  shouldPersistGeneratedProjectName,
} from '../title-parse'

describe('parseTitleResponse', () => {
  test('parses valid JSON', () => {
    expect(parseTitleResponse(
      '{"title":"App Development","description":"Build an application."}',
      'build an app',
    )).toEqual({
      name: 'App Development',
      description: 'Build an application.',
      source: 'ai',
    })
  })

  test('parses fenced JSON and ignores surrounding text', () => {
    expect(parseTitleResponse(
      '```json\n{"title":"Recipe Book","description":"Store recipes."}\n```',
      'build a recipe manager',
    ).name).toBe('Recipe Book')
  })

  test('recovers a quoted title from otherwise malformed output', () => {
    expect(parseTitleResponse(
      '{"title": "App Development", description:',
      'build a fintech dashboard',
    )).toEqual({
      name: 'App Development',
      description: '',
      source: 'ai',
    })
  })

  test('does not leak malformed or truncated JSON', () => {
    for (const output of [
      '{title: Build Request, description:',
      '{',
      '{title',
      '',
    ]) {
      const result = parseTitleResponse(output, 'build a metallurgy dashboard')
      expect(result.source).toBe('heuristic')
      expect(result.name.startsWith('{')).toBe(false)
    }
  })

  test('rejects unsafe and overlong titles', () => {
    expect(parseTitleResponse(
      '{"title":"{title: broken","description":"x"}',
      'create a safe title',
    ).source).toBe('heuristic')
    expect(parseTitleResponse(
      `{"title":"${'x'.repeat(51)}","description":"x"}`,
      'create a safe title',
    ).source).toBe('heuristic')
  })
})

describe('fallbackGenerateProjectName', () => {
  test('uses meaningful prompt words', () => {
    expect(fallbackGenerateProjectName('build a metallurgy dashboard')).toBe('Metallurgy Dashboard')
  })

  test('falls back for filler-only prompts', () => {
    expect(fallbackGenerateProjectName('build a simple web app')).toBe('New Project')
  })
})

describe('shouldPersistGeneratedProjectName', () => {
  test('allows renaming a project that still has the placeholder name', () => {
    expect(shouldPersistGeneratedProjectName('New Project')).toBe(true)
  })

  test('allows naming a project with no name yet', () => {
    expect(shouldPersistGeneratedProjectName(null)).toBe(true)
    expect(shouldPersistGeneratedProjectName(undefined)).toBe(true)
    expect(shouldPersistGeneratedProjectName('')).toBe(true)
  })

  test('does not rename a project that already has a real name', () => {
    // Regression test: every "New Chat" / debug thread's first assistant
    // response used to unconditionally overwrite an already-named project's
    // title via `/api/generate-project-name`, even though the client-side
    // guard correctly skipped the local rename.
    expect(shouldPersistGeneratedProjectName('Recipe Book')).toBe(false)
  })
})
