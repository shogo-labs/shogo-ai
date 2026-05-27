// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Compatibility shim — the implementation lives in @shogo/pty-core now.
// Keep this re-export so internal consumers (`./pty-scrollback`) and the
// existing test file (`../pty-scrollback`) continue to resolve without churn.
//
// Plan ref: feat/desktop-terminal-enhancement Phase 1 — lift shared PTY
// primitives into a package shared with apps/desktop's PtyHost.

export { ScrollbackRing } from '@shogo/pty-core'
