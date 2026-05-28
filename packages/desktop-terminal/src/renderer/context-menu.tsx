// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * VS Code-parity right-click context menu for the terminal surface.
 *
 * Standalone — no external UI deps. Lives in the same package as the
 * surface (lazy-loaded only in Desktop) so the mobile/web bundle never
 * pulls it in.
 *
 * Menu ordering (exactly matches VS Code 1.95):
 *   Copy
 *   Copy as HTML
 *   Paste
 *   ─
 *   Select All
 *   Find
 *   ─
 *   Kill
 *   Rename
 *   Configure
 *   Change Icon  ▶  (icon picker submenu)
 *   Change Color ▶  (8-swatch submenu)
 *   Split
 *   ─
 *   Run Recent
 *   Clear
 */
import * as React from 'react'

export interface TerminalContextMenuAction {
  /** Visible label. */
  label: string
  /** Called when clicked. Menu auto-closes after. */
  onSelect?: () => void | Promise<void>
  /** When true, the row is greyed out and unclickable. */
  disabled?: boolean
  /** Right-aligned keyboard hint like '⌘C'. */
  shortcut?: string
  /** Nested submenu items — opens on hover with a 200ms delay. */
  submenu?: TerminalContextMenuAction[]
  /** Used for color swatches — renders a 12px dot before the label. */
  swatch?: string
}

export interface TerminalContextMenuProps {
  /** Top-level groups, separated by '─' rows in the rendered output. */
  groups: TerminalContextMenuAction[][]
  /** Where to anchor the menu (page-coordinate, from contextmenu event). */
  x: number
  y: number
  /** Called when the menu should dismiss (outside click, Esc, item select). */
  onDismiss(): void
}

const ROW_HEIGHT = 24
const MENU_MIN_WIDTH = 220
const SUBMENU_DELAY_MS = 200

/**
 * Build the canonical VS Code action list. Caller wires real handlers per
 * item — anything left without `onSelect` is rendered disabled.
 */
export function buildVsCodeMenuGroups(opts: {
  hasSelection: boolean
  hasClipboard: boolean
  hasProcess: boolean
  isEmpty: boolean
  recentCommands: ReadonlyArray<{ label: string; onSelect(): void }>
  colors: ReadonlyArray<{ label: string; hex: string; onSelect(): void }>
  icons: ReadonlyArray<{ label: string; onSelect(): void }>
  onCopy(): void
  onCopyAsHtml(): void
  onPaste(): void
  onSelectAll(): void
  onFind(): void
  onKill(): void
  onRename(): void
  onConfigure(): void
  onSplit(): void
  onClear(): void
}): TerminalContextMenuAction[][] {
  return [
    [
      { label: 'Copy', shortcut: '⌘C', disabled: !opts.hasSelection, onSelect: opts.onCopy },
      { label: 'Copy as HTML', disabled: !opts.hasSelection, onSelect: opts.onCopyAsHtml },
      { label: 'Paste', shortcut: '⌘V', disabled: !opts.hasClipboard, onSelect: opts.onPaste },
    ],
    [
      { label: 'Select All', shortcut: '⌘A', onSelect: opts.onSelectAll },
      { label: 'Find', shortcut: '⌘F', disabled: opts.isEmpty, onSelect: opts.onFind },
    ],
    [
      { label: 'Kill', disabled: !opts.hasProcess, onSelect: opts.onKill },
      { label: 'Rename', onSelect: opts.onRename },
      { label: 'Configure', onSelect: opts.onConfigure },
      {
        label: 'Change Icon',
        submenu: opts.icons.length > 0
          ? opts.icons.map((it) => ({ label: it.label, onSelect: it.onSelect }))
          : [{ label: '(no icons configured)', disabled: true }],
      },
      {
        label: 'Change Color',
        submenu: opts.colors.length > 0
          ? opts.colors.map((c) => ({ label: c.label, swatch: c.hex, onSelect: c.onSelect }))
          : [{ label: '(no colors configured)', disabled: true }],
      },
      { label: 'Split', shortcut: '⌘\\', onSelect: opts.onSplit },
    ],
    [
      {
        label: 'Run Recent',
        disabled: opts.recentCommands.length === 0,
        submenu: opts.recentCommands.length > 0
          ? opts.recentCommands.map((c) => ({ label: c.label, onSelect: c.onSelect }))
          : [{ label: '(no recent commands)', disabled: true }],
      },
      { label: 'Clear', shortcut: '⌘K', onSelect: opts.onClear },
    ],
  ]
}

/**
 * Floating menu. We position with raw CSS rather than a portal helper
 * because the surface already establishes its own positioning context.
 * Caller is expected to render this as a sibling of the host div.
 */
export function TerminalContextMenu(props: TerminalContextMenuProps): React.ReactElement | null {
  const { groups, x, y, onDismiss } = props
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const [openSubmenu, setOpenSubmenu] = React.useState<string | null>(null)
  const submenuTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    const onDocMouseDown = (ev: MouseEvent) => {
      if (!rootRef.current) return
      if (!rootRef.current.contains(ev.target as Node)) onDismiss()
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') { ev.preventDefault(); onDismiss() }
    }
    document.addEventListener('mousedown', onDocMouseDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [onDismiss])

  React.useEffect(() => () => {
    if (submenuTimer.current) clearTimeout(submenuTimer.current)
  }, [])

  // Clamp to viewport so right-clicks near the right/bottom edge don't
  // render the menu offscreen.
  const left = React.useMemo(() => {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 9999
    return Math.min(x, Math.max(0, vw - MENU_MIN_WIDTH - 4))
  }, [x])
  const top = React.useMemo(() => {
    const vh = typeof window !== 'undefined' ? window.innerHeight : 9999
    const estHeight = groups.reduce((s, g) => s + g.length, 0) * ROW_HEIGHT + (groups.length - 1) * 9
    return Math.min(y, Math.max(0, vh - estHeight - 4))
  }, [y, groups])

  const flatItems: Array<{ kind: 'item'; item: TerminalContextMenuAction; key: string } | { kind: 'sep'; key: string }> = []
  groups.forEach((group, gi) => {
    if (gi > 0) flatItems.push({ kind: 'sep', key: `sep-${gi}` })
    group.forEach((item, ii) => flatItems.push({ kind: 'item', item, key: `g${gi}i${ii}` }))
  })

  const handleSelect = (item: TerminalContextMenuAction) => {
    if (item.disabled || item.submenu) return
    onDismiss()
    Promise.resolve().then(() => item.onSelect?.()).catch(() => undefined)
  }

  const handleHover = (key: string, item: TerminalContextMenuAction) => {
    if (submenuTimer.current) clearTimeout(submenuTimer.current)
    if (!item.submenu || item.disabled) {
      submenuTimer.current = setTimeout(() => setOpenSubmenu(null), SUBMENU_DELAY_MS)
      return
    }
    submenuTimer.current = setTimeout(() => setOpenSubmenu(key), SUBMENU_DELAY_MS)
  }

  return React.createElement('div', {
    ref: rootRef,
    role: 'menu',
    'aria-label': 'Terminal actions',
    'data-shogo-terminal-context-menu': 'true',
    style: {
      position: 'fixed',
      top,
      left,
      zIndex: 50,
      minWidth: MENU_MIN_WIDTH,
      background: '#252526',
      border: '1px solid #3c3c3c',
      borderRadius: 6,
      padding: '4px 0',
      boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
      color: '#cccccc',
      font: '13px system-ui, -apple-system, "Segoe UI", sans-serif',
      userSelect: 'none',
    },
  },
    ...flatItems.map((entry) => {
      if (entry.kind === 'sep') {
        return React.createElement('div', {
          key: entry.key,
          role: 'separator',
          style: { height: 1, margin: '4px 6px', background: '#3c3c3c' },
        })
      }
      const item = entry.item
      const isSubOpen = openSubmenu === entry.key && !!item.submenu
      return React.createElement('div', {
        key: entry.key,
        role: 'menuitem',
        'aria-disabled': item.disabled ? 'true' : undefined,
        'data-shogo-menu-item': item.label,
        tabIndex: item.disabled ? -1 : 0,
        onMouseEnter: () => handleHover(entry.key, item),
        onClick: () => handleSelect(item),
        onKeyDown: (ev: React.KeyboardEvent) => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); handleSelect(item) }
        },
        style: {
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 10px',
          height: ROW_HEIGHT,
          opacity: item.disabled ? 0.4 : 1,
          cursor: item.disabled ? 'default' : 'pointer',
          background: isSubOpen ? '#094771' : 'transparent',
        },
      },
        item.swatch
          ? React.createElement('span', {
              'aria-hidden': true,
              style: {
                width: 12,
                height: 12,
                borderRadius: '50%',
                background: item.swatch,
                border: '1px solid rgba(255,255,255,0.2)',
                flexShrink: 0,
              },
            })
          : null,
        React.createElement('span', { style: { flex: 1, whiteSpace: 'nowrap' } }, item.label),
        item.shortcut
          ? React.createElement('span', { style: { color: '#8a8a8a', fontSize: 11, marginLeft: 12 } }, item.shortcut)
          : null,
        item.submenu
          ? React.createElement('span', { 'aria-hidden': true, style: { color: '#8a8a8a', marginLeft: 6 } }, '▸')
          : null,
        // Inline submenu — rendered when this row is the open one.
        isSubOpen && item.submenu
          ? React.createElement(TerminalContextMenu, {
              groups: [item.submenu],
              x: left + MENU_MIN_WIDTH + 2,
              y: top + flatItems.findIndex((e) => 'key' in e && e.key === entry.key) * ROW_HEIGHT,
              onDismiss,
            })
          : null,
      )
    }),
  )
}
