# Shogo IDE — Phase 1 Prototype

A VS Code / Cursor–style code editor shell built on Monaco, living inside the `apps/` tree so it can grow into our canonical editing surface.

## What's in this phase

- Full VS Code–shaped layout: title bar, activity bar, resizable sidebar, editor tabs, breadcrumbs, bottom panel, status bar
- Monaco editor with custom `shogo-dark` theme and TypeScript syntax
- File tree with expandable folders and active-file highlighting
- Tab bar with dirty indicators, middle-click close, ⌘W close
- Resizable panes (`react-resizable-panels`) — drag any separator
- Keyboard: ⌘S save (in-memory), ⌘W close tab, ⌘J toggle bottom panel
- Zero console errors; QA-verified in browser

## Not yet in this phase (see the phased plan)

- Real filesystem backend (Phase 2 — skill server routes)
- File tree CRUD + virtualization for large repos (Phase 3)
- Command Palette + Quick Open + splits (Phase 4)
- Local folder picker via File System Access API (Phase 5)
- IntelliSense / project-wide search / find & replace (Phase 6)
- Agent live-edit diffs with accept/reject (Phase 7) ← the differentiator
- Mobile gating + lazy-load (Phase 8)

## Run it

```bash
cd apps/ide-prototype
bun install
bun run dev
```

Then open the Vite URL it prints. Everything lives under `src/components/ide/`.
