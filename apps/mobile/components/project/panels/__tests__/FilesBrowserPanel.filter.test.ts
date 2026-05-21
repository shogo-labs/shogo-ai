// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for `filterForFilesBrowser`.
 *
 * The function is the client-side filter that keeps the Agent Files panel's
 * curated narrow view stable after the agent-runtime tree endpoint switched
 * to VS Code-style visibility (see packages/agent-runtime/src/server.ts).
 * If the underlying SET changes (e.g. someone adds a new config file the
 * panel shouldn't show), this test will catch a regression in the panel's
 * UX without needing a full Expo render.
 */
import { describe, expect, test } from 'bun:test'
import type { FileNode } from '@shogo-ai/sdk/agent'
import { filterForFilesBrowser } from '../files-browser-filter'

function dir(name: string, children: FileNode[] = []): FileNode {
  return { name, path: name, type: 'directory', children }
}
function file(name: string): FileNode {
  return { name, path: name, type: 'file', size: 1 }
}

describe('filterForFilesBrowser', () => {
  test('hides dotfiles and dot-directories', () => {
    const tree: FileNode[] = [
      file('.env'),
      file('.gitignore'),
      dir('.shogo'),
      dir('.git'),
      file('notes.md'),
    ]
    const filtered = filterForFilesBrowser(tree)
    expect(filtered.map((n) => n.name)).toEqual(['notes.md'])
  })

  test('hides curated config files at the workspace root', () => {
    const tree: FileNode[] = [
      file('AGENTS.md'),
      file('MEMORY.md'),
      file('HEARTBEAT.md'),
      file('TOOLS.md'),
      file('package.json'),
      file('tsconfig.json'),
      file('LICENSE'),
      file('README.md'),
      file('user-notes.md'),
    ]
    const filtered = filterForFilesBrowser(tree)
    expect(filtered.map((n) => n.name)).toEqual(['user-notes.md'])
  })

  test('hides heavy build/dep directories the IDE shows lazily', () => {
    const tree: FileNode[] = [
      dir('node_modules'),
      dir('dist'),
      dir('build'),
      dir('.next'),
      dir('coverage'),
      dir('memory'),
      dir('scripts'),
      dir('files'),
    ]
    const filtered = filterForFilesBrowser(tree)
    expect(filtered.map((n) => n.name)).toEqual(['files'])
  })

  test('recurses into kept directories and filters their children', () => {
    const tree: FileNode[] = [
      dir('files', [
        file('user-data.csv'),
        file('.DS_Store'),
        dir('node_modules'),
        dir('sub', [file('AGENTS.md'), file('keep-me.txt')]),
      ]),
    ]
    const [files] = filterForFilesBrowser(tree)
    // user-data.csv kept; .DS_Store (dotfile) and node_modules (heavy dir) gone.
    expect(files.children?.map((n) => n.name)).toEqual(['user-data.csv', 'sub'])
    const sub = files.children?.find((n) => n.name === 'sub')
    // AGENTS.md is curated everywhere — including nested directories.
    expect(sub?.children?.map((n) => n.name)).toEqual(['keep-me.txt'])
  })

  test('passes a non-curated file with the same prefix through', () => {
    // `package-lock.json` isn't in the curated set; only the literal
    // `package.json` is. Confirm the filter doesn't substring-match.
    const tree: FileNode[] = [file('package-lock.json'), file('package.json')]
    const filtered = filterForFilesBrowser(tree)
    expect(filtered.map((n) => n.name)).toEqual(['package-lock.json'])
  })

  test('returns a new array (does not mutate input)', () => {
    const original: FileNode[] = [file('.env'), file('keep.md')]
    const snapshot = JSON.parse(JSON.stringify(original))
    filterForFilesBrowser(original)
    expect(original).toEqual(snapshot)
  })
})
