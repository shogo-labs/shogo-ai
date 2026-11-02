// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Opens the file a shared link names (`/agent?workspace=<id>&file=<path>`,
 * SHO-284) once per arrival, in the workspace the link names when this account
 * is a member of it.
 *
 * The one rule this hook exists to keep: **the params are dropped when the pane
 * closes, never when it opens.** `router.setParams` remounts the chat screen on
 * web, so dropping `?file=`/`?workspace=` in the same tick as the open would
 * throw away the very pane it had just opened.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { planFileLinkArrival } from "../../lib/file-link-arrival"

export interface UseFileLinkArrivalOptions {
  /** `?file=`, already workspace-relative; `null` when the arrival carried none. */
  initialFilePath: string | null
  /** `?workspace=`, when the link named the workspace itself. */
  linkWorkspaceId: string | null
  /** The workspace on screen (or the paired machine's own, SHO-130). */
  workspaceId: string | null
  /** Every workspace id this account can see; `null` while the list loads. */
  memberWorkspaceIds: readonly string[] | null
  /** Opens a `<projectId>/<path>` or a bare workspace-root path in the pane. */
  openFilePane: (path: string) => void
  /** Switches to the workspace the link names, when this account may. */
  adoptWorkspace: (workspaceId: string) => void
  /** `router.setParams`; absent off the router, where there is no URL. */
  setParams?: (params: { file: undefined; workspace: undefined }) => void
}

export interface FileLinkArrival {
  /** Set when the link names a workspace this account cannot see. */
  error: string | null
  /** Clears that message, when the viewer dismisses it. */
  dismissError: () => void
  /**
   * Drops `?file=`/`?workspace=` so reloading after the pane is closed does not
   * reopen the file. Call it from the close handler only.
   */
  dropLinkParams: () => void
}

export function useFileLinkArrival({
  initialFilePath,
  linkWorkspaceId,
  workspaceId,
  memberWorkspaceIds,
  openFilePane,
  adoptWorkspace,
  setParams,
}: UseFileLinkArrivalOptions): FileLinkArrival {
  const [error, setError] = useState<string | null>(null)
  const handled = useRef(false)
  // Kept in refs so an inline arrow from the caller doesn't re-run the effect.
  const openFilePaneRef = useRef(openFilePane)
  openFilePaneRef.current = openFilePane
  const adoptWorkspaceRef = useRef(adoptWorkspace)
  adoptWorkspaceRef.current = adoptWorkspace

  const step = planFileLinkArrival({
    path: initialFilePath,
    linkWorkspaceId,
    workspaceId,
    memberWorkspaceIds,
    handled: handled.current,
  })

  useEffect(() => {
    if (!workspaceId || !initialFilePath) return
    if (step === "open") {
      handled.current = true
      openFilePaneRef.current(initialFilePath)
      return
    }
    if (step === "adopt" && linkWorkspaceId) {
      // Deliberately not marked handled: the arrival is not finished until the
      // workspace in view is the one the link named, and then this effect runs
      // again with `open`. A refused switch leaves the step at `adopt`, which
      // changes nothing and so does not loop.
      adoptWorkspaceRef.current(linkWorkspaceId)
      return
    }
    if (step === "denied") {
      handled.current = true
      setError("You don't have access to this workspace.")
    }
  }, [step, initialFilePath, linkWorkspaceId, workspaceId])

  const dropLinkParams = useCallback(() => {
    if (!initialFilePath || !setParams) return
    setParams({ file: undefined, workspace: undefined })
  }, [initialFilePath, setParams])

  const dismissError = useCallback(() => setError(null), [])

  return { error, dismissError, dropLinkParams }
}
