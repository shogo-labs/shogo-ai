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
  Terminal as TerminalIcon,
  Trash2,
} from 'lucide-react-native'
import { useEffect, useRef, useState } from 'react'

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
}

const ICON_BTN =
  'flex shrink-0 items-center rounded p-[3px] text-[#cccccc] hover:bg-[#ffffff1a] focus:outline focus:outline-1 focus:outline-[#0078d4]'

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
    <div data-testid="terminal-header" className="flex items-center gap-[2px]">
      {/* 1. Shell-name dropdown */}
      <div ref={profileMenu.ref} className="relative">
        <button
          type="button"
          aria-label="Select Default Profile"
          aria-haspopup="menu"
          aria-expanded={profileMenu.open}
          onClick={() => profileMenu.setOpen((v) => !v)}
          className="flex shrink-0 items-center gap-[3px] rounded px-[6px] py-[2px] text-[11px] text-[#cccccc] hover:bg-[#ffffff1a]"
          title="Select Default Profile"
        >
          <TerminalIcon size={11} />
          <span>{props.shellName}</span>
          <ChevronDown size={10} className="text-[#858585]" />
        </button>
        {profileMenu.open && (
          <div
            role="menu"
            className="absolute right-0 top-full z-50 mt-1 min-w-[180px] rounded border border-[#454545] bg-[#252526] py-1 shadow-lg"
          >
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-[#858585]">Default profile</div>
            {KNOWN_PROFILES.map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  props.onPickProfile(p.id)
                  profileMenu.setOpen(false)
                }}
                className="flex w-full items-center px-3 py-1 text-left text-[12px] text-[#cccccc] hover:bg-[#04395e]"
              >
                <span className="flex-1">{p.label}</span>
                {props.shellName === p.id && <span className="text-[#0078d4]">✓</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 2. + new terminal */}
      <button
        type="button"
        onClick={props.onNew}
        aria-label="New Terminal"
        className={ICON_BTN}
        title="New Terminal  (⌘⇧`)"
      >
        <Plus size={12} />
      </button>

      {/* 3. ▾ new-with-profile menu */}
      <div ref={launchMenu.ref} className="relative">
        <button
          type="button"
          aria-label="Launch Profile"
          aria-haspopup="menu"
          aria-expanded={launchMenu.open}
          onClick={() => launchMenu.setOpen((v) => !v)}
          className={ICON_BTN}
          title="Launch Profile…"
        >
          <ChevronDown size={10} />
        </button>
        {launchMenu.open && (
          <div
            role="menu"
            className="absolute right-0 top-full z-50 mt-1 min-w-[220px] rounded border border-[#454545] bg-[#252526] py-1 shadow-lg"
          >
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-[#858585]">New terminal with…</div>
            {KNOWN_PROFILES.map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  if (props.onNewWithProfile) props.onNewWithProfile(p.id)
                  else props.onNew()
                  launchMenu.setOpen(false)
                }}
                className="flex w-full items-center justify-between px-3 py-1 text-left text-[12px] text-[#cccccc] hover:bg-[#04395e]"
              >
                <span>{p.label}</span>
                <span className="text-[10px] text-[#858585]">{p.binary}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 4. □ split */}
      <button
        type="button"
        onClick={props.onSplit}
        aria-label="Split Terminal"
        className={ICON_BTN}
        title="Split Terminal  (⌘\)"
      >
        <SquareSplitHorizontal size={12} />
      </button>

      {/* 5. 🗑️ kill */}
      <button
        type="button"
        onClick={askKill}
        aria-label="Kill Terminal"
        className={`${ICON_BTN}${props.running ? ' text-[#f48771]' : ''}`}
        title="Kill Terminal"
      >
        <Trash2 size={12} />
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
          <MoreHorizontal size={14} />
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

      {/* Kill-while-running confirm modal — simple <dialog>-style overlay since
          apps/mobile doesn't have a shadcn AlertDialog import; uses the same
          DOM primitives as the rest of the panel. */}
      {killOpen && (
        <div
          role="presentation"
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
          onClick={() => setKillOpen(false)}
        >
          <div
            role="alertdialog"
            aria-labelledby="kill-title"
            aria-describedby="kill-body"
            onClick={(e) => e.stopPropagation()}
            className="w-[420px] rounded border border-[#454545] bg-[#252526] p-4 text-[#cccccc] shadow-2xl"
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
        </div>
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
