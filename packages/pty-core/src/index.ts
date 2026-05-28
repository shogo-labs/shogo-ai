// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// @shogo/pty-core — shared PTY primitives.
//
// Consumed by:
//   - packages/agent-runtime         (mobile/web WS-backed terminal)
//   - apps/desktop/pty-host          (Electron utilityProcess, local node-pty)
//   - packages/desktop-terminal      (renderer-side desktop client)
//
// Keep this package free of runtime deps. Pure TS + Web platform types only.

export { ScrollbackRing } from "./scrollback-ring";

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
  encodeClientAck,
  encodeServerData,
  encodeServerExit,
  encodeServerTrunc,
  decodeClientFrame,
  decodeServerFrame,
} from "./pty-protocol";

export type {
  SpawnOptions,
  SessionInfo,
  SnapshotSummary,
  ControlEvent,
} from "./desktop-protocol";
export {
  DESKTOP_TERMINAL_CLOSE_REASONS,
  DESKTOP_COLS_MIN,
  DESKTOP_COLS_MAX,
  DESKTOP_ROWS_MIN,
  DESKTOP_ROWS_MAX,
} from "./desktop-protocol";

export {
  OscDecoder,
  decodeOscOneShot,
} from "./osc-decoder";
export type {
  OscDecoderOptions,
  OscDecodeResult,
  OscEvent,
  Osc633Event,
  Osc633Letter,
  Osc133Event,
  OscUnknownEvent,
  OscOverflowEvent,
} from "./osc-decoder";
