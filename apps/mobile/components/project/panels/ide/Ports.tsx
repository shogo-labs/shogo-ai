// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import * as React from 'react'
import { PortsPanel } from './PortsPanel'

/**
 * Bottom-panel "Ports" tab.
 *
 * Phase 11 shipped an empty-state shell so the tab strip rendered the
 * correct VS Code arrangement. Phase 12 fills this with a live `lsof`
 * poller, the 5-column table (Port · Forwarded Address · Running
 * Process · Local Address · Visibility), and the click-to-open /
 * copy-link / kill action menu.
 *
 * The bridge wiring + the actual table live in `PortsPanel.tsx`. This
 * module is the stable export so the rest of `BottomPanel.tsx` doesn't
 * have to know about the implementation file.
 */
export function Ports({ visible }: { visible: boolean }): React.ReactElement {
  return <PortsPanel visible={visible} />
}
