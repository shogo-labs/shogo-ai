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

const { installAppNavigationGuards, isInAppFileUrl } = await import('../window-manager')

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

  it('matches a share_file download link and its legacy shape', () => {
    expect(isInAppFileUrl(`${API}/api/f/eyJ0eXA.abc_`, API)).toBe(true)
    expect(isInAppFileUrl(`${API}/f/eyJ0eXA.abc`, API)).toBe(true)
  })

  it('rejects a share link on another host', () => {
    expect(isInAppFileUrl('https://evil.example/api/f/eyJ0eXA.abc', API)).toBe(false)
    expect(isInAppFileUrl('https://evil.example/f/eyJ0eXA.abc', API)).toBe(false)
  })
})

/**
 * A refused link is handed to the renderer, which shows it in the app's pane.
 * Neither of the two ways a click can leave the window may reach the browser
 * for a file the API serves (SHO-80).
 */
describe('the navigation guards', () => {
  function fakeWebContents() {
    const sent: Array<{ channel: string; payload: unknown }> = []
    const state: {
      windowOpen?: (details: { url: string }) => unknown
      willNavigate?: (event: { preventDefault: () => void }, url: string) => void
    } = {}
    const webContents = {
      setWindowOpenHandler: (handler: (details: { url: string }) => unknown) => {
        state.windowOpen = handler
      },
      on: (event: string, handler: (...args: any[]) => void) => {
        if (event === 'will-navigate') state.willNavigate = handler as never
      },
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
      isDestroyed: () => false,
    }
    installAppNavigationGuards(webContents as never)
    return { state, sent }
  }

  it('denies a window for a served file and forwards it to the app', () => {
    const { state, sent } = fakeWebContents()
    const url = `${API}/api/f/eyJ0eXA.abc`
    expect(state.windowOpen!({ url })).toEqual({ action: 'deny' })
    expect(sent).toEqual([{ channel: 'shogo:open-file', payload: { href: url } }])
  })

  it('keeps the window where it is when a plain link would navigate to a file', () => {
    const { state, sent } = fakeWebContents()
    const url = `${API}/api/conversation-files/att-1?t=abc.def`
    let prevented = false
    state.willNavigate!({ preventDefault: () => (prevented = true) }, url)
    expect(prevented).toBe(true)
    expect(sent).toEqual([{ channel: 'shogo:open-file', payload: { href: url } }])
  })
})
