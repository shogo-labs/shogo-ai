// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// browser-relay.cjs — Playwright extension relay protocol v2 (SHO-360).
//
// The relay runs under Node (the ws upgrade handling needs node:http), so these
// tests drive the real script in a child process and impersonate the Chrome
// extension over a WebSocket, exactly as the installed extension does.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RELAY_SCRIPT = join(import.meta.dir, '..', 'browser-relay.cjs')
const relayModule = require('../browser-relay.cjs')

interface RelayLine {
  type: 'ready' | 'connected' | 'error'
  cdpEndpoint?: string
  extensionEndpoint?: string
  protocolVersion?: number
  message?: string
}

/** Spawns the relay, collecting its newline-delimited stdout messages. */
function startRelay(args: { timeoutMs?: number; env?: Record<string, string> } = {}) {
  const lines: RelayLine[] = []
  const waiters: Array<() => void> = []
  const child = Bun.spawn(
    [
      'node',
      RELAY_SCRIPT,
      'chrome',
      '/nonexistent/definitely-not-chrome',
      String(args.timeoutMs ?? 5000),
    ],
    {
      cwd: import.meta.dir,
      env: {
        ...process.env,
        // Never launch a browser in tests; the spawn error is captured by the
        // relay and only surfaces in the timeout message.
        PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'test-extension-token',
        ...args.env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  const decoder = new TextDecoder()
  let buffer = ''
  void (async () => {
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk)
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''
      for (const line of parts) {
        if (!line.trim()) continue
        lines.push(JSON.parse(line))
        for (const wake of waiters.splice(0)) wake()
      }
    }
  })()

  return {
    child,
    lines,
    async next(predicate: (line: RelayLine) => boolean, timeoutMs = 5000): Promise<RelayLine> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = lines.find(predicate)
        if (found) return found
        if (Date.now() > deadline) throw new Error(`relay never emitted the expected message. got: ${JSON.stringify(lines)}`)
        await new Promise<void>((resolve) => {
          waiters.push(resolve)
          setTimeout(resolve, 50)
        })
      }
    },
    kill() {
      child.kill()
    },
  }
}

/** Minimal stand-in for the Chrome extension's relay connection. */
function connectFakeExtension(endpoint: string) {
  const ws = new WebSocket(endpoint)
  const received: Array<{ id?: number; method?: string; params?: any }> = []
  const waiters: Array<() => void> = []
  ws.addEventListener('message', (event) => {
    received.push(JSON.parse(String(event.data)))
    for (const wake of waiters.splice(0)) wake()
  })
  const ready = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error('extension websocket failed')))
  })
  return {
    ws,
    received,
    ready,
    send(message: any) {
      ws.send(JSON.stringify(message))
    },
    async next(predicate: (message: { id?: number; method?: string; params?: any }) => boolean, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = received.find(predicate)
        if (found) return found
        if (Date.now() > deadline) throw new Error(`extension never received the expected message. got: ${JSON.stringify(received)}`)
        await new Promise<void>((resolve) => {
          waiters.push(resolve)
          setTimeout(resolve, 25)
        })
      }
    },
    close() {
      ws.close()
    },
  }
}

let cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup()
    } catch {}
  }
})

describe('browser relay protocol v2', () => {
  test('announces protocol 2 and completes the v2 handshake', async () => {
    const relay = startRelay()
    cleanups.push(() => relay.kill())

    const ready = await relay.next((line) => line.type === 'ready')
    expect(ready.protocolVersion).toBe(2)
    expect(ready.cdpEndpoint).toStartWith('ws://127.0.0.1:')
    expect(ready.extensionEndpoint).toStartWith('ws://127.0.0.1:')

    const extension = connectFakeExtension(ready.extensionEndpoint!)
    cleanups.push(() => extension.close())
    await extension.ready
    extension.send({ method: 'extension.initialized', params: [] })

    const connected = await relay.next((line) => line.type === 'connected')
    expect(connected.protocolVersion).toBe(2)
  }, 20000)

  test('relays CDP traffic both ways and auto-attaches known tabs', async () => {
    const relay = startRelay()
    cleanups.push(() => relay.kill())
    const ready = await relay.next((line) => line.type === 'ready')

    const extension = connectFakeExtension(ready.extensionEndpoint!)
    cleanups.push(() => extension.close())
    await extension.ready

    // The extension answers the relay's chrome.* commands.
    extension.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.method === 'chrome.debugger.attach')
        extension.send({ id: message.id, result: {} })
      else if (message.method === 'chrome.debugger.sendCommand')
        extension.send({ id: message.id, result: { targetInfo: { targetId: 'tab-1', type: 'page', title: 'Tab', url: 'https://example.com' } } })
      else if (message.method === 'chrome.tabs.create')
        extension.send({ id: message.id, result: { id: 1, url: 'about:blank' } })
    })

    extension.send({ method: 'extension.initialized', params: [] })
    await relay.next((line) => line.type === 'connected')

    const cdp = new WebSocket(ready.cdpEndpoint!)
    cleanups.push(() => cdp.close())
    await new Promise<void>((resolve, reject) => {
      cdp.addEventListener('open', () => resolve())
      cdp.addEventListener('error', () => reject(new Error('cdp websocket failed')))
    })
    const cdpMessages: any[] = []
    const cdpWaiters: Array<() => void> = []
    cdp.addEventListener('message', (event) => {
      cdpMessages.push(JSON.parse(String(event.data)))
      for (const wake of cdpWaiters.splice(0)) wake()
    })
    const nextCdp = async (predicate: (m: any) => boolean) => {
      const deadline = Date.now() + 5000
      for (;;) {
        const found = cdpMessages.find(predicate)
        if (found) return found
        if (Date.now() > deadline) throw new Error(`cdp client never got the expected message. got: ${JSON.stringify(cdpMessages)}`)
        await new Promise<void>((resolve) => {
          cdpWaiters.push(resolve)
          setTimeout(resolve, 25)
        })
      }
    }

    // Target.setAutoAttach is answered by the relay itself.
    cdp.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true } }))
    expect(await nextCdp((m) => m.id === 1)).toEqual({ id: 1, result: {} })

    // A tab opened afterwards is attached through the extension and announced to Playwright.
    extension.send({ method: 'chrome.tabs.onCreated', params: [{ id: 7, url: 'https://example.com' }] })
    const attached = await nextCdp((m) => m.method === 'Target.attachedToTarget')
    expect(attached.params.targetInfo.targetId).toBe('tab-1')
    expect(extension.received.some((m) => m.method === 'chrome.debugger.attach')).toBe(true)
  }, 20000)

  test('a ready without a connected extension times out with a protocol-naming error', async () => {
    const relay = startRelay({ timeoutMs: 300 })
    cleanups.push(() => relay.kill())

    await relay.next((line) => line.type === 'ready')
    const error = await relay.next((line) => line.type === 'error', 8000)
    expect(error.message).toMatch(/did not connect within/)
    expect(error.message).toContain('protocol 2')
    expect(error.protocolVersion).toBe(2)
  }, 20000)
})

describe('extension protocol version detection', () => {
  test('reads the supported protocol version from the installed extension', () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'shogo-chrome-'))
    cleanups.push(() => rmSync(userDataDir, { recursive: true, force: true }))
    const connectScriptDir = join(userDataDir, 'Profile 2', 'Extensions', relayModule.EXTENSION_ID, '0.6.0', 'lib', 'ui')
    mkdirSync(connectScriptDir, { recursive: true })
    writeFileSync(
      join(connectScriptDir, 'connect.js'),
      'var SUPPORTED_PROTOCOL_VERSION = 3;\nif (requestedVersion < SUPPORTED_PROTOCOL_VERSION) {}\n',
    )

    expect(relayModule.findInstalledExtensionProtocolVersions([userDataDir])).toEqual([
      { profile: 'Profile 2', extensionVersion: '0.6.0', protocolVersion: 3 },
    ])
  })

  test('mismatch error names both protocol versions and which side to update', () => {
    const newer = relayModule.protocolMismatchError([
      { profile: 'Default', extensionVersion: '0.6.0', protocolVersion: 3 },
    ])
    expect(newer).toContain('protocol 3')
    expect(newer).toContain('protocol 2')
    expect(newer).toContain('Update Shogo Desktop')

    const older = relayModule.protocolMismatchError([
      { profile: 'Default', extensionVersion: '0.2.0', protocolVersion: 1 },
    ])
    expect(older).toContain('protocol 1')
    expect(older).toContain('protocol 2')
    expect(older).toContain('Chrome Web Store')
  })

  test('no error when any installed extension speaks our protocol', () => {
    expect(
      relayModule.protocolMismatchError([
        { profile: 'Default', extensionVersion: '0.5.0', protocolVersion: 3 },
        { profile: 'Profile 3', extensionVersion: '0.5.0', protocolVersion: 2 },
      ]),
    ).toBeNull()
    expect(relayModule.protocolMismatchError([])).toBeNull()
  })

  test('the connect page asks the extension for protocol 2', () => {
    const url = new URL(relayModule.buildConnectUrl({
      extensionEndpoint: 'ws://127.0.0.1:1234/extension/uuid',
      token: 'tok',
      clientName: 'Shogo',
    }))
    expect(url.protocol).toBe('chrome-extension:')
    expect(url.searchParams.get('protocolVersion')).toBe('2')
    expect(url.searchParams.get('token')).toBe('tok')
    expect(url.searchParams.get('mcpRelayUrl')).toBe('ws://127.0.0.1:1234/extension/uuid')
    expect(JSON.parse(url.searchParams.get('client')!).name).toBe('Shogo')
  })
})
