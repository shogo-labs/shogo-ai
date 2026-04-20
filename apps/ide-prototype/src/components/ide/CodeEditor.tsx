import Editor, { type OnMount } from "@monaco-editor/react";
import { useRef } from "react";

export function CodeEditor({
  value,
  language,
  onChange,
  onCursor,
}: {
  value: string;
  language: string;
  onChange: (v: string) => void;
  onCursor: (line: number, col: number) => void;
}) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
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
    monaco.editor.setTheme("shogo-dark");

    editor.onDidChangeCursorPosition((e) => {
      onCursor(e.position.lineNumber, e.position.column);
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      // save handled at Workbench level via keydown listener
    });
  };

  return (
    <Editor
      height="100%"
      language={language}
      value={value}
      theme="shogo-dark"
      onChange={(v) => onChange(v ?? "")}
      onMount={handleMount}
      options={{
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, monospace",
        minimap: { enabled: true, scale: 1 },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        cursorBlinking: "smooth",
        renderLineHighlight: "all",
        padding: { top: 8 },
        tabSize: 2,
        automaticLayout: true,
      }}
    />
  );
}
