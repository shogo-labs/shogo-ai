// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SidebarContextMenu - lightweight web-only right-click menu for the app
 * sidebar's project and chat rows.
 *
 * Modeled on components/project/panels/ide/ContextMenu.tsx but styled with the
 * app's semantic NativeWind tokens (popover / accent / destructive). It renders
 * a fixed-position DOM node portaled to <body>, so it is web-only; callers gate
 * the trigger behind `Platform.OS === 'web'` (right-click / `onContextMenu`).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Platform } from 'react-native'
import { createPortal } from 'react-dom'
import { ChevronRight } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

export interface SidebarMenuItem {
  label: string
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  separator?: false
  /** Nested items: the row grows a chevron and opens a flyout instead of selecting. */
  children?: SidebarMenuEntry[]
  onSelect?: () => void
}

export type SidebarMenuEntry = SidebarMenuItem | { separator: true }

const MENU_WIDTH = 200
const ITEM_HEIGHT = 32

/** One row. Items with `children` open a nested flyout on hover (and on click). */
function MenuRow({
  item,
  onClose,
  flip,
}: {
  item: SidebarMenuItem
  onClose: () => void
  flip: boolean
}) {
  const [open, setOpen] = useState(false)
  const children = item.children ?? []
  const hasChildren = children.length > 0
  const disabled = !!item.disabled
  const close = () => setOpen(false)

  return (
    <div
      className="relative"
      onMouseEnter={() => {
        if (hasChildren && !disabled) setOpen(true)
      }}
      onMouseLeave={close}
    >
      <button
        type="button"
        role="menuitem"
        aria-haspopup={hasChildren ? 'menu' : undefined}
        aria-expanded={hasChildren ? open : undefined}
        disabled={disabled}
        style={{ fontFamily: 'inherit' }}
        onClick={() => {
          if (disabled) return
          // A parent row never fires its own action while it has children: it
          // toggles the flyout, so a click can't silently do the wrong thing.
          if (hasChildren) {
            setOpen((o) => !o)
            return
          }
          item.onSelect?.()
          onClose()
        }}
        className={cn(
          'flex w-full items-center gap-2.5 border-0 bg-transparent px-3 py-1.5 text-left text-[13px]',
          disabled
            ? 'cursor-not-allowed text-muted-foreground opacity-50'
            : item.danger
              ? 'cursor-pointer text-destructive hover:bg-destructive/10'
              : 'cursor-pointer text-popover-foreground hover:bg-accent',
          hasChildren && open && !disabled ? 'bg-accent' : '',
        )}
      >
        {item.icon ? <span className="flex items-center justify-center">{item.icon}</span> : null}
        <span className="flex-1">{item.label}</span>
        {hasChildren ? <ChevronRight size={13} className="text-muted-foreground" /> : null}
      </button>
      {hasChildren && open ? (
        <div
          role="menu"
          className="absolute top-0 min-w-[200px] rounded-md border border-border bg-popover py-1"
          style={{
            // No gap between the row and its flyout: a dead pixel strip makes
            // the hover hand-off flicker the submenu closed.
            ...(flip ? { right: '100%' } : { left: '100%' }),
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
          }}
        >
          {children.map((child, i) =>
            'separator' in child && child.separator ? (
              <div key={i} className="my-1 h-px bg-border" />
            ) : (
              <MenuRow key={i} item={child as SidebarMenuItem} onClose={onClose} flip={flip} />
            ),
          )}
        </div>
      ) : null}
    </div>
  )
}

export function SidebarContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number
  y: number
  items: SidebarMenuEntry[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    // `mousedown` fires before a fresh `contextmenu`, so right-clicking another
    // row dismisses this menu first — only one stays open at a time.
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  if (Platform.OS !== 'web' || typeof document === 'undefined') return null

  // Keep the menu inside the viewport.
  const maxX = typeof window !== 'undefined' ? window.innerWidth - MENU_WIDTH - 8 : x
  const maxY =
    typeof window !== 'undefined' ? window.innerHeight - items.length * ITEM_HEIGHT - 16 : y
  // A flyout needs a second menu-width of room; otherwise it opens to the left.
  const flip =
    typeof window !== 'undefined' ? Math.min(x, maxX) + MENU_WIDTH * 2 + 16 > window.innerWidth : false

  // Portal to <body> so the menu escapes the sidebar's scroll/overflow and any
  // transformed ancestor (RNW wraps Views in transforms, which trap `position:
  // fixed` and confine z-index to that ancestor's stacking context). At the body
  // level the menu is genuinely top-most and intercepts its own pointer events,
  // so rows beneath no longer receive the hover/click. `stopPropagation` below
  // also blocks React-tree bubbling, which a portal otherwise preserves.
  return createPortal(
    <div
      ref={ref}
      role="menu"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      style={{
        position: 'fixed',
        left: Math.max(8, Math.min(x, maxX)),
        top: Math.max(8, Math.min(y, maxY)),
        zIndex: 9999,
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
      }}
      className="min-w-[200px] rounded-md border border-border bg-popover py-1"
    >
      {items.map((it, i) =>
        'separator' in it && it.separator ? (
          <div key={i} className="my-1 h-px bg-border" />
        ) : (
          <MenuRow key={i} item={it as SidebarMenuItem} onClose={onClose} flip={flip} />
        ),
      )}
    </div>,
    document.body,
  )
}
