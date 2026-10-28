// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which pane the conversation screen shows. The panes are URL params and share
 * one column, so exactly one of them wins and the rest stay out of the way.
 *
 * Kept as a pure function so the precedence — the part that is easy to get
 * subtly wrong — can be tested directly instead of through a mounted screen.
 */

export interface PaneInputs {
  /** Wide enough for a pane beside the timeline rather than in place of it. */
  sidePane: boolean
  threadRootId: string | null
  projectPaneId: string | null
  filesOpen: boolean
  /** A doc is open *and* this conversation has one. */
  docOpen: boolean
  cardId: string | null
  profilePaneId: string | null
  /** A file from chat is open in the viewer. */
  fileOpen?: boolean
}

export interface PaneVisibility {
  showDocPane: boolean
  showDocFull: boolean
  showFilesPane: boolean
  showFilesFull: boolean
  showCardPane: boolean
  showProfilePane: boolean
  showProjectPane: boolean
  showThreadPane: boolean
  /** A chat file in the pane beside the timeline. */
  showFilePane: boolean
  /** A chat file taking the screen on a narrow layout. */
  showFileFull: boolean
  /** The timeline and whatever sits beside it. */
  showMain: boolean
}

/**
 * Precedence, highest first: profile, card, project, thread. A doc or the files
 * list takes the whole screen on a narrow layout, so nothing else shows there.
 *
 * A profile only ever takes the *pane*, never the whole screen — narrow layouts
 * push the full page instead — so a thread left in the URL underneath it is
 * simply hidden, and closing the profile reveals it again.
 */
export function resolvePanes(input: PaneInputs): PaneVisibility {
  const {
    sidePane,
    threadRootId,
    projectPaneId,
    filesOpen,
    docOpen,
    cardId,
    profilePaneId,
    fileOpen = false,
  } = input
  const showDocPane = sidePane && docOpen
  const showDocFull = !sidePane && docOpen
  const showFilesPane = sidePane && filesOpen
  const showFilesFull = !sidePane && filesOpen
  // A chat file behaves like a card: it takes the pane (and the thread under
  // it stays in the URL, so closing the file shows the thread again).
  const showFilePane = !!fileOpen && sidePane && !showDocPane && !showFilesPane
  const showFileFull = !!fileOpen && !sidePane
  const showCardPane = !!cardId && !showDocFull && !showFilesFull && !showFileFull && !showFilePane
  const showProfilePane = sidePane && !!profilePaneId
  const showProjectPane =
    sidePane &&
    !!projectPaneId &&
    !showDocPane &&
    !showFilesPane &&
    !showCardPane &&
    !showFilePane &&
    !showProfilePane
  const showThreadPane =
    !!threadRootId &&
    !showCardPane &&
    !showFilePane &&
    !showFileFull &&
    !showProjectPane &&
    !showDocPane &&
    !showDocFull &&
    !showFilesPane &&
    !showFilesFull &&
    !showProfilePane
  const showMain =
    !showDocFull && !showFilesFull && !showFileFull && (sidePane || (!threadRootId && !cardId))
  return {
    showDocPane,
    showDocFull,
    showFilesPane,
    showFilesFull,
    showCardPane,
    showProfilePane,
    showProjectPane,
    showThreadPane,
    showFilePane,
    showFileFull,
    showMain,
  }
}
