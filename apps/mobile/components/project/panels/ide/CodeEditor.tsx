import Editor, { type OnMount } from "@monaco-editor/react";
import { useEffect, useRef } from "react";
import type { editor } from "monaco-editor";
import type { EditorSettings } from "./types";
import { setupAgentFix } from "./agentFixProvider";
import { setMonacoRef } from "./monaco/workspaceModels";
import { setupExtraLibs } from "./monaco/extraLibs";

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

  // We register extraLibs (react, react-dom, csstype, prop-types) below,
  // so 2307 "Cannot find module" should fire correctly for genuinely-missing
  // packages. We still ignore noisy codes that apply to ad-hoc workspace files.
  const diagOpts = {
    noSemanticValidation: false,
    noSyntaxValidation: false,
    diagnosticCodesToIgnore: [
      2339, // Property does not exist (common with dynamic types)
      2691, // An import path cannot end with .tsx
      1375, // 'await' expressions in top-level
    ],
  };
  ts.typescriptDefaults.setDiagnosticsOptions(diagOpts);
  ts.javascriptDefaults.setDiagnosticsOptions(diagOpts);

  ts.typescriptDefaults.setEagerModelSync(true);

  // Register the Monaco instance so workspace files can be preloaded as
  // models for cross-file go-to-def, hover, and import resolution.
  setMonacoRef(monaco);

  // Load real @types/react, @types/react-dom, csstype, prop-types
  // declaration files as extraLibs so React autocomplete + hover work.
  setupExtraLibs(monaco);

  // Register the "Fix with Shogo" hover button + quick-fix code action for
  // every language Monaco knows about. Idempotent across split editors.
  setupAgentFix(monaco);
}

export function CodeEditor({
  value,
  language,
  pathKey,
  settings,
  themeMode,
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
  onChange: (v: string) => void;
  onCursor: (line: number, col: number) => void;
  onMount?: (ed: editor.IStandaloneCodeEditor, monaco: MonacoNs) => void;
}) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<MonacoNs | null>(null);

  const themeName = themeMode === "light" ? "shogo-light" : "shogo-dark";

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
      }}
    />
  );
}
