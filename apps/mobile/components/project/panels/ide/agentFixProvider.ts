// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Monaco integration that lets the user send a diagnostic (error / warning /
 * hint) straight into the Shogo chat with one click.
 *
 * Two entry-points are exposed inside the editor:
 *   1. Hover widget — when the user hovers a squiggle, Monaco's built-in
 *      tooltip is appended with a trusted markdown command-link styled as a
 *      small accent button ("✨ Fix with Shogo").
 *   2. Code Action (⌘.) — the same action appears in the lightbulb / Quick
 *      Fix menu for every marker, matching VS Code's native UX.
 *
 * Both entry-points invoke the same registered command, which constructs a
 * `FixInAgentPayload` (file path, line, severity, message, offending source
 * line, language) and dispatches a `shogo:fix-in-agent` CustomEvent on
 * `window`. `ChatPanel` consumes the event and sends the formatted prompt to
 * the agent, while `Workbench` flashes a toast as visual confirmation.
 */

import type { editor, IDisposable, IMarkdownString, languages, Uri } from "monaco-editor";

type MonacoNs = typeof import("monaco-editor");

/** CustomEvent name dispatched when the user clicks "Fix with Shogo". */
export const FIX_IN_AGENT_EVENT = "shogo:fix-in-agent";

export type FixSeverity = "error" | "warning" | "info" | "hint";

export interface FixInAgentPayload {
  /** Workspace-relative path of the file the marker belongs to. */
  path: string;
  /** Optional root id parsed from the model URI (e.g. "agent", "local:foo"). */
  rootId: string | null;
  /** 1-based line number where the marker starts. */
  line: number;
  /** 1-based column where the marker starts. */
  column: number;
  severity: FixSeverity;
  /** Human-readable diagnostic message. */
  message: string;
  /** TypeScript / ESLint error code if present. */
  code?: string;
  /** Source of the diagnostic (e.g. "ts", "eslint"). */
  source?: string;
  /** The full text of the offending line, trimmed. */
  lineText: string;
  /** Monaco language id for correct fenced-code rendering. */
  language: string;
}

/**
 * HMR-safe configuration flag. Module-level `let` state gets reset to its
 * initial value on every dev hot-reload, but Monaco's internal registry
 * keeps previously-registered hover and code-action providers alive — which
 * would stack up duplicate "Fix with Shogo" entries with every save. Pin
 * the flag on `globalThis` so it survives module re-evaluation. We avoid
 * storing it on the Monaco namespace object because some bundlers ship a
 * non-extensible namespace (`Object.preventExtensions`), which throws when
 * assigning ad-hoc properties.
 */
const CONFIGURED_FLAG = "__shogoFixConfigured__";
const disposables: IDisposable[] = [];

function severityLabel(sev: number, monaco: MonacoNs): FixSeverity {
  const s = monaco.MarkerSeverity;
  if (sev === s.Error) return "error";
  if (sev === s.Warning) return "warning";
  if (sev === s.Info) return "info";
  return "hint";
}

/**
 * @monaco-editor/react encodes the `path` prop into the model URI's path.
 * Our workbench uses `pathKey = "<rootId>::<relPath>"`, so strip any leading
 * slash and split on `::` to recover the pieces.
 */
function pathFromUri(uri: Uri): { path: string; rootId: string | null } {
  let raw = uri.path ?? "";
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* leave raw as-is */
  }
  raw = raw.replace(/^\/+/, "");
  const idx = raw.indexOf("::");
  if (idx === -1) return { path: raw, rootId: null };
  return { rootId: raw.slice(0, idx), path: raw.slice(idx + 2) };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + "…";
}

/**
 * Monaco's TS worker frequently reports the same diagnostic twice (once from
 * semantic validation and once from the suggestion pass, especially on
 * `.tsx` files where both the typescript and javascript defaults match).
 * Dedupe by position + message + code so the Quick Fix menu and hover don't
 * show duplicate "Fix with Shogo" entries.
 */
function dedupeMarkers<T extends editor.IMarkerData | editor.IMarker>(markers: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const m of markers) {
    const codeRaw = (m as { code?: string | number | { value: string } }).code;
    const code =
      typeof codeRaw === "object" && codeRaw ? (codeRaw as { value: string }).value : codeRaw ?? "";
    const key = `${m.startLineNumber}:${m.startColumn}-${m.endLineNumber}:${m.endColumn}|${code}|${m.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

function buildPayload(
  monaco: MonacoNs,
  model: editor.ITextModel,
  marker: editor.IMarker | editor.IMarkerData,
): FixInAgentPayload {
  const { path, rootId } = pathFromUri(model.uri);
  const lineText = (model.getLineContent(marker.startLineNumber) ?? "").replace(/\s+$/, "");
  const codeRaw = (marker as { code?: string | number | { value: string } }).code;
  const code =
    typeof codeRaw === "object" && codeRaw
      ? String((codeRaw as { value: string }).value)
      : codeRaw != null
        ? String(codeRaw)
        : undefined;
  return {
    path,
    rootId,
    line: marker.startLineNumber,
    column: marker.startColumn,
    severity: severityLabel(marker.severity, monaco),
    message: marker.message,
    code,
    source: (marker as { source?: string }).source,
    lineText,
    language: model.getLanguageId?.() ?? "plaintext",
  };
}

/**
 * Registers hover + code-action providers and the dispatching command. Safe
 * to call more than once — subsequent calls are no-ops.
 */
export function setupAgentFix(monaco: MonacoNs): void {
  const flagHost = globalThis as unknown as Record<string, unknown>;
  if (flagHost[CONFIGURED_FLAG]) return;
  flagHost[CONFIGURED_FLAG] = true;

  const commandId = "shogo.fixInAgent";

  const cmdDisp = monaco.editor.registerCommand(
    commandId,
    (_accessor: unknown, payload: FixInAgentPayload) => {
      if (typeof window === "undefined" || !payload) return;
      window.dispatchEvent(
        new CustomEvent<FixInAgentPayload>(FIX_IN_AGENT_EVENT, { detail: payload }),
      );
    },
  );
  disposables.push(cmdDisp);

  const hoverProvider: languages.HoverProvider = {
    provideHover: (model, position) => {
      const raw = monaco.editor
        .getModelMarkers({ resource: model.uri })
        .filter((m) => {
          if (position.lineNumber < m.startLineNumber) return false;
          if (position.lineNumber > m.endLineNumber) return false;
          if (position.lineNumber === m.startLineNumber && position.column < m.startColumn) return false;
          if (position.lineNumber === m.endLineNumber && position.column > m.endColumn) return false;
          return true;
        });
      const markers = dedupeMarkers(raw);
      if (markers.length === 0) return null;
      // Prefer the most severe marker at this position.
      markers.sort((a, b) => b.severity - a.severity);
      const top = markers[0];
      const payload = buildPayload(monaco, model, top);
      const args = encodeURIComponent(JSON.stringify([payload]));
      // Trusted markdown lets us embed a `command:` link. Using codicons
      // ($(sparkle)) matches Monaco's native styling and the link renders as
      // a clean accent-colored button inside the hover widget.
      const md: IMarkdownString = {
        value: `[$(sparkle) Fix with Shogo](command:${commandId}?${args} "Send this ${payload.severity} to the Shogo chat — the agent will read the file and fix it")`,
        isTrusted: true,
        supportThemeIcons: true,
      };
      return {
        range: {
          startLineNumber: top.startLineNumber,
          startColumn: top.startColumn,
          endLineNumber: top.endLineNumber,
          endColumn: top.endColumn,
        },
        contents: [md],
      };
    },
  };

  const codeActionProvider: languages.CodeActionProvider = {
    provideCodeActions: (model, _range, context) => {
      const markers = dedupeMarkers(context.markers);
      if (markers.length === 0) return { actions: [], dispose: () => {} };
      const actions: languages.CodeAction[] = markers.map((marker) => {
        const payload = buildPayload(monaco, model, marker);
        return {
          title: `✨ Fix with Shogo: ${truncate(marker.message, 64)}`,
          kind: "quickfix",
          diagnostics: [marker],
          isPreferred: true,
          command: {
            id: commandId,
            title: "Fix with Shogo",
            arguments: [payload],
          },
        };
      });
      return { actions, dispose: () => {} };
    },
  };

  // Monaco wants one registration per language id. Iterate every language the
  // editor knows about plus "plaintext" so the provider is active for files
  // without a dedicated grammar too. Languages are bundled at load-time by
  // the monaco-editor package, so a single pass at first-mount covers all of
  // them.
  const registered = new Set<string>();
  const register = (langId: string) => {
    if (registered.has(langId)) return;
    registered.add(langId);
    disposables.push(monaco.languages.registerHoverProvider(langId, hoverProvider));
    disposables.push(monaco.languages.registerCodeActionProvider(langId, codeActionProvider));
  };
  for (const lang of monaco.languages.getLanguages()) register(lang.id);
  register("plaintext");
}

/**
 * Format a payload as a Markdown prompt suitable for the chat agent.
 *
 * The message deliberately includes:
 *  - The full file path so the agent can call `read_file` without guessing.
 *  - The 1-based line/column so the fix is scoped correctly.
 *  - The raw diagnostic (including code + source) for determinism.
 *  - The offending source line in a fenced block tagged with the model's
 *    language id for syntax-highlighted rendering.
 */
export function buildFixPrompt(p: FixInAgentPayload): string {
  const icon =
    p.severity === "error" ? "❌" : p.severity === "warning" ? "⚠️" : p.severity === "info" ? "ℹ️" : "💡";
  const loc = `\`${p.path}\`:${p.line}${p.column ? `:${p.column}` : ""}`;
  const codeTag =
    p.code || p.source
      ? ` (${[p.source, p.code].filter(Boolean).join(" ")})`
      : "";
  const lines: string[] = [];
  lines.push(`${icon} Fix this ${p.severity} in ${loc}${codeTag}`);
  lines.push("");
  lines.push("**Diagnostic:**");
  lines.push(`> ${p.message.replace(/\n/g, "\n> ")}`);
  if (p.lineText.trim().length > 0) {
    lines.push("");
    lines.push("**Offending line:**");
    lines.push("```" + (p.language || ""));
    lines.push(p.lineText);
    lines.push("```");
  }
  lines.push("");
  lines.push(
    "Please read the file, diagnose the root cause, and apply a minimal fix. " +
      "If other files need updates, include them too.",
  );
  return lines.join("\n");
}
