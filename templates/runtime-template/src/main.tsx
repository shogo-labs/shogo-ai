// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { createRoot } from 'react-dom/client'
import App from './App'
import { ShogoErrorBoundary } from './ShogoErrorBoundary'
import './index.css'

// Render the user's React app. Everything else — the update toast, the
// parent <-> iframe theme bridge, capability detection, async error
// forwarding, the canvas-ready handshake — is owned by the canvas-bridge
// script that the agent runtime injects into the HTML served to the iframe.
// See packages/agent-runtime/static/canvas-bridge.js.
//
// DO NOT add bridge concerns back into this file. It is a Shogo-managed
// platform contract: in canvas-code mode, write_file / edit_file / delete_file
// reject mutations to src/main.tsx (see packages/agent-runtime/src/protected-files.ts),
// and a self-heal pass at workspace boot rewrites the file to this canonical
// shape if it has drifted.

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <ShogoErrorBoundary>
      <App />
    </ShogoErrorBoundary>,
  )
}
