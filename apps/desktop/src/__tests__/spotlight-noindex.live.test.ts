// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-152 acceptance, on a real Mac: the migration must make Spotlight forget
 * the workspaces directory, and it must not break paths into it.
 *
 * The unit suite (`spotlight-exclusion.test.ts`) pins the state machine against
 * temp dirs under `$TMPDIR`, which Spotlight already ignores — so it can prove
 * the file layout but not the point of the card. This test creates a probe data
 * dir where the real one lives (`~/Library/Application Support/Shogo/`), proves
 * the indexer sees a `package.json` inside it, migrates it with the shipped
 * `ensureWorkspacesNoIndex`, and then waits for `mdfind` to come back empty.
 *
 * Opt-in, like the other live suites here (`e2e/local/*-live.test.ts`): it needs
 * a real Mac, a running indexer and up to ~4 minutes, and the repo's isolated
 * runner deliberately points `HOME` at `$TMPDIR`, where Spotlight proves
 * nothing. Run it on the machine you care about:
 *
 *   SHOGO_LIVE_SPOTLIGHT=1 bun test apps/desktop/src/__tests__/spotlight-noindex.live.test.ts
 *
 * Without the flag the file reports 0 tests (skipped), so CI is unaffected.
 * The control poll is the whole point: if Spotlight never indexed the plain dir
 * either, the negative assertion would prove nothing, so the test says so and
 * stops instead of claiming a pass.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureWorkspacesNoIndex } from '../spotlight-exclusion'

const LIVE = process.env.SHOGO_LIVE_SPOTLIGHT === '1'
const IS_DARWIN = process.platform === 'darwin'
const HAS_MDFIND = Boolean(Bun.which('mdfind')) && Boolean(Bun.which('mdimport'))

/** Spotlight's own re-index of a fresh dir is fast; a rename purge takes ~75 s. */
const CONTROL_TIMEOUT_MS = 90_000
const PURGE_TIMEOUT_MS = 120_000
const POLL_INTERVAL_MS = 1_500

function mdfindPackageJson(dir: string): string[] {
  try {
    const out = execFileSync('mdfind', ['-onlyin', dir, '-name', 'package.json'], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    })
    return out.split('\n').filter(Boolean)
  } catch {
    return []
  }
}

async function poll<T>(fn: () => T, done: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = fn()
  while (!done(value) && Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL_MS)
    value = fn()
  }
  return value
}

const live = IS_DARWIN && HAS_MDFIND && LIVE ? describe : describe.skip

live('SHO-152 live Spotlight exclusion (macOS)', () => {
  let probeRoot: string
  let dataDir: string
  let legacyDir: string
  let noIndexDir: string
  let projectId: string
  let packageJsonPath: string
  let controlIndexed = false

  beforeAll(async () => {
    // `os.userInfo()` reads the passwd entry, so the real home survives the
    // test runner's isolated `HOME` (scripts/run-tests-isolated.ts points HOME
    // at $TMPDIR, and `/private/var` is excluded from Spotlight, so a probe
    // there could never prove anything).
    const homeDir = os.userInfo().homedir
    const probeParent = path.join(homeDir, 'Library', 'Application Support', 'Shogo')
    fs.mkdirSync(probeParent, { recursive: true })
    probeRoot = fs.mkdtempSync(path.join(probeParent, 'qa-sho152-probe-'))
    dataDir = path.join(probeRoot, 'data')
    legacyDir = path.join(dataDir, 'workspaces')
    noIndexDir = path.join(dataDir, 'workspaces.noindex')
    projectId = '0b7c1e2d-qa-probe'
    packageJsonPath = path.join(legacyDir, projectId, 'node_modules', 'left-pad', 'package.json')

    fs.mkdirSync(path.dirname(packageJsonPath), { recursive: true })
    fs.writeFileSync(packageJsonPath, '{"name":"left-pad","version":"1.3.0"}\n')
    fs.writeFileSync(path.join(legacyDir, projectId, 'package.json'), '{"name":"probe-project"}\n')

    // Nudge the indexer so the control poll does not depend on FSEvents timing.
    try {
      execFileSync('mdimport', [packageJsonPath], { stdio: 'ignore' })
    } catch {
      /* not fatal: the poll below is the real signal */
    }

    const hits = await poll(
      () => mdfindPackageJson(legacyDir),
      (results) => results.length > 0,
      CONTROL_TIMEOUT_MS,
    )
    controlIndexed = hits.length > 0
  }, CONTROL_TIMEOUT_MS + 30_000)

  afterAll(() => {
    console.log(
      `[SHO-152] control dir indexed: ${controlIndexed} — ` +
        `the purge/regrowth assertions ${controlIndexed ? 'ran' : 'were skipped on this machine'}`,
    )
    if (probeRoot) fs.rmSync(probeRoot, { recursive: true, force: true })
  })

  test('the probe dir is really being indexed before the migration', () => {
    if (!controlIndexed) {
      console.warn(
        '[SHO-152] Spotlight indexed nothing under the probe dir, so the negative ' +
          'assertions below would prove nothing on this machine. Skipping them ' +
          '(indexing is disabled or still busy).',
      )
    }
    expect(fs.existsSync(packageJsonPath)).toBe(true)
    expect(fs.statSync(path.dirname(packageJsonPath)).isDirectory()).toBe(true)
  })

  test(
    'migration renames the dir, leaves a relative symlink, and keeps both paths usable',
    () => {
      const decision = ensureWorkspacesNoIndex(dataDir, { platform: 'darwin', log: () => {} })

      expect(decision.workspacesDir).toBe(noIndexDir)
      expect(decision.excluded).toBe(true)
      expect(decision.migrated).toBe(true)
      expect(decision.blocked).toBeNull()

      expect(fs.lstatSync(legacyDir).isSymbolicLink()).toBe(true)
      expect(fs.readlinkSync(legacyDir)).toBe('workspaces.noindex')
      expect(fs.lstatSync(noIndexDir).isDirectory()).toBe(true)

      // Everything that already holds the old absolute path keeps working: the
      // DB rows, chat history and pty records written before the move.
      const viaLegacy = path.join(legacyDir, projectId, 'node_modules', 'left-pad', 'package.json')
      expect(fs.readFileSync(viaLegacy, 'utf8')).toContain('left-pad')
      expect(fs.readFileSync(packageJsonPath, 'utf8')).toContain('left-pad')
      expect(fs.realpathSync(viaLegacy)).toBe(
        fs.realpathSync(path.join(noIndexDir, projectId, 'node_modules', 'left-pad', 'package.json')),
      )

      // A second launch (or a second caller) must not move anything again.
      const again = ensureWorkspacesNoIndex(dataDir, { platform: 'darwin', log: () => {} })
      expect(again.migrated).toBe(false)
      expect(again.workspacesDir).toBe(noIndexDir)
      expect(again.blocked).toBeNull()
    },
    30_000,
  )

  test(
    'Spotlight purges the directory it already indexed (the card acceptance criterion)',
    async () => {
      if (!controlIndexed) return

      const remaining = await poll(
        () => mdfindPackageJson(noIndexDir),
        (results) => results.length === 0,
        PURGE_TIMEOUT_MS,
      )
      expect(remaining).toEqual([])

      // The back-compat symlink must not hand the entries back either.
      expect(mdfindPackageJson(legacyDir)).toEqual([])
    },
    PURGE_TIMEOUT_MS + 30_000,
  )

  test(
    'a new file written after the migration (what bun install does) stays unindexed',
    async () => {
      if (!controlIndexed) return

      const fresh = path.join(noIndexDir, projectId, 'node_modules', 'fresh-dep', 'package.json')
      fs.mkdirSync(path.dirname(fresh), { recursive: true })
      fs.writeFileSync(fresh, '{"name":"fresh-dep"}\n')
      try {
        execFileSync('mdimport', [fresh], { stdio: 'ignore' })
      } catch {
        /* the poll is the signal */
      }

      // Give the indexer the same window the control poll got.
      await Bun.sleep(CONTROL_TIMEOUT_MS)
      expect(mdfindPackageJson(noIndexDir)).toEqual([])
      expect(fs.readFileSync(fresh, 'utf8')).toContain('fresh-dep')
    },
    CONTROL_TIMEOUT_MS + 60_000,
  )
})
