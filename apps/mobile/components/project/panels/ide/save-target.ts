/**
 * save-target.ts — fileId-keyed save-target resolution (BUG-003 fix).
 *
 * The bug ("Settings JSON: schema validation runs against wrong file on
 * save", canvas shorthand: "getActiveModel() returns previous tab during
 * transition. Fix: Capture model ref at save invocation."):
 *
 *   The old save path captured the React-rendered `active` OpenFile in a
 *   useCallback closure. On a rapid Cmd+S immediately after a tab swap,
 *   that closure could be one render-tick stale. Worse, any save-time hook
 *   that reached for `editor.getActiveModel()` (e.g. format-on-save running
 *   a Monaco JSON formatter, which carries the document's JSON-schema
 *   validation under the same model URI) ran against whatever Monaco
 *   currently considered "active" — which on a split-pane workbench is
 *   itself ambiguous, and on a transition is racy.
 *
 *   Concretely: settings.json open in group A, user clicks
 *   preferences.json (also JSON, different schema), presses Cmd+S during
 *   the React-commit window. Old code:
 *     - resolved `active` via closure → preferences.json (or settings.json
 *       depending on batching);
 *     - format-on-save would have triggered against `editor.getModel()`,
 *       which Monaco was mid-swap on — returning either model;
 *     - JSON schema diagnostics attach by `fileMatch` to model URI, so
 *       running the formatter against the wrong model causes settings.json
 *       schema to evaluate preferences.json content (or the reverse),
 *       silently surfacing bogus diagnostics or — much worse — silently
 *       writing one file's content over the other's path if any code in
 *       the chain ever inferred the path from the model.
 *
 * Fix: resolve every save-time operation through a STABLE fileId that's
 * captured at save invocation (not at React render). `resolveSaveTarget`
 * is the pure resolver:
 *
 *   - takes a `groupsRef.current` snapshot (the latest state — same as
 *     React would see in the next render);
 *   - returns the OpenFile whose `id` matches, or null if it's gone (e.g.
 *     user closed the tab between the keystroke and the save callback);
 *   - explicitly does NOT consult any "active" pointer — the bug fix is
 *     that activeId is irrelevant to save-target resolution. The fileId
 *     IS the target.
 *
 * Returning `null` on a missing file is the correct semantic for the
 * "closed mid-flight" race — caller drops the save silently (the file
 * the user wanted to save no longer exists in any group; their close-tab
 * gesture wins over their save-keystroke gesture).
 */
import type { EditorGroup, OpenFile } from "./types";

export function resolveSaveTarget(
  groups: ReadonlyArray<EditorGroup>,
  fileId: string,
): OpenFile | null {
  for (const g of groups) {
    for (const f of g.files) {
      if (f.id === fileId) return f;
    }
  }
  return null;
}

/**
 * Enumerate every dirty file across all groups, deduplicated by fileId.
 * Used by Save-All so a file open in two groups (split view, same file)
 * isn't written twice. The first-encountered snapshot wins — both copies
 * share the same `id` and React-state content, so this is well-defined.
 */
export function collectDirtyFiles(
  groups: ReadonlyArray<EditorGroup>,
): OpenFile[] {
  const seen = new Set<string>();
  const out: OpenFile[] = [];
  for (const g of groups) {
    for (const f of g.files) {
      if (!f.dirty) continue;
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      out.push(f);
    }
  }
  return out;
}
