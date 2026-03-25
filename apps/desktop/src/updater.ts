// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { updateElectronApp } from 'update-electron-app'

export function initAutoUpdater(): void {
  updateElectronApp({
    repo: 'shogo-labs/shogo-ai',
    updateInterval: '10 minutes',
  })
}
