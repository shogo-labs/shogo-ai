import Editor, { type OnMount } from "@monaco-editor/react";
import { useRef } from "react";
import type { editor } from "monaco-editor";
import type { EditorSettings } from "./types";
import { setMonacoRef } from "./monaco/workspaceModels";
import { loadExtraLibs } from "./monaco/extraLibs";

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

  // Suppress "cannot find module" spam for files outside the current model.
  const diagOpts = {
    noSemanticValidation: false,
    noSyntaxValidation: false,
    diagnosticCodesToIgnore: [
      // 2307 (Cannot find module) is now surfaced — extraLibs loads @types/react.
      2339, // Property does not exist (common with dynamic types in user code)
      2691, // An import path cannot end with .tsx
      1375, // 'await' expressions in top-level
    ],
  };
  ts.typescriptDefaults.setDiagnosticsOptions(diagOpts);
  ts.javascriptDefaults.setDiagnosticsOptions(diagOpts);

  ts.typescriptDefaults.setEagerModelSync(true);
}

export function CodeEditor({
  value,
  language,
  pathKey,
  settings,
  onChange,
  onCursor,
  onMount,
}: {
  value: string;
  language: string;
  /** Stable unique path used as the Monaco model URI so IntelliSense scopes per-file. */
  pathKey: string;
  settings: EditorSettings;
  onChange: (v: string) => void;
  onCursor: (line: number, col: number) => void;
  onMount?: (ed: editor.IStandaloneCodeEditor) => void;
}) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  const handleMount: OnMount = (ed, monaco) => {
    editorRef.current = ed;
    configureMonaco(monaco);
    setMonacoRef(monaco);
    loadExtraLibs(monaco);
    monaco.editor.setTheme("shogo-dark");

    ed.onDidChangeCursorPosition((e) => {
      onCursor(e.position.lineNumber, e.position.column);
    });

    onMount?.(ed);
  };

  return (
    <Editor
      height="100%"
      path={pathKey}
      language={language}
      value={value}
      theme="shogo-dark"
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
