// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Monaco-side integration for G4: gutter markers (added/modified/removed),
// inline blame at the end of the current cursor line, and a conflict
// CodeLens provider that surfaces "Accept Current / Incoming / Both" on
// `<<<<<<<` / `=======` / `>>>>>>>` markers.
//
// Everything here is intentionally side-effecty — we register Monaco
// providers and apply decorations through `editor.deltaDecorations`.
// The Workbench effect calls `attachGitDecorations(...)` once per
// (editor, monaco, root, path, refreshTick) combo and disposes via the
// returned cleanup.

import type { editor as MonacoEditor, IDisposable } from "monaco-editor";

import { getDesktopGitBridge, type BlameLine, type DiffMarker } from "./bridge";

export type MonacoNs = typeof import("monaco-editor");

interface AttachOptions {
  monaco: MonacoNs;
  ed: MonacoEditor.IStandaloneCodeEditor;
  workspaceRoot: string;
  relPath: string;
  /** Bump when the snapshot or file body changes to force a recompute. */
  refreshTick: number;
}

const GUTTER_ADDED = "shogo-gutter-added";
const GUTTER_MODIFIED = "shogo-gutter-modified";
const GUTTER_REMOVED = "shogo-gutter-removed";
const INLINE_BLAME_AFTER = "shogo-inline-blame-after";

let stylesInjected = false;
function ensureStylesInjected(): void {
  if (stylesInjected) return;
  if (typeof document === "undefined") return;
  const css = `
.${GUTTER_ADDED} {
  border-left: 3px solid #73c991 !important;
  margin-left: 3px;
}
.${GUTTER_MODIFIED} {
  border-left: 3px solid #6366f1 !important;
  margin-left: 3px;
}
.${GUTTER_REMOVED} {
  border-left: 3px solid transparent;
  background: linear-gradient(to bottom, transparent 30%, #f48771 30%, #f48771 70%, transparent 70%) no-repeat 4px center / 6px 6px;
}
.${INLINE_BLAME_AFTER}::after {
  content: attr(data-blame);
  color: rgba(133, 133, 133, 0.85);
  font-style: italic;
  margin-left: 1.5em;
  pointer-events: none;
}
.shogo-conflict-codelens {
  font-style: italic;
}
`;
  const style = document.createElement("style");
  style.setAttribute("data-shogo-git", "");
  style.textContent = css;
  document.head.appendChild(style);
  stylesInjected = true;
}

/**
 * Attach all G4 decorations + the conflict CodeLens provider to the given
 * editor. Returns a disposer that:
 *   - removes diff/blame decorations
 *   - disposes the cursor + blame listeners
 *   - unregisters the CodeLens provider
 */
export function attachGitDecorations(opts: AttachOptions): IDisposable {
  ensureStylesInjected();
  const { monaco, ed, workspaceRoot, relPath, refreshTick: _refreshTick } = opts;
  const bridge = getDesktopGitBridge();
  void _refreshTick; // consumed by the React effect's dep array
  let diffDecoIds: string[] = [];
  let blameDecoIds: string[] = [];
  let blameMap = new Map<number, BlameLine>();
  let cancelled = false;

  // Track marker hunks so the gutter-glyph click handler can find which
  // hunk the user is reverting just from a line number.
  let currentMarkers: DiffMarker[] = [];
  const applyDiffDecorations = (markers: DiffMarker[]) => {
    if (cancelled) return;
    currentMarkers = markers;
    const decos: MonacoEditor.IModelDeltaDecoration[] = markers.map((m) => ({
      range: new monaco.Range(m.startLine, 1, m.endLine, 1),
      options: {
        isWholeLine: true,
        linesDecorationsClassName:
          m.kind === "added" ? GUTTER_ADDED : m.kind === "modified" ? GUTTER_MODIFIED : GUTTER_REMOVED,
        hoverMessage: {
          value:
            (m.kind === "added"
              ? `+ ${m.added} line${m.added === 1 ? "" : "s"} added`
              : m.kind === "modified"
              ? `~ ${m.added} line${m.added === 1 ? "" : "s"} modified (${m.removed} removed)`
              : `- ${m.removed} line${m.removed === 1 ? "" : "s"} removed`) +
            "\n\n[Revert this hunk](command:shogo.git.revertHunk?" +
            encodeURIComponent(JSON.stringify([m.startLine, m.endLine, m.kind])) +
            ")",
          isTrusted: true,
        },
      },
    }));
    diffDecoIds = ed.deltaDecorations(diffDecoIds, decos);
  };

  // Register the revert command. It's per-editor (addAction), so the
  // hover message's command: link works without polluting Monaco's
  // global command registry.
  const revertAction = ed.addAction({
    id: "shogo.git.revertHunk",
    label: "Shogo: Revert Hunk",
    run: async (_e, ...args: unknown[]) => {
      const startLine = Number(args[0]);
      const endLine = Number(args[1]);
      const kind = String(args[2] ?? "modified") as DiffMarker["kind"];
      if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return;
      if (!bridge) return;
      // Pure-add hunks: no HEAD counterpart, just delete the working lines.
      if (kind === "added") {
        await bridge.revertHunk(workspaceRoot, relPath, startLine, endLine, null, null);
        return;
      }
      // Otherwise we need the OLD-side line range from the parsed marker
      // — we can't infer it from working line numbers because prior
      // hunks above may have changed the net line count.
      const m = currentMarkers.find((x) => x.startLine === startLine && x.endLine === endLine);
      if (!m || m.oldStart <= 0 || m.removed <= 0) {
        // Fall back to "delete working lines" rather than splicing garbage.
        await bridge.revertHunk(workspaceRoot, relPath, startLine, endLine, null, null);
        return;
      }
      const headStart = m.oldStart;
      const headEnd = m.oldStart + m.removed - 1;
      // "removed" hunks have startLine === endLine and no content in the
      // working buffer to replace — we want to INSERT the HEAD lines at
      // that anchor, which means working range = anchor..(anchor-1)
      // (an empty splice). The hunkRevert helper handles that via the
      // workingStart > workingEnd convention: pass workingEnd = anchor-1.
      const workingEndForSplice = kind === "removed" ? Math.max(0, startLine - 1) : endLine;
      await bridge.revertHunk(workspaceRoot, relPath, startLine, workingEndForSplice, headStart, headEnd);
    },
  });

  const renderInlineBlame = (lineNumber: number) => {
    if (cancelled) return;
    blameDecoIds = ed.deltaDecorations(blameDecoIds, []);
    const entry = blameMap.get(lineNumber);
    if (!entry) return;
    if (entry.sha.startsWith("0000000")) return; // uncommitted line — hide
    const label = `${entry.author}, ${formatRelative(entry.authorTime)} · ${entry.summary}`;
    const model = ed.getModel();
    if (!model) return;
    const lineLen = Math.max(1, model.getLineMaxColumn(lineNumber));
    blameDecoIds = ed.deltaDecorations(blameDecoIds, [
      {
        range: new monaco.Range(lineNumber, lineLen, lineNumber, lineLen),
        options: {
          after: {
            content: label,
            inlineClassName: INLINE_BLAME_AFTER,
            cursorStops: monaco.editor.InjectedTextCursorStops.None,
          },
        },
      },
    ]);
  };

  // Conflict CodeLens — scans the document for `<<<<<<<` / `=======` /
  // `>>>>>>>` and offers Accept Current / Incoming / Both. Click handlers
  // edit the buffer directly via the model.
  const language = ed.getModel()?.getLanguageId() ?? "plaintext";
  const codeLensDisposer = monaco.languages.registerCodeLensProvider(language, {
    provideCodeLenses: (model) => {
      const text = model.getValue();
      // Cheap pre-check: if no conflict markers present, return nothing.
      if (!/^<<<<<<<\s/m.test(text)) return { lenses: [], dispose: () => undefined };
      const lenses: import('monaco-editor').languages.CodeLens[] = [];
      const total = model.getLineCount();
      const blocks: { start: number; mid: number; end: number }[] = [];
      let cur: { start: number; mid: number; end: number } | null = null;
      for (let line = 1; line <= total; line++) {
        const lineText = model.getLineContent(line);
        if (lineText.startsWith("<<<<<<< ")) {
          cur = { start: line, mid: -1, end: -1 };
        } else if (cur && cur.mid === -1 && /^=======\s*$/.test(lineText)) {
          cur.mid = line;
        } else if (cur && cur.mid !== -1 && lineText.startsWith(">>>>>>> ")) {
          cur.end = line;
          blocks.push(cur);
          cur = null;
        }
      }
      for (const b of blocks) {
        const range = new monaco.Range(b.start, 1, b.start, 1);
        const argsKey = `${b.start}:${b.mid}:${b.end}`;
        lenses.push(
          { range, id: `current-${argsKey}`, command: { id: "shogo.git.acceptConflict", title: "Accept Current Change", arguments: ["current", b.start, b.mid, b.end] } },
          { range, id: `incoming-${argsKey}`, command: { id: "shogo.git.acceptConflict", title: "Accept Incoming Change", arguments: ["incoming", b.start, b.mid, b.end] } },
          { range, id: `both-${argsKey}`, command: { id: "shogo.git.acceptConflict", title: "Accept Both", arguments: ["both", b.start, b.mid, b.end] } },
        );
      }
      return { lenses, dispose: () => undefined };
    },
    resolveCodeLens: (_model, lens) => lens,
  });

  // Register the command if not already present.
  const cmdId = "shogo.git.acceptConflict";
  // Monaco's `editor.addCommand` returns void; we re-register every
  // attach but that's fine — Monaco dedupes by id.
  ed.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.F1, () => undefined); // no-op: ensures the command system is alive
  // For arbitrary args we route through editor.trigger via a registered action.
  const acceptAction = ed.addAction({
    id: cmdId,
    label: "Shogo: Accept Conflict Hunk",
    run: (_editor, ...args: unknown[]) => {
      const kind = args[0] as "current" | "incoming" | "both";
      const start = args[1] as number;
      const mid = args[2] as number;
      const end = args[3] as number;
      acceptConflict(monaco, ed, kind, start, mid, end);
    },
  });

  // Fetch markers + blame in parallel.
  if (bridge) {
    void bridge.diffMarkers(workspaceRoot, relPath).then((r) => {
      if (cancelled) return;
      if (r.ok && r.markers) applyDiffDecorations(r.markers);
    });
    void bridge.blame(workspaceRoot, relPath).then((r) => {
      if (cancelled) return;
      if (!r.ok || !r.lines) return;
      blameMap = new Map(r.lines.map((b) => [b.line, b]));
      const pos = ed.getPosition();
      if (pos) renderInlineBlame(pos.lineNumber);
    });
  }

  // Cursor listener — re-render inline blame as the user moves around.
  const cursorListener = ed.onDidChangeCursorPosition((e) => {
    renderInlineBlame(e.position.lineNumber);
  });

  return {
    dispose() {
      cancelled = true;
      try { ed.deltaDecorations(diffDecoIds, []); } catch { /* editor disposed */ }
      try { ed.deltaDecorations(blameDecoIds, []); } catch { /* editor disposed */ }
      cursorListener.dispose();
      codeLensDisposer.dispose();
      acceptAction.dispose();
      revertAction.dispose();
    },
  };
}

/**
 * Apply a conflict-resolution choice by editing the buffer. We keep the
 * decision purely client-side — auto `git add` happens on the next save
 * via `maybeAutoStageIfConflictResolved`.
 */
function acceptConflict(
  monaco: MonacoNs,
  ed: MonacoEditor.IStandaloneCodeEditor,
  kind: "current" | "incoming" | "both",
  start: number,
  mid: number,
  end: number,
): void {
  const model = ed.getModel();
  if (!model) return;
  let replacement = "";
  if (kind === "current") {
    // Keep lines (start+1 .. mid-1)
    replacement = model.getValueInRange(new monaco.Range(start + 1, 1, mid, 1));
  } else if (kind === "incoming") {
    // Keep lines (mid+1 .. end-1)
    replacement = model.getValueInRange(new monaco.Range(mid + 1, 1, end, 1));
  } else {
    const a = model.getValueInRange(new monaco.Range(start + 1, 1, mid, 1));
    const b = model.getValueInRange(new monaco.Range(mid + 1, 1, end, 1));
    replacement = a + b;
  }
  ed.executeEdits("shogo.git.acceptConflict", [
    {
      range: new monaco.Range(start, 1, end + 1, 1),
      text: replacement,
      forceMoveMarkers: true,
    },
  ]);
}

/**
 * Auto-stage hook called on file save. If the buffer no longer contains
 * any `<<<<<<<` markers, we assume the user resolved the conflict and
 * stage the file. Gated by the caller — useful inside Workbench's save
 * handler.
 */
export async function maybeAutoStageIfConflictResolved(
  workspaceRoot: string,
  relPath: string,
  textAfterSave: string,
): Promise<void> {
  // If the buffer still has conflict markers we obviously haven't
  // resolved anything yet.
  if (/^<<<<<<<\s/m.test(textAfterSave)) return;
  const bridge = getDesktopGitBridge();
  if (!bridge) return;
  // Only auto-stage if the file is currently flagged as a merge conflict
  // by porcelain. Otherwise we'd silently stage every saved file, which
  // would surprise the user (especially mid-feature work where they
  // explicitly want to keep changes unstaged).
  try {
    const snap = await bridge.current(workspaceRoot);
    if (!snap.ok || !snap.snapshot) return;
    if (!snap.snapshot.conflictPaths.includes(relPath)) return;
  } catch {
    return;
  }
  try {
    await bridge.stage(workspaceRoot, [relPath]);
  } catch {
    // Best-effort — staging will surface in the next status refresh
    // regardless of failure here.
  }
}

function formatRelative(epochSec: number): string {
  if (!epochSec) return "unknown";
  const diffMs = Date.now() - epochSec * 1000;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hour = Math.floor(min / 60);
  if (hour < 48) return `${hour}h ago`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 18) return `${mo}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}
