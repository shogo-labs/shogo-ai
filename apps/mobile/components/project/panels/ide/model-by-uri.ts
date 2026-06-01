/**
 * model-by-uri.ts — fileId → Monaco model / editor resolution (BUG-003).
 *
 * Companion to save-target.ts. Where `resolveSaveTarget` resolves the
 * OpenFile by id from React state, these helpers resolve the corresponding
 * Monaco artefacts by URI.
 *
 * Why this exists:
 *   `@monaco-editor/react` constructs each Editor's URI by
 *   `monaco.Uri.parse(path)` where `path` is the `path` prop we pass —
 *   which is the OpenFile.id. So every model whose URI string contains
 *   our fileId is the model for that file. There can be at most one
 *   per group (one editor per group), at most N across N split groups.
 *
 * Why we never use `editor.getActiveModel()` for save-time work:
 *   "Active" is a UI concept tied to focus / last-rendered prop. During
 *   a tab swap or a rapid Cmd+S, the active model can be either the
 *   incoming or outgoing one depending on browser/React timing. By
 *   keying on fileId we get a deterministic answer that survives any
 *   focus race.
 *
 * The helpers are pure (no side effects). The DOM-side resolution
 * (iterating editorRefs) lives in the caller; here we just wrap the
 * URI-matching predicate so it's unit-testable in isolation.
 */

/**
 * Minimal shape of a Monaco code editor that we depend on. Kept narrow
 * so tests can pass plain objects without dragging the full monaco-editor
 * typings into the test runtime.
 */
export interface EditorLike {
  getModel(): { uri: { toString(): string } } | null;
}

/**
 * Returns true when `editor`'s currently-attached model has a URI string
 * containing the given fileId.
 *
 * We use `includes()` not `===` because `monaco.Uri.parse(path)` does its
 * own scheme/authority normalisation — the resulting `uri.toString()` is
 * something like "inmemory://model/<id>" or "file:///<id>", and the
 * fileId we constructed (rootId::path) is preserved as a contiguous
 * substring inside that. Matching on `includes` is robust to whatever
 * URI shape Monaco settles on without forcing us to track its
 * normalisation rules in the application code.
 */
export function editorHoldsFileId(
  editor: EditorLike | null | undefined,
  fileId: string,
): boolean {
  if (!editor) return false;
  const m = editor.getModel();
  if (!m) return false;
  return m.uri.toString().includes(fileId);
}

/**
 * Find the editor (across split groups) whose currently-attached model
 * corresponds to `fileId`. Returns null if no editor holds the file as
 * its current model — possible when the file is open in a tab but the
 * tab isn't the active one in any group (e.g. user has A pinned but
 * is viewing B in group 1, and A isn't open in group 2).
 *
 * Caller uses this for save-time operations that need a real editor
 * instance (e.g. running `editor.action.formatDocument` via the
 * `editor.trigger` API). If null, the operation falls back to writing
 * the file directly from its React-state content — the format step
 * is skipped, but the save still succeeds with the correct content.
 */
export function findEditorForFileId<E extends EditorLike>(
  editors: ReadonlyArray<E | null | undefined>,
  fileId: string,
): E | null {
  for (const ed of editors) {
    if (editorHoldsFileId(ed, fileId)) return ed as E;
  }
  return null;
}
