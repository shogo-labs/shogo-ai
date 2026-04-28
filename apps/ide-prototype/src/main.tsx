// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

// Render the user's React app. Everything else — the update toast, the
// parent <-> iframe theme bridge, capability detection, async error
// forwarding, the canvas-ready handshake — is owned by the canvas-bridge
// script that the agent runtime injects into the HTML served to the iframe.
// See packages/agent-runtime/static/canvas-bridge.js.

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(<App />)
}
