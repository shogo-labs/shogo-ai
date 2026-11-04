// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Main-side containment for "Show in Finder" / "Open" on a local share
 * (SHO-302): a path outside the workspaces dir and every folder-linked
 * project root is refused before `shell` sees it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveAllowedLocalFile } from '../local-file-roots'

let root = ''
let outside = ''

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'local-file-roots-')))
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'local-file-roots-outside-')))
  mkdirSync(join(root, 'proj-a', 'out'), { recursive: true })
  writeFileSync(join(root, 'proj-a', 'out', 'report.pdf'), 'pdf')
  writeFileSync(join(outside, 'secret.txt'), 'nope')
  symlinkSync(outside, join(root, 'proj-a', 'escape'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('resolveAllowedLocalFile', () => {
  it('allows a regular file inside a root and returns its real path', () => {
    expect(resolveAllowedLocalFile(join(root, 'proj-a', 'out', 'report.pdf'), [root])).toBe(
      join(root, 'proj-a', 'out', 'report.pdf'),
    )
  })

  it('allows a file inside a second (folder-linked) root', () => {
    expect(resolveAllowedLocalFile(join(outside, 'secret.txt'), [root, outside])).toBe(
      join(outside, 'secret.txt'),
    )
  })

  it('refuses a path outside every root', () => {
    expect(resolveAllowedLocalFile(join(outside, 'secret.txt'), [root])).toBeNull()
  })

  it('refuses a symlink that escapes a root', () => {
    expect(resolveAllowedLocalFile(join(root, 'proj-a', 'escape', 'secret.txt'), [root])).toBeNull()
  })

  it('refuses a directory and a missing file', () => {
    expect(resolveAllowedLocalFile(join(root, 'proj-a'), [root])).toBeNull()
    expect(resolveAllowedLocalFile(join(root, 'nope.pdf'), [root])).toBeNull()
  })

  it('refuses an empty path', () => {
    expect(resolveAllowedLocalFile('', [root])).toBeNull()
  })
})
