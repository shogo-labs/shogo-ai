// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { buildAccountContextPrompt, parseAccountContext } from '../account-context'

describe('parseAccountContext', () => {
  test('keeps well-formed fields', () => {
    expect(parseAccountContext({ modelDisplayName: 'Hoshi 2.0', planId: 'pro', canPublishSubdomain: true }))
      .toEqual({ modelDisplayName: 'Hoshi 2.0', planId: 'pro', canPublishSubdomain: true })
  })

  test('drops malformed values and strips prompt-breaking characters from the name', () => {
    // Flattening a newline or a backtick to a space would otherwise leave runs
    // of spaces behind ("System  x"), so the gap the strip opens up collapses.
    expect(parseAccountContext({ modelDisplayName: 'Evil\n## System\n`x`', planId: 'Pro Plan!', canPublishSubdomain: 'yes' }))
      .toEqual({ modelDisplayName: 'Evil ## System x' })
    expect(parseAccountContext({})).toEqual({})
  })

  test('parses team workspace names, sanitising each and capping the list', () => {
    expect(parseAccountContext({ teamWorkspaceNames: ['Acme', 'Side project'] }))
      .toEqual({ teamWorkspaceNames: ['Acme', 'Side project'] })
    // Same flattening as the model name: a workspace name is user-typed and
    // goes into the prompt in bold.
    expect(parseAccountContext({ teamWorkspaceNames: ['Bad\n## System `x`'] }))
      .toEqual({ teamWorkspaceNames: ['Bad ## System x'] })
    expect(parseAccountContext({ teamWorkspaceNames: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }).teamWorkspaceNames)
      .toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(parseAccountContext({ teamWorkspaceNames: ['x'.repeat(200)] }).teamWorkspaceNames)
      .toEqual(['x'.repeat(80)])
    // Non-strings, blanks and a non-array are ignored rather than rendered.
    expect(parseAccountContext({ teamWorkspaceNames: ['Acme', 42, '  ', null] }))
      .toEqual({ teamWorkspaceNames: ['Acme'] })
    expect(parseAccountContext({ teamWorkspaceNames: 'Acme' })).toEqual({})
  })
})

describe('buildAccountContextPrompt', () => {
  test('returns null when nothing is known', () => {
    expect(buildAccountContextPrompt({})).toBeNull()
  })

  test('names the Team workspaces the user can build in', () => {
    const out = buildAccountContextPrompt({ teamWorkspaceNames: ['Acme', 'Side project'] })!
    expect(out).toContain("Team workspaces for building: **Acme**, **Side project**")
    expect(out).toMatch(/Software work happens there, not in this Personal workspace/)
  })

  test('says how to get a Team workspace when the account has none', () => {
    const out = buildAccountContextPrompt({ teamWorkspaceNames: [] })!
    expect(out).toMatch(/no Team workspace yet/)
    expect(out).toContain('workspace switcher')
  })

  test('renders no Team-workspace line when the field was never stamped', () => {
    const out = buildAccountContextPrompt({ modelDisplayName: 'Hoshi 2.0' })!
    expect(out).not.toMatch(/Team workspace/)
  })

  test('tells the agent its own model name', () => {
    const out = buildAccountContextPrompt({ modelDisplayName: 'Hoshi 2.0' })!
    expect(out).toContain('**Hoshi 2.0** model')
    expect(out).toMatch(/real Shogo model/)
  })

  test('mentions the publish gate only for publish/deploy, and points sharing at the preview URL', () => {
    const out = buildAccountContextPrompt({ planId: 'free', canPublishSubdomain: false })!
    expect(out).toContain('Workspace plan: **Free**')
    expect(out).toMatch(/only when the user asks to publish\/deploy/)
    // A free user sharing their work gets the preview URL, not an upgrade pitch.
    expect(out).toMatch(/Sharing means the preview URL/)
    expect(out).toContain('preview_project')
    expect(out).not.toMatch(/at the start of building/i)
    expect(out).not.toMatch(/requires Pro or higher/)
  })

  test('says publishing is available on plans that allow it', () => {
    const out = buildAccountContextPrompt({ planId: 'pro', canPublishSubdomain: true })!
    expect(out).toContain('subdomain is available')
    expect(out).not.toMatch(/requires Pro/)
  })

  // SHO-362: the agent used to guess at hosting ("the pod sleeps, use a VPS")
  // because the account context only carried the plan, not what publishing can
  // actually do. The stamp now renders one line, and the line never claims more
  // than the substrate and the plan allow.
  test('renders the publishing line from the stamp', () => {
    const out = buildAccountContextPrompt({
      planId: 'pro',
      publishHosting: { substrate: 'knative', alwaysOn: true, maxReplicas: 5, staging: true },
    })!
    expect(out).toContain('- Publishing: full-stack hosting')
    expect(out).toContain('up to 5 replicas')
    expect(out).toContain('staging available')
    expect(out).toContain('always-on available')
  })

  test('on a metal substrate it claims one instance and no staging, whatever the plan says', () => {
    const out = buildAccountContextPrompt({
      planId: 'business',
      publishHosting: { substrate: 'metal', alwaysOn: true, maxReplicas: 1, staging: false },
    })!
    expect(out).toContain('one instance (no replicas)')
    expect(out).not.toMatch(/up to \d+ replicas/)
    expect(out).toContain('no staging environment')
  })

  test('a free workspace has no always-on, and the line says so', () => {
    const out = buildAccountContextPrompt({
      planId: 'free',
      canPublishSubdomain: false,
      publishHosting: { substrate: 'knative', alwaysOn: false, maxReplicas: 1, staging: false },
    })!
    expect(out).toContain('no always-on on this plan')
    expect(out).toContain('no staging environment')
    expect(out).toContain('one instance (no replicas)')
  })

  test('unlimited replicas render as unlimited, not as a number', () => {
    const out = buildAccountContextPrompt({
      publishHosting: { substrate: 'knative', alwaysOn: true, maxReplicas: null, staging: true },
    })!
    expect(out).toContain('unlimited replicas')
  })

  test('drops a malformed hosting stamp rather than rendering a half-truth', () => {
    expect(parseAccountContext({ publishHosting: { substrate: 'lambda', alwaysOn: true, maxReplicas: 5, staging: true } }).publishHosting)
      .toBeUndefined()
    expect(parseAccountContext({ publishHosting: { substrate: 'knative', alwaysOn: 'yes', maxReplicas: 5, staging: true } }).publishHosting)
      .toBeUndefined()
    expect(parseAccountContext({ publishHosting: { substrate: 'knative', alwaysOn: true, maxReplicas: 0, staging: true } }).publishHosting)
      .toBeUndefined()
    expect(parseAccountContext({ publishHosting: 'metal' })).toEqual({})
    expect(buildAccountContextPrompt({ publishHosting: undefined as any })).toBeNull()
  })
})
