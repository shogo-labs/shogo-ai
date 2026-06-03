// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// G4.5 — 3-way merge editor. Mirrors VS Code's merge editor:
//   ┌──────────────────────────────┬──────────────────────────────┐
//   │           BASE               │            INCOMING          │
//   │   (common ancestor)          │       (theirs / stage 3)     │
//   ├──────────────────────────────┴──────────────────────────────┤
//   │                       RESULT (working tree)                  │
//   │              — what gets saved to disk on Accept             │
//   └──────────────────────────────────────────────────────────────┘
//
// Stage 1 is the merge-base, stage 2 is OURS (HEAD-side), stage 3 is
// THEIRS. We show BASE + THEIRS in the top row and the live working
// buffer (with the user's edits) underneath. The header surfaces
// per-conflict navigation + accept actions; clicking one rewrites the
// working buffer and re-renders.
//
// The renderer never writes directly — it stages the resolved buffer
// through `git add` via the bridge (handled by maybeAutoStage on the
// next save), and reuses the existing fs.writeFile for the disk write.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { editor as MonacoEditor } from "monaco-editor";

import { getDesktopGitBridge } from "./bridge";
import { parseConflictBlocks, type ConflictBlock } from "./conflictBlocks";
import type { MonacoNs } from "./editorIntegration";

interface Props {
  monaco: MonacoNs;
  workspaceRoot: string;
  relPath: string;
  onClose: () => void;
  /**
   * Called when the user clicks Save & Stage. Receives the resolved
   * buffer contents — the caller is responsible for writing it to disk
   * (so we reuse the existing workspace service / dirty-buffer logic in
   * Workbench) and then `git add`-ing it.
   */
  onSave: (content: string) => Promise<void>;
}

export function MergeEditorModal({ monaco, workspaceRoot, relPath, onClose, onSave }: Props) {
  const [stages, setStages] = useState<{ base: string | null; ours: string | null; theirs: string | null; working: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeBlock, setActiveBlock] = useState(0);

  const baseRef = useRef<HTMLDivElement | null>(null);
  const theirsRef = useRef<HTMLDivElement | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const baseEdRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const theirsEdRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const resultEdRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    let cancelled = false;
    const bridge = getDesktopGitBridge();
    if (!bridge) { setError("Desktop bridge unavailable"); return; }
    bridge.mergeStages(workspaceRoot, relPath).then((r) => {
      if (cancelled) return;
      if (!r.ok || !r.stages) { setError(r.error || r.reason || "failed to load merge stages"); return; }
      setStages(r.stages);
    });
    return () => { cancelled = true; };
  }, [workspaceRoot, relPath]);

  // Mount editors when stages arrive.
  useEffect(() => {
    if (!stages) return;
    const opts: MonacoEditor.IStandaloneEditorConstructionOptions = {
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 12,
      theme: "vs-dark",
      scrollBeyondLastLine: false,
    };
    if (baseRef.current && !baseEdRef.current) {
      baseEdRef.current = monaco.editor.create(baseRef.current, { ...opts, value: stages.base ?? "(no base)", language: "plaintext" });
    }
    if (theirsRef.current && !theirsEdRef.current) {
      theirsEdRef.current = monaco.editor.create(theirsRef.current, { ...opts, value: stages.theirs ?? "(missing)", language: "plaintext" });
    }
    if (resultRef.current && !resultEdRef.current) {
      resultEdRef.current = monaco.editor.create(resultRef.current, {
        ...opts,
        readOnly: false,
        value: stages.working,
        language: "plaintext",
      });
    }
    return () => {
      baseEdRef.current?.dispose(); baseEdRef.current = null;
      theirsEdRef.current?.dispose(); theirsEdRef.current = null;
      resultEdRef.current?.dispose(); resultEdRef.current = null;
    };
  }, [monaco, stages]);

  // Re-parse conflict blocks whenever the result buffer changes.
  const [blocks, setBlocks] = useState<ConflictBlock[]>(() => stages ? parseConflictBlocks(stages.working) : []);
  useEffect(() => {
    const ed = resultEdRef.current;
    if (!ed) return;
    const refresh = () => setBlocks(parseConflictBlocks(ed.getValue()));
    refresh();
    const d = ed.onDidChangeModelContent(refresh);
    return () => d.dispose();
  }, [stages]);

  const jumpTo = useCallback((i: number) => {
    setActiveBlock(i);
    const b = blocks[i];
    const ed = resultEdRef.current;
    if (!b || !ed) return;
    ed.revealLineInCenter(b.start);
    ed.setPosition({ lineNumber: b.start, column: 1 });
  }, [blocks]);

  const accept = useCallback((kind: "current" | "incoming" | "both") => {
    const ed = resultEdRef.current;
    const b = blocks[activeBlock];
    if (!ed || !b) return;
    const model = ed.getModel();
    if (!model) return;
    // The current section ends at b.currentEnd (the `|||||||` base marker
    // under diff3, otherwise the `=======` separator) — never include the
    // common-ancestor section in "Accept Current"/"Accept Both".
    const replacement =
      kind === "current" ? model.getValueInRange(new monaco.Range(b.start + 1, 1, b.currentEnd, 1)) :
      kind === "incoming" ? model.getValueInRange(new monaco.Range(b.mid + 1, 1, b.end, 1)) :
      model.getValueInRange(new monaco.Range(b.start + 1, 1, b.currentEnd, 1)) + model.getValueInRange(new monaco.Range(b.mid + 1, 1, b.end, 1));
    // Clamp to model bounds: if `>>>>>>>` is the final line of the file
    // there is no `b.end + 1` to anchor on. End at column-end of b.end.
    const lastLine = model.getLineCount();
    const endLine = Math.min(b.end + 1, lastLine);
    const endCol = endLine === lastLine && b.end >= lastLine ? model.getLineMaxColumn(lastLine) : 1;
    ed.executeEdits("shogo.merge.accept", [{
      range: new monaco.Range(b.start, 1, endLine, endCol),
      text: replacement,
      forceMoveMarkers: true,
    }]);
  }, [monaco, blocks, activeBlock]);

  const saveAndStage = useCallback(async () => {
    const ed = resultEdRef.current;
    if (!ed) return;
    setBusy(true);
    setError(null);
    try {
      const content = ed.getValue();
      await onSave(content);
      const git = getDesktopGitBridge();
      if (git && !/^<<<<<<<\s/m.test(content)) {
        await git.stage(workspaceRoot, [relPath]);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [workspaceRoot, relPath, onSave, onClose]);

  const remaining = blocks.length;
  const hint = useMemo(() => {
    if (!stages) return "Loading…";
    if (error) return `Error: ${error}`;
    if (remaining === 0) return "All conflicts resolved";
    return `${remaining} conflict${remaining === 1 ? "" : "s"} remaining`;
  }, [stages, error, remaining]);

  if (typeof document === "undefined") return null;
  // `shogo-ide` class so any var(--ide-*) inside this subtree resolves
  // correctly — the IDE theme tokens are scoped to .shogo-ide and
  // portaling moves us out of that ancestor. See BranchPicker.tsx.
  return createPortal(
    <div className="shogo-ide fixed inset-0 z-[1000] flex flex-col bg-zinc-950/95 backdrop-blur-sm text-zinc-100">
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">Merge: {relPath}</span>
          <span className={`text-xs ${remaining === 0 ? "text-emerald-400" : "text-amber-300"}`}>{hint}</span>
        </div>
        <div className="flex items-center gap-2">
          <button className="text-xs px-2 py-1 rounded hover:bg-zinc-800" onClick={() => jumpTo(Math.max(0, activeBlock - 1))} disabled={!blocks.length}>↑ Prev</button>
          <button className="text-xs px-2 py-1 rounded hover:bg-zinc-800" onClick={() => jumpTo(Math.min(blocks.length - 1, activeBlock + 1))} disabled={!blocks.length}>↓ Next</button>
          <span className="text-xs text-zinc-500 mx-1">|</span>
          <button className="text-xs px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50" onClick={() => accept("current")} disabled={!blocks.length}>Accept Current</button>
          <button className="text-xs px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50" onClick={() => accept("incoming")} disabled={!blocks.length}>Accept Incoming</button>
          <button className="text-xs px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50" onClick={() => accept("both")} disabled={!blocks.length}>Accept Both</button>
          <span className="text-xs text-zinc-500 mx-1">|</span>
          <button className="text-xs px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50" onClick={saveAndStage} disabled={busy}>Save & Stage</button>
          <button className="text-xs px-2 py-1 rounded hover:bg-zinc-800" onClick={onClose}>Close</button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-px bg-zinc-800 flex-1 min-h-0">
        <div className="flex flex-col bg-zinc-950">
          <div className="px-3 py-1 text-[11px] uppercase tracking-wider text-zinc-400 border-b border-zinc-800">Base (common ancestor)</div>
          <div ref={baseRef} className="flex-1 min-h-0" />
        </div>
        <div className="flex flex-col bg-zinc-950">
          <div className="px-3 py-1 text-[11px] uppercase tracking-wider text-zinc-400 border-b border-zinc-800">Incoming (theirs)</div>
          <div ref={theirsRef} className="flex-1 min-h-0" />
        </div>
      </div>
      <div className="flex flex-col bg-zinc-950 flex-1 min-h-0 border-t border-zinc-800">
        <div className="px-3 py-1 text-[11px] uppercase tracking-wider text-zinc-400 border-b border-zinc-800">Result (your working buffer)</div>
        <div ref={resultRef} className="flex-1 min-h-0" />
      </div>
    </div>,
    document.body,
  );
}
