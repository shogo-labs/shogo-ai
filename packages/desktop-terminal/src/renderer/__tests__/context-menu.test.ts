// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import { buildVsCodeMenuGroups, type TerminalContextMenuAction } from '../context-menu'

function flatten(groups: TerminalContextMenuAction[][]): TerminalContextMenuAction[] {
  return groups.flat()
}

function labelOf(it: TerminalContextMenuAction): string { return it.label }

const callbacks = {
  onCopy() {}, onCopyAsHtml() {}, onPaste() {}, onSelectAll() {}, onFind() {},
  onKill() {}, onRename() {}, onConfigure() {}, onSplit() {}, onClear() {},
}

const defaultOpts = {
  hasSelection: true,
  hasClipboard: true,
  hasProcess: true,
  isEmpty: false,
  recentCommands: [{ label: 'ls -la', onSelect: () => {} }],
  colors: [{ label: 'Red', hex: '#cd3131', onSelect: () => {} }],
  icons: [{ label: 'Terminal', onSelect: () => {} }],
  ...callbacks,
}

describe('buildVsCodeMenuGroups', () => {
  it('produces 4 groups in the exact VS Code order', () => {
    const groups = buildVsCodeMenuGroups(defaultOpts)
    expect(groups.length).toBe(4)
    expect(groups[0].map(labelOf)).toEqual(['Copy', 'Copy as HTML', 'Paste'])
    expect(groups[1].map(labelOf)).toEqual(['Select All', 'Find'])
    expect(groups[2].map(labelOf)).toEqual(['Kill', 'Rename', 'Configure', 'Change Icon', 'Change Color', 'Split'])
    expect(groups[3].map(labelOf)).toEqual(['Run Recent', 'Clear'])
  })

  it('disables Copy and Copy as HTML when there is no selection', () => {
    const groups = buildVsCodeMenuGroups({ ...defaultOpts, hasSelection: false })
    const flat = flatten(groups)
    expect(flat.find((i) => i.label === 'Copy')?.disabled).toBe(true)
    expect(flat.find((i) => i.label === 'Copy as HTML')?.disabled).toBe(true)
  })

  it('enables Copy when there IS a selection', () => {
    const flat = flatten(buildVsCodeMenuGroups(defaultOpts))
    expect(flat.find((i) => i.label === 'Copy')?.disabled).toBeFalsy()
  })

  it('disables Paste when clipboard is empty', () => {
    const flat = flatten(buildVsCodeMenuGroups({ ...defaultOpts, hasClipboard: false }))
    expect(flat.find((i) => i.label === 'Paste')?.disabled).toBe(true)
  })

  it('disables Kill when no process is running', () => {
    const flat = flatten(buildVsCodeMenuGroups({ ...defaultOpts, hasProcess: false }))
    expect(flat.find((i) => i.label === 'Kill')?.disabled).toBe(true)
  })

  it('disables Find when the terminal is empty', () => {
    const flat = flatten(buildVsCodeMenuGroups({ ...defaultOpts, isEmpty: true }))
    expect(flat.find((i) => i.label === 'Find')?.disabled).toBe(true)
  })

  it('disables Run Recent when there are no recent commands', () => {
    const flat = flatten(buildVsCodeMenuGroups({ ...defaultOpts, recentCommands: [] }))
    const runRecent = flat.find((i) => i.label === 'Run Recent')
    expect(runRecent?.disabled).toBe(true)
    expect(runRecent?.submenu?.[0].disabled).toBe(true)
    expect(runRecent?.submenu?.[0].label).toBe('(no recent commands)')
  })

  it('puts the 8 default colors into the Change Color submenu with swatches', () => {
    const colors = [
      { label: 'Red', hex: '#ff0000', onSelect: () => {} },
      { label: 'Blue', hex: '#0000ff', onSelect: () => {} },
    ]
    const flat = flatten(buildVsCodeMenuGroups({ ...defaultOpts, colors }))
    const changeColor = flat.find((i) => i.label === 'Change Color')
    expect(changeColor?.submenu?.length).toBe(2)
    expect(changeColor?.submenu?.[0]).toMatchObject({ label: 'Red', swatch: '#ff0000' })
    expect(changeColor?.submenu?.[1]).toMatchObject({ label: 'Blue', swatch: '#0000ff' })
  })

  it('falls back to a disabled placeholder when no colors are provided', () => {
    const flat = flatten(buildVsCodeMenuGroups({ ...defaultOpts, colors: [] }))
    const changeColor = flat.find((i) => i.label === 'Change Color')
    expect(changeColor?.submenu?.length).toBe(1)
    expect(changeColor?.submenu?.[0]).toMatchObject({ label: '(no colors configured)', disabled: true })
  })

  it('falls back to a disabled placeholder when no icons are provided', () => {
    const flat = flatten(buildVsCodeMenuGroups({ ...defaultOpts, icons: [] }))
    const changeIcon = flat.find((i) => i.label === 'Change Icon')
    expect(changeIcon?.submenu?.length).toBe(1)
    expect(changeIcon?.submenu?.[0]).toMatchObject({ label: '(no icons configured)', disabled: true })
  })

  it('attaches recent commands as a submenu', () => {
    const recent = [
      { label: 'ls -la', onSelect: () => {} },
      { label: 'cd /tmp', onSelect: () => {} },
    ]
    const flat = flatten(buildVsCodeMenuGroups({ ...defaultOpts, recentCommands: recent }))
    const runRecent = flat.find((i) => i.label === 'Run Recent')
    expect(runRecent?.disabled).toBeFalsy()
    expect(runRecent?.submenu?.map(labelOf)).toEqual(['ls -la', 'cd /tmp'])
  })

  it('renders the canonical ⌘ shortcuts for Copy, Paste, Select All, Find, Clear, Split', () => {
    const flat = flatten(buildVsCodeMenuGroups(defaultOpts))
    expect(flat.find((i) => i.label === 'Copy')?.shortcut).toBe('⌘C')
    expect(flat.find((i) => i.label === 'Paste')?.shortcut).toBe('⌘V')
    expect(flat.find((i) => i.label === 'Select All')?.shortcut).toBe('⌘A')
    expect(flat.find((i) => i.label === 'Find')?.shortcut).toBe('⌘F')
    expect(flat.find((i) => i.label === 'Split')?.shortcut).toBe('⌘\\')
    expect(flat.find((i) => i.label === 'Clear')?.shortcut).toBe('⌘K')
  })

  it('invokes the wired callbacks on item selection', () => {
    let copyCalled = 0
    let pasteCalled = 0
    let killCalled = 0
    let clearCalled = 0
    const groups = buildVsCodeMenuGroups({
      ...defaultOpts,
      onCopy: () => { copyCalled++ },
      onPaste: () => { pasteCalled++ },
      onKill: () => { killCalled++ },
      onClear: () => { clearCalled++ },
    })
    const flat = flatten(groups)
    flat.find((i) => i.label === 'Copy')?.onSelect?.()
    flat.find((i) => i.label === 'Paste')?.onSelect?.()
    flat.find((i) => i.label === 'Kill')?.onSelect?.()
    flat.find((i) => i.label === 'Clear')?.onSelect?.()
    expect(copyCalled).toBe(1)
    expect(pasteCalled).toBe(1)
    expect(killCalled).toBe(1)
    expect(clearCalled).toBe(1)
  })

  it('invokes the correct color callback with the swatch hex', () => {
    const captured: string[] = []
    const colors = [
      { label: 'Red', hex: '#cd3131', onSelect: () => captured.push('#cd3131') },
      { label: 'Green', hex: '#0dbc79', onSelect: () => captured.push('#0dbc79') },
    ]
    const flat = flatten(buildVsCodeMenuGroups({ ...defaultOpts, colors }))
    const changeColor = flat.find((i) => i.label === 'Change Color')
    changeColor?.submenu?.[1].onSelect?.()
    expect(captured).toEqual(['#0dbc79'])
  })

  it('invokes the correct recent-command callback with the command label', () => {
    const captured: string[] = []
    const recent = [
      { label: 'git status', onSelect: () => captured.push('git status') },
      { label: 'bun test', onSelect: () => captured.push('bun test') },
    ]
    const flat = flatten(buildVsCodeMenuGroups({ ...defaultOpts, recentCommands: recent }))
    const runRecent = flat.find((i) => i.label === 'Run Recent')
    runRecent?.submenu?.[1].onSelect?.()
    expect(captured).toEqual(['bun test'])
  })
})
