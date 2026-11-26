// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The one-column rule: the panes are URL params sharing a column, so exactly
 * one shows and the rest stay out of the way.
 *
 * Note: `?from=` (member filter) is NOT a pane — it filters the timeline in
 * place and is invisible to `resolvePanes` (SHO-458).
 */

import { describe, expect, test } from 'bun:test'
import { resolvePanes, type PaneInputs } from '../team-chat-panes'

const base: PaneInputs = {
  sidePane: true,
  threadRootId: null,
  projectPaneId: null,
  filesOpen: false,
  docOpen: false,
  cardId: null,
  profilePaneId: null,
  fileOpen: false,
  fitsCardAndFile: false,
}

const panes = (over: Partial<PaneInputs>) => resolvePanes({ ...base, ...over })

describe('resolvePanes', () => {
  test('a bare conversation shows just the timeline', () => {
    expect(panes({})).toMatchObject({
      showMain: true,
      showThreadPane: false,
      showProfilePane: false,
      showProjectPane: false,
      showCardPane: false,
    })
  })

  test('a profile takes the pane from the project pane', () => {
    const both = panes({ profilePaneId: 'u-ana', projectPaneId: 'proj-1' })
    expect(both.showProfilePane).toBe(true)
    expect(both.showProjectPane).toBe(false)
  })

  test('a profile takes the pane from an open thread, which comes back when it closes', () => {
    const withProfile = panes({ threadRootId: 'm-1', profilePaneId: 'u-ana' })
    expect(withProfile.showProfilePane).toBe(true)
    expect(withProfile.showThreadPane).toBe(false)
    expect(withProfile.showMain).toBe(true)

    const closed = panes({ threadRootId: 'm-1' })
    expect(closed.showProfilePane).toBe(false)
    expect(closed.showThreadPane).toBe(true)
  })

  test('a card still beats a thread, and a profile beats both', () => {
    const card = panes({ cardId: 'card-1', threadRootId: 'm-1' })
    expect(card.showCardPane).toBe(true)
    expect(card.showThreadPane).toBe(false)

    const profile = panes({ cardId: 'card-1', threadRootId: 'm-1', profilePaneId: 'u-ana' })
    expect(profile.showProfilePane).toBe(true)
    expect(profile.showCardPane).toBe(true)
    expect(profile.showThreadPane).toBe(false)
  })

  test('a narrow layout never shows a profile pane — it pushes a page instead', () => {
    const narrow = panes({ sidePane: false, profilePaneId: 'u-ana' })
    expect(narrow.showProfilePane).toBe(false)
    expect(narrow.showMain).toBe(true)
  })

  test('a narrow layout gives a doc or the files list the whole screen', () => {
    const doc = panes({ sidePane: false, docOpen: true, threadRootId: 'm-1', profilePaneId: 'u-ana' })
    expect(doc.showDocFull).toBe(true)
    expect(doc.showDocPane).toBe(false)
    expect(doc.showThreadPane).toBe(false)
    expect(doc.showProfilePane).toBe(false)
    expect(doc.showMain).toBe(false)

    const files = panes({ sidePane: false, filesOpen: true })
    expect(files.showFilesFull).toBe(true)
    expect(files.showMain).toBe(false)
  })

  test('a wide layout keeps the timeline beside the pane it opens', () => {
    for (const over of [
      { threadRootId: 'm-1' },
      { projectPaneId: 'proj-1' },
      { profilePaneId: 'u-ana' },
      { docOpen: true },
      { filesOpen: true },
      { cardId: 'card-1' },
    ] satisfies Partial<PaneInputs>[]) {
      expect(panes(over).showMain).toBe(true)
    }
  })

  test('a file opened from chat takes the pane from the thread, which comes back when it closes', () => {
    const withFile = panes({ threadRootId: 'm-1', fileOpen: true })
    expect(withFile.showFilePane).toBe(true)
    expect(withFile.showThreadPane).toBe(false)
    expect(withFile.showMain).toBe(true)

    const closed = panes({ threadRootId: 'm-1' })
    expect(closed.showFilePane).toBe(false)
    expect(closed.showThreadPane).toBe(true)
  })

  test('on a narrow layout a file replaces the timeline instead of sitting beside it', () => {
    const narrow = panes({ sidePane: false, fileOpen: true })
    expect(narrow.showFileFull).toBe(true)
    expect(narrow.showFilePane).toBe(false)
    expect(narrow.showMain).toBe(false)
  })

  test('a file beats the project pane and a card, and an open doc still wins the whole screen', () => {
    const overProject = panes({ fileOpen: true, projectPaneId: 'proj-1', cardId: 'card-1' })
    expect(overProject.showFilePane).toBe(true)
    expect(overProject.showProjectPane).toBe(false)
    expect(overProject.showCardPane).toBe(false)

    const doc = panes({ fileOpen: true, docOpen: true })
    expect(doc.showDocPane).toBe(true)
    expect(doc.showFilePane).toBe(false)
  })

  test('a file opened from a card sits beside it when the width has room for both (SHO-589)', () => {
    const wide = panes({ cardId: 'card-1', fileOpen: true, fitsCardAndFile: true })
    expect(wide.showCardPane).toBe(true)
    expect(wide.showFilePane).toBe(true)
    expect(wide.showFileFull).toBe(false)
    expect(wide.showMain).toBe(true)
  })

  test('without room the file takes the card’s place, and the card comes back when it closes (SHO-589)', () => {
    const narrowPane = panes({ cardId: 'card-1', fileOpen: true, fitsCardAndFile: false })
    expect(narrowPane.showFilePane).toBe(true)
    expect(narrowPane.showCardPane).toBe(false)
    expect(narrowPane.showMain).toBe(true)

    // `card` stays in the URL while the file is open, so closing the file is
    // just `fileOpen: false` with the card still there.
    const closed = panes({ cardId: 'card-1', fitsCardAndFile: false })
    expect(closed.showFilePane).toBe(false)
    expect(closed.showCardPane).toBe(true)
  })

  test('on a phone a file opened from a card takes the screen, and the card is back when it closes (SHO-589)', () => {
    const phone = panes({ sidePane: false, cardId: 'card-1', fileOpen: true })
    expect(phone.showFileFull).toBe(true)
    expect(phone.showFilePane).toBe(false)
    expect(phone.showCardPane).toBe(false)
    expect(phone.showMain).toBe(false)

    const closed = panes({ sidePane: false, cardId: 'card-1' })
    expect(closed.showFileFull).toBe(false)
    expect(closed.showCardPane).toBe(true)
  })

  test('a file opened from a thread keeps today’s behaviour whether or not it could fit beside a card', () => {
    for (const fitsCardAndFile of [false, true]) {
      const open = panes({ threadRootId: 'm-1', fileOpen: true, fitsCardAndFile })
      expect(open.showFilePane).toBe(true)
      expect(open.showThreadPane).toBe(false)
      expect(open.showCardPane).toBe(false)
      expect(open.showMain).toBe(true)
    }
  })

  test('a doc or the files list still takes the whole screen from a card and its file', () => {
    const doc = panes({ sidePane: false, cardId: 'card-1', fileOpen: true, docOpen: true })
    expect(doc.showDocFull).toBe(true)
    expect(doc.showCardPane).toBe(false)
    expect(doc.showFilePane).toBe(false)

    const files = panes({ sidePane: false, cardId: 'card-1', fileOpen: true, filesOpen: true })
    expect(files.showFilesFull).toBe(true)
    expect(files.showCardPane).toBe(false)
    expect(files.showFilePane).toBe(false)
  })

  test('resolvePanes does not have showMemberPane / showMemberFull — the member filter lives in TimelinePane', () => {
    const result = panes({})
    expect('showMemberPane' in result).toBe(false)
    expect('showMemberFull' in result).toBe(false)
  })

  test('the timeline stays visible on wide with any pane open', () => {
    for (const sidePane of [false, true])
      for (const threadRootId of [null, 'm-1'])
        for (const projectPaneId of [null, 'proj-1'])
          for (const filesOpen of [false, true])
            for (const docOpen of [false, true])
              for (const cardId of [null, 'card-1'])
                for (const profilePaneId of [null, 'u-ana'])
                  for (const fileOpen of [false, true]) {
                    const p = resolvePanes({
                      sidePane,
                      threadRootId,
                      projectPaneId,
                      filesOpen,
                      docOpen,
                      cardId,
                      profilePaneId,
                      fileOpen,
                    })
                    // showMain is true whenever the full-screen takeovers are absent
                    if (sidePane) {
                      // Wide: timeline always visible unless full-screen doc/files/file
                      if (!docOpen && !filesOpen && !fileOpen) {
                        expect({ sidePane, threadRootId, projectPaneId, filesOpen, docOpen, cardId, profilePaneId, fileOpen, showMain: p.showMain })
                          .toMatchObject({ showMain: true })
                      }
                    }
                  }
  })
})
