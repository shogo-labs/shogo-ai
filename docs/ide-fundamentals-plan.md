# IDE review: data loss, basics, quick wins, speed, parity

The core is solid. Monaco keeps undo history and cursor position across tab switches, the dirty flag clears when you undo back to the saved text, opening an already-open file focuses its tab, and agent fixes, the TypeScript language server and terminal splits all work. What hurts is a long tail of small mistakes. Many are a single line, and a surprising number are features already written (with tests) that were never mounted in the UI.

Reference points: VS Code for correctness and QoL, and [ZCode](https://github.com/zai-org/ZCode) for speed and agent ergonomics.

## Tier 1: data loss

- **Fake rename and broken folder ops.** `sdkFs.rename` reads, writes, then deletes (`workspace/sdkFs.ts:203-207`). On macOS, a case-only rename therefore loses the file. Folder rename fails, and binary files can't be renamed. Folder delete returns 400 (`workspace-file-routes.ts:269`). **Fix:** add native rename and recursive delete to agent-runtime and `apps/desktop/src/fs-ipc.ts`.
- **Unsaved work.**
  - There's no `beforeunload` guard.
  - Closing a dirty tab uses a `confirm()` with only OK/Cancel and no Save option (`Workbench.tsx:916`).
  - Deleting an open dirty file from the tree skips the prompt entirely (`Workbench.tsx:1017-1030`).
- **Split view of the same file** can save stale content: the `OpenFile` is cloned per group (`Workbench.tsx:1337`, `:903`), and `save-target.ts:50` takes the first match.
- **Leaving the IDE tab destroys all state.** `IDEPanel.tsx:125` returns `null` when the tab is hidden.
- **Escape commits a rename or create through blur** (`FileTree.tsx:963-971`).

## Tier 2: broken basics

- **Tree content and order:**
  - `.env` is hidden because the walker skips gitignored files (`fs-tree-walker.ts:398`) and the Agent Files panel drops dotfiles (`files-browser-filter.ts:69`).
  - The cloud and desktop backends don't sort at all. Fix: sort folders first with `Intl.Collator(numeric)`.
- **DesktopFs is never used.** `Workbench.tsx:322` captures the service in `useState`.
- **Refresh empties expanded folders.** Lazy-loaded subtrees get replaced by stubs (`Workbench.tsx:456,508`).
- **New files never open, select or reveal** (`Workbench.tsx:973-986`).
- **Clicking a problem does nothing.** `DrawerHost` never receives `onReveal` (`_layout.tsx:4329`, `Problems.tsx:371`).
- **Shortcut conflicts:**
  - `Cmd+G` steals Find Next and opens a `prompt()` (`Workbench.tsx:1821`).
  - `Cmd+Shift+O` steals Go to Symbol (`:1828`).
  - `Cmd+J` both toggles and maximizes the panel (`BottomPanel.tsx:193`).
- **`tsconfig.json` comments show as errors** because it's mapped to `json` instead of `jsonc` (`sdkFs.ts:28`, `desktopFs.ts:119`).
- **The language mode doesn't update after a rename** (`Workbench.tsx:1004`).
- **The desktop editor theme is dead.** `EditorGroup.tsx:56` declares `editorTheme` but never passes it to `CodeEditor`.

## Tier 3: QoL quick wins (each one XS or S)

Grouped into batches that each fit in one PR.

**A. One Monaco options patch** (`CodeEditor.tsx:335-373`, all XS):
- `fixedOverflowWidgets: true`, so suggest and hover widgets stop being clipped by the `overflow-hidden` root.
- `mouseWheelZoom: true` and `fontLigatures: true` (the default fonts are JetBrains Mono and Fira Code).
- `scrollBeyondLastLine: true` and `linkedEditing: true`.
- `suggest.preview: true`.
- `guides.bracketPairs` tied to the existing bracket setting.
- Make `renderWhitespace` default to `"selection"` and add it as an option in `SettingsPane.tsx:107`.
- Call `model.detectIndentation` on model swap, instead of forcing `tabSize` 2.
- Add `Cmd+=` and `Cmd+-` to zoom the font.

**B. Light mode and copy** (XS):
- About 30 hardcoded `bg-[#1e1e1e]` and `text-[#cccccc]` usages break light mode: `StatusBar.tsx:57`, `Problems.tsx:218`, `PortsPanel.tsx:271`, `OutputTab.tsx:208`, `DebugConsolePanel.tsx:251`, `BottomPanel.tsx:252`, `Terminal.tsx` (many), `TerminalHeader.tsx`, `XtermView.tsx`, `MediaPreview.tsx:76`, the Hide Sidebar button `Workbench.tsx:2482`, and `DrawerHost.tsx:233`. Replace them with `--ide-*` vars from `global.css:509-598`, and add a light xterm theme (`xterm-theme.ts`).
- Fix user-visible copy:
  - "Already split (max 2 groups in Phase 4)" (`Workbench.tsx:1330`).
  - "Coming soon — Prettier" on a toggle that already works (`SettingsPane.tsx:145`).
  - "Agent not ready yet…" with no retry (`IDEPanel.tsx:118`).
  - The raw open error with no retry (`EditorGroup.tsx:95`).
  - The emoji in "No editor" (`EditorGroup.tsx:233`) and the 📁 emoji (`Workbench.tsx:2519`).

**C. Wire up modules that are already written** (S each, logic and tests exist):
- `tab-context-menu.ts`: right-click on tabs (Close Others/Right, Copy Path, Copy Relative Path, Reveal).
- `zen-mode.ts`: a `Cmd+K Z` chord plus a palette command.
- `minimap-settings.ts`: pass it to Monaco instead of `{ enabled, scale: 1 }`.
- `settings-form.ts`: settings search, "Modified" markers and per-setting reset.
- `peek-actions.ts`.
- `NotificationStack.tsx`: stacked, typed toasts with action buttons, replacing the single-string toast (`Workbench.tsx:409`).

**D. Explorer** (`FileTree.tsx`, `Workbench.tsx:2433-2520`):
- XS:
  - Add Collapse All, and make the header actions show only on hover.
  - Esc always clears the selection (`:542`).
  - Keyboard navigation scrolls the selection into view.
  - Show an "(empty)" row for empty non-lazy folders (`:74-85`).
  - Show a loading skeleton (`anyLoading` is computed but unused at `Workbench.tsx:2430`).
  - Distinguish the active file from the selection (`:862`).
  - Dim gitignored files (`:859`).
  - Remove Rename and Delete from root rows.
  - Relabel "Copy Path" as "Copy Relative Path" and add the absolute "Copy Path".
  - Add a focus ring and `role="tree"`/`treeitem` with aria state.
- S:
  - Auto-reveal the active editor file.
  - Context menu staples: Reveal in Finder, Open in Terminal, Open to the Side, Find in Folder, Duplicate, Cut/Copy/Paste, Upload.
  - Home, End, PageUp/PageDown and type-to-jump.
  - OS drag-and-drop upload, and dragging a tree file into the editor or terminal (set `text/plain`).
  - Indent guides and file-type icons.
  - An "Open Editors" section.

**E. Tabs, status bar, palette** (`EditorTabs.tsx`, `StatusBar.tsx`, `Palette.tsx`):
- XS:
  - Show the close X on hover only, and swap the dirty dot to X on hover (`EditorTabs.tsx:219-236`).
  - Add a tab tooltip with the full path and a file icon in each tab.
  - Disambiguate duplicate tab names.
  - Map vertical wheel to horizontal scroll on the tab strip.
  - Make Ln/Col open a Go to Line palette mode in place of the `prompt()`, and make the language label open a language picker (`StatusBar.tsx:108-111`).
  - Esc in the palette refocuses the editor (`Workbench.tsx:2334`).
  - Clearer palette placeholder text.
  - Agent banner: show the basename, with the labels "Accept agent" and "Keep my edits".
- S:
  - Status bar: Spaces, EOL, "(N selected)", and a clickable problem count.
  - Missing palette commands: Toggle Word Wrap, Toggle Minimap, Format Document, Change Language Mode, Close All, Reopen Closed, Reveal Active File, Copy Path of Active File, Toggle Terminal, Open Settings, Color Theme, Reload.
  - `>` prefix switching between files and commands.
  - `Cmd+1..9`, next/prev tab, and `Cmd+Enter` in Quick Open to open to the side.
  - Clickable breadcrumbs.
  - An empty-editor watermark with shortcuts and recent files.
  - Double-click the empty tab bar to create a new file.

**F. Search, terminal, SCM, panels:**
- XS:
  - `Cmd+Shift+F` prefills the search from the editor selection (`SearchPane` already accepts `initialQuery`, but `Workbench.tsx:2233` never passes it).
  - Lift the search query to Workbench so it survives switching views.
  - Ctrl+` focuses the terminal (`Workbench.tsx:1858`).
  - `Cmd+K` clears the terminal (the menu shows it, but nothing binds it).
  - Load `@xterm/addon-search` so terminal Find works on web (`xterm-session.ts:76`).
  - Pass terminal font size from settings (`Terminal.tsx:2569`).
  - Add a Problems badge to the bottom tab (`BottomPanel.tsx:256`).
  - Confirm before discarding a single file in SCM (`ChangesList.tsx:338`).
  - Add an "Initialize Repository" button (`SourceControlViewlet.tsx:551`).
  - `Cmd+Enter` commits from anywhere in the SCM view.
  - Hide Run/Debug on web (`ActivityBar.tsx:20`).
  - Double-click a panel tab to maximize.
  - Make the resize handle visible.
  - Double-click the sidebar splitter to reset its width.
- S:
  - Search: include/exclude globs, query history, collapse/expand all, F4 result navigation.
  - Terminal: `file:line` links that open in the editor, copy-on-select, right-click paste.
  - Problems: filter box and severity chips.
  - Auto-collapse the sidebar when the IDE is narrow (split with chat).

**G. Save pipeline and editor menus** (S):
- Insert a final newline and trim trailing whitespace on save (`Workbench.tsx:1189-1213`), with settings toggles.
- Make the autosave delay configurable (currently hardcoded at `Workbench.tsx:161`).
- Register JSON schemas for `package.json` and `tsconfig*.json`, with `allowComments`.
- Add editor right-click items: Copy Relative Path, Reveal in Explorer, and "Ask Shogo about selection", reusing `FIX_IN_AGENT_EVENT`.
- Add missing settings: line height, insert spaces, cursor style, terminal font size, and default shell.
- Cap the size of agent file reads (`sdkFs.readFile` has no gate).

## Tier 4: feel instant (ZCode patterns)

- Refresh the tree incrementally, per directory, from watcher and SSE events.
- Show a read-only Shiki view while Monaco loads, preload `/vs/loader.js`, and defer `extraLibs`.
- Build a cached path index (Web Worker fuzzy filtering) for `Cmd+P`, replacing `flattenFiles` (`Workbench.tsx:197`).
- Search with ripgrep through agent-runtime and IPC, replacing the 600-file JavaScript walk.
- Use async reads, gzip and ETags on file reads.
- Virtualize the tree.

## Tier 5: parity

- Session restore and hot exit.
- Preview tabs, Reopen Closed, and Ctrl+Tab most-recently-used switching.
- A real SCM DiffEditor instead of opening the file (`Workbench.tsx:2253-2260`), then hunk staging.
- Go to Symbol and markdown split preview.
- Line comments that attach to the agent chat, and "Open in Cursor/VS Code".
- Split `Workbench.tsx` and `Terminal.tsx`.
- Language servers beyond TypeScript.
- SCM on cloud.

## Suggested PR sequence

1. Tier 1 (data loss), with tests for case-only rename, folder delete and the dirty-close dialog.
2. Tier 2 (broken basics).
3. Quick-win batches A and B together: one options patch plus a light-mode and copy sweep. Low risk, very visible.
4. Batch C (wire existing modules).
5. Batches D, E and F, one PR per area.
6. Batch G, then Tiers 4 and 5.
