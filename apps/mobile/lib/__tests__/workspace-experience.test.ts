import { beforeEach, describe, expect, test } from 'bun:test'
import { clearActiveWorkspaceId, getCachedWorkspaceKind, setActiveWorkspaceId } from '../workspace-store'
import { deriveWorkspaceExperience } from '../workspace-experience'

beforeEach(() => {
  localStorage.clear()
  clearActiveWorkspaceId()
})

describe('deriveWorkspaceExperience', () => {
  test('is unresolved when no workspace is loaded and nothing is cached', () => {
    const experience = deriveWorkspaceExperience(null, null)
    expect(experience.resolved).toBe(false)
    expect(experience.showProjectsTree).toBe(false)
    expect(experience.showGoalsNav).toBe(false)
    expect(experience.showMarketplace).toBe(false)
    expect(experience.showNewChat).toBe(false)
  })

  test('uses the cached kind before the collection loads', () => {
    const experience = deriveWorkspaceExperience(null, 'personal')
    expect(experience.resolved).toBe(true)
    expect(experience.kind).toBe('personal')
    expect(experience.homeScreen).toBe('companion')
    expect(experience.showProjectsTree).toBe(false)
  })

  test('resolves from the loaded workspace and remembers its kind', () => {
    const loaded = deriveWorkspaceExperience({ id: 'ws-team', kind: 'team' }, null)
    expect(loaded.resolved).toBe(true)
    expect(loaded.kind).toBe('team')
    expect(loaded.showProjectsTree).toBe(true)
    expect(loaded.homeScreen).toBe('builder')
    setActiveWorkspaceId('ws-team')
    expect(getCachedWorkspaceKind('ws-team')).toBe('team')
    const cached = deriveWorkspaceExperience(null, getCachedWorkspaceKind('ws-team'))
    expect(cached.resolved).toBe(true)
    expect(cached.kind).toBe('team')
  })
})
