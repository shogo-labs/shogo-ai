// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import * as React from 'react'
import { DebugConsolePanel } from './DebugConsolePanel'

/**
 * Bottom-panel "Debug Console" tab.
 *
 * Phase 11 shipped the empty-state shell so the 5-tab strip rendered the
 * VS Code 1.95 arrangement. Phase 13 fills it with the live UX: scrollable
 * log surface with type pills, REPL input at the bottom with history + tab
 * completion stub + multi-line via Shift+Enter, collapsible object trees
 * for structured `data` payloads.
 *
 * The actual wire-up to a `node --inspect` debug session lives in
 * `apps/desktop/src/debug/` (session-emitter + node-inspector-client).
 * The renderer subscribes to a globally-injected emitter on
 * `window.shogoDebugEmitter`, falling back to a hermetic local emitter
 * (so the REPL still works for `2 + 2` even with no debugger attached).
 *
 * Full CDP wire (Runtime.consoleAPICalled streaming + Runtime.evaluate)
 * is Phase 13b — discovery + UI ship now, wire follows.
 */
export function DebugConsole({ visible }: { visible: boolean }): React.ReactElement {
  return <DebugConsolePanel visible={visible} />
}
