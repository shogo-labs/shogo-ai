// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

export function loadDesktopTerminal(): Promise<any> {
  return import('@shogo/desktop-terminal')
}
