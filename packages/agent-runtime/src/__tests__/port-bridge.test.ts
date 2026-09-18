// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  allowedPorts,
  isPortAllowed,
  parsePortParam,
  proxyPortHttp,
  buildPortBridgeWsData,
  createPortBridgeWsHandlers,
  type TcpConnector,
} from '../port-bridge'

describe('allowedPorts / isPortAllowed', () => {
  test('parses a comma-separated SHOGO_EXPOSED_PORTS', () => {
    expect(allowedPorts({ SHOGO_EXPOSED_PORTS: '8000,5432' })).toEqual(new Set([8000, 5432]))
  })

  test('tolerates whitespace', () => {
    expect(allowedPorts({ SHOGO_EXPOSED_PORTS: ' 8000 , 5432 ' })).toEqual(new Set([8000, 5432]))
  })

  test('empty set when unset — the default for every non-Docker stack', () => {
    expect(allowedPorts({})).toEqual(new Set())
    expect(isPortAllowed(8000, {})).toBe(false)
  })

  test('ignores garbage entries rather than throwing', () => {
    expect(allowedPorts({ SHOGO_EXPOSED_PORTS: '8000,not-a-port,,99999999' })).toEqual(new Set([8000]))
  })

  test('isPortAllowed reflects the parsed set', () => {
    const env = { SHOGO_EXPOSED_PORTS: '8000' }
    expect(isPortAllowed(8000, env)).toBe(true)
    expect(isPortAllowed(22, env)).toBe(false)
  })
})

describe('parsePortParam', () => {
  test('accepts a bare positive integer string', () => {
    expect(parsePortParam('8000')).toBe(8000)
    expect(parsePortParam('1')).toBe(1)
    expect(parsePortParam('65535')).toBe(65535)
  })

  test('rejects anything not a clean small positive integer', () => {
    expect(parsePortParam(undefined)).toBeNull()
    expect(parsePortParam('')).toBeNull()
    expect(parsePortParam('0')).toBeNull()
    expect(parsePortParam('-1')).toBeNull()
    expect(parsePortParam('8000.5')).toBeNull()
    expect(parsePortParam('8000; rm -rf /')).toBeNull()
    expect(parsePortParam('0x1F90')).toBeNull()
    expect(parsePortParam('999999')).toBeNull() // > 65535, and > 5 digits anyway
    expect(parsePortParam('08000')).toBeNull() // leading zero
  })
})

describe('proxyPortHttp', () => {
  test('403s a port the project does not expose — the security-relevant check', async () => {
    const res = await proxyPortHttp(
      22,
      { method: 'GET', restPath: '/', search: '', headers: new Headers(), body: null },
      { env: { SHOGO_EXPOSED_PORTS: '8000' } },
    )
    expect(res.status).toBe(403)
  })

  test('proxies to 127.0.0.1:{port} for an allowed port', async () => {
    let capturedUrl: string | undefined
    const fetchImpl = (async (url: string) => {
      capturedUrl = url
      return new Response('hello', { status: 200, headers: { 'x-upstream': '1' } })
    }) as unknown as typeof fetch

    const res = await proxyPortHttp(
      8000,
      { method: 'GET', restPath: '/widgets', search: '?a=1', headers: new Headers(), body: null },
      { env: { SHOGO_EXPOSED_PORTS: '8000' }, fetchImpl },
    )
    expect(capturedUrl).toBe('http://127.0.0.1:8000/widgets?a=1')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello')
  })

  test('502s when the upstream fetch throws (port not actually listening)', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const res = await proxyPortHttp(
      8000,
      { method: 'GET', restPath: '/', search: '', headers: new Headers(), body: null },
      { env: { SHOGO_EXPOSED_PORTS: '8000' }, fetchImpl },
    )
    expect(res.status).toBe(502)
  })

  test('defaults restPath to / when empty', async () => {
    let capturedUrl: string | undefined
    const fetchImpl = (async (url: string) => {
      capturedUrl = url
      return new Response('ok')
    }) as unknown as typeof fetch
    await proxyPortHttp(
      8000,
      { method: 'GET', restPath: '', search: '', headers: new Headers(), body: null },
      { env: { SHOGO_EXPOSED_PORTS: '8000' }, fetchImpl },
    )
    expect(capturedUrl).toBe('http://127.0.0.1:8000/')
  })
})

// ── Raw TCP bridge ──────────────────────────────────────────────────────────

/** A fake ServerWebSocket good enough for the handlers under test. */
function fakeWs(port: number) {
  const sent: Array<ArrayBuffer | Uint8Array | string> = []
  const closes: Array<{ code?: number; reason?: string }> = []
  return {
    data: buildPortBridgeWsData(port),
    sent,
    closes,
    send(payload: any) {
      sent.push(payload)
      return 0
    },
    close(code?: number, reason?: string) {
      closes.push({ code, reason })
    },
  } as any
}

/** A fake TCP connector whose socket callbacks we can drive by hand. */
function fakeConnector() {
  const writes: Uint8Array[] = []
  let ended = false
  let socketCallbacks: any = null
  let rejectConnect: ((err: Error) => void) | null = null
  const connector: TcpConnector = {
    connect: (opts) => {
      socketCallbacks = opts.socket
      return new Promise((resolve, reject) => {
        rejectConnect = reject
        ;(connector as any)._resolve = resolve
      })
    },
  }
  return {
    connector,
    writes,
    get ended() { return ended },
    get callbacks() { return socketCallbacks },
    /** Simulate a successful TCP connect. */
    openNow() {
      const sock = {
        write(data: Uint8Array) { writes.push(data); return data.byteLength },
        end() { ended = true },
      }
      ;(connector as any)._resolve(sock)
      socketCallbacks.open(sock)
      return sock
    },
    failNow(err: Error) {
      rejectConnect?.(err)
    },
  }
}

describe('createPortBridgeWsHandlers', () => {
  test('closes immediately (4403) for a port the project does not expose', () => {
    const ws = fakeWs(22)
    const handlers = createPortBridgeWsHandlers({ env: { SHOGO_EXPOSED_PORTS: '8000' } })
    handlers.open(ws)
    expect(ws.closes).toEqual([{ code: 4403, reason: 'port 22 is not exposed by this project' }])
  })

  test('connects to 127.0.0.1:{port} for an allowed port and pumps bytes both ways', async () => {
    const ws = fakeWs(8000)
    const fc = fakeConnector()
    const handlers = createPortBridgeWsHandlers({ env: { SHOGO_EXPOSED_PORTS: '8000' }, connector: fc.connector })
    handlers.open(ws)

    const sock = fc.openNow()
    // client → guest
    const clientFrame = new TextEncoder().encode('SELECT 1').buffer
    handlers.message(ws, clientFrame)
    expect(fc.writes).toHaveLength(1)
    expect(new TextDecoder().decode(fc.writes[0])).toBe('SELECT 1')

    // guest → client
    fc.callbacks.data(sock, new TextEncoder().encode('row-1'))
    expect(ws.sent).toHaveLength(1)

    // client closes → guest socket ends
    handlers.close(ws)
    expect(fc.ended).toBe(true)
  })

  test('queues client→guest frames sent before connect() resolves, then flushes in order', () => {
    const ws = fakeWs(8000)
    const fc = fakeConnector()
    const handlers = createPortBridgeWsHandlers({ env: { SHOGO_EXPOSED_PORTS: '8000' }, connector: fc.connector })
    handlers.open(ws)

    handlers.message(ws, new TextEncoder().encode('first').buffer)
    handlers.message(ws, new TextEncoder().encode('second').buffer)
    expect(fc.writes).toHaveLength(0) // not connected yet

    fc.openNow()
    expect(fc.writes).toHaveLength(2)
    expect(new TextDecoder().decode(fc.writes[0])).toBe('first')
    expect(new TextDecoder().decode(fc.writes[1])).toBe('second')
  })

  test('closes the client WS (1011) when the guest connect fails', () => {
    const ws = fakeWs(8000)
    const fc = fakeConnector()
    const errors: unknown[] = []
    const handlers = createPortBridgeWsHandlers({
      env: { SHOGO_EXPOSED_PORTS: '8000' },
      connector: fc.connector,
      logger: { error: (...a) => errors.push(a) },
    })
    handlers.open(ws)
    fc.failNow(new Error('ECONNREFUSED'))
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(ws.closes).toEqual([{ code: 1011, reason: 'port-unreachable' }])
        resolve(undefined)
      }, 0)
    })
  })

  test('a guest-side close forwards as a clean 1000 close to the client', () => {
    const ws = fakeWs(8000)
    const fc = fakeConnector()
    const handlers = createPortBridgeWsHandlers({ env: { SHOGO_EXPOSED_PORTS: '8000' }, connector: fc.connector })
    handlers.open(ws)
    const sock = fc.openNow()
    fc.callbacks.close(sock)
    expect(ws.closes).toEqual([{ code: 1000, reason: 'port-closed' }])
  })
})
