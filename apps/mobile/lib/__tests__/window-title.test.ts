// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { getProjectDocumentTitle, resolveProjectWindowName, workspaceBasename } from '../window-title'

describe('window-title helpers', () => {
  it('uses the project name for managed project windows', () => {
    expect(getProjectDocumentTitle({ projectName: 'Video Builder' })).toBe('Video Builder — Shogo')
  })

  it('uses the folder name for desktop folder-linked project windows', () => {
    expect(getProjectDocumentTitle({
      projectName: 'Imported Project',
      workspacePath: '/Users/ashutoshojha/Desktop/shogo-ai',
      preferWorkspaceName: true,
    })).toBe('shogo-ai — Shogo')
  })

  it('falls back to Shogo outside a resolved project', () => {
    expect(getProjectDocumentTitle({})).toBe('Shogo')
  })

  it('handles posix and windows workspace paths', () => {
    expect(workspaceBasename('/Users/me/Desktop/odin-dev-stack')).toBe('odin-dev-stack')
    expect(workspaceBasename('C:\\Users\\me\\Desktop\\shogo-ai')).toBe('shogo-ai')
  })

  it('falls back to folder name when the project name is blank', () => {
    expect(resolveProjectWindowName({ projectName: ' ', workspacePath: '/tmp/shogo-website' })).toBe('shogo-website')
  })
})
