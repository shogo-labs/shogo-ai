import { AlertTriangle } from "lucide-react-native";
import { EditorTabs } from "./EditorTabs";
import { Breadcrumbs } from "./Breadcrumbs";
import { CodeEditor } from "./CodeEditor";
import type { EditorGroup as GroupState, EditorSettings, OpenFile } from "./types";
import type { editor } from "monaco-editor";

export function EditorGroupView({
  group,
  focused,
  onFocus,
  onSelect,
  onClose,
  onTogglePin,
  onChange,
  onCursor,
  onEditorMount,
  settings,
}: {
  group: GroupState;
  focused: boolean;
  onFocus: () => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onTogglePin: (id: string) => void;
  onChange: (val: string) => void;
  onCursor: (line: number, col: number) => void;
  onEditorMount?: (ed: editor.IStandaloneCodeEditor) => void;
  settings: EditorSettings;
}) {
  const active: OpenFile | null =
    group.files.find((f) => f.id === group.activeId) ?? null;

  return (
    <div
      onMouseDown={onFocus}
      className={`flex h-full flex-col bg-[#1e1e1e] ${
        focused ? "" : "opacity-95"
      }`}
    >
      <EditorTabs
        files={group.files}
        activeId={group.activeId}
        onSelect={onSelect}
        onClose={onClose}
        onTogglePin={onTogglePin}
        onFocus={onFocus}
        groupFocused={focused}
      />
      {active && <Breadcrumbs path={active.path} />}
      <div className="flex-1 min-h-0 relative">
        {active ? (
          active.loading ? (
            <div className="flex h-full items-center justify-center text-[13px] text-[#858585]">
              Loading {active.name}…
            </div>
          ) : active.error ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-[#f48771]">
              <AlertTriangle size={24} />
              <div className="text-[13px]">Could not open {active.name}</div>
              <div className="text-[12px] text-[#858585]">{active.error}</div>
            </div>
          ) : (
            <CodeEditor
              value={active.content}
              language={active.language}
              pathKey={active.id}
              settings={settings}
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
    <div className="flex h-full flex-col items-center justify-center gap-3 text-[#858585]">
      <div className="text-4xl">⚡</div>
      <div className="text-[13px]">No editor</div>
      <div className="flex gap-4 text-[11px]">
        <span>
          <kbd className="rounded bg-[#2a2a2a] px-1.5 py-0.5">⌘P</kbd> Go to file
        </span>
        <span>
          <kbd className="rounded bg-[#2a2a2a] px-1.5 py-0.5">⌘⇧P</kbd> Commands
        </span>
      </div>
    </div>
  );
}
