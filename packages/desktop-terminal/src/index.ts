// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// @shogo/desktop-terminal — renderer-only desktop terminal pieces.
//
// Loaded LAZILY by apps/mobile/.../terminal/pty-factory.ts when
// `isDesktop()` is true. Mobile/web must never reach this package.

export const DESKTOP_TERMINAL_VERSION = '1.0.0'

export { ShogoTerminalSurface } from './renderer/ShogoTerminalSurface'
export type {
  ShogoTerminalSurfaceHandle,
  ShogoTerminalSurfaceProps,
  SurfacePtyClient,
} from './renderer/ShogoTerminalSurface'

export { isDesktop, getDesktopBridge } from './renderer/desktop-features'
export type {
  ShogoDesktopTerminalBridge,
  MessagePortLike,
} from './renderer/desktop-features'

export {
  DesktopPtyClient,
  createDesktopPtyClient,
  spawnDesktopPtyClient,
} from './renderer/desktop-pty-client'
export type {
  DesktopPtySpawnOptions,
  DesktopPtyClientOptions,
  PtyClientListeners,
  PtyClientState,
} from './renderer/desktop-pty-client'
