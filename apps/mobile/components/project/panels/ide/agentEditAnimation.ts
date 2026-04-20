/**
 * agentEditAnimation — Cursor-style visual feedback when the chat agent
 * writes to a file that is currently open in the IDE.
 *
 * Per-line diff overlay (Cursor-style):
 *
 *   • Added lines → green background + "+" gutter marker + green overview
 *     ruler tick.
 *   • Modified lines (delete+insert pair at the same position) → amber
 *     background + "~" gutter marker + amber overview ruler tick.
 *   • Deleted lines → phantom view-zone above the affected line showing the
 *     removed text with red strikethrough, plus a red overview ruler tick.
 *
 * For small pure-insertions we also replay a brief typewriter reveal so the
 * user visually catches the agent "typing" new code before the decorations
 * settle. Modifications and deletions apply instantly.
 *
 * All decorations/phantom zones self-clear after `overlayTtlMs` (default 6s)
 * so the editor doesn't accumulate visual noise across many agent writes.
 *
 * Cursor position and scroll offset are preserved across the apply.
 */
import type { editor } from "monaco-editor";

export type MonacoNs = typeof import("monaco-editor");

// ─── Diff primitives ───────────────────────────────────────────────────────

interface DiffOp {
  kind: "eq" | "add" | "del";
  /** 0-indexed line number in the old document (for `eq`/`del`). */
  oldLine?: number;
  /** 0-indexed line number in the new document (for `eq`/`add`). */
  newLine?: number;
  text: string;
}

/**
 * Classic LCS-based line diff. O(n*m) memory/time — fine for files <~5k lines.
 * Callers should guard against huge docs and fall back to coarse-range.
 */
function lcsDiff(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  const dp: Uint32Array[] = Array.from(
    { length: n + 1 },
    () => new Uint32Array(m + 1),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: "eq", oldLine: i, newLine: j, text: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "del", oldLine: i, text: oldLines[i] });
      i++;
    } else {
      ops.push({ kind: "add", newLine: j, text: newLines[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", oldLine: i, text: oldLines[i++] });
  while (j < m) ops.push({ kind: "add", newLine: j, text: newLines[j++] });
  return ops;
}

/**
 * Output of diff classification — drives the decoration layer after the edit
 * is applied. All line numbers are 1-indexed against the NEW document.
 */
interface DiffHighlights {
  /** Lines that are brand-new (green). */
  addedLines: number[];
  /** Lines that replaced a deleted line at the same position (amber). */
  modifiedLines: number[];
  /**
   * Phantom insertions: deleted blocks of lines that need to be rendered
   * above `anchorLine` in the new doc. `anchorLine === 0` means "at the top".
   */
  deletions: Array<{ anchorLine: number; lines: string[] }>;
}

/**
 * Walk the diff ops and classify them into added / modified / phantom-deleted
 * per the UX rules above. Consecutive add+del runs are paired up so editing
 * a line reads as "modified" rather than "delete + add".
 */
function classifyDiff(ops: DiffOp[]): DiffHighlights {
  const addedLines: number[] = [];
  const modifiedLines: number[] = [];
  const deletions: Array<{ anchorLine: number; lines: string[] }> = [];

  let k = 0;
  let lastEqNewLine = 0; // 1-indexed; 0 means top-of-file
  while (k < ops.length) {
    const op = ops[k];
    if (op.kind === "eq") {
      lastEqNewLine = (op.newLine ?? 0) + 1;
      k++;
      continue;
    }
    // Collect a contiguous run of non-eq ops
    const adds: DiffOp[] = [];
    const dels: DiffOp[] = [];
    while (k < ops.length && ops[k].kind !== "eq") {
      if (ops[k].kind === "add") adds.push(ops[k]);
      else dels.push(ops[k]);
      k++;
    }

    const pair = Math.min(adds.length, dels.length);
    for (let p = 0; p < pair; p++) {
      const a = adds[p];
      if (a.newLine != null) modifiedLines.push(a.newLine + 1);
    }
    for (let p = pair; p < adds.length; p++) {
      const a = adds[p];
      if (a.newLine != null) addedLines.push(a.newLine + 1);
    }
    if (dels.length > pair) {
      // Remaining deletions have no matching add — render as phantom lines.
      // Anchor them above the line that followed the deletion block in the
      // new doc: the first add's newLine (if any) or the next eq's newLine.
      let anchor = lastEqNewLine;
      if (adds.length > 0 && adds[0].newLine != null) {
        // Place phantoms after the modified lines.
        anchor = adds[adds.length - 1].newLine! + 1;
      } else if (k < ops.length && ops[k].kind === "eq") {
        anchor = (ops[k].newLine ?? 0); // before the next eq line
      }
      deletions.push({
        anchorLine: anchor,
        lines: dels.slice(pair).map((d) => d.text),
      });
    }
  }

  return { addedLines, modifiedLines, deletions };
}

// ─── Legacy coarse-range helpers (still used for the pure-insertion reveal) ──

/** A contiguous range of line numbers (1-indexed, inclusive) in the NEW document. */
export interface ChangedRange {
  startLine: number;
  endLine: number;
}

export function computeChangedLineRange(
  oldContent: string,
  newContent: string,
): ChangedRange | null {
  if (oldContent === newContent) return null;
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  let prefix = 0;
  const maxPrefix = Math.min(oldLines.length, newLines.length);
  while (prefix < maxPrefix && oldLines[prefix] === newLines[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < maxPrefix - prefix &&
    oldLines[oldLines.length - 1 - suffix] ===
      newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const startLine = prefix + 1;
  const endLine = Math.max(startLine, newLines.length - suffix);
  return { startLine, endLine };
}

export function detectPureInsertion(
  oldContent: string,
  newContent: string,
): { insertAfterLine: number; insertedLines: string[] } | null {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  if (newLines.length <= oldLines.length) return null;

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] ===
      newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  if (prefix + suffix !== oldLines.length) return null;

  const insertedLines = newLines.slice(prefix, newLines.length - suffix);
  if (insertedLines.length === 0) return null;

  return { insertAfterLine: prefix, insertedLines };
}

// ─── Apply ─────────────────────────────────────────────────────────────────

export interface ApplyOpts {
  /**
   * How long to keep the green/amber/red highlights + phantom zones visible
   * before they fade out and the editor returns to its normal appearance.
   */
  overlayTtlMs?: number;
  /** Max lines to animate line-by-line for pure insertions. */
  animateMaxLines?: number;
  /** Milliseconds between appending each animated line. */
  stepMs?: number;
  /** Files longer than this skip the O(n*m) diff and fall back to coarse range. */
  maxDiffLines?: number;
}

function buildDecorations(
  monaco: MonacoNs,
  highlights: DiffHighlights,
): editor.IModelDeltaDecoration[] {
  const decos: editor.IModelDeltaDecoration[] = [];
  const rulerPos = monaco.editor.OverviewRulerLane.Right;
  const minimapPos = monaco.editor.MinimapPosition.Gutter;

  for (const line of highlights.addedLines) {
    decos.push({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: "agent-edit-added-line",
        linesDecorationsClassName: "agent-edit-added-gutter",
        minimap: { color: "#10b981", position: minimapPos },
        overviewRuler: { color: "#10b981", position: rulerPos },
      },
    });
  }
  for (const line of highlights.modifiedLines) {
    decos.push({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: "agent-edit-modified-line",
        linesDecorationsClassName: "agent-edit-modified-gutter",
        minimap: { color: "#eab308", position: minimapPos },
        overviewRuler: { color: "#eab308", position: rulerPos },
      },
    });
  }
  return decos;
}

function addPhantomZones(
  ed: editor.IStandaloneCodeEditor,
  deletions: DiffHighlights["deletions"],
  ttlMs: number,
): void {
  if (deletions.length === 0) return;
  const zoneIds: string[] = [];
  ed.changeViewZones((accessor) => {
    for (const d of deletions) {
      const container = document.createElement("div");
      container.className = "agent-edit-deleted-zone";
      for (const text of d.lines) {
        const lineEl = document.createElement("div");
        lineEl.className = "agent-edit-deleted-line";
        lineEl.textContent = text.length === 0 ? "\u00a0" : text;
        container.appendChild(lineEl);
      }
      const id = accessor.addZone({
        afterLineNumber: d.anchorLine,
        heightInLines: d.lines.length,
        domNode: container,
      });
      zoneIds.push(id);
    }
  });
  // Fade out + remove after TTL.
  window.setTimeout(() => {
    try {
      ed.changeViewZones((accessor) => {
        for (const id of zoneIds) accessor.removeZone(id);
      });
    } catch {
      /* editor may have been disposed */
    }
  }, ttlMs);
}

/**
 * Apply the incoming content to the editor with Cursor-style visual feedback.
 * Returns a promise that resolves when any animation has finished.
 */
export function applyAgentEdit(
  ed: editor.IStandaloneCodeEditor,
  monaco: MonacoNs,
  newContent: string,
  opts: ApplyOpts = {},
): Promise<void> {
  const {
    overlayTtlMs = 6000,
    animateMaxLines = 30,
    stepMs = 35,
    maxDiffLines = 5000,
  } = opts;

  const model = ed.getModel();
  if (!model) return Promise.resolve();

  const oldContent = model.getValue();
  if (oldContent === newContent) return Promise.resolve();

  const rememberedPosition = ed.getPosition();
  const rememberedScrollTop = ed.getScrollTop();

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  // Pure insertion + small enough → typewriter reveal (keeps the "agent is
  // typing" feel for the common append-a-function case).
  const insertion = detectPureInsertion(oldContent, newContent);
  if (
    insertion &&
    insertion.insertedLines.length > 0 &&
    insertion.insertedLines.length <= animateMaxLines
  ) {
    return typewriterInsert(ed, monaco, insertion, {
      stepMs,
      overlayTtlMs,
    });
  }

  // Full line diff + classify (only if both sides are small enough).
  let highlights: DiffHighlights;
  if (oldLines.length <= maxDiffLines && newLines.length <= maxDiffLines) {
    const ops = lcsDiff(oldLines, newLines);
    highlights = classifyDiff(ops);
  } else {
    // Coarse fallback: treat the whole changed region as "modified".
    const range = computeChangedLineRange(oldContent, newContent);
    highlights = {
      addedLines: [],
      modifiedLines: range
        ? Array.from(
            { length: range.endLine - range.startLine + 1 },
            (_, idx) => range.startLine + idx,
          )
        : [],
      deletions: [],
    };
  }

  // Apply the edit in a single push so undo groups cleanly.
  model.pushEditOperations(
    [],
    [{ range: model.getFullModelRange(), text: newContent }],
    () => null,
  );
  restoreCursorAndScroll(ed, model, rememberedPosition, rememberedScrollTop);

  // Paint decorations.
  const decoIds = ed.deltaDecorations([], buildDecorations(monaco, highlights));
  window.setTimeout(() => {
    try {
      ed.deltaDecorations(decoIds, []);
    } catch {
      /* editor disposed */
    }
  }, overlayTtlMs);

  // Paint phantom "deleted" view zones.
  addPhantomZones(ed, highlights.deletions, overlayTtlMs);

  // Scroll the first change into view if it happens to be off-screen.
  const firstChange =
    highlights.addedLines[0] ??
    highlights.modifiedLines[0] ??
    highlights.deletions[0]?.anchorLine;
  if (firstChange && firstChange > 0) {
    ed.revealLineInCenterIfOutsideViewport(firstChange);
  }

  return Promise.resolve();
}

function restoreCursorAndScroll(
  ed: editor.IStandaloneCodeEditor,
  model: editor.ITextModel,
  rememberedPosition: ReturnType<editor.IStandaloneCodeEditor["getPosition"]>,
  rememberedScrollTop: number,
): void {
  if (rememberedPosition) {
    const lineCount = model.getLineCount();
    const line = Math.min(rememberedPosition.lineNumber, lineCount);
    const column = Math.min(
      rememberedPosition.column,
      model.getLineMaxColumn(line),
    );
    ed.setPosition({ lineNumber: line, column });
  }
  ed.setScrollTop(rememberedScrollTop);
}

function typewriterInsert(
  ed: editor.IStandaloneCodeEditor,
  monaco: MonacoNs,
  insertion: NonNullable<ReturnType<typeof detectPureInsertion>>,
  { stepMs, overlayTtlMs }: { stepMs: number; overlayTtlMs: number },
): Promise<void> {
  return new Promise<void>((resolve) => {
    const model = ed.getModel();
    if (!model) {
      resolve();
      return;
    }
    const after = insertion.insertAfterLine;
    ed.revealLineInCenterIfOutsideViewport(after + 1);

    let progress = 0;
    const tick = () => {
      if (progress >= insertion.insertedLines.length) {
        const startLine = after + 1;
        const endLine = after + insertion.insertedLines.length;
        const decoIds = ed.deltaDecorations(
          [],
          [
            {
              range: new monaco.Range(startLine, 1, endLine, 1),
              options: {
                isWholeLine: true,
                className: "agent-edit-added-line",
                linesDecorationsClassName: "agent-edit-added-gutter",
                minimap: {
                  color: "#10b981",
                  position: monaco.editor.MinimapPosition.Gutter,
                },
                overviewRuler: {
                  color: "#10b981",
                  position: monaco.editor.OverviewRulerLane.Right,
                },
              },
            },
          ],
        );
        window.setTimeout(() => {
          try {
            ed.deltaDecorations(decoIds, []);
          } catch {
            /* editor disposed */
          }
        }, overlayTtlMs);
        resolve();
        return;
      }
      const line = insertion.insertedLines[progress];
      const insertLineNumber = after + progress + 1;
      const startColumn =
        insertLineNumber > model.getLineCount()
          ? 1
          : model.getLineMaxColumn(insertLineNumber);
      const startLine = Math.min(insertLineNumber, model.getLineCount());
      model.pushEditOperations(
        [],
        [
          {
            range: new monaco.Range(
              startLine,
              startColumn,
              startLine,
              startColumn,
            ),
            text: "\n" + line,
          },
        ],
        () => null,
      );
      ed.revealLineInCenterIfOutsideViewport(insertLineNumber + 1);
      progress++;
      window.setTimeout(tick, stepMs);
    };
    tick();
  });
}
