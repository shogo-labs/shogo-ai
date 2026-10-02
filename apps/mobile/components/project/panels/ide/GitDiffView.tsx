import { useCallback, useEffect, useMemo, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { Columns2, Rows2, FileText, RefreshCw } from "lucide-react-native";
import { configureMonaco } from "./CodeEditor";
import { getDesktopGitBridge } from "./git/bridge";
import {
  DIFF_VIEW_MODE_STORAGE_KEY,
  diffViewModeLabel,
  diffViewModeToMonacoOptions,
  parseStoredDiffViewMode,
  serializeDiffViewMode,
  toggleDiffViewMode,
  type DiffViewMode,
} from "./diff-view-mode";
import type { EditorSettings, GitDiffSpec } from "./types";

/** What each SCM group compares: [original ref, modified ref]. */
export function diffRefsFor(group: GitDiffSpec["group"]): { original: string; modified: string; label: string } {
  // `:` = the index, `WORKING` = the file on disk (see gitFileContent).
  if (group === "staged") return { original: "HEAD", modified: ":", label: "Index ↔ HEAD" };
  return { original: ":", modified: "WORKING", label: "Working Tree ↔ Index" };
}

/**
 * Read-only side-by-side / inline diff for a Source Control entry, backed by
 * the desktop git bridge (`fileContent` for HEAD / index / working tree).
 */
export function GitDiffView({
  spec,
  fileName,
  settings,
  themeMode,
  refreshKey,
  onOpenFile,
}: {
  spec: GitDiffSpec;
  fileName: string;
  settings: EditorSettings;
  themeMode: "dark" | "light";
  /** Bump to re-read both sides (e.g. after a git status refresh). */
  refreshKey?: number;
  onOpenFile?: (path: string) => void;
}) {
  const refs = diffRefsFor(spec.group);
  const [original, setOriginal] = useState<string | null>(null);
  const [modified, setModified] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<DiffViewMode>(() => {
    try {
      return parseStoredDiffViewMode(localStorage.getItem(DIFF_VIEW_MODE_STORAGE_KEY));
    } catch {
      return parseStoredDiffViewMode(null);
    }
  });

  const load = useCallback(async () => {
    const git = getDesktopGitBridge();
    if (!git) {
      setError("Diffs need the Shogo desktop app.");
      return;
    }
    setError(null);
    const [o, m] = await Promise.all([
      git.fileContent(spec.workspaceRoot, spec.path, refs.original),
      git.fileContent(spec.workspaceRoot, spec.path, refs.modified),
    ]);
    if (!o.ok) return setError(o.error ?? o.reason ?? "Could not read the original version");
    if (!m.ok) return setError(m.error ?? m.reason ?? "Could not read the modified version");
    setOriginal(o.content ?? "");
    setModified(m.content ?? "");
  }, [spec.workspaceRoot, spec.path, refs.original, refs.modified]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const options = useMemo(
    () => ({
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      fontSize: settings.fontSize,
      fontFamily: settings.fontFamily,
      minimap: { enabled: false },
      renderOverviewRuler: true,
      scrollBeyondLastLine: false,
      ...diffViewModeToMonacoOptions(mode),
    }),
    [settings.fontSize, settings.fontFamily, mode],
  );

  const toggleMode = () => {
    const next = toggleDiffViewMode(mode);
    setMode(next);
    try { localStorage.setItem(DIFF_VIEW_MODE_STORAGE_KEY, serializeDiffViewMode(next)); } catch { /* ignore */ }
  };

  const language = guessLanguage(spec.path);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-[color:var(--ide-border)] px-3 py-1 text-[12px] text-[color:var(--ide-muted)]">
        <span className="truncate text-[color:var(--ide-text)]">{spec.path}</span>
        <span className="shrink-0">· {refs.label}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => void load()}
            title="Refresh diff"
            className="rounded p-1 hover:bg-[color:var(--ide-hover)] hover:text-[color:var(--ide-text-strong)]"
          >
            <RefreshCw size={13} />
          </button>
          <button
            type="button"
            onClick={toggleMode}
            title={diffViewModeLabel(mode)}
            aria-label={diffViewModeLabel(mode)}
            className="rounded p-1 hover:bg-[color:var(--ide-hover)] hover:text-[color:var(--ide-text-strong)]"
          >
            {mode === "sideBySide" ? <Columns2 size={13} /> : <Rows2 size={13} />}
          </button>
          {onOpenFile && (
            <button
              type="button"
              onClick={() => onOpenFile(spec.path)}
              title={`Open ${fileName}`}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[color:var(--ide-hover)] hover:text-[color:var(--ide-text-strong)]"
            >
              <FileText size={13} /> Open File
            </button>
          )}
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {error ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-[color:var(--ide-error)]">
            {error}
          </div>
        ) : original === null || modified === null ? (
          <div className="flex h-full items-center justify-center text-[13px] text-[color:var(--ide-muted)]">
            Loading diff…
          </div>
        ) : (
          <DiffEditor
            original={original}
            modified={modified}
            language={language}
            theme={themeMode === "light" ? "shogo-light" : "shogo-dark"}
            options={options}
            beforeMount={(monaco) => configureMonaco(monaco as Parameters<typeof configureMonaco>[0])}
            keepCurrentOriginalModel={false}
            keepCurrentModifiedModel={false}
          />
        )}
      </div>
    </div>
  );
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", md: "markdown", css: "css", scss: "scss", html: "html", py: "python", rs: "rust", go: "go",
  java: "java", rb: "ruby", sh: "shell", yml: "yaml", yaml: "yaml", toml: "ini", sql: "sql", xml: "xml",
  c: "c", h: "c", cpp: "cpp", cs: "csharp", php: "php", swift: "swift", kt: "kotlin", prisma: "plaintext",
};

function guessLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANG[ext] ?? "plaintext";
}
