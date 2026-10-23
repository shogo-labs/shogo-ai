// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHomeWatch, getHomeWatch, homeNotPersistedNote, resetHomeWatch } from '../home-state-watch'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'home-watch-'))
  resetHomeWatch()
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  resetHomeWatch()
})

const mk = (rel: string) => mkdirSync(join(home, rel), { recursive: true })

describe('createHomeWatch', () => {
  test('entries present when primed are the baseline', () => {
    mk('workspace')
    mk('.openart')
    const w = createHomeWatch(home)
    w.prime()
    expect(w.checkNew()).toEqual([])
  })

  test('a new unsaved folder is reported once', () => {
    const w = createHomeWatch(home)
    w.prime()
    mk('.openart')
    expect(w.checkNew()).toEqual(['.openart'])
    expect(w.checkNew()).toEqual([])
  })

  test('persisted paths, caches and shell history are not reported', () => {
    const w = createHomeWatch(home)
    w.prime()
    mk('.config/openart')
    mk('.ssh')
    mk('.cache/x')
    mk('.npm')
    writeFileSync(join(home, '.bash_history'), 'ls')
    writeFileSync(join(home, '.netrc'), 'machine x')
    expect(w.checkNew()).toEqual([])
  })

  test('new children of ~/.local/share and ~/.local/state are reported', () => {
    mk('.local/share/old')
    const w = createHomeWatch(home)
    w.prime()
    mk('.local/share/tool')
    mk('.local/state/other')
    mk('.local/share/pnpm')
    expect(w.checkNew().sort()).toEqual(['.local/share/tool', '.local/state/other'])
  })

  test('the first check without a prime only records the baseline', () => {
    mk('.openart')
    const w = createHomeWatch(home)
    expect(w.checkNew()).toEqual([])
    mk('.later')
    expect(w.checkNew()).toEqual(['.later'])
  })
})

describe('getHomeWatch', () => {
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    SHOGO_DURABILITY_HOST_MEDIATED: '1',
    PROJECT_ID: 'p1',
    HOME_STATE_KEY: randomBytes(32).toString('base64'),
    SHOGO_HOME_STATE_DIR: home,
    ...extra,
  })

  test('off when home persistence is off', () => {
    expect(getHomeWatch(join(home, 'workspace'), env({ HOME_STATE_KEY: '' }))).toBeNull()
    expect(getHomeWatch(join(home, 'workspace'), env({ SHOGO_DURABILITY_HOST_MEDIATED: '' }))).toBeNull()
  })

  test('one watch per process, and the workspace folder under HOME is never reported', () => {
    const w = getHomeWatch(join(home, 'workspace', 'p1'), env())!
    expect(getHomeWatch(join(home, 'workspace', 'p1'), env())).toBe(w)
    w.prime()
    mk('workspace/p1')
    mk('.openart')
    expect(w.checkNew()).toEqual(['.openart'])
  })
})

test('the note names the path and where to move it', () => {
  const note = homeNotPersistedNote(['.openart'])
  expect(note).toContain('~/.openart was created but will NOT be saved')
  expect(note).toContain('~/.config/openart')
  expect(homeNotPersistedNote(['.a', '.local/share/b'])).toContain('~/.a, ~/.local/share/b were created')
})
