# Canvas E2E: VS Code Parity Audit & Build Plan

## Executive Summary

After deep-diving into both the VS Code documentation and the entire Shogo codebase, here's the reality: **Shogo Desktop IDE is already remarkably feature-complete** — it has ~150+ component files spanning the full VS Code layout (Activity Bar, File Tree, Monaco Editor, Terminal, Git/SCM, Debug, Search, Command Palette, Breadcrumbs, Status Bar, etc.). The "canvas" in Shogo's architecture refers to the **preview canvas** (the rendered React app iframe), not the IDE itself.

The real gaps are in **canvas E2E (end-to-end)** — the live preview pipeline that shows the agent-built app inside the IDE. This document covers both.

---

## Part 1: VS Code Feature Parity Matrix

### ✅ FULLY IMPLEMENTED in Shogo Desktop IDE

| VS Code Feature | Shogo Component | Status |
|---|---|---|
| **Activity Bar** | `ActivityBar.tsx` | ✅ Files, Search, Outline, Git, Debug, Checkpoint, Settings |
| **File Explorer** | `FileTree.tsx` | ✅ Lazy loading, drag-drop, new file/folder, multi-root |
| **Code Editor (Monaco)** | `CodeEditor.tsx` | ✅ Full Monaco with themes, minimap, word wrap, bracket pairs |
| **Editor Tabs** | `EditorTabs.tsx` | ✅ Reorderable, closeable, pin/unpin |
| **Editor Groups (Split)** | `EditorGroup.tsx` + `Splitter.tsx` | ✅ Side-by-side horizontal split |
| **Breadcrumbs** | `Breadcrumbs.tsx` | ✅ File path navigation |
| **Command Palette** | `Palette.tsx` | ✅ Fuzzy search, disambiguation, line jump (`:N`) |
| **Quick Open (⌘P)** | `Palette.tsx` with `QuickOpen` variant | ✅ File search + `:line` support |
| **Search (Global)** | `SearchPane.tsx` | ✅ Cross-file search + replace |
| **Source Control (Git)** | `scm/SourceControlViewlet.tsx` | ✅ Changes list, commit input, branch picker |
| **Git Branch Picker** | `git/BranchPicker.tsx` | ✅ Branch switching |
| **Git Diff (Monaco)** | `git/editorIntegration.ts` | ✅ Diff view for staged/changed files |
| **Merge Editor** | `git/MergeEditorModal.tsx` | ✅ 3-way merge for conflicts |
| **Run & Debug** | `run/RunDebugPanel.tsx` + `DebugView.tsx` | ✅ Debug sessions, variables, call stack |
| **Terminal** | `Terminal.tsx` + `terminal/` subsystem | ✅ PTY, split tree, xterm.js, auto-replies |
| **Status Bar** | `StatusBar.tsx` | ✅ Language, line/col, git branch, dirty indicator |
| **Settings Pane** | `SettingsPane.tsx` | ✅ Font, tab size, minimap, word wrap, themes |
| **Outline View** | `OutlinePanel.tsx` | ✅ Document symbols from LSP |
| **Image Preview** | `ImagePreview.tsx` | ✅ Binary file preview |
| **SQLite Preview** | `SqlitePreview.tsx` | ✅ Table browser for .db files |
| **Media Preview** | `MediaPreview.tsx` | ✅ Audio, video, font, PDF |
| **Context Menus** | `ContextMenu.tsx` + `tab-context-menu.ts` | ✅ Right-click on files, tabs |
| **Zen Mode** | `zen-mode.ts` | ✅ Hide all chrome |
| **LSP Integration** | `monaco/lspProviders.ts` | ✅ Hover, completion, definitions, references, symbols |
| **Live Agent Edits** | `useLiveAgentEdits.ts` + `AgentEditBanner.tsx` | ✅ Real-time agent file changes |
| **Checkpoint/Commit Graph** | `graph/GraphView.tsx` | ✅ Full commit graph with detail panel |
| **Multi-Root Workspaces** | `workspace/` subsystem | ✅ Local FS (FSA) + agent root |
| **Drag-Drop Tabs** | `useDragCancel.ts` | ✅ Tab reordering |
| **Tab Overflow** | `TabOverflowDropdown.tsx` | ✅ Dropdown for many tabs |
| **Preview Mode** | File tree single-click | ✅ Italic tab preview |
| **Keyboard Shortcuts** | `keybindings.ts` + `commands.ts` | ✅ ⌘P, ⌘⇧P, ⌘⇧F, ⌘⇧O, ⌘J, ⌘K ⌘W, etc. |

### ⚠️ PARTIALLY IMPLEMENTED (Gaps Found)

| VS Code Feature | Shogo Status | Gap |
|---|---|---|
| **Multi-Direction Split** | Only horizontal split | No vertical split (stack editors above/below) |
| **Wrap Tabs** | `TabOverflowDropdown.tsx` handles overflow | No "wrapped tabs" mode (multiple rows) |
| **Custom Tab Labels** | No custom label patterns | Missing `workbench.editor.customLabels` |
| **Find in Files (Replace)** | SearchPane has replace | Replace-all vs per-match UX may differ |
| **Drag Tabs Between Groups** | Single group split only | Can't drag tab to a different group |
| **Empty Editor Groups** | Closing last tab closes group | No `closeEmptyGroups: false` option |
| **Centered Editor Layout** | Zen mode centers | No standalone centered layout toggle |
| **Floating Windows** | Electron-based (can do) | Not exposed in IDE UI |
| **Status Bar Items (Extensions)** | Static items only | No extension-contributed items |
| **Minimap Side Toggle** | Minimap on/off only | No "left side" minimap option |
| **Timeline View** | Checkpoint graph exists | No per-file timeline (local history) |
| **Open Editors Section** | Editor tabs only | No separate "Open Editors" tree in explorer |

### ❌ NOT IMPLEMENTED (Missing Features)

| VS Code Feature | Priority | Notes |
|---|---|---|
| **Multi-Group Grid Layout** | Medium | VS Code allows 2x2+ grid; Shogo only 1x2 horizontal |
| **Grid Editor Layout Presets** | Low | View > Editor Layout menu |
| **Split in Group** | Medium | ⌘K ⇧⌘\ — split within same group |
| **Do Not Disturb Mode** | Low | Bell icon with DND toggle |
| **Notification System** | Medium | VS Code has toast notifications; Shogo has basic toast |
| **Custom Data Extensions** | Low | HTML/CSS custom data providers |
| **Workspace Trust** | Low | Trust model for folders |
| **Profiles** | Low | Multiple editor profiles |
| **Modal Editors** | Low | Settings in centered modal overlay |
| **Tab Index Display** | Low | Show tab number in tab header |

---

## Part 2: Canvas Preview Pipeline (E2E) Audit

The "canvas" in Shogo's architecture is the **live preview** of the agent-built React app. Here's the full pipeline:

### Canvas Architecture
```
Agent writes files → CanvasFileWatcher detects → CanvasBuildManager triggers Vite/Metro build
→ Build output committed to dist/ → PreviewManager serves at origin →
CanvasWebView (iframe/native) renders it → canvas-bridge.js handles SSE reload
```

### ✅ What Works
1. **CanvasFileWatcher** — Dual input (explicit tool notifications + chokidar watcher), dedupe guard, build-trigger detection
2. **CanvasBuildManager** — Debounced builds, atomic output commit, staging dir isolation
3. **CanvasWebView** — iframe (web) + native WebView (mobile), theme sync, error forwarding
4. **canvas-bridge.js** — SSE reload, user interaction breadcrumbs, error reporting
5. **CanvasRuntimeErrors** — Ring buffer for compile/runtime errors, `read_lints` integration
6. **Canvas Theme System** — Dark/light presets, real-time theme sync to iframe
7. **Canvas Runtime Components** — Layout (Row/Column/Grid/Card), Data (Metric/Table/Chart), Display (Text/Badge/Image/Progress)

### ⚠️ Gaps in Canvas E2E

| Gap | Severity | Description |
|---|---|---|
| **No E2E test for canvas render** | High | `e2e/terminal.spec.ts` and `e2e/notetaker.spec.ts` exist but no `canvas.spec.ts` |
| **No canvas build verification test** | High | `test-vm-canvas-build-gate.ts` exists but is a unit test, not E2E |
| **Canvas iframe error recovery** | Medium | When canvas errors, user sees blank — no "retry" or "show error" button in iframe |
| **Canvas loading state** | Medium | No skeleton/spinner while canvas builds — blank until first render |
| **Canvas URL deep-linking** | Low | Canvas route state not preserved across iframe reloads |
| **Cross-origin canvas (Desktop VM)** | Medium | In VM mode, canvas runs on different origin — theme sync needs proxy |
| **Canvas SSE reconnection** | Low | If SSE drops, no automatic reconnect with backoff |
| **Canvas file change debouncing** | Low | Rapid writes can cause build storms (500ms debounce exists but no max-burst limit) |

---

## Part 3: Build Plan — Canvas E2E

### Phase 1: Canvas E2E Test Suite (High Priority)

**File: `apps/desktop/e2e/canvas.spec.ts`**

```typescript
// Test cases:
1. Canvas loads and renders preview iframe
2. File change triggers rebuild and preview refresh
3. Compile error shows error overlay in canvas
4. Runtime error captures and reports via canvas-bridge
5. Theme sync works (dark/light toggle)
6. Canvas iframe survives IDE tab switch (mount/unmount)
7. Canvas build gate (deps ready before build)
8. Multiple rapid file changes don't cause build storm
```

### Phase 2: Canvas UX Improvements (Medium Priority)

1. **Canvas Loading State** — Add skeleton/spinner in `CanvasWebView.tsx` during build
2. **Canvas Error Recovery** — Add "Retry" button in canvas error overlay
3. **Canvas Build Status** — Show "Building..." / "Built in Xms" indicator
4. **Canvas SSE Reconnection** — Auto-reconnect with exponential backoff in canvas-bridge.js

### Phase 3: IDE Feature Gaps (Medium Priority)

1. **Multi-Direction Split** — Extend `Splitter.tsx` to support vertical splits
2. **Notification System** — Add toast notification stack (not just single toast)
3. **Local File History** — Timeline view for per-file save history
4. **Tab Index Display** — Show ⌘1-9 indices in tab headers

### Phase 4: Polish & Edge Cases (Low Priority)

1. **Wrap Tabs** mode
2. **Empty Editor Groups** persistence
3. **Do Not Disturb** mode
4. **Custom Tab Labels**

---

## Implementation Order

1. **Canvas E2E test suite** — Proves the canvas pipeline works end-to-end
2. **Canvas loading/error UX** — Better user experience during builds
3. **Multi-direction split** — Major IDE parity feature
4. **Notification system** — Foundation for extension notifications
5. **Local file history** — Timeline view completion

---

*Generated from VS Code docs analysis + full codebase audit of shogo-ai*
*Date: 2026-06-12*
