import type { WsNode } from "./workspace/types";

export type ActivityId = "files" | "search" | "git" | "debug" | "extensions" | "checkpoint" | "settings";

/** A tree node annotated with the root it belongs to. */
export interface TreeNode extends WsNode {
  rootId: string;
  isRoot?: boolean;
  children?: TreeNode[];
}

/** Raw service node helper — we decorate this with rootId when ingesting. */
export type RawNode = WsNode;

export interface OpenFile {
  id: string;           // `${rootId}::${path}` — globally unique
  rootId: string;
  name: string;
  path: string;         // relative to root
  language: string;
  content: string;
  savedContent: string;
  dirty: boolean;
  pinned?: boolean;
  loading?: boolean;
  error?: string;
}

export interface EditorGroup {
  id: string;
  files: OpenFile[];
  activeId: string | null;
}

export interface EditorSettings {
  fontSize: number;       // 11..20
  /**
   * Full CSS font-family stack (NOT a single family name). Single source
   * of truth for fonts across the IDE — Monaco editor, xterm.js terminal,
   * and every HTML output panel (Output, Problems, Debug Console, Run &
   * Debug Output, Debug View). See BUG-012 and `useEditorFont.ts`.
   *
   * Pick from `FONT_FAMILY_OPTIONS` in `useEditorFont.ts` (curated list)
   * or supply a custom stack. Always include a generic `monospace`
   * fallback at the end.
   */
  fontFamily: string;
  tabSize: number;        // 2 | 4
  wordWrap: "on" | "off";
  minimap: boolean;
  lineNumbers: "on" | "off" | "relative";
  renderWhitespace: "none" | "boundary" | "all";
  bracketPairs: boolean;
  /** Persist editor buffers to the workspace after a short pause while typing. */
  autoSave: boolean;
  formatOnSave: boolean;
  /**
   * Desktop-only: Monaco theme id (built-in from `BUILTIN_DESKTOP_THEMES`
   * or `shogo-user-<slug>` for an imported custom theme). Ignored by the
   * web/mobile build; CodeEditor falls back to shogo-dark/light when this
   * is unset or unregistered.
   */
  editorTheme?: string;
}

// IMPORTANT: keep `DEFAULT_SETTINGS.fontFamily` byte-identical to
// `DEFAULT_FONT_FAMILY` in `useEditorFont.ts` AND to the CSS variable
// `--ide-mono-font` in `apps/mobile/global.css`. A test pins all three.
// We DON'T import DEFAULT_FONT_FAMILY here to avoid a circular dep:
// useEditorFont.ts → types.ts → useEditorFont.ts would form a cycle.
export const DEFAULT_SETTINGS: EditorSettings = {
  fontSize: 13,
  fontFamily:
    "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Consolas, 'Liberation Mono', monospace",
  tabSize: 2,
  wordWrap: "off",
  minimap: true,
  lineNumbers: "on",
  renderWhitespace: "none",
  bracketPairs: true,
  autoSave: true,
  formatOnSave: false,
};

export interface Root {
  id: string;                             // "agent" | `local:${uuid}`
  label: string;
  kind: "agent" | "local";
  tree: TreeNode[];
  loading: boolean;
  error: string | null;
}
