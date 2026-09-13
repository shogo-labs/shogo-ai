import { describe, expect, test } from 'bun:test'
import { fallbackGenerateProjectName, parseTitleResponse } from '../title-parse'

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
