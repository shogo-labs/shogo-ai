import { AlertTriangle, Code2 } from "lucide-react-native";
import { EditorTabs } from "./EditorTabs";
import { Breadcrumbs } from "./Breadcrumbs";
import { GitDiffView } from "./GitDiffView";
import { CodeEditor } from "./CodeEditor";
import { ImagePreview } from "./ImagePreview";
import { SqlitePreview } from "./SqlitePreview";
import {
  AudioPreview,
  FontPreview,
  PdfPreview,
  VideoPreview,
} from "./MediaPreview";
import { ExtensionDetails } from "./extensions/ExtensionDetails";
import type { ExtensionSearchResult, ExtensionUsableEntryPoint, InstalledExtension } from "./extensions/types";
import type { EditorGroup as GroupState, EditorSettings, OpenFile } from "./types";
import { MarkdownText } from "../../../chat/MarkdownText";
import type { editor } from "monaco-editor";

type MonacoNs = typeof import("monaco-editor");

export function EditorGroupView({
  group,
  focused,
  onFocus,
  onSelect,
  onClose,
  onTogglePin,
  onKeepOpen,
  onReorder,
  onChange,
  onCursor,
  onEditorMount,
  settings,
  themeMode,
  editorTheme,
  installedExtensions = [],
  extensionInstallingId,
  onInstallExtension,
  onEnableExtension,
  onDisableExtension,
  onUninstallExtension,
  onRunExtensionCommand,
  onUseExtensionEntryPoint,
  onSetMdMode,
  onRetryOpen,
  onRevealPath,
  gitRefreshKey,
  onOpenPlainFile,
  recentFiles,
  onCloseMany,
  onCopyText,
  onRevealFile,
  onNewFile,
  hideTabs,
}: {
  group: GroupState;
  focused: boolean;
  onFocus: () => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onTogglePin: (id: string) => void;
  onKeepOpen?: (id: string) => void;
  onReorder?: (orderedIds: string[]) => void;
  onChange: (fileId: string, val: string) => void;
  onCursor: (line: number, col: number) => void;
  onEditorMount?: (ed: editor.IStandaloneCodeEditor, monaco: MonacoNs) => void;
  settings: EditorSettings;
  themeMode: "dark" | "light";
  editorTheme?: string;
  installedExtensions?: InstalledExtension[];
  extensionInstallingId?: string | null;
  onInstallExtension?: (item: InstalledExtension | ExtensionSearchResult) => void;
  onEnableExtension?: (id: string) => void;
  onDisableExtension?: (id: string) => void;
  onUninstallExtension?: (id: string) => void;
  onRunExtensionCommand?: (commandId: string) => void;
  onUseExtensionEntryPoint?: (extension: InstalledExtension, entryPoint: ExtensionUsableEntryPoint) => void;
  onSetMdMode?: (fileId: string, mode: "preview" | "edit") => void;
  onRetryOpen?: (fileId: string) => void;
  /** Breadcrumb click: reveal a workspace-relative path in the Explorer. */
  onRevealPath?: (path: string) => void;
  /** Bumps when git status changes so open diff tabs re-read their sides. */
  gitRefreshKey?: number;
  /** "Open File" from a diff tab. */
  onOpenPlainFile?: (path: string) => void;
  /** Recently opened workspace paths, newest first (empty-state list). */
  recentFiles?: string[];
  onCloseMany?: (ids: string[]) => void;
  onCopyText?: (text: string, what: string) => void;
  onRevealFile?: (fileId: string) => void;
  onNewFile?: () => void;
  /** Zen mode: hide the tab strip. */
  hideTabs?: boolean;
}) {
  const active: OpenFile | null =
    group.files.find((f) => f.id === group.activeId) ?? null;

  return (
    <div
      onMouseDown={onFocus}
      className={`flex h-full flex-col bg-[color:var(--ide-bg)] ${
        focused ? "" : "opacity-95"
      }`}
    >
      {!hideTabs && <EditorTabs
        files={group.files}
        activeId={group.activeId}
        onSelect={onSelect}
        onClose={onClose}
        onTogglePin={onTogglePin}
        onKeepOpen={onKeepOpen}
        onReorder={onReorder}
        onFocus={onFocus}
        groupFocused={focused}
        onCloseMany={onCloseMany}
        onCopyText={onCopyText}
        onRevealFile={onRevealFile}
        onNewFile={onNewFile}
      />}
      {active && active.language !== "extension-detail" && active.language !== "extension-webview" && active.language !== "git-diff" && <Breadcrumbs path={active.path} onReveal={onRevealPath} />}
      <div className="flex-1 min-h-0 relative">
        {active ? (
          active.loading ? (
            <div className="flex h-full items-center justify-center text-[13px] text-[color:var(--ide-muted)]">
              Loading {active.name}…
            </div>
          ) : active.error ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-[color:var(--ide-error)]">
              <AlertTriangle size={24} />
              <div className="text-[13px]">Could not open {active.name}</div>
              <div className="max-w-[420px] text-center text-[12px] text-[color:var(--ide-muted)]">{active.error}</div>
              {onRetryOpen && (
                <button
                  type="button"
                  onClick={() => onRetryOpen(active.id)}
                  className="mt-1 rounded bg-[color:var(--ide-btn-secondary-bg)] px-3 py-1 text-[12px] text-[color:var(--ide-text-strong)] hover:bg-[color:var(--ide-btn-secondary-hover)]"
                >
                  Retry
                </button>
              )}
            </div>
          ) : active.language === "git-diff" && active.gitDiff ? (
            <GitDiffView
              spec={active.gitDiff}
              fileName={active.name}
              settings={settings}
              themeMode={themeMode}
              refreshKey={gitRefreshKey}
              onOpenFile={onOpenPlainFile}
            />
          ) : active.language === "extension-webview" ? (
            <ExtensionWebview html={active.content} title={active.name} />
          ) : active.language === "extension-detail" && active.extensionDetail ? (
            <ExtensionDetails
              item={active.extensionDetail}
              installedItem={installedExtensions.find((extension) => extension.id === active.extensionDetail?.id)}
              installing={extensionInstallingId === active.extensionDetail.id}
              onInstall={!installedExtensions.some((extension) => extension.id === active.extensionDetail?.id) ? () => onInstallExtension?.(active.extensionDetail as InstalledExtension | ExtensionSearchResult) : undefined}
              onEnable={installedExtensions.some((extension) => extension.id === active.extensionDetail?.id) ? () => onEnableExtension?.(active.extensionDetail!.id) : undefined}
              onDisable={installedExtensions.some((extension) => extension.id === active.extensionDetail?.id) ? () => onDisableExtension?.(active.extensionDetail!.id) : undefined}
              onUninstall={installedExtensions.some((extension) => extension.id === active.extensionDetail?.id) ? () => onUninstallExtension?.(active.extensionDetail!.id) : undefined}
              onRunCommand={onRunExtensionCommand}
              onUseEntryPoint={(entryPoint) => {
                const installed = installedExtensions.find((extension) => extension.id === active.extensionDetail?.id);
                if (installed) onUseExtensionEntryPoint?.(installed, entryPoint);
              }}
            />
          ) : active.language === "image" ? (
            <ImagePreview url={active.content} name={active.name} path={active.path} />
          ) : active.language === "sqlite" ? (
            <SqlitePreview url={active.content} name={active.name} path={active.path} />
          ) : active.language === "pdf" ? (
            <PdfPreview url={active.content} name={active.name} path={active.path} />
          ) : active.language === "audio" ? (
            <AudioPreview url={active.content} name={active.name} path={active.path} />
          ) : active.language === "video" ? (
            <VideoPreview url={active.content} name={active.name} path={active.path} />
          ) : active.language === "font" ? (
            <FontPreview url={active.content} name={active.name} path={active.path} />
          ) : active.language === "markdown" ? (
            <MarkdownFileView
              file={active}
              settings={settings}
              themeMode={themeMode}
              editorTheme={editorTheme}
              onChange={onChange}
              onCursor={onCursor}
              onEditorMount={onEditorMount}
              onSetMdMode={onSetMdMode}
            />
          ) : (
            <CodeEditor
              value={active.content}
              language={active.language}
              pathKey={active.id}
              settings={settings}
              themeMode={themeMode}
              editorTheme={editorTheme}
              onChange={onChange}
              onCursor={onCursor}
              onMount={onEditorMount}
            />
          )
        ) : (
          <EmptyGroup recent={recentFiles} onOpen={onOpenPlainFile} />
        )}
      </div>
    </div>
  );
}

function MarkdownFileView({
  file,
  settings,
  themeMode,
  editorTheme,
  onChange,
  onCursor,
  onEditorMount,
  onSetMdMode,
}: {
  file: OpenFile;
  settings: EditorSettings;
  themeMode: "dark" | "light";
  editorTheme?: string;
  onChange: (fileId: string, val: string) => void;
  onCursor: (line: number, col: number) => void;
  onEditorMount?: (ed: editor.IStandaloneCodeEditor, monaco: MonacoNs) => void;
  onSetMdMode?: (fileId: string, mode: "preview" | "edit") => void;
}) {
  const mode = file.mdMode ?? "preview";
  const select = (next: "preview" | "edit") => onSetMdMode?.(file.id, next);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-[color:var(--ide-border)] px-2 py-1">
        <button
          type="button"
          data-testid="ide-md-mode-preview"
          aria-pressed={mode === "preview"}
          onClick={() => select("preview")}
          className={`rounded px-2 py-0.5 text-[12px] ${
            mode === "preview"
              ? "bg-[color:var(--ide-active)] text-[color:var(--ide-text)]"
              : "text-[color:var(--ide-muted)]"
          }`}
        >
          Preview
        </button>
        <button
          type="button"
          data-testid="ide-md-mode-edit"
          aria-pressed={mode === "edit"}
          onClick={() => select("edit")}
          className={`rounded px-2 py-0.5 text-[12px] ${
            mode === "edit"
              ? "bg-[color:var(--ide-active)] text-[color:var(--ide-text)]"
              : "text-[color:var(--ide-muted)]"
          }`}
        >
          Edit
        </button>
      </div>
      {mode === "edit" ? (
        <div className="min-h-0 flex-1">
          <CodeEditor
            value={file.content}
            language={file.language}
            pathKey={file.id}
            settings={settings}
            themeMode={themeMode}
            editorTheme={editorTheme}
            onChange={onChange}
            onCursor={onCursor}
            onMount={onEditorMount}
          />
        </div>
      ) : (
        <div
          data-testid="ide-md-preview"
          className="min-h-0 flex-1 overflow-auto px-4 py-3"
        >
          <MarkdownText>{file.content}</MarkdownText>
        </div>
      )}
    </div>
  );
}

const WATERMARK_SHORTCUTS: Array<[string, string]> = [
  ["⌘P", "Go to file"],
  ["⌘⇧P", "Show all commands"],
  ["⌘⇧F", "Search in files"],
  ["⌘B", "Toggle sidebar"],
  ["⌘J", "Toggle panel"],
  ["⌘\\", "Split editor"],
];

function EmptyGroup({ recent, onOpen }: { recent?: string[]; onOpen?: (path: string) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-[color:var(--ide-muted)]">
      <Code2 size={56} color="var(--ide-border-strong)" />
      <div className="text-[13px]">Open a file from the explorer to start editing</div>
      <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1.5 text-[12px]">
        {WATERMARK_SHORTCUTS.map(([keys, label]) => (
          <div key={keys} className="contents">
            <span className="text-right">{label}</span>
            <span>
              <kbd className="rounded bg-[color:var(--ide-kbd-bg)] px-1.5 py-0.5 text-[color:var(--ide-text)]">{keys}</kbd>
            </span>
          </div>
        ))}
      </div>
      {recent && recent.length > 0 && onOpen && (
        <div className="flex w-[360px] max-w-[90%] flex-col gap-0.5 text-[12px]">
          <div className="mb-1 text-[11px] uppercase tracking-wider">Recent</div>
          {recent.slice(0, 6).map((p) => {
            const i = p.lastIndexOf("/");
            return (
              <button
                key={p}
                type="button"
                onClick={() => onOpen(p)}
                title={p}
                className="flex items-baseline gap-2 truncate rounded px-2 py-1 text-left hover:bg-[color:var(--ide-hover)]"
              >
                <span className="text-[color:var(--ide-text)]">{i === -1 ? p : p.slice(i + 1)}</span>
                <span className="truncate text-[11px]">{i === -1 ? "" : p.slice(0, i)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}


function ExtensionWebview({ html, title }: { html: string; title: string }) {
  return (
    <iframe
      title={title}
      sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
      srcDoc={html || "<html><body style='background:#1e1e1e;color:#cccccc;font-family:sans-serif;padding:16px'>Extension webview is loading…</body></html>"}
      className="h-full w-full border-0 bg-[color:var(--ide-bg)]"
    />
  );
}
