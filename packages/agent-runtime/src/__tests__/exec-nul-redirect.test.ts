// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-180 / #1686 — `cmd 2>nul` under Git Bash on Windows creates a real file
 * called `nul`, and a workspace holding one can never be committed there.
 *
 * The `exec` path therefore rewrites a bare `nul` redirection *target* to
 * `/dev/null`. Only the target moves: a command or argument merely containing
 * `nul`, a filename like `nul.txt`, a quoted string, and any non-bash shell are
 * all left exactly as the agent wrote them.
 */
import { describe, test, expect } from 'bun:test'
import { rewriteNulRedirectsOnWindows } from '../sandbox-exec'

const win = (command: string, shellLabel = 'bash') =>
  rewriteNulRedirectsOnWindows(command, { platform: 'win32', shellLabel })

describe('rewriteNulRedirectsOnWindows', () => {
  test('points a bare > nul / 2>nul at /dev/null', () => {
    expect(win('echo hi > nul')).toBe('echo hi > /dev/null')
    expect(win('cmd 2>nul')).toBe('cmd 2>/dev/null')
    expect(win('cmd 2> nul')).toBe('cmd 2> /dev/null')
    expect(win('make >>nul')).toBe('make >>/dev/null')
    expect(win('make &>nul')).toBe('make &>/dev/null')
    expect(win('make >NUL')).toBe('make >/dev/null')
  })

  test('handles a redirected command that starts the line', () => {
    expect(win('>nul some-tool --flag')).toBe('>/dev/null some-tool --flag')
  })

  test('rewrites several redirections in one command', () => {
    expect(win('tool >nul 2>nul && echo done')).toBe('tool >/dev/null 2>/dev/null && echo done')
  })

  test('leaves a value that is merely named nul alone', () => {
    expect(win('echo nul')).toBe('echo nul')
    expect(win('git add nul')).toBe('git add nul')
    expect(win('cat nul.txt')).toBe('cat nul.txt')
    expect(win('rm -f ./nul')).toBe('rm -f ./nul')
    expect(win('echo null')).toBe('echo null')
    expect(win('echo mynul')).toBe('echo mynul')
  })

  test('leaves quoted text alone — it is not a redirection', () => {
    expect(win(`echo '>nul'`)).toBe(`echo '>nul'`)
    expect(win('echo "redirect with >nul"')).toBe('echo "redirect with >nul"')
  })

  test('is a no-op off Windows and under cmd.exe', () => {
    expect(rewriteNulRedirectsOnWindows('echo hi > nul', { platform: 'linux', shellLabel: 'bash' }))
      .toBe('echo hi > nul')
    expect(rewriteNulRedirectsOnWindows('echo hi > nul', { platform: 'darwin', shellLabel: 'zsh' }))
      .toBe('echo hi > nul')
    // cmd.exe already treats `nul` as the null device — rewriting it would break it.
    expect(win('echo hi > nul', 'cmd.exe')).toBe('echo hi > nul')
    expect(win('echo hi > nul', null as unknown as string)).toBe('echo hi > nul')
  })

  test('leaves a command with no nul at all untouched', () => {
    expect(win('bun test > /dev/null 2>&1')).toBe('bun test > /dev/null 2>&1')
    expect(win('ls -la')).toBe('ls -la')
  })
})
