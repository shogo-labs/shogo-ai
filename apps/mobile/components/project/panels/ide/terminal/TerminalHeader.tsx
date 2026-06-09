// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * VS Code-style terminal panel header — the strip above the xterm grid.
 *
 * Right-side button cluster (left → right):
 *   1. Shell-name dropdown          — `▶ zsh ▾`, opens profile picker
 *   2. + (new terminal)             — default new with current profile
 *   3. ▾ (new-with-profile menu)    — pick a non-default shell
 *   4. □ split-pane                 — emits onSplit
 *   5. 🗑️ kill (terminal)           — closes the active session; confirms when running
 *   6. ⋯ more menu                  — Stop, Clear, Find, Rename, Configure, Run Recent
 *
 * Maximize/close at the far right are PANEL-LEVEL (Phase 11), not terminal-level.
 *
 * Implementation note: this file deliberately uses raw <div>/<button> + lucide-react
 * icons rather than shadcn primitives, matching the rest of apps/mobile (which runs
 * under React Native + Expo Web and ships its own gluestack-ui set). A small
 * `useMenu()` helper handles click-outside dismissal for the three dropdowns.
 */
import {
  ChevronDown,
  MoreHorizontal,
  Plus,
  Square as StopIcon,
  SquareSplitHorizontal,
  SquareSplitVertical,
  Terminal as TerminalIcon,
  Trash2,
} from 'lucide-react-native'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { ShellName } from './useShellName'

// Known profiles surfaced in the dropdowns. Source-defined for now; once the
// desktop bridge exposes a real profile registry we'll source from there.
const KNOWN_PROFILES: { id: ShellName; label: string; binary: string }[] = [
  { id: 'zsh', label: 'zsh', binary: '/bin/zsh' },
  { id: 'bash', label: 'bash', binary: '/bin/bash' },
  { id: 'fish', label: 'fish', binary: '/opt/homebrew/bin/fish' },
  { id: 'pwsh', label: 'PowerShell', binary: 'pwsh' },
  { id: 'sh', label: 'sh', binary: '/bin/sh' },
]

export interface TerminalHeaderProps {
  shellName: ShellName
  onPickProfile: (next: ShellName) => void

  onNew: () => void
  onNewWithProfile?: (profile: ShellName) => void

  onSplit: () => void
  /**
   * Phase 3 — vertical split. When provided, a second split button is
   * rendered after the horizontal-split button. Leaving this undefined
   * preserves the pre-Phase-3 single-button layout for any caller that
   * hasn't been updated.
   */
  onSplitDown?: () => void

  /** Close the active terminal tab (kills the PTY). */
  onKill: () => void
  /** True when a foreground command is running — we ask before killing. */
  running: boolean

  /** Send SIGINT to the foreground command. Shown inside the … menu. */
  onStop: () => void
  /** Clear the scrollback. Shown inside the … menu. */
  onClear: () => void
  clearDisabled: boolean

  /** Phase 4/5 hooks — wired through to the existing terminal actions. */
  onFind?: () => void
  onRename?: () => void
  onConfigure?: () => void
  onRunRecent?: () => void
  onNewWithProfile?: (profile: ShellName) => void
  onSplitWithProfile?: (profile: ShellName) => void
  onSelectDefaultProfile?: (profile: ShellName) => void
  onRunTask?: () => void
  onConfigureTasks?: () => void
}

const ICON_BTN =
  'flex shrink-0 items-center rounded p-[4px] text-[#cccccc] hover:bg-[#ffffff1a] hover:text-white focus:outline focus:outline-1 focus:outline-[#0078d4] transition-colors'

/** Tiny click-outside dismiss helper for the three dropdowns. */
function useMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return { open, setOpen, ref }
}

export function TerminalHeader(props: TerminalHeaderProps) {
  const profileMenu = useMenu()
  const launchMenu = useMenu()
  const moreMenu = useMenu()
  const [killOpen, setKillOpen] = useState(false)

  const askKill = () => {
    if (props.running) setKillOpen(true)
    else props.onKill()
  }

  return (
    <div data-testid="terminal-header" className="flex h-full items-center gap-[1px] px-[2px]">
      {/* 1. Shell-name label (shows current default, opens VS Code dropdown) */}
      <div ref={launchMenu.ref} className="relative">
        <button
          type="button"
          aria-label="Terminal Profile"
          aria-haspopup="menu"
          aria-expanded={profileMenu.open}
          onClick={() => launchMenu.setOpen((v) => !v)}
          className="flex shrink-0 items-center gap-[4px] rounded px-[6px] py-[3px] text-[12px] text-[#cccccc] hover:bg-[#ffffff1a] hover:text-white transition-colors"
          title="Terminal Actions"
        >
          <TerminalIcon size={12} />
          <span className="font-normal">{props.shellName}</span>
          <ChevronDown size={10} className="text-[#858585]" />
        </button>
      </div>

      {/* 2. + new terminal */}
      <button
        type="button"
        onClick={props.onNew}
        aria-label="New Terminal"
        className={ICON_BTN}
        title="New Terminal  (⌘⇧`)"
      >
        <Plus size={14} />
      </button>

      {/* 3. ▾ VS Code terminal dropdown menu */}
      <TerminalDropdownMenu
        open={launchMenu.open}
        onToggle={() => launchMenu.setOpen((v) => !v)}
        onClose={() => launchMenu.setOpen(false)}
        triggerRef={launchMenu.ref}
        shellName={props.shellName}
        onNew={props.onNew}
        onNewWithProfile={(p) => { props.onNewWithProfile?.(p); launchMenu.setOpen(false) }}
        onSplit={props.onSplit}
        onSplitDown={props.onSplitDown}
        onSplitWithProfile={(p) => { props.onSplitWithProfile?.(p); launchMenu.setOpen(false) }}
        onConfigure={props.onConfigure}
        onSelectDefaultProfile={(p) => { props.onPickProfile(p); launchMenu.setOpen(false) }}
        onRunTask={props.onRunTask}
        onConfigureTasks={props.onConfigureTasks}
      />

      {/* 4. □ split right */}
      <button
        type="button"
        onClick={props.onSplit}
        aria-label="Split Terminal Right"
        className={ICON_BTN}
        title="Split Terminal Right  (⌘\)"
      >
        <SquareSplitHorizontal size={12} />
      </button>

      {/* 4b. □ split down (Phase 3) */}
      {props.onSplitDown && (
        <button
          type="button"
          onClick={props.onSplitDown}
          aria-label="Split Terminal Down"
          className={ICON_BTN}
          title="Split Terminal Down  (⌘⇧\)"
        >
          <SquareSplitVertical size={12} />
        </button>
      )}

      {/* 5. 🗑️ kill */}
      <button
        type="button"
        onClick={askKill}
        aria-label="Kill Terminal"
        className={`${ICON_BTN} ${props.running ? 'text-[#f48771] hover:text-[#f48771]' : ''}`}
        title="Kill Terminal"
      >
        <Trash2 size={14} />
      </button>

      {/* 6. ⋯ more menu */}
      <div ref={moreMenu.ref} className="relative">
        <button
          type="button"
          aria-label="Views and More Actions"
          aria-haspopup="menu"
          aria-expanded={moreMenu.open}
          onClick={() => moreMenu.setOpen((v) => !v)}
          className={ICON_BTN}
          title="Views and More Actions…"
        >
          <MoreHorizontal size={15} />
        </button>
        {moreMenu.open && (
          <div
            role="menu"
            className="absolute right-0 top-full z-50 mt-1 min-w-[220px] rounded border border-[#454545] bg-[#252526] py-1 shadow-lg"
          >
            {props.running && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    props.onStop()
                    moreMenu.setOpen(false)
                  }}
                  className="flex w-full items-center px-3 py-1 text-left text-[12px] text-[#f48771] hover:bg-[#04395e]"
                >
                  <StopIcon size={11} className="mr-2" />
                  Stop Running Command
                  <span className="ml-auto text-[10px] text-[#858585]">⌃C</span>
                </button>
                <div className="my-1 h-px bg-[#454545]" />
              </>
            )}
            <MenuItem
              label="Clear"
              shortcut="⌘K"
              disabled={props.clearDisabled}
              onClick={() => {
                props.onClear()
                moreMenu.setOpen(false)
              }}
            />
            <MenuItem
              label="Find…"
              shortcut="⌘F"
              onClick={() => {
                props.onFind?.()
                moreMenu.setOpen(false)
              }}
            />
            <MenuItem
              label="Run Recent Command…"
              onClick={() => {
                props.onRunRecent?.()
                moreMenu.setOpen(false)
              }}
            />
            <div className="my-1 h-px bg-[#454545]" />
            <MenuItem
              label="Rename…"
              onClick={() => {
                props.onRename?.()
                moreMenu.setOpen(false)
              }}
            />
            <MenuItem
              label="Configure Terminal Settings"
              onClick={() => {
                props.onConfigure?.()
                moreMenu.setOpen(false)
              }}
            />
          </div>
        )}
      </div>

      {killOpen && createPortal(
        <div
          role="presentation"
          className="fixed inset-0 z-[2147483647] flex items-center justify-center bg-black/55 p-4"
          onClick={() => setKillOpen(false)}
        >
          <div
            role="alertdialog"
            aria-labelledby="kill-title"
            aria-describedby="kill-body"
            onClick={(e) => e.stopPropagation()}
            className="max-h-[calc(100vh-32px)] w-[min(420px,calc(100vw-32px))] overflow-auto rounded border border-[#454545] bg-[#252526] p-4 text-[#cccccc] shadow-2xl"
          >
            <h2 id="kill-title" className="mb-2 text-[13px] font-semibold">Kill terminal?</h2>
            <p id="kill-body" className="mb-4 text-[12px] text-[#bdbdbd]">
              A process is still running in this terminal. Killing it will end the process and close the tab.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setKillOpen(false)}
                className="rounded border border-[#454545] px-3 py-[3px] text-[11px] text-[#cccccc] hover:bg-[#ffffff1a]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setKillOpen(false)
                  props.onKill()
                }}
                className="rounded bg-[#a1260d] px-3 py-[3px] text-[11px] text-white hover:bg-[#b1320d]"
              >
                Kill terminal
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

function MenuItem(props: { label: string; shortcut?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={props.onClick}
      disabled={props.disabled}
      className="flex w-full items-center px-3 py-1 text-left text-[12px] text-[#cccccc] hover:bg-[#04395e] disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <span className="flex-1">{props.label}</span>
      {props.shortcut && <span className="ml-2 text-[10px] text-[#858585]">{props.shortcut}</span>}
    </button>
  )
}

type DropdownItem = {
  kind: 'action' | 'separator' | 'profile' | 'submenu-trigger' | 'disabled'
  label?: string
  shortcut?: string
  profile?: ShellName
  checked?: boolean
  disabled?: boolean
  subItems?: DropdownItem[]
}

function TerminalDropdownMenu(props: {
  open: boolean
  onToggle: () => void
  onClose: () => void
  triggerRef: React.RefObject<HTMLDivElement | null>
  shellName: ShellName
  onNew: () => void
  onNewWithProfile: (p: ShellName) => void
  onSplit: () => void
  onSplitDown?: () => void
  onSplitWithProfile: (p: ShellName) => void
  onConfigure: () => void
  onSelectDefaultProfile: (p: ShellName) => void
  onRunTask?: () => void
  onConfigureTasks?: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [activeIdx, setActiveIdx] = useState(-1)
  const [submenuOpen, setSubmenuOpen] = useState(false)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const submenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const items: DropdownItem[] = [
    { kind: 'action', label: 'New Terminal', shortcut: '⌃⇧`', disabled: false },
    { kind: 'action', label: 'New Terminal Window', shortcut: '⌃⇧⌥`', disabled: true },
    { kind: 'action', label: 'Split Terminal', shortcut: '⌘\\', disabled: false },
    { kind: 'separator' },
    ...KNOWN_PROFILES.map((p) => ({
      kind: 'profile' as const,
      label: p.label,
      profile: p.id,
      checked: props.shellName === p.id,
    })),
    {
      kind: 'submenu-trigger' as const,
      label: 'Split Terminal with Profile',
      subItems: KNOWN_PROFILES.map((p) => ({
        kind: 'profile' as const,
        label: p.label,
        profile: p.id,
      })),
    },
    { kind: 'separator' },
    { kind: 'action', label: 'Configure Terminal Settings', disabled: false },
    { kind: 'action', label: 'Select Default Profile', disabled: false },
    { kind: 'separator' },
    { kind: 'action', label: 'Run Task…', disabled: !props.onRunTask },
    { kind: 'action', label: 'Configure Tasks…', disabled: !props.onConfigureTasks },
  ]

  const enabledItems = items.filter((it) => it.kind !== 'separator')

  useEffect(() => {
    if (!props.open) {
      setActiveIdx(-1)
      setSubmenuOpen(false)
    }
  }, [props.open])

  useEffect(() => {
    if (!props.open) return
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) props.onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { props.onClose(); return }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIdx((prev) => {
          let next = prev + 1
          while (next < enabledItems.length && enabledItems[next].kind === 'separator') next++
          return Math.min(next, enabledItems.length - 1)
        })
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIdx((prev) => {
          let next = prev - 1
          while (next >= 0 && enabledItems[next].kind === 'separator') next--
          return Math.max(next, 0)
        })
      }
      if (e.key === 'ArrowRight') {
        const item = enabledItems[activeIdx]
        if (item?.kind === 'submenu-trigger') setSubmenuOpen(true)
      }
      if (e.key === 'ArrowLeft') {
        if (submenuOpen) setSubmenuOpen(false)
      }
      if (e.key === 'Enter' && activeIdx >= 0) {
        e.preventDefault()
        activateItem(enabledItems[activeIdx])
      }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [props.open, activeIdx, submenuOpen, enabledItems])

  const activateItem = (item: DropdownItem) => {
    if (item.kind === 'separator' || item.disabled) return
    props.onClose()
    if (item.kind === 'action') {
      if (item.label === 'New Terminal') props.onNew()
      else if (item.label === 'Split Terminal') props.onSplit()
      else if (item.label === 'Configure Terminal Settings') props.onConfigure()
      else if (item.label === 'Select Default Profile') {
        const defaultP = KNOWN_PROFILES.find((p) => p.id !== props.shellName)
        if (defaultP) props.onSelectDefaultProfile(defaultP.id)
      }
      else if (item.label === 'Run Task…') props.onRunTask?.()
      else if (item.label === 'Configure Tasks…') props.onConfigureTasks?.()
    } else if (item.kind === 'profile' && item.profile) {
      props.onNewWithProfile(item.profile)
    } else if (item.kind === 'submenu-trigger') {
      setSubmenuOpen((v) => !v)
    }
  }

  const activateSubItem = (item: DropdownItem) => {
    if (item.kind !== 'profile' || !item.profile) return
    props.onClose()
    props.onSplitWithProfile(item.profile)
  }

  const [menuPos, setMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const [subPos, setSubPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  useEffect(() => {
    if (props.open && props.triggerRef?.current) {
      const rect = props.triggerRef.current.getBoundingClientRect()
      let top = rect.bottom + 4
      let left = rect.right - 260
      if (top + 400 > window.innerHeight) top = rect.top - 400
      if (top < 0) top = 4
      if (left < 4) left = 4
      setMenuPos({ top, left })
    }
  }, [props.open])

  useEffect(() => {
    if (submenuOpen && props.triggerRef?.current) {
      const menuRect = props.triggerRef.current.getBoundingClientRect()
      const activeItem = enabledItems[activeIdx]
      if (activeItem?.kind === 'submenu-trigger') {
        const idx = enabledItems.indexOf(activeItem)
        const btnEl = itemRefs.current[idx]
        if (btnEl) {
          const itemRect = btnEl.getBoundingClientRect()
          let top = itemRect.top
          let left = menuRect.right + 2
          if (left + 220 > window.innerWidth) left = menuRect.left - 220
          if (top + 300 > window.innerHeight) top = window.innerHeight - 300
          setSubPos({ top, left })
        }
      }
    }
  }, [submenuOpen, activeIdx])

  if (!props.open) return null

  const menu = (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[2147483647] min-w-[260px] rounded-md border border-[#454545] bg-[#252526] py-1 shadow-xl"
      style={{ top: menuPos.top, left: menuPos.left }}
    >
      {items.map((item, i) => {
        if (item.kind === 'separator') {
          return <div key={`sep-${i}`} className="my-1 h-px bg-[#454545]" />
        }
        const enabledIdx = enabledItems.indexOf(item)
        const isActive = enabledIdx === activeIdx
        return (
          <button
            key={item.label}
            ref={(el) => { itemRefs.current[enabledIdx] = el }}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onMouseEnter={() => {
              setActiveIdx(enabledIdx)
              if (item.kind === 'submenu-trigger') {
                if (submenuTimerRef.current) clearTimeout(submenuTimerRef.current)
                setSubmenuOpen(true)
              }
            }}
            onMouseLeave={() => {
              if (item.kind === 'submenu-trigger') {
                submenuTimerRef.current = setTimeout(() => setSubmenuOpen(false), 200)
              }
            }}
            onClick={() => activateItem(item)}
            className={`flex w-full items-center px-3 py-[3px] text-left text-[12px] transition-colors ${
              item.disabled
                ? 'cursor-default text-[#585858]'
                : isActive
                ? 'bg-[#04395e] text-white'
                : 'text-[#cccccc] hover:bg-[#04395e]'
            }`}
          >
            {item.checked && <span className="mr-1 text-[#0078d4]">✓</span>}
            <span className="flex-1">{item.label}</span>
            {item.kind === 'submenu-trigger' && <span className="ml-2 text-[#858585]">▶</span>}
            {item.shortcut && <span className="ml-3 text-[10px] text-[#858585]">{item.shortcut}</span>}
          </button>
        )
      })}
    </div>
  )

  const submenu = submenuOpen && enabledItems[activeIdx]?.kind === 'submenu-trigger' ? (
    <div
      role="menu"
      className="fixed z-[2147483647] min-w-[220px] rounded-md border border-[#454545] bg-[#252526] py-1 shadow-xl"
      style={{ top: subPos.top, left: subPos.left }}
      onMouseEnter={() => {
        if (submenuTimerRef.current) clearTimeout(submenuTimerRef.current)
      }}
      onMouseLeave={() => setSubmenuOpen(false)}
    >
      {(enabledItems[activeIdx] as DropdownItem).subItems?.map((sub) => (
        <button
          key={sub.label}
          type="button"
          role="menuitem"
          onClick={() => activateSubItem(sub)}
          className="flex w-full items-center px-3 py-[3px] text-left text-[12px] text-[#cccccc] hover:bg-[#04395e]"
        >
          <span className="flex-1">{sub.label}</span>
        </button>
      ))}
    </div>
  ) : null

  return createPortal(
    <>
      {menu}
      {submenu}
    </>,
    document.body,
  )
}
