/**
 * agentEditAnimation — Cursor-style visual feedback when the chat agent
 * writes to a file that is currently open in the IDE.
 *
 * Two layered effects:
 *
 *   1. Green flash — the changed line range gets a soft-green background
 *      decoration that fades out over ~2s. Makes it instantly obvious
 *      "this just changed" without being distracting.
 *   2. Typewriter reveal (optional) — if the incoming content only ADDS
 *      lines (pure insertion), the new lines are appended one at a time
 *      over ~400ms, simulating a live typing feel. Modifications and
 *      deletions are applied instantly (animating those well would
 *      require a real side-by-side diff viewer).
 *
 * Cursor position and scroll offset are preserved across the apply.
 */
import type { editor } from "monaco-editor";

export type MonacoNs = typeof import("monaco-editor");

/** A contiguous range of line numbers (1-indexed, inclusive) in the NEW document. */
export interface ChangedRange {
  startLine: number;
  endLine: number;
}

/**
 * Compute a coarse line-level diff using longest-common-prefix + suffix.
 * Returns a single "changed region" spanning from the first divergent line
 * to the last — good enough for the flash UI. For precise line-by-line
 * precision use Monaco's built-in diff computer (heavier, not needed here).
 */
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

/**
 * Detect a "pure insertion": the new content equals the old with one contiguous
 * block of added lines. This is the case most agent writes fall into (appending
 * a route, adding a function, etc.) and it animates well.
 */
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

  // If prefix + suffix doesn't cover every old line, some old line was modified
  // or removed → not a pure insertion.
  if (prefix + suffix !== oldLines.length) return null;

  const insertedLines = newLines.slice(prefix, newLines.length - suffix);
  if (insertedLines.length === 0) return null;

  return { insertAfterLine: prefix, insertedLines };
}

export interface ApplyOpts {
  flashMs?: number;
  /** Max lines to animate line-by-line. Larger changes apply instantly. */
  animateMaxLines?: number;
  /** Milliseconds between appending each animated line. */
  stepMs?: number;
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
  const { flashMs = 2200, animateMaxLines = 30, stepMs = 35 } = opts;

  const model = ed.getModel();
  if (!model) return Promise.resolve();

  const oldContent = model.getValue();
  if (oldContent === newContent) return Promise.resolve();

  const rememberedPosition = ed.getPosition();
  const rememberedScrollTop = ed.getScrollTop();

  const changedRange = computeChangedLineRange(oldContent, newContent);
  const insertion = detectPureInsertion(oldContent, newContent);

  const addFlash = (startLine: number, endLine: number) => {
    const decos: editor.IModelDeltaDecoration[] = [
      {
        range: new monaco.Range(startLine, 1, endLine, 1),
        options: {
          isWholeLine: true,
          className: "agent-edit-flash",
          linesDecorationsClassName: "agent-edit-gutter-flash",
        },
      },
    ];
    const ids = ed.deltaDecorations([], decos);
    setTimeout(() => {
      try {
        ed.deltaDecorations(ids, []);
      } catch {
        /* editor may have been disposed */
      }
    }, flashMs);
  };

  const restoreCursorAndScroll = () => {
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
  };

  // --- Pure insertion + small enough → typewriter reveal ----------------------
  if (
    insertion &&
    insertion.insertedLines.length > 0 &&
    insertion.insertedLines.length <= animateMaxLines
  ) {
    return new Promise<void>((resolve) => {
      const after = insertion.insertAfterLine;
      // `after` is 0-indexed before the insert point. Monaco uses 1-indexed.
      // Insert position: end of line `after` (i.e. between line `after` and
      // line `after + 1` in the old doc).
      const revealLine = after + 1;
      ed.revealLineInCenterIfOutsideViewport(revealLine);

      let progress = 0;
      const tick = () => {
        if (progress >= insertion.insertedLines.length) {
          restoreCursorAndScroll();
          addFlash(after + 1, after + insertion.insertedLines.length);
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
        // Use a push-edit to append a new line and content, using identifier
        // "shogo-agent-edit" so undo groups properly.
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
        // Follow the cursor as it "types"
        ed.revealLineInCenterIfOutsideViewport(insertLineNumber + 1);
        progress++;
        setTimeout(tick, stepMs);
      };
      tick();
    });
  }

  // --- Fallback: instant full-document replace + flash ------------------------
  model.pushEditOperations(
    [],
    [
      {
        range: model.getFullModelRange(),
        text: newContent,
      },
    ],
    () => null,
  );
  restoreCursorAndScroll();
  if (changedRange) {
    ed.revealLineInCenterIfOutsideViewport(changedRange.startLine);
    addFlash(changedRange.startLine, changedRange.endLine);
  }
  return Promise.resolve();
}
