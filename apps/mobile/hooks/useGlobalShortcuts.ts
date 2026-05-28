// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import * as React from 'react'

/**
 * Tiny global keyboard-shortcut hook used by the IDE bottom panel
 * (Phase 11) to switch tabs from anywhere — including when the
 * terminal pane has DOM focus.
 *
 * Why a hook at all rather than reusing the existing project palette?
 *
 *   The palette command system (`apps/mobile/components/project/panels/
 *   ide/commands.ts`) requires the palette to be open to dispatch.
 *   These four shortcuts (⌘⇧M, ⌘⇧U, ⌘⇧Y, ⌘\`) need to fire
 *   *unconditionally* — matching VS Code, which binds them at the
 *   workbench level. We attach a `keydown` listener in capture phase
 *   on `document` so xterm (which swallows most keys) and the Monaco
 *   editor (which swallows the rest) don't gate us out.
 *
 * Each ShortcutHandler is a tuple of `{ id, when?, run }`. `when` is
 * an optional predicate evaluated each event — return `false` to
 * skip. Useful for "only when the panel is open" gating.
 */
export interface ShortcutBinding {
  /** Stable id — used for dedupe and logging. */
  id: string
  /** Required key portion (lowercased), e.g. 'm', 'u', 'y', '`'. */
  key: string
  /** Whether Cmd (mac) / Ctrl (other) is required. Defaults to true. */
  mod?: boolean
  /** Whether Shift is required. Defaults to false. */
  shift?: boolean
  /** Whether Alt/Option is required. Defaults to false. */
  alt?: boolean
  /** Optional gate. Returning false prevents the run from firing. */
  when?(): boolean
  /** What to do when the binding fires. Receives the original event. */
  run(ev: KeyboardEvent): void
}

export interface UseGlobalShortcutsOptions {
  /** Set true on Windows / Linux to use Ctrl instead of Cmd. */
  useCtrl?: boolean
}

/**
 * Detect Mac via `navigator.platform` (cheap, sync, works in our Expo
 * web target). Server-safe — returns `false` on SSR.
 */
function isMac(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform)
}

export function useGlobalShortcuts(
  bindings: ShortcutBinding[],
  opts: UseGlobalShortcutsOptions = {},
): void {
  // Hold the latest bindings in a ref so we don't rebind the document
  // listener on every parent re-render (which would also be a memory
  // leak vector in dev because of double-mount).
  const ref = React.useRef(bindings)
  ref.current = bindings

  React.useEffect(() => {
    const useCtrl = opts.useCtrl ?? !isMac()
    const onKey = (ev: KeyboardEvent) => {
      const modOk = useCtrl ? (ev.ctrlKey && !ev.metaKey) : (ev.metaKey && !ev.ctrlKey)
      for (const b of ref.current) {
        const wantsMod = b.mod ?? true
        if (wantsMod !== modOk) continue
        if ((b.shift ?? false) !== ev.shiftKey) continue
        if ((b.alt ?? false) !== ev.altKey) continue
        if (b.key.toLowerCase() !== ev.key.toLowerCase()) continue
        if (b.when && !b.when()) continue
        ev.preventDefault()
        ev.stopPropagation()
        try {
          b.run(ev)
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`[useGlobalShortcuts] binding ${b.id} threw:`, err)
        }
        return // first match wins
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [opts.useCtrl])
}
