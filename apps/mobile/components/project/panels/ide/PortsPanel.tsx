// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Ports tab — live table of listening TCP ports.
 *
 * Subscribes to `window.shogoDesktopPorts` (exposed by the Electron preload)
 * for the data plane. On non-desktop runtimes (mobile web build, e.g. when
 * Storybook compiles this file) the bridge is absent and we fall back to a
 * "desktop only" empty state — that keeps the file safe to bundle into web
 * without polluting it with `if (typeof window === 'undefined')` everywhere.
 *
 * Columns: Port · Forwarded Address · Running Process · Local Address · Visibility
 * (matches VS Code 1.95's Ports view exactly.)
 *
 * Row interactions:
 *   - left-click / Enter   → open `http://localhost:<port>` in default browser
 *   - right-click          → context menu (copy address, copy command-line, kill)
 *   - keyboard nav         → ArrowUp / ArrowDown moves selection
 *
 * "New" rows (detected on the most recent poll) animate a 200ms highlight
 * pulse via the `port-row-new` class — see ports-panel.css below.
 */

import * as React from 'react'

// ─── bridge typing (shape mirrors apps/desktop/src/preload-ports.ts) ─────

interface PortEntryLike {
  port: number
  command: string
  pid: number
  address: string
  type: 'IPv4' | 'IPv6'
}

interface ListMessage {
  ports: PortEntryLike[]
  newKeys: string[]
}

interface ShogoDesktopPortsBridgeLike {
  subscribe(opts: {
    onList(msg: ListMessage): void
    onUnsupported(): void
  }): Promise<() => Promise<void>>
  open(port: number): Promise<{ ok: boolean; error?: string }>
  kill(pid: number): Promise<{ ok: boolean; error?: string }>
  getCommandLine(pid: number): Promise<{ ok: boolean; commandLine?: string; error?: string }>
}

declare global {
  interface Window {
    shogoDesktopPorts?: ShogoDesktopPortsBridgeLike
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────

type Status = 'loading' | 'ready' | 'unsupported' | 'no-bridge'

/**
 * Format the row's address column the way VS Code does:
 *   * (wildcard) → "All interfaces"
 *   * 127.0.0.1  → "Private"
 *   * ::1, ::    → IPv6 forms, displayed as-is
 *   * other      → as-is
 */
function visibilityLabel(address: string): string {
  if (address === '*' || address === '0.0.0.0' || address === '::') return 'Public'
  if (address === '127.0.0.1' || address === '::1' || address === 'localhost') return 'Private'
  return address
}

/**
 * "Forwarded address" — the URL you'd point a browser at to reach the port.
 * For wildcard or loopback binds we always show localhost (that's what
 * actually works); for non-loopback specific binds we show the bound address.
 */
function forwardedAddress(port: number, address: string): string {
  if (address === '*' || address === '0.0.0.0' || address === '127.0.0.1'
      || address === '::' || address === '::1' || address === 'localhost') {
    return `http://localhost:${port}`
  }
  // IPv6 literal needs brackets in URLs.
  if (address.includes(':')) return `http://[${address}]:${port}`
  return `http://${address}:${port}`
}

async function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    try { await navigator.clipboard.writeText(text); return } catch { /* fall through */ }
  }
  // Fallback for environments without the async clipboard API (older Electron,
  // tests). Use a transient textarea + execCommand.
  if (typeof document === 'undefined') return
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try { document.execCommand('copy') } catch { /* swallow */ }
  document.body.removeChild(ta)
}

// ─── component ───────────────────────────────────────────────────────────

interface ContextMenuState {
  x: number
  y: number
  entry: PortEntryLike
}

export interface PortsPanelProps {
  visible: boolean
  /** Override the global bridge — handy for tests. */
  bridge?: ShogoDesktopPortsBridgeLike
}

export function PortsPanel({ visible, bridge: bridgeOverride }: PortsPanelProps): React.ReactElement {
  const [status, setStatus] = React.useState<Status>('loading')
  const [ports, setPorts] = React.useState<PortEntryLike[]>([])
  const [newKeys, setNewKeys] = React.useState<Set<string>>(new Set())
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null)
  const [menu, setMenu] = React.useState<ContextMenuState | null>(null)
  const newKeysTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  // Resolve the bridge once on mount. Lazy: only touch `window` inside the
  // effect so SSR / test environments without `window` don't blow up.
  const bridge = React.useMemo<ShogoDesktopPortsBridgeLike | null>(() => {
    if (bridgeOverride) return bridgeOverride
    if (typeof window === 'undefined') return null
    return window.shogoDesktopPorts ?? null
  }, [bridgeOverride])

  React.useEffect(() => {
    if (!bridge) {
      setStatus('no-bridge')
      return
    }

    let disposed = false
    let unsub: (() => Promise<void>) | null = null

    void bridge.subscribe({
      onList(msg) {
        if (disposed) return
        setStatus('ready')
        setPorts(msg.ports)
        if (msg.newKeys.length > 0) {
          setNewKeys(new Set(msg.newKeys))
          if (newKeysTimerRef.current) clearTimeout(newKeysTimerRef.current)
          newKeysTimerRef.current = setTimeout(() => {
            if (!disposed) setNewKeys(new Set())
          }, 220)
        }
      },
      onUnsupported() {
        if (disposed) return
        setStatus('unsupported')
      },
    }).then((u) => {
      if (disposed) { void u() } else { unsub = u }
    })

    return () => {
      disposed = true
      if (newKeysTimerRef.current) clearTimeout(newKeysTimerRef.current)
      if (unsub) void unsub()
    }
  }, [bridge])

  // Dismiss the context menu on any global click that isn't on the menu itself.
  React.useEffect(() => {
    if (!menu) return
    const onDoc = (): void => setMenu(null)
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onDoc)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onDoc)
    }
  }, [menu])

  const handleOpen = React.useCallback((entry: PortEntryLike): void => {
    if (!bridge) return
    void bridge.open(entry.port)
  }, [bridge])

  const handleKill = React.useCallback(async (entry: PortEntryLike): Promise<void> => {
    if (!bridge) return
    setMenu(null)
    await bridge.kill(entry.pid)
  }, [bridge])

  const handleCopyAddress = React.useCallback(async (entry: PortEntryLike): Promise<void> => {
    setMenu(null)
    await copyToClipboard(forwardedAddress(entry.port, entry.address))
  }, [])

  const handleCopyCommandLine = React.useCallback(async (entry: PortEntryLike): Promise<void> => {
    if (!bridge) return
    setMenu(null)
    const res = await bridge.getCommandLine(entry.pid)
    if (res.ok && res.commandLine) await copyToClipboard(res.commandLine)
  }, [bridge])

  const handleRowKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLTableRowElement>, entry: PortEntryLike): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handleOpen(entry)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const i = ports.findIndex((p) => `${p.port}:${p.pid}` === `${entry.port}:${entry.pid}`)
      const next = e.key === 'ArrowDown' ? Math.min(i + 1, ports.length - 1) : Math.max(i - 1, 0)
      const nextEntry = ports[next]
      if (nextEntry) {
        const key = `${nextEntry.port}:${nextEntry.pid}`
        setSelectedKey(key)
        const row = document.querySelector<HTMLElement>(`[data-port-row-key="${key}"]`)
        row?.focus()
      }
    }
  }, [ports, handleOpen])

  // ─── render branches ──────────────────────────────────────────────────

  if (status === 'no-bridge') {
    return (
      <EmptyState
        visible={visible}
        heading="Ports tab is desktop-only"
        body="Open this workspace in Shogo Desktop to see the live list of listening ports."
      />
    )
  }
  if (status === 'unsupported') {
    return (
      <EmptyState
        visible={visible}
        heading="`lsof` not available"
        body="The Ports tab needs `lsof` to enumerate listening sockets. Install it (or the platform-specific equivalent) and reopen this tab."
      />
    )
  }
  if (status === 'loading') {
    return (
      <EmptyState
        visible={visible}
        heading="Scanning ports…"
        body="Reading `lsof -iTCP -sTCP:LISTEN`."
      />
    )
  }
  if (ports.length === 0) {
    return (
      <EmptyState
        visible={visible}
        heading="No forwarded ports"
        body="Run a dev server (e.g. `vite`, `next dev`) and the listening port will appear here within a few seconds."
      />
    )
  }

  return (
    <div
      data-testid="bottompanel-pane-ports"
      aria-hidden={!visible}
      className="relative flex h-full w-full flex-col overflow-hidden bg-[#1e1e1e] text-[#cccccc]"
    >
      <PortsStyles />
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-[12px]" role="table" aria-label="Forwarded ports">
          <thead className="sticky top-0 z-10 bg-[#252526] text-[11px] uppercase tracking-wider text-[#858585]">
            <tr>
              <th className="px-3 py-1.5 text-left font-semibold">Port</th>
              <th className="px-3 py-1.5 text-left font-semibold">Forwarded Address</th>
              <th className="px-3 py-1.5 text-left font-semibold">Running Process</th>
              <th className="px-3 py-1.5 text-left font-semibold">Local Address</th>
              <th className="px-3 py-1.5 text-left font-semibold">Visibility</th>
            </tr>
          </thead>
          <tbody>
            {ports.map((p) => {
              const key = `${p.port}:${p.pid}`
              const isNew = newKeys.has(key)
              const isSelected = selectedKey === key
              return (
                <tr
                  key={key}
                  data-port-row-key={key}
                  data-testid={`port-row-${p.port}`}
                  tabIndex={0}
                  role="row"
                  aria-selected={isSelected}
                  onClick={() => handleOpen(p)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setMenu({ x: e.clientX, y: e.clientY, entry: p })
                  }}
                  onFocus={() => setSelectedKey(key)}
                  onKeyDown={(e) => handleRowKeyDown(e, p)}
                  className={[
                    'cursor-pointer border-b border-[#2d2d2d] hover:bg-[#2a2d2e] focus:bg-[#062f4a] focus:outline-none',
                    isSelected ? 'bg-[#062f4a]' : '',
                    isNew ? 'port-row-new' : '',
                  ].join(' ').trim()}
                >
                  <td className="px-3 py-1.5 font-mono">{p.port}</td>
                  <td className="px-3 py-1.5 font-mono text-[#3794ff] underline-offset-2 hover:underline">
                    {forwardedAddress(p.port, p.address)}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className="font-mono">{p.command}</span>
                    <span className="ml-2 text-[#858585]">({p.pid})</span>
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[#cccccc]">{p.address}</td>
                  <td className="px-3 py-1.5">{visibilityLabel(p.address)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {menu && (
        <PortsContextMenu
          x={menu.x}
          y={menu.y}
          entry={menu.entry}
          onOpen={handleOpen}
          onCopyAddress={handleCopyAddress}
          onCopyCommandLine={handleCopyCommandLine}
          onKill={handleKill}
        />
      )}
    </div>
  )
}

// ─── subcomponents ───────────────────────────────────────────────────────

function EmptyState({ visible, heading, body }: { visible: boolean; heading: string; body: string }): React.ReactElement {
  return (
    <div
      data-testid="bottompanel-pane-ports"
      aria-hidden={!visible}
      className="flex h-full w-full items-center justify-center bg-[#1e1e1e] text-[#858585]"
    >
      <div className="flex max-w-md flex-col items-center gap-2 px-6 text-center">
        <p className="text-xs uppercase tracking-wider text-[#858585]">Ports</p>
        <p className="text-sm text-[#cccccc]">{heading}</p>
        <p className="text-[11px] leading-snug">{body}</p>
      </div>
    </div>
  )
}

interface ContextMenuProps {
  x: number
  y: number
  entry: PortEntryLike
  onOpen(entry: PortEntryLike): void
  onCopyAddress(entry: PortEntryLike): Promise<void>
  onCopyCommandLine(entry: PortEntryLike): Promise<void>
  onKill(entry: PortEntryLike): Promise<void>
}

function PortsContextMenu({
  x, y, entry, onOpen, onCopyAddress, onCopyCommandLine, onKill,
}: ContextMenuProps): React.ReactElement {
  const ref = React.useRef<HTMLDivElement | null>(null)

  // Clamp the menu inside the viewport so we don't render off-screen near
  // the bottom-right edge.
  const [pos, setPos] = React.useState({ x, y })
  React.useLayoutEffect(() => {
    if (!ref.current) return
    const r = ref.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const nx = Math.min(x, Math.max(0, vw - r.width - 4))
    const ny = Math.min(y, Math.max(0, vh - r.height - 4))
    if (nx !== x || ny !== y) setPos({ x: nx, y: ny })
  }, [x, y])

  return (
    <div
      ref={ref}
      role="menu"
      data-testid="ports-context-menu"
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-50 min-w-[200px] rounded border border-[#454545] bg-[#252526] py-1 text-[12px] text-[#cccccc] shadow-lg"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <MenuItem label="Open in Browser" onClick={() => onOpen(entry)} />
      <MenuItem label="Copy Local Address" onClick={() => void onCopyAddress(entry)} />
      <MenuItem label="Copy Command Line" onClick={() => void onCopyCommandLine(entry)} />
      <div className="my-1 border-t border-[#3c3c3c]" />
      <MenuItem
        label="Stop Forwarding (Kill Process)"
        onClick={() => void onKill(entry)}
        destructive
      />
    </div>
  )
}

function MenuItem({ label, onClick, destructive }: { label: string; onClick(): void; destructive?: boolean }): React.ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={[
        'block w-full px-3 py-1.5 text-left hover:bg-[#094771]',
        destructive ? 'text-[#f48771]' : '',
      ].join(' ').trim()}
    >
      {label}
    </button>
  )
}

function PortsStyles(): React.ReactElement {
  // The "new row" animation lives inline so the panel is one self-contained
  // file. 200ms ease-out, fades from a bright accent to the row's base bg.
  return (
    <style>{`
      @keyframes port-row-new-pulse {
        0%   { background-color: rgba(55, 148, 255, 0.35); }
        100% { background-color: transparent; }
      }
      .port-row-new {
        animation: port-row-new-pulse 200ms ease-out;
      }
    `}</style>
  )
}
