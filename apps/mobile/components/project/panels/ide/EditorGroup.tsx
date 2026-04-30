import { AlertTriangle } from "lucide-react-native";
import { EditorTabs } from "./EditorTabs";
import { Breadcrumbs } from "./Breadcrumbs";
import { CodeEditor } from "./CodeEditor";
import { ImagePreview } from "./ImagePreview";
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
}: {
  group: GroupState;
  focused: boolean;
  onFocus: () => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onTogglePin: (id: string) => void;
  onReorder?: (orderedIds: string[]) => void;
  onChange: (val: string) => void;
  onCursor: (line: number, col: number) => void;
  onEditorMount?: (ed: editor.IStandaloneCodeEditor, monaco: MonacoNs) => void;
  settings: EditorSettings;
  themeMode: "dark" | "light";
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
      {active && <Breadcrumbs path={active.path} />}
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
          ) : active.language === "image" ? (
            <ImagePreview url={active.content} name={active.name} path={active.path} />
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
