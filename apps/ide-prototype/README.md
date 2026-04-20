# Shogo IDE — Prototype

A VS Code / Cursor–style code editor surface built on Monaco, designed to grow into our canonical editing experience across web and desktop.

## Current status: Phase 2 — live filesystem ✅

- Full VS Code–shaped layout (activity bar, resizable sidebar, tabs, breadcrumbs, bottom panel, status bar)
- Monaco editor with custom `shogo-dark` theme and language auto-detection
- **Live filesystem**: click files → Monaco loads them → edit → ⌘S writes to disk
- Path-jailed server (`.git`, `node_modules`, `.env*` blocked), 2 MB text cap, binary guard
- Keyboard: ⌘S save, ⌘W close tab, ⌘J toggle bottom panel

## Run it

```bash
cd apps/ide-prototype
bun install
bun run dev          # runs the FS server + Vite together
```

Open the Vite URL (http://localhost:5173). The FS server listens on port 38325 and serves files from **two levels up** (the monorepo root).

## Architecture

```
WorkspaceService (interface)
 ├─ AgentFs          ← Phase 2 — talks to server.ts over HTTP
 └─ LocalFs (future) ← Phase 5 — File System Access API
```

`Workbench.tsx` is UI-only. Swapping the backend is a one-line change.

### FS API (Bun server, `server.ts`)

| Route | Purpose |
|---|---|
| `GET /api/fs/tree?path=&depth=` | Recursive tree listing |
| `GET /api/fs/file?path=` | Read file |
| `PUT /api/fs/file` | Write file |
| `POST /api/fs/mkdir` | Create directory |
| `DELETE /api/fs/entry?path=` | Remove |
| `POST /api/fs/rename` | Move / rename |

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Monaco + layout shell | ✅ |
| 2 | Live filesystem | ✅ |
| 3 | File tree CRUD + virtualization | next |
| 4 | Command Palette, Quick Open, splits | |
| 5 | Local folder picker (FS Access API) | |
| 6 | IntelliSense, global search, find & replace | |
| 7 | Agent live-edit diffs (accept/reject) | |
| 8 | Mobile gating, a11y, lazy-load | |
