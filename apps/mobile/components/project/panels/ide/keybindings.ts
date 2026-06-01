/**
 * keybindings.ts — single source of truth for palette shortcuts (BUG-005).
 *
 * Background ("Cmd+P opens both Quick Open and Command Palette"):
 *   The two palette shortcuts (⌘P / ⌘⇧P) were dispatched by two sequential
 *   `matchesShortcut` if-statements in Workbench's window-level keydown
 *   handler. The order was correct (Cmd+Shift+P checked first), and strict
 *   modifier discipline in matchesShortcut prevented the Cmd+P fall-through
 *   from matching Cmd+Shift+P — but two latent hazards remained:
 *
 *     1. No stopPropagation. Any OTHER window-level keydown listener
 *        (FileTree, Terminal, future panels) also receives the event.
 *        Today none of them act on Cmd+P, but a future addition would
 *        silently fire alongside the palette.
 *
 *     2. Monaco standalone's keybinding service runs FIRST when the editor
 *        is focused. The standalone editor doesn't bind Cmd+P by default,
 *        but any future Monaco upgrade, contribution, or @monaco-editor/
 *        react config change that does — including the very common
 *        "workbench.action.quickOpen" binding — would surface Monaco's
 *        own Quick Open simultaneously with ours.
 *
 *     3. The "Shift wins → command palette" rule was implicit in source
 *        ordering. A maintainer reordering the if-statements (e.g.
 *        alphabetising) would silently swap Cmd+P and Cmd+Shift+P
 *        meanings.
 *
 * Fix design: one pure resolver — `resolvePaletteIntent(e)` — that
 * encodes the rule explicitly. The dispatcher in Workbench dispatches
 * through it (preventDefault + stopPropagation), and CodeEditor's mount
 * registers no-op Monaco commands so the editor's keybinding service
 * cannot fire palette shortcuts even if a future binding tries to.
 *
 * The resolver is pure and unit-testable. Modifier discipline (no Alt,
 * no extra meta, exact key) is enforced ONCE here so no future caller
 * can reintroduce the duplicate-dispatch class bug.
 */

export type PaletteIntent = "command" | "file";

/**
 * Returns the palette intent for a keyboard event, or null if it's not a
 * palette shortcut. Rules (matching VS Code):
 *
 *   - Cmd/Ctrl + Shift + P  →  "command"   (Command Palette)
 *   - Cmd/Ctrl +         P  →  "file"      (Quick Open file)
 *   - With ANY extra modifier (Alt) →  null
 *   - With WRONG key →  null
 *   - With no modifier →  null  (plain 'p' is a text input, NOT a shortcut)
 *
 * Cross-platform: Cmd on macOS, Ctrl on Windows/Linux. We treat
 * `metaKey || ctrlKey` as one "platform meta" so the resolver works
 * uniformly. Case-insensitive on the key (Shift+P arrives as 'P' upper-
 * case in most browsers).
 */
export function resolvePaletteIntent(
  e: KeyboardEvent,
): PaletteIntent | null {
  // Exactly ONE of meta/ctrl must be set; both is unusual and we
  // accept either as "platform meta" so the resolver is OS-portable.
  const meta = e.metaKey || e.ctrlKey;
  if (!meta) return null;
  // Alt is never part of a palette shortcut — it's reserved for other
  // bindings (e.g. ⌘⌥P could be a future "preview file" without clashing).
  if (e.altKey) return null;

  // Strict key check, case-insensitive. Some browsers report 'p', some
  // 'P' (when shift is held). Anything else returns null — never let a
  // mistyped key match.
  const key = (e.key ?? "").toLowerCase();
  if (key !== "p") return null;

  // Shift wins → command palette. The "explicit rule, not source order"
  // half of the BUG-005 fix.
  return e.shiftKey ? "command" : "file";
}

/**
 * Convenience predicate used by CodeEditor's Monaco mount to register
 * no-op commands for both palette shortcuts. Mirrors resolvePaletteIntent
 * but cheaper to call from a hot path (boolean only).
 */
export function isPaletteShortcut(e: KeyboardEvent): boolean {
  return resolvePaletteIntent(e) !== null;
}
