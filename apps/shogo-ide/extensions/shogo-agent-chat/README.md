# Shogo Agent Chat

Bundled Shogo IDE extension that owns the right-side chat panel. It is intentionally separate from GitHub Copilot Chat and talks to the Shogo Desktop agent bridge when that bridge is available.

Phase 3 reuses the Shogo Desktop chat UI shell inside the VS Code webview: Shogo-branded header, transcript turns, context chips, model/mode controls, and the Desktop-style composer. Later phases wire streaming model/tool execution through the Shogo Desktop bridge.
