// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Compatibility shim — the implementation lives in @shogo/pty-core now.
// Keep this re-export so internal consumers (`./pty-protocol`) and the
// existing test file (`../pty-protocol`) continue to resolve without churn.
//
// Plan ref: feat/desktop-terminal-enhancement Phase 1 — lift shared PTY
// primitives into a package shared with apps/desktop's PtyHost.

export {
  ClientFrameType,
  ServerFrameType,
  type ClientFrameTypeValue,
  type ServerFrameTypeValue,
  type ClientFrame,
  type ServerFrame,
  encodeClientData,
  encodeClientResize,
  encodeClientSignal,
  encodeServerData,
  encodeServerExit,
  encodeServerTrunc,
  decodeClientFrame,
  decodeServerFrame,
} from '@shogo/pty-core'
