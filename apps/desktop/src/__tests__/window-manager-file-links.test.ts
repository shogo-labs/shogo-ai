// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Which links open in the in-app file viewer rather than the system browser.
 * Electron and the local server are mocked so the module loads headless.
 */

import { describe, expect, it, mock } from 'bun:test'

mock.module('electron', () => ({
  app: {},
  BrowserWindow: class {},
  shell: { openExternal: async () => true },
}))

mock.module('../local-server', () => ({
  getApiPort: () => 39100,
  getApiUrl: () => 'http://localhost:39100',
}))

const { isInAppFileUrl } = await import('../window-manager')

const API = 'http://localhost:39100'

describe('isInAppFileUrl', () => {
  it('matches a local conversation file', () => {
    expect(isInAppFileUrl(`${API}/api/conversation-files/att-1?t=abc.def`, API)).toBe(true)
  })

  it('matches a cloud-relayed conversation file', () => {
    const url = `${API}/api/cloud/b5c1129c-5d79-4361-ab94-bb8bf207cb18/conversation-files/382901e0?t=mvd26tc0.f8af`
    expect(isInAppFileUrl(url, API)).toBe(true)
  })

  it('matches a chat attachment', () => {
    expect(isInAppFileUrl(`${API}/api/chat-attachments/key/file.pdf?t=sig`, API)).toBe(true)
  })

  it('rejects another localhost port', () => {
    expect(isInAppFileUrl('http://localhost:3000/api/conversation-files/att-1?t=abc', API)).toBe(false)
  })

  it('rejects an external https URL with the same path', () => {
    expect(isInAppFileUrl('https://evil.example/api/conversation-files/att-1?t=abc', API)).toBe(false)
  })

  it('rejects a cloud project path', () => {
    expect(isInAppFileUrl(`${API}/api/cloud/ws-1/projects/p-1/files/x.pdf`, API)).toBe(false)
  })

  it('rejects an unrelated local API path', () => {
    expect(isInAppFileUrl(`${API}/api/workspaces`, API)).toBe(false)
  })

  it('rejects a path that only starts with the prefix', () => {
    expect(isInAppFileUrl(`${API}/api/conversation-files-old/att-1`, API)).toBe(false)
  })

  it('returns false for a value that is not a URL', () => {
    expect(isInAppFileUrl('not a url', API)).toBe(false)
    expect(isInAppFileUrl(`${API}/api/conversation-files/att-1`, 'not a url')).toBe(false)
  })
})
