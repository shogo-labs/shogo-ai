// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { clampSelectionText, type ChatReferenceInput } from "../../../../lib/chat-references";
import { AGENT_ROOT_ID } from "../../../../lib/chat-drag";
import { requestChatInsert } from "../../../../lib/chat-insert-bus";

/** Structural slices of Monaco's editor / model / selection types (testable without Monaco). */
export interface SelectionLike {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  isEmpty(): boolean;
}
export interface ModelLike {
  getValueInRange(range: SelectionLike): string;
}
export interface EditorLike {
  getModel(): ModelLike | null;
  getSelections(): SelectionLike[] | null;
}

export interface AddToChatFile {
  path: string;
  name: string;
  rootId: string;
  languageId?: string;
}

export type AddToChatResult =
  | { kind: "selection" | "file"; references: ChatReferenceInput[] }
  | { error: string };

export const NON_AGENT_FILE_ERROR = "Select code to add from files outside the project workspace.";
export const NO_FILE_ERROR = "Open a file to add it to chat.";

/**
 * One `selection` reference per non-empty selection (multi-cursor), sorted by
 * start line, identical ranges collapsed. Lines are 1-based and inclusive; a
 * selection ending at column 1 of a later line doesn't include that line.
 */
export function buildSelectionReferences(
  model: ModelLike,
  selections: readonly SelectionLike[],
  file: AddToChatFile,
): ChatReferenceInput[] {
  const refs: ChatReferenceInput[] = [];
  const seen = new Set<string>();
  const ordered = [...selections].sort((a, b) => a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn);
  for (const sel of ordered) {
    if (sel.isEmpty()) continue;
    const raw = model.getValueInRange(sel);
    if (!raw.trim()) continue;
    const startLine = sel.startLineNumber;
    const endLine = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber;
    const key = `${startLine}-${endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { text, truncated } = clampSelectionText(raw);
    refs.push({
      type: "selection",
      path: file.path,
      name: file.name,
      startLine,
      endLine,
      text,
      ...(file.languageId ? { languageId: file.languageId } : {}),
      ...(truncated ? { truncated } : {}),
      rootId: file.rootId,
    });
  }
  return refs;
}

/** What ⌘L / "Add to Chat" adds for the editor's current state. */
export function resolveAddToChat(editor: EditorLike, file: AddToChatFile | null): AddToChatResult {
  const model = editor.getModel();
  if (!file || !model) return { error: NO_FILE_ERROR };
  const references = buildSelectionReferences(model, editor.getSelections() ?? [], file);
  if (references.length > 0) return { kind: "selection", references };
  if (file.rootId !== AGENT_ROOT_ID) return { error: NON_AGENT_FILE_ERROR };
  return { kind: "file", references: [{ type: "file", path: file.path, name: file.name }] };
}

export function unsavedChangesMessage(names: string[]): string {
  return `${names.join(", ")} ${names.length === 1 ? "has" : "have"} unsaved changes — the agent reads the saved file. Save (⌘S) to include them.`;
}

export function addToChatResultMessage(result: AddToChatResult): string {
  if ("error" in result) return result.error;
  if (result.kind === "file") return `Added ${result.references[0]?.type === "file" ? result.references[0].name : "file"} to chat`;
  const n = result.references.length;
  return `Added ${n} selection${n === 1 ? "" : "s"} to chat`;
}

interface MonacoKeys {
  KeyMod: { CtrlCmd: number };
  KeyCode: { KeyL: number };
}
interface EditorWithActions extends EditorLike {
  addAction(descriptor: {
    id: string;
    label: string;
    contextMenuGroupId?: string;
    contextMenuOrder?: number;
    keybindings?: number[];
    run: (editor: EditorLike) => void;
  }): { dispose(): void };
}

export const ADD_TO_CHAT_ACTION_ID = "shogo.addToChat";

/**
 * Editor "Add to Chat": right-click menu entry and ⌘L / Ctrl+L. Deliberately
 * replaces Monaco's default ⌘L (expand line selection), as Cursor does.
 */
export function registerAddToChatAction(
  editor: EditorWithActions,
  monaco: MonacoKeys,
  { fileOf, onResult }: { fileOf: () => AddToChatFile | null; onResult?: (result: AddToChatResult) => void },
): { dispose(): void } {
  return editor.addAction({
    id: ADD_TO_CHAT_ACTION_ID,
    label: "Add to Chat",
    contextMenuGroupId: "navigation",
    contextMenuOrder: 0,
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL],
    run: (ed) => {
      const result = resolveAddToChat(ed, fileOf());
      if (!("error" in result)) requestChatInsert({ references: result.references, source: "ide-editor" });
      onResult?.(result);
    },
  });
}
