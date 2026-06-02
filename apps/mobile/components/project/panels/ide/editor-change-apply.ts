/**
 * editor-change-apply.ts — pure target resolution for Monaco content changes.
 *
 * The bug this exists to prevent (BUG-001, "Monaco split-editor: stale model
 * on rapid tab swap"):
 *
 *   Old code in Workbench.handleChangeFor wrote Monaco's value to whichever
 *   file matched the group's CURRENT `activeId`. If the user swapped tabs
 *   faster than React could re-render <CodeEditor path={…}>, an in-flight
 *   onChange fired against the previously-attached model could land in the
 *   newly-active tab — polluting tab B with tab A's content.
 *
 *   The fix routes every change by the model URI's fileId (carried out of
 *   CodeEditor's Monaco listener) rather than by group.activeId. This module
 *   is the deterministic, side-effect-free target resolver so the routing
 *   rule is unit-testable.
 *
 * Contract:
 *   - File NOT in group  → return same group ref (no allocation), no write.
 *     This is the "closed mid-flight" case: user closed the tab between the
 *     keystroke and React flushing the close — silently drop the edit.
 *   - File in group, value unchanged → return same group ref, no write.
 *     Skips churning React state for no-op flush events.
 *   - File in group, value changed → return new group + new file objects
 *     with content updated and dirty re-derived from `val !== savedContent`.
 *
 * The handler explicitly does NOT consult `group.activeId` — that's the
 * whole point. Routing by activeId is what made the bug possible.
 */
import type { EditorGroup, OpenFile } from "./types";

export function applyEditorChange(
  group: EditorGroup,
  fileId: string,
  val: string,
): EditorGroup {
  const idx = group.files.findIndex((f) => f.id === fileId);
  if (idx < 0) return group;

  const file = group.files[idx]!;
  if (file.content === val) return group;

  const nextFile: OpenFile = {
    ...file,
    content: val,
    dirty: val !== file.savedContent,
  };
  const nextFiles = group.files.slice();
  nextFiles[idx] = nextFile;
  return { ...group, files: nextFiles };
}
