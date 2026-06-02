// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * FEAT-PORTS — RTL coverage for the Ports tab (PortsPanel).
 *
 * The component was built test-ready via its `bridge` override prop but
 * shipped without React-level tests (the desktop IPC + lsof parser are
 * tested on the Electron side; the rendering/interaction layer was not).
 * This suite locks the user-visible contract:
 *
 *   • Status branches: no-bridge (desktop-only), unsupported (no lsof),
 *     loading, ready-empty, ready-with-rows.
 *   • The 5-column table renders port / forwarded address / process+pid /
 *     local address / visibility, with VS Code's address + visibility
 *     formatting (wildcard, loopback, IPv6 bracketing).
 *   • Left-click and Enter open the port via the bridge.
 *   • Right-click opens the context menu; its actions call open / copy
 *     local address / copy command line / kill with the right arguments.
 *   • A freshly-detected port gets the `port-row-new` pulse class.
 *
 * The bridge `subscribe` is async; the mock captures the handlers
 * synchronously (before its first await) so `push()` can drive list
 * updates deterministically inside `act`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import * as React from "react"

import { PortsPanel } from "../PortsPanel"

interface PortEntryLike {
  port: number
  command: string
  pid: number
  address: string
  type: "IPv4" | "IPv6"
}
interface ListMessage {
  ports: PortEntryLike[]
  newKeys: string[]
}

function entry(over: Partial<PortEntryLike> = {}): PortEntryLike {
  return { port: 3000, command: "node", pid: 111, address: "127.0.0.1", type: "IPv4", ...over }
}

function makeBridge(opts: { commandLine?: string } = {}) {
  let handlers: { onList(m: ListMessage): void; onUnsupported(): void } | null = null
  const unsub = mock(async () => {})
  const bridge = {
    subscribe: mock(async (h: { onList(m: ListMessage): void; onUnsupported(): void }) => {
      handlers = h
      return unsub
    }),
    open: mock(async (_port: number) => ({ ok: true })),
    kill: mock(async (_pid: number) => ({ ok: true })),
    getCommandLine: mock(async (_pid: number) => ({ ok: true, commandLine: opts.commandLine ?? "node server.js" })),
  }
  return {
    bridge,
    unsub,
    async push(msg: ListMessage) {
      await act(async () => {
        handlers?.onList(msg)
      })
    },
    async unsupported() {
      await act(async () => {
        handlers?.onUnsupported()
      })
    },
    ready() {
      return waitFor(() => expect(bridge.subscribe).toHaveBeenCalled())
    },
  }
}

let clipboardWrites: string[]
beforeEach(() => {
  clipboardWrites = []
  // navigator.clipboard is a read-only accessor in happy-dom — define it.
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: { writeText: mock(async (t: string) => { clipboardWrites.push(t) }) },
  })
})
afterEach(() => cleanup())

describe("status branches", () => {
  test("no bridge → desktop-only empty state", () => {
    render(<PortsPanel visible />)
    expect(screen.getByTestId("bottompanel-pane-ports").textContent).toContain("desktop-only")
  })

  test("unsupported → lsof-not-available message", async () => {
    const h = makeBridge()
    render(<PortsPanel visible bridge={h.bridge} />)
    await h.ready()
    await h.unsupported()
    expect(screen.getByTestId("bottompanel-pane-ports").textContent).toContain("lsof")
  })

  test("loading before first push → scanning message", async () => {
    const h = makeBridge()
    render(<PortsPanel visible bridge={h.bridge} />)
    await h.ready()
    expect(screen.getByTestId("bottompanel-pane-ports").textContent).toContain("Scanning")
  })

  test("ready with empty list → no forwarded ports", async () => {
    const h = makeBridge()
    render(<PortsPanel visible bridge={h.bridge} />)
    await h.ready()
    await h.push({ ports: [], newKeys: [] })
    expect(screen.getByTestId("bottompanel-pane-ports").textContent).toContain("No forwarded ports")
  })
})

describe("table rendering + formatting", () => {
  test("renders a row with process, pid and loopback formatting", async () => {
    const h = makeBridge()
    render(<PortsPanel visible bridge={h.bridge} />)
    await h.ready()
    await h.push({ ports: [entry({ port: 3000, command: "node", pid: 111, address: "127.0.0.1" })], newKeys: [] })
    const row = screen.getByTestId("port-row-3000")
    expect(row.textContent).toContain("3000")
    expect(row.textContent).toContain("node")
    expect(row.textContent).toContain("111")
    expect(row.textContent).toContain("http://localhost:3000") // loopback → localhost
    expect(row.textContent).toContain("Private") // 127.0.0.1 → Private
  })

  test("wildcard bind → Public + localhost forwarded address", async () => {
    const h = makeBridge()
    render(<PortsPanel visible bridge={h.bridge} />)
    await h.ready()
    await h.push({ ports: [entry({ port: 8080, address: "*", type: "IPv4" })], newKeys: [] })
    const row = screen.getByTestId("port-row-8080")
    expect(row.textContent).toContain("http://localhost:8080")
    expect(row.textContent).toContain("Public")
  })

  test("non-loopback IPv6 bind → bracketed URL + raw local address", async () => {
    const h = makeBridge()
    render(<PortsPanel visible bridge={h.bridge} />)
    await h.ready()
    await h.push({ ports: [entry({ port: 9000, address: "fe80::1", type: "IPv6" })], newKeys: [] })
    const row = screen.getByTestId("port-row-9000")
    expect(row.textContent).toContain("http://[fe80::1]:9000")
  })

  test("freshly-detected port gets the pulse class", async () => {
    const h = makeBridge()
    render(<PortsPanel visible bridge={h.bridge} />)
    await h.ready()
    await h.push({ ports: [entry({ port: 5173, pid: 222 })], newKeys: ["5173:222"] })
    expect(screen.getByTestId("port-row-5173").className).toContain("port-row-new")
  })
})

describe("open interactions", () => {
  test("click opens the port via the bridge", async () => {
    const h = makeBridge()
    render(<PortsPanel visible bridge={h.bridge} />)
    await h.ready()
    await h.push({ ports: [entry({ port: 3000 })], newKeys: [] })
    fireEvent.click(screen.getByTestId("port-row-3000"))
    expect(h.bridge.open).toHaveBeenCalledWith(3000)
  })

  test("Enter on a focused row opens the port", async () => {
    const h = makeBridge()
    render(<PortsPanel visible bridge={h.bridge} />)
    await h.ready()
    await h.push({ ports: [entry({ port: 4000 })], newKeys: [] })
    fireEvent.keyDown(screen.getByTestId("port-row-4000"), { key: "Enter" })
    expect(h.bridge.open).toHaveBeenCalledWith(4000)
  })
})

describe("context menu actions", () => {
  async function openMenu(h: ReturnType<typeof makeBridge>, e: PortEntryLike) {
    render(<PortsPanel visible bridge={h.bridge} />)
    await h.ready()
    await h.push({ ports: [e], newKeys: [] })
    fireEvent.contextMenu(screen.getByTestId(`port-row-${e.port}`))
    return screen.getByTestId("ports-context-menu")
  }

  test("copy local address writes the forwarded URL to the clipboard", async () => {
    const h = makeBridge()
    const menu = await openMenu(h, entry({ port: 3000, address: "127.0.0.1" }))
    fireEvent.click(within(menu, "Copy Local Address"))
    await waitFor(() => expect(clipboardWrites).toContain("http://localhost:3000"))
  })

  test("copy command line fetches via bridge then writes it", async () => {
    const h = makeBridge({ commandLine: "node /app/server.js --port 3000" })
    const menu = await openMenu(h, entry({ port: 3000, pid: 777 }))
    fireEvent.click(within(menu, "Copy Command Line"))
    await waitFor(() => expect(h.bridge.getCommandLine).toHaveBeenCalledWith(777))
    await waitFor(() => expect(clipboardWrites).toContain("node /app/server.js --port 3000"))
  })

  test("kill calls the bridge with the pid", async () => {
    const h = makeBridge()
    const menu = await openMenu(h, entry({ port: 3000, pid: 555 }))
    fireEvent.click(within(menu, "Stop Forwarding (Kill Process)"))
    await waitFor(() => expect(h.bridge.kill).toHaveBeenCalledWith(555))
  })
})

// Small helper: find a <button role=menuitem> by its text within a container.
function within(container: HTMLElement, text: string): HTMLElement {
  const items = Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]'))
  const match = items.find((el) => el.textContent?.trim() === text)
  if (!match) throw new Error(`menu item "${text}" not found (have: ${items.map((i) => i.textContent).join(", ")})`)
  return match
}
