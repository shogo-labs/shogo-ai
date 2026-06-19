import { AlertTriangle } from "lucide-react-native";
import { EditorTabs } from "./EditorTabs";
import { Breadcrumbs } from "./Breadcrumbs";
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
import type { editor } from "monaco-editor";

type MonacoNs = typeof import("monaco-editor");

export function EditorGroupView({
  group,
  focused,
  onFocus,
  onSelect,
  onClose,
  onTogglePin,
  onReorder,
  onChange,
  onCursor,
  onEditorMount,
  settings,
  themeMode,
  installedExtensions = [],
  extensionInstallingId,
  onInstallExtension,
  onEnableExtension,
  onDisableExtension,
  onUninstallExtension,
  onRunExtensionCommand,
  onUseExtensionEntryPoint,
}: {
  group: GroupState;
  focused: boolean;
  onFocus: () => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onTogglePin: (id: string) => void;
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
      <EditorTabs
        files={group.files}
        activeId={group.activeId}
        onSelect={onSelect}
        onClose={onClose}
        onTogglePin={onTogglePin}
        onReorder={onReorder}
        onFocus={onFocus}
        groupFocused={focused}
      />
      {active && active.language !== "extension-detail" && active.language !== "extension-webview" && <Breadcrumbs path={active.path} />}
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
              <div className="text-[12px] text-[color:var(--ide-muted)]">{active.error}</div>
            </div>
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
          ) : (
            <CodeEditor
              value={active.content}
              language={active.language}
              pathKey={active.id}
              settings={settings}
              themeMode={themeMode}
              onChange={onChange}
              onCursor={onCursor}
              onMount={onEditorMount}
            />
          )
        ) : (
          <EmptyGroup />
        )}
      </div>
    </div>
  );
}

function EmptyGroup() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-[color:var(--ide-muted)]">
      <div className="text-4xl">⚡</div>
      <div className="text-[13px]">No editor</div>
      <div className="flex gap-4 text-[11px]">
        <span>
          <kbd className="rounded bg-[color:var(--ide-kbd-bg)] px-1.5 py-0.5">⌘P</kbd> Go to file
        </span>
        <span>
          <kbd className="rounded bg-[color:var(--ide-kbd-bg)] px-1.5 py-0.5">⌘⇧P</kbd> Commands
        </span>
      </div>
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
