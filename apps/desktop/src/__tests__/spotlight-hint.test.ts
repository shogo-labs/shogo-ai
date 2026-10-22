// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-152: the fallback Spotlight hint must appear once, explain the folder,
 * and only open System Settings when the user asks for it.
 */
import { describe, expect, test, mock } from 'bun:test'
import {
  runSpotlightHint,
  spotlightHintDetail,
  spotlightHintReason,
  SPOTLIGHT_HINT_NOT_NOW,
  SPOTLIGHT_HINT_OPEN_SETTINGS,
  type SpotlightHintContext,
} from '../spotlight-hint'

const context: SpotlightHintContext = {
  workspacesDir: '/Users/test/Library/Application Support/Shogo/data/workspaces.noindex',
  blocked: 'rename-failed',
  detail: 'EPERM: operation not permitted, rename',
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  let dismissed = false
  const deps = {
    isDismissed: () => dismissed,
    rememberDismissed: mock(() => {
      dismissed = true
    }),
    openSettings: mock(() => {}),
    ask: mock(async () => 1),
    ...overrides,
  }
  return { deps, isDismissed: () => dismissed }
}

describe('runSpotlightHint', () => {
  test('never asks twice: a remembered dismissal skips the dialog', async () => {
    const { deps } = makeDeps({ isDismissed: () => true })

    expect(await runSpotlightHint(context, deps)).toBe('skipped')
    expect(deps.ask).not.toHaveBeenCalled()
    expect(deps.openSettings).not.toHaveBeenCalled()
  })

  test('first launch asks, then remembers the dismissal', async () => {
    const { deps, isDismissed } = makeDeps()

    expect(await runSpotlightHint(context, deps)).toBe('dismissed')
    expect(deps.ask).toHaveBeenCalledTimes(1)
    expect(isDismissed()).toBe(true)
    expect(deps.openSettings).not.toHaveBeenCalled()
  })

  test('the dialog names the folder and offers the settings button', async () => {
    const { deps } = makeDeps()
    await runSpotlightHint(context, deps)

    const options = (deps.ask as ReturnType<typeof mock>).mock.calls[0][0] as {
      message: string
      detail: string
      buttons: string[]
    }
    expect(options.message).toContain('Spotlight')
    expect(options.message).toContain('CPU')
    expect(options.detail).toContain(context.workspacesDir)
    expect(options.detail).toContain('node_modules')
    expect(options.buttons).toEqual([SPOTLIGHT_HINT_OPEN_SETTINGS, SPOTLIGHT_HINT_NOT_NOW])
  })

  test('"Open Spotlight Settings" opens the pane and still counts as seen', async () => {
    const { deps, isDismissed } = makeDeps({ ask: mock(async () => 0) })

    expect(await runSpotlightHint(context, deps)).toBe('opened-settings')
    expect(deps.openSettings).toHaveBeenCalledTimes(1)
    expect(isDismissed()).toBe(true)
  })

  test('closing the dialog (no display) does not burn the one-and-only showing', async () => {
    const { deps, isDismissed } = makeDeps({
      ask: mock(async () => {
        throw new Error('no display')
      }),
    })

    expect(await runSpotlightHint(context, deps)).toBe('skipped')
    expect(isDismissed()).toBe(false)
  })

  test('a failing openExternal never throws out of the hint', async () => {
    const { deps } = makeDeps({
      ask: mock(async () => 0),
      openSettings: mock(() => {
        throw new Error('no handler')
      }),
    })

    expect(await runSpotlightHint(context, deps)).toBe('opened-settings')
  })
})

describe('spotlightHintDetail', () => {
  test('carries the migration error when there is one', () => {
    expect(spotlightHintDetail(context)).toContain('EPERM')
  })

  test('names the folder to add to the privacy list', () => {
    expect(spotlightHintDetail(context)).toContain(context.workspacesDir)
    expect(spotlightHintDetail(context)).toContain('node_modules')
  })

  test('still reads correctly without a reason', () => {
    const detail = spotlightHintDetail({ workspacesDir: '/data/workspaces', blocked: null })
    expect(detail).toContain('/data/workspaces')
    expect(detail).not.toContain('null')
    expect(detail).not.toContain('undefined')
  })
})

describe('spotlightHintReason', () => {
  test('both-exist explains the leftover folder', () => {
    const reason = spotlightHintReason({
      workspacesDir: '/data/workspaces.noindex',
      blocked: 'both-exist',
      detail: '/data/workspaces',
    })
    expect(reason).toContain('twice')
    expect(reason).toContain('/data/workspaces')
  })

  test('foreign-symlink says the link was left alone', () => {
    const reason = spotlightHintReason({
      workspacesDir: '/data/workspaces',
      blocked: 'foreign-symlink',
      detail: '/Volumes/external/workspaces',
    })
    expect(reason).toContain('/Volumes/external/workspaces')
    expect(reason).toContain('left it alone')
  })

  test('a missing detail never leaks "undefined" into the copy', () => {
    for (const blocked of ['both-exist', 'foreign-symlink', 'rename-failed'] as const) {
      const reason = spotlightHintReason({ workspacesDir: '/data/workspaces', blocked })
      expect(reason).not.toContain('undefined')
    }
  })
})
