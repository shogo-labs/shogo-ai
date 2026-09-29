// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { getRemoteParentPath } from '../remote-host-picker-utils'

describe('remote host picker path navigation', () => {
  test('keeps the home shortcut at the top of a remote home tree', () => {
    expect(getRemoteParentPath('~')).toBeNull()
    expect(getRemoteParentPath('~/projects')).toBe('~')
    expect(getRemoteParentPath('~/projects/app')).toBe('~/projects')
  })

  test('handles absolute remote paths and the filesystem root', () => {
    expect(getRemoteParentPath('/')).toBeNull()
    expect(getRemoteParentPath('/srv')).toBe('/')
    expect(getRemoteParentPath('/srv/apps/shogo')).toBe('/srv/apps')
  })
})
