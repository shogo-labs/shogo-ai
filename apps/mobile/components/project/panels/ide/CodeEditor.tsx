import Editor, { loader, type OnMount } from "@monaco-editor/react";
import { useEffect, useRef } from "react";
import type { editor } from "monaco-editor";
import type { EditorSettings } from "./types";
import { setupAgentFix } from "./agentFixProvider";
import { setMonacoRef } from "./monaco/workspaceModels";
import { setupExtraLibs } from "./monaco/extraLibs";
import { isDesktopRuntime } from "./terminal/pty-factory";
import {
  registerDesktopThemes,
  loadCustomThemes,
  BUILTIN_DESKTOP_THEMES,
} from "./monaco/themes";

// Point `@monaco-editor/loader` at our self-hosted Monaco bundle (mirrored
// from `node_modules/monaco-editor/min/vs` into `public/vs` by
// `scripts/copy-monaco-vs.mjs`) so the AMD loader script is served from
// the same origin as the app shell.
//
// Why we can't use the default CDN (`https://cdn.jsdelivr.net/...`):
//   - Packaged desktop loads the renderer from `shogo://app/` under a tight
//     CSP — `script-src 'self' shogo: blob: 'unsafe-inline' 'unsafe-eval'`
//     (apps/desktop/src/main.ts, `setupSessionHandlers`). That has no
//     `https:`, so the CDN script load is blocked, `@monaco-editor/loader`
//     rejects with a script-load `Event`, and the renderer logs
//     `Monaco initialization: error: Event`. The IDE editor stays blank.
//   - Even when the CDN is reachable, self-hosting is the offline-friendly
//     default and matches what `bundle-monaco-types.mjs` already does for
//     React/CSS-type extraLibs.
//
// `loader.config()` mutates the loader's internal paths object; it must run
// before any `<Editor>` mounts (i.e. before the first `loader.init()`).
// Module-level evaluation runs on first import of this file, which is
// guaranteed to be before React renders the component below.
//
// The `/vs` path resolves the same way in every host:
//   - Expo dev (`expo start --web`) serves `public/` at `/`, so the loader
//     fetches `http://localhost:8081/vs/loader.js`.
//   - Expo `export --platform web` copies `public/` into `dist/`, so the
//     loader fetches `${origin}/vs/loader.js` from whatever host serves it.
//   - Desktop's `shogo://app/` protocol handler resolves URL paths against
//     `resources/web/`, so `/vs/loader.js` lands on `resources/web/vs/loader.js`
//     — matching `'self'` in CSP.
loader.config({ paths: { vs: "/vs" } });

/* -------------------------------------------------------------------------- *
 * One-time Monaco setup: TS/JSX compiler defaults so the TS worker gives us
 * hover tooltips, autocomplete, and JSX highlighting for free. Guarded by a
 * module-level flag so split editors don't reconfigure twice.
 * -------------------------------------------------------------------------- */
let monacoConfigured = false;

type MonacoNs = Parameters<OnMount>[1];

function configureMonaco(monaco: MonacoNs) {
  if (monacoConfigured) return;
  monacoConfigured = true;

  monaco.editor.defineTheme("shogo-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#1e1e1e",
      "editor.lineHighlightBackground": "#2a2a2a",
      "editorGutter.background": "#1e1e1e",
    },
  });

  monaco.editor.defineTheme("shogo-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#ffffff",
      "editor.lineHighlightBackground": "#f3f3f3",
      "editorGutter.background": "#ffffff",
    },
  });

  const ts = monaco.languages.typescript;
  const compilerOptions: Parameters<typeof ts.typescriptDefaults.setCompilerOptions>[0] = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    jsx: ts.JsxEmit.React,
    allowJs: true,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    isolatedModules: true,
    strict: false,
    noEmit: true,
    skipLibCheck: true,
    lib: ["esnext", "dom", "dom.iterable"],
  };
  ts.typescriptDefaults.setCompilerOptions(compilerOptions);
  ts.javascriptDefaults.setCompilerOptions(compilerOptions);

  // Semantic diagnostics are owned by the backend typescript-language-server
  // (surfaced via the Problems panel's `/diagnostics` route and via Monaco
  // markers wired through Workbench). The in-browser TS Web Worker only sees
  // currently-open Monaco models, so its semantic results are always
  // incomplete and frequently contradict the real LSP — keep syntactic
  // checks on (cheap, local) but turn semantic validation off so the two
  // sources of truth don't fight each other in hover popovers and the
  // gutter. `setEagerModelSync` is dropped for the same reason: there's
  // nothing to eagerly sync once the bulk preload is gone.
  const diagOpts = {
    noSemanticValidation: true,
    noSyntaxValidation: false,
    diagnosticCodesToIgnore: [
      2339, // Property does not exist (common with dynamic types)
      2691, // An import path cannot end with .tsx
      1375, // 'await' expressions in top-level
    ],
  };
  ts.typescriptDefaults.setDiagnosticsOptions(diagOpts);
  ts.javascriptDefaults.setDiagnosticsOptions(diagOpts);

  // Register the Monaco instance so the live-edit handlers can upsert
  // single-file models on demand (hot path: SSE `file.changed` from the
  // chat agent → upsert into the open editor's model). Cross-file
  // IntelliSense itself is served by the backend LSP (see lspProviders).
  setMonacoRef(monaco);

  // Load real @types/react, @types/react-dom, csstype, prop-types
  // declaration files as extraLibs so React autocomplete + hover work.
  setupExtraLibs(monaco);

  // Register the "Fix with Shogo" hover button + quick-fix code action for
  // every language Monaco knows about. Idempotent across split editors.
  setupAgentFix(monaco);

  // Desktop-only: register the curated theme catalog and replay any
  // user-imported JSON themes from localStorage. Gated by isDesktopRuntime()
  // so the web/mobile bundle never registers these themes — that surface is
  // intentionally frozen at shogo-dark / shogo-light.
  if (isDesktopRuntime()) {
    registerDesktopThemes(monaco);
    loadCustomThemes(monaco);
  }
}

export function CodeEditor({
  value,
  language,
  pathKey,
  settings,
  themeMode,
  editorTheme,
  onChange,
  onCursor,
  onMount,
}: {
  value: string;
  language: string;
  /** Stable unique path used as the Monaco model URI so IntelliSense scopes per-file. */
  pathKey: string;
  settings: EditorSettings;
  /** Resolved app theme — Monaco flips between shogo-dark / shogo-light. */
  themeMode: "dark" | "light";
  /**
   * Desktop-only override for the Monaco theme id. When set to a registered
   * theme (one of `BUILTIN_DESKTOP_THEMES` or a user-imported custom theme),
   * it takes precedence over the shogo-dark/light auto-pick. Ignored when
   * `isDesktopRuntime()` is false so web users never see the desktop themes.
   */
  editorTheme?: string;
  onChange: (v: string) => void;
  onCursor: (line: number, col: number) => void;
  onMount?: (ed: editor.IStandaloneCodeEditor, monaco: MonacoNs) => void;
}) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<MonacoNs | null>(null);

  // Resolve the effective Monaco theme:
  //   1. Desktop + caller passed a registered custom/builtin theme  → use it.
  //   2. Otherwise fall back to the always-available shogo-dark/light.
  // Falling through (instead of trusting whatever the caller sent) means a
  // stale localStorage value for a theme that no longer exists can never
  // brick the editor with an undefined theme id.
  const fallback = themeMode === "light" ? "shogo-light" : "shogo-dark";
  const desktopRegistered = isDesktopRuntime()
    && !!editorTheme
    && (
      BUILTIN_DESKTOP_THEMES.some(t => t.id === editorTheme)
      || editorTheme.startsWith("shogo-user-")
    );
  const themeName = desktopRegistered ? (editorTheme as string) : fallback;

  // Live-swap Monaco theme when the app theme changes under an already-mounted
  // editor (e.g. user toggles theme while a file is open).
  useEffect(() => {
    monacoRef.current?.editor.setTheme(themeName);
  }, [themeName]);

  const handleMount: OnMount = (ed, monaco) => {
    editorRef.current = ed;
    monacoRef.current = monaco;
    configureMonaco(monaco);
    monaco.editor.setTheme(themeName);

    ed.onDidChangeCursorPosition((e) => {
      onCursor(e.position.lineNumber, e.position.column);
    });

    onMount?.(ed, monaco);
  };

  return (
    <Editor
      height="100%"
      path={pathKey}
      language={language}
      value={value}
      theme={themeName}
      onChange={(v) => onChange(v ?? "")}
      onMount={handleMount}
      options={{
        fontSize: settings.fontSize,
        fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, monospace",
        minimap: { enabled: settings.minimap, scale: 1 },
        wordWrap: settings.wordWrap,
        lineNumbers: settings.lineNumbers,
        renderWhitespace: settings.renderWhitespace,
        bracketPairColorization: { enabled: settings.bracketPairs },
        tabSize: settings.tabSize,
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        cursorBlinking: "smooth",
        renderLineHighlight: "all",
        padding: { top: 8 },
        automaticLayout: true,
        quickSuggestions: { other: true, comments: false, strings: true },
        suggestOnTriggerCharacters: true,
        hover: { enabled: true, delay: 200, sticky: true },
        parameterHints: { enabled: true },
        folding: true,
        find: {
          addExtraSpaceOnTop: false,
          autoFindInSelection: "multiline",
          seedSearchStringFromSelection: "selection",
        },
        // Suppress Monaco's "detected unusual line terminators" modal.
        // Default is `"prompt"`, which pops a confirmation dialog whenever
        // an opened file contains U+2028 / U+2029 — common in agent-written,
        // minified, or copy-pasted content and consistently jarring. `"off"`
        // keeps the bytes intact (no silent buffer mutation, unlike `"auto"`)
        // and just hides the dialog, matching VS Code's
        // `"editor.unusualLineTerminators": "off"` setting.
        unusualLineTerminators: "off",
      }}
    />
  );
}
