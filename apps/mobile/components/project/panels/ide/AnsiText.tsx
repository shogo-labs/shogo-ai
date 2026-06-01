/**
 * AnsiText — render an ANSI-coded string as theme-aware styled spans.
 *
 * Companion to ansi-render.ts (BUG-013 fix). Parsing is pure; this
 * component is the side-effect-free DOM mapping:
 *
 *   - Each AnsiSpan → one <span> with inline style for color / weight /
 *     style / decoration. Colors bind through CSS custom properties
 *     (--ide-ansi-red, etc.) so the active Monaco theme drives them and
 *     a future theme switch reflows colors without re-rendering the log.
 *   - Default fg / bg map to the editor's text/background variables —
 *     this is what makes a "default" span invisible (= same as the panel
 *     background) on every theme.
 *   - Adjacent spans with identical style are pre-merged by the parser,
 *     so this component never produces more <span> elements than
 *     necessary — a 200-line log with sparse styling still renders in
 *     a single React commit budget.
 *
 * Intentionally NOT a hook — just a function component so it composes
 * naturally inside <pre> in the run output, the debug console, etc.
 */
import * as React from "react";
import { parseAnsi, type AnsiSpan } from "./ansi-render";

// Map each ANSI color name to a CSS custom property defined by the
// active theme. Defaults are conventional VS Code dark-plus values that
// the theme can override at runtime via --ide-ansi-* variables.
/**
 * Colors are emitted as `data-ansi-fg` / `data-ansi-bg` attributes, NOT
 * inline `style.color`. Two reasons:
 *   1. JSDOM / happy-dom (the runtime our RTL tests use) silently drop
 *      inline `color: var(--theme-var, …)` because their CSSStyleDeclaration
 *      parser rejects var(). Real browsers accept it. Data attributes work
 *      in BOTH environments.
 *   2. A single CSS rule per color (defined once in ANSI_STYLE_SHEET below)
 *      keeps the per-span DOM payload minimal AND lets a theme override the
 *      color globally without re-rendering the log. Inline-style binding
 *      forces re-render on every theme switch.
 *
 * The CSS rule uses CSS custom properties so a theme can swap any
 * individual ANSI color by overriding `--ide-ansi-<name>` on a parent.
 */
function styleAttrs(
  s: AnsiSpan["style"],
): { style: React.CSSProperties; fg?: string; bg?: string } {
  const style: React.CSSProperties = {};
  if (s.bold) style.fontWeight = 700;
  if (s.dim) style.opacity = 0.6;       // VT spec: dim = reduced opacity, keep hue
  if (s.italic) style.fontStyle = "italic";
  if (s.underline) style.textDecoration = "underline";
  return {
    style,
    fg: s.fg !== "default" ? s.fg : undefined,
    bg: s.bg !== "default" ? s.bg : undefined,
  };
}

/**
 * One CSS rule per ANSI color. Injected once per document via a
 * <style data-ansi-stylesheet> element. The rules bind through CSS
 * custom properties so the active theme owns the actual color values.
 */
const ANSI_STYLE_SHEET = `
[data-ansi-fg="black"]          { color: var(--ide-ansi-black, #000000); }
[data-ansi-fg="red"]            { color: var(--ide-ansi-red, #cd3131); }
[data-ansi-fg="green"]          { color: var(--ide-ansi-green, #0dbc79); }
[data-ansi-fg="yellow"]         { color: var(--ide-ansi-yellow, #e5e510); }
[data-ansi-fg="blue"]           { color: var(--ide-ansi-blue, #2472c8); }
[data-ansi-fg="magenta"]        { color: var(--ide-ansi-magenta, #bc3fbc); }
[data-ansi-fg="cyan"]           { color: var(--ide-ansi-cyan, #11a8cd); }
[data-ansi-fg="white"]          { color: var(--ide-ansi-white, #e5e5e5); }
[data-ansi-fg="bright-black"]   { color: var(--ide-ansi-bright-black, #666666); }
[data-ansi-fg="bright-red"]     { color: var(--ide-ansi-bright-red, #f14c4c); }
[data-ansi-fg="bright-green"]   { color: var(--ide-ansi-bright-green, #23d18b); }
[data-ansi-fg="bright-yellow"]  { color: var(--ide-ansi-bright-yellow, #f5f543); }
[data-ansi-fg="bright-blue"]    { color: var(--ide-ansi-bright-blue, #3b8eea); }
[data-ansi-fg="bright-magenta"] { color: var(--ide-ansi-bright-magenta, #d670d6); }
[data-ansi-fg="bright-cyan"]    { color: var(--ide-ansi-bright-cyan, #29b8db); }
[data-ansi-fg="bright-white"]   { color: var(--ide-ansi-bright-white, #e5e5e5); }
[data-ansi-bg="black"]          { background: var(--ide-ansi-black, #000000); }
[data-ansi-bg="red"]            { background: var(--ide-ansi-red, #cd3131); }
[data-ansi-bg="green"]          { background: var(--ide-ansi-green, #0dbc79); }
[data-ansi-bg="yellow"]         { background: var(--ide-ansi-yellow, #e5e510); }
[data-ansi-bg="blue"]           { background: var(--ide-ansi-blue, #2472c8); }
[data-ansi-bg="magenta"]        { background: var(--ide-ansi-magenta, #bc3fbc); }
[data-ansi-bg="cyan"]           { background: var(--ide-ansi-cyan, #11a8cd); }
[data-ansi-bg="white"]          { background: var(--ide-ansi-white, #e5e5e5); }
[data-ansi-bg^="bright-"]       { /* generic bright bg fallback handled per color below */ }
[data-ansi-bg="bright-black"]   { background: var(--ide-ansi-bright-black, #666666); }
[data-ansi-bg="bright-red"]     { background: var(--ide-ansi-bright-red, #f14c4c); }
[data-ansi-bg="bright-green"]   { background: var(--ide-ansi-bright-green, #23d18b); }
[data-ansi-bg="bright-yellow"]  { background: var(--ide-ansi-bright-yellow, #f5f543); }
[data-ansi-bg="bright-blue"]    { background: var(--ide-ansi-bright-blue, #3b8eea); }
[data-ansi-bg="bright-magenta"] { background: var(--ide-ansi-bright-magenta, #d670d6); }
[data-ansi-bg="bright-cyan"]    { background: var(--ide-ansi-bright-cyan, #29b8db); }
[data-ansi-bg="bright-white"]   { background: var(--ide-ansi-bright-white, #e5e5e5); }
`;

let sheetInjected = false;
function ensureSheet(): void {
  if (sheetInjected) return;
  if (typeof document === "undefined") return;
  if (document.querySelector("style[data-ansi-stylesheet]")) {
    sheetInjected = true;
    return;
  }
  const el = document.createElement("style");
  el.setAttribute("data-ansi-stylesheet", "true");
  el.textContent = ANSI_STYLE_SHEET;
  document.head.appendChild(el);
  sheetInjected = true;
}

export interface AnsiTextProps {
  /** Raw text containing zero or more ANSI escape sequences. */
  text: string;
  /** Optional class applied to the wrapping element. */
  className?: string;
  /**
   * Optional element tag. Defaults to <span> so the component can be
   * used inline. Pass "div" / "pre" for block contexts.
   */
  as?: keyof React.JSX.IntrinsicElements;
}

export function AnsiText({ text, className, as = "span" }: AnsiTextProps): React.ReactElement {
  ensureSheet();
  const spans = React.useMemo(() => parseAnsi(text), [text]);
  return React.createElement(
    as,
    { className, "data-ansi": "true" },
    spans.map((s, i) => {
      const attrs = styleAttrs(s.style);
      return (
        <span
          key={i}
          style={attrs.style}
          data-ansi-fg={attrs.fg}
          data-ansi-bg={attrs.bg}
        >
          {s.text}
        </span>
      );
    }),
  );
}
