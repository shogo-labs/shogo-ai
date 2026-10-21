// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * How a file link in chat reaches the app's own viewer.
 *
 * `MarkdownText` and the tool widgets ask the nearest provider to open a file
 * instead of navigating to it. The conversation screen provides the side pane;
 * `ShareFileHost` at the app root is the fallback for every other screen
 * (project chat, search, a card), so a file link never falls through to the
 * browser no matter where it was clicked.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react"
import { parseInAppFileHref } from "../../lib/share-file-links"
import { ShareFileSheet, type ShareFileTarget } from "./ShareFileViewer"

export type { ShareFileTarget }

export type OpenShareFile = (target: ShareFileTarget) => void

const ShareFileContext = createContext<OpenShareFile | null>(null)

/** The nearest way to open a file in-app, or null when nothing can. */
export function useShareFileOpener(): OpenShareFile | null {
  return useContext(ShareFileContext)
}

export function ShareFileProvider({ open, children }: { open: OpenShareFile; children: ReactNode }) {
  return <ShareFileContext.Provider value={open}>{children}</ShareFileContext.Provider>
}

/** Event the desktop window manager dispatches for a link it refused to open. */
export const OPEN_FILE_EVENT = "shogo:open-file"

/**
 * App-wide host. Renders a modal for whatever the surrounding screen cannot
 * show in a pane, and accepts the desktop's forwarded clicks.
 */
export function ShareFileHost({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<ShareFileTarget | null>(null)
  const open = useCallback<OpenShareFile>((next) => setTarget(next), [])
  const close = useCallback(() => setTarget(null), [])

  useEffect(() => {
    if (typeof window === "undefined") return
    const onOpenFile = (event: Event) => {
      const href = (event as CustomEvent<{ href?: string }>).detail?.href
      const file = parseInAppFileHref(href)
      if (file) setTarget(file)
    }
    window.addEventListener(OPEN_FILE_EVENT, onOpenFile as EventListener)
    return () => window.removeEventListener(OPEN_FILE_EVENT, onOpenFile as EventListener)
  }, [])

  return (
    <ShareFileProvider open={open}>
      {children}
      <ShareFileSheet target={target} onClose={close} />
    </ShareFileProvider>
  )
}
