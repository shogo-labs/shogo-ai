// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import {
  BUILT_IN_RULES,
  extractPort,
  extractMissingModule,
  extractMissingCommand,
  extractGitPathspec,
} from '../quick-fix/quick-fix-rules'

const find = (id: string) => {
  const r = BUILT_IN_RULES.find((x) => x.id === id)
  if (!r) throw new Error(`rule ${id} missing from BUILT_IN_RULES`)
  return r
}

describe('extractPort', () => {
  it('extracts port from EADDRINUSE ipv4', () => {
    expect(extractPort('Error: listen EADDRINUSE: address already in use 127.0.0.1:3000')).toBe(3000)
  })
  it('extracts port from EADDRINUSE ipv6 (:::)', () => {
    expect(extractPort('EADDRINUSE: address already in use :::8080')).toBe(8080)
  })
  it('extracts port from "Port N is in use"', () => {
    expect(extractPort('Port 4321 is in use, trying another one...')).toBe(4321)
  })
  it('rejects out-of-range port numbers', () => {
    expect(extractPort('listening on 0.0.0.0:99999')).toBe(null)
  })
  it('returns null when there is no port in the line', () => {
    expect(extractPort('something happened')).toBe(null)
  })
})

describe('extractMissingModule', () => {
  it('parses a simple Cannot-find-module message', () => {
    expect(extractMissingModule("Error: Cannot find module 'lodash'")).toBe('lodash')
  })
  it('parses double-quoted variant', () => {
    expect(extractMissingModule('Cannot find module "express"')).toBe('express')
  })
  it('returns scope/name for scoped packages', () => {
    expect(extractMissingModule("Cannot find module '@shogo/pty-core'")).toBe('@shogo/pty-core')
  })
  it('strips subpath under unscoped packages', () => {
    expect(extractMissingModule("Cannot find module 'lodash/get'")).toBe('lodash')
  })
  it('rejects relative paths', () => {
    expect(extractMissingModule("Cannot find module './foo'")).toBe(null)
    expect(extractMissingModule("Cannot find module '/abs/foo'")).toBe(null)
  })
  it('returns null on malformed scoped name', () => {
    expect(extractMissingModule("Cannot find module '@only-scope'")).toBe(null)
  })
  it('returns null when nothing matches', () => {
    expect(extractMissingModule('nothing here')).toBe(null)
  })
})