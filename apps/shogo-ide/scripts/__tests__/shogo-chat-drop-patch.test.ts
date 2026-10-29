// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Checks the Code-OSS patch that lets Explorer items be dropped on Shogo Chat
 * (patches/code-oss/shogo-chat-explorer-drop.patch) without building VS Code:
 * the import-free drop parser it adds is extracted from the patch and run, and
 * the patch's wiring is checked against the shogo-core manifest.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const IDE_DIR = resolve(import.meta.dir, '..', '..')
const PATCH = readFileSync(join(IDE_DIR, 'patches', 'code-oss', 'shogo-chat-explorer-drop.patch'), 'utf8').replace(/\r\n/g, '\n')
const MANIFEST = JSON.parse(readFileSync(join(IDE_DIR, 'extensions', 'shogo-core', 'package.json'), 'utf8'))

/** Per-file sections of a `git diff`. */
function sections(patch: string): Map<string, string> {
  const out = new Map<string, string>()
  const parts = patch.split(/^diff --git /m).slice(1)
  for (const part of parts) {
    const file = /^a\/(\S+) b\//.exec(part)?.[1]
    if (file) out.set(file, part)
  }
  return out
}

/** Content of a file the patch adds (a `new file` section). */
function addedFile(section: string): string {
  const body = section.slice(section.indexOf('\n@@'))
  return body
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n')
}

const files = sections(PATCH)
const DATA = 'src/vs/workbench/contrib/webviewView/browser/shogoChatDropData.ts'
const PANE = 'src/vs/workbench/contrib/webviewView/browser/webviewViewPane.ts'

const dir = mkdtempSync(join(tmpdir(), 'shogo-chat-drop-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
writeFileSync(join(dir, 'shogoChatDropData.ts'), addedFile(files.get(DATA)!))
const drop = await import(join(dir, 'shogoChatDropData.ts'))

const transfer = (data: Record<string, string>) => ({ types: Object.keys(data), getData: (f: string) => data[f] ?? '' })

describe('shogo-chat-explorer-drop.patch', () => {
  test('records the upstream commit it was generated against', () => {
    expect(PATCH).toMatch(/^Generated against microsoft\/vscode [0-9a-f]{40}\.$/m)
  })

  test('touches only the webview view pane, its new drop helper, CSS and test', () => {
    expect([...files.keys()].sort()).toEqual([
      'src/vs/workbench/contrib/webviewView/browser/media/shogoChatDrop.css',
      DATA,
      PANE,
      'src/vs/workbench/contrib/webviewView/test/browser/shogoChatDrop.test.ts',
    ])
  })

  test('the parser module stays import-free', () => {
    expect(addedFile(files.get(DATA)!)).not.toMatch(/^import /m)
  })

  test('only the Shogo Chat view handles drops, forwarding to shogo-core', () => {
    const pane = files.get(PANE)!
    expect(pane).toContain('+		if (this.id === SHOGO_CHAT_VIEW_ID) {')
    expect(pane).toContain('executeCommand(SHOGO_ADD_URIS_COMMAND, uris)')
    expect(pane).toContain("+import './media/shogoChatDrop.css';")
    // The existing re-dispatch loop for view drag-and-drop is untouched.
    expect(pane).not.toMatch(/^-.*Re-dispatch all drag events/m)
  })

  test('the view id and command exist in the shogo-core manifest', () => {
    const views = MANIFEST.contributes.views['shogo-agent-chat'].map((v: { id: string }) => v.id)
    const commands = MANIFEST.contributes.commands.map((c: { command: string }) => c.command)
    expect(views).toContain(drop.SHOGO_CHAT_VIEW_ID)
    expect(commands).toContain(drop.SHOGO_ADD_URIS_COMMAND)
  })
})

describe('drop parsing (from the patch)', () => {
  test('recognises resource drags only', () => {
    expect(drop.isShogoChatResourceDrag(['ResourceURLs'])).toBe(true)
    expect(drop.isShogoChatResourceDrag(['Files'])).toBe(false)
    expect(drop.isShogoChatResourceDrag(['application/vnd.code.tree.views'])).toBe(false)
    expect(drop.isShogoChatResourceDrag(undefined)).toBe(false)
  })

  test('ResourceURLs, CodeEditors, CodeFiles and uri-list, deduped in order', () => {
    expect(
      drop.parseShogoChatDropData(
        transfer({
          ResourceURLs: JSON.stringify(['file:///repo/a.ts', 'file:///repo/a.ts']),
          CodeEditors: JSON.stringify([{ resource: { scheme: 'file', authority: '', path: '/repo/b.ts' } }]),
          CodeFiles: JSON.stringify(['C:\\repo\\c d.ts']),
          'text/uri-list': '# comment\nfile:///repo/a.ts\nfile:///repo/e.ts',
        }),
      ),
    ).toEqual(['file:///repo/a.ts', 'file:///repo/b.ts', 'file:///C:/repo/c%20d.ts', 'file:///repo/e.ts'])
  })

  test('malformed data yields nothing', () => {
    expect(drop.parseShogoChatDropData(transfer({ ResourceURLs: '{x', CodeFiles: '7' }))).toEqual([])
  })

  test('merge drops empties and duplicates', () => {
    expect(drop.mergeShogoChatDropUris(['a', undefined, 'b'], ['a', 'c'])).toEqual(['a', 'b', 'c'])
  })
})
