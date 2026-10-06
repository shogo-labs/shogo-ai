// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Shows the OS notification for a waiting agent. On macOS it has Allow and Deny
// buttons. Electron reports button presses only on macOS (`action` is darwin
// only, and a Windows toast cannot say which button was pressed), so Windows
// and Linux get a banner that opens the chat when clicked.

import { Notification } from 'electron'
import { noticeActionFor, noticeActions, type PendingNotice } from './island-notifications'
import type { IslandAction, IslandActionResult } from './island-protocol'

export class PendingNotifier {
  private readonly shown = new Map<string, Notification>()

  constructor(private readonly perform: (action: IslandAction) => Promise<IslandActionResult>) {}

  show(notice: PendingNotice): void {
    if (!Notification.isSupported()) return
    try {
      const actions = process.platform === 'darwin' ? noticeActions(notice) : []
      const notification = new Notification({ title: notice.title, body: notice.body, silent: false, actions })
      const open = () => {
        void this.perform({ type: 'open', projectId: notice.projectId, sessionId: notice.sessionId })
      }
      notification.on('click', open)
      notification.on('action', (_event, index) => {
        const action = noticeActionFor(notice, index)
        if (!action) return open()
        void this.perform(action).then((result) => {
          // Answered somewhere else, or the chat closed: take them to it instead.
          if (!result.ok) {
            console.warn(`[Island] Notification answer failed: ${result.error}`)
            open()
          }
        })
      })
      notification.on('close', () => {
        if (this.shown.get(notice.requestId) === notification) this.shown.delete(notice.requestId)
      })
      this.shown.set(notice.requestId, notification)
      notification.show()
    } catch {
      // Headless or notifications blocked.
    }
  }

  /** The request was answered somewhere else. */
  close(requestId: string): void {
    const notification = this.shown.get(requestId)
    this.shown.delete(requestId)
    try {
      notification?.close()
    } catch {
      // Already gone.
    }
  }

  closeAll(): void {
    for (const id of [...this.shown.keys()]) this.close(id)
  }
}
