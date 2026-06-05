// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SidebarContextMenu - lightweight web-only right-click menu for the app
 * sidebar's project and chat rows.
 *
 * Modeled on components/project/panels/ide/ContextMenu.tsx but styled with the
 * app's semantic NativeWind tokens (popover / accent / destructive). It renders
 * a fixed-position DOM node, so it is web-only; callers gate the trigger behind
 * `Platform.OS === 'web'` (right-click / `onContextMenu`).
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { Platform } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'

export interface SidebarMenuItem {
  label: string
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  separator?: false
  onSelect: () => void
}

export type SidebarMenuEntry = SidebarMenuItem | { separator: true }

const MENU_WIDTH = 200
const ITEM_HEIGHT = 32

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

  if (Platform.OS !== 'web') return null

  // Keep the menu inside the viewport.
  const maxX = typeof window !== 'undefined' ? window.innerWidth - MENU_WIDTH - 8 : x
  const maxY =
    typeof window !== 'undefined' ? window.innerHeight - items.length * ITEM_HEIGHT - 16 : y

  return (
    <div
      ref={ref}
      role="menu"
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
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={(it as SidebarMenuItem).disabled}
            style={{ fontFamily: 'inherit' }}
            onClick={() => {
              (it as SidebarMenuItem).onSelect()
              onClose()
            }}
            className={cn(
              'flex w-full items-center gap-2.5 border-0 bg-transparent px-3 py-1.5 text-left text-[13px]',
              (it as SidebarMenuItem).disabled
                ? 'cursor-not-allowed text-muted-foreground opacity-50'
                : (it as SidebarMenuItem).danger
                  ? 'cursor-pointer text-destructive hover:bg-destructive/10'
                  : 'cursor-pointer text-popover-foreground hover:bg-accent',
            )}
          >
            {(it as SidebarMenuItem).icon ? (
              <span className="flex items-center justify-center">{(it as SidebarMenuItem).icon}</span>
            ) : null}
            <span className="flex-1">{(it as SidebarMenuItem).label}</span>
          </button>
        ),
      )}
    </div>
  )
}
