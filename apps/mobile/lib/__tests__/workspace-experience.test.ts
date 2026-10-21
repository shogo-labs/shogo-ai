import { beforeEach, describe, expect, test } from 'bun:test'
import { clearActiveWorkspaceId, getCachedWorkspaceKind, setActiveWorkspaceId } from '../workspace-store'
import { deriveWorkspaceExperience, machineWorkspaceKindKey } from '../workspace-experience'

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

// ─── A paired desktop's own workspace (SHO-87) ──────────────────────────────
//
// Opening Samsara (team) from `samasra` while a personal cloud workspace is
// selected must render the team shell — and the reverse. The machine's kind
// wins, and it is remembered against the machine's own workspace id so the
// team shell does not flash personal on the next mount.

describe('deriveWorkspaceExperience in a machine workspace', () => {
  const machine = {
    instanceId: 'inst-1',
    localWorkspaceId: 'lw-samsara',
    kind: 'team',
  }

  test('a team machine workspace was rendering the companion shell on a personal cloud workspace', () => {
    const experience = deriveWorkspaceExperience({ id: 'ws-cloud', kind: 'personal' }, null, machine)
    expect(experience.kind).toBe('team')
    expect(experience.homeScreen).toBe('builder')
    expect(experience.showProjectsTree).toBe(true)
    expect(experience.resolved).toBe(true)
  })

  test('a personal machine workspace wins over a team cloud workspace', () => {
    const experience = deriveWorkspaceExperience({ id: 'ws-cloud', kind: 'team' }, null, {
      ...machine,
      kind: 'personal',
    })
    expect(experience.kind).toBe('personal')
    expect(experience.homeScreen).toBe('companion')
    expect(experience.showProjectsTree).toBe(false)
  })

  test('the machine kind is remembered under its instance and local workspace id', () => {
    deriveWorkspaceExperience({ id: 'ws-cloud', kind: 'personal' }, null, machine)
    expect(getCachedWorkspaceKind(machineWorkspaceKindKey(machine))).toBe('team')
    // Next mount, before the sidebar has handed over a kind again: the cached
    // machine kind keeps the team shell instead of flashing the companion one.
    const remount = deriveWorkspaceExperience({ id: 'ws-cloud', kind: 'personal' }, null, {
      ...machine,
      kind: undefined,
    })
    expect(remount.kind).toBe('team')
  })

  test('a stale selection without a kind falls back to the cloud kind instead of guessing', () => {
    const experience = deriveWorkspaceExperience({ id: 'ws-cloud', kind: 'personal' }, null, {
      ...machine,
      kind: undefined,
    })
    expect(experience.kind).toBe('personal')
  })
})
