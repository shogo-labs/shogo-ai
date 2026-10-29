// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { ChatReferenceInput } from "./chat-references";

/** Drag payload for IDE tree items dropped on the chat composer. */
export const CHAT_REFS_MIME = "application/x-shogo-chat-refs";

/** Workbench root id of the project's agent workspace. */
export const AGENT_ROOT_ID = "agent";

export interface ChatDragItem {
  kind: "file" | "folder";
  path: string;
  name: string;
  rootId: string;
  /** The file has unsaved editor changes (the agent reads the saved file). */
  dirty?: boolean;
}

export function encodeChatDragPayload(items: ChatDragItem[]): string {
  return JSON.stringify({ v: 1, items });
}

function isItem(value: unknown): value is ChatDragItem {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    (v.kind === "file" || v.kind === "folder") &&
    typeof v.path === "string" &&
    v.path.length > 0 &&
    typeof v.name === "string" &&
    typeof v.rootId === "string" &&
    (v.dirty === undefined || typeof v.dirty === "boolean")
  );
}

/**
 * Reads the payload back. Tolerant: null for a missing or unparseable
 * payload, malformed entries dropped, duplicates (same root + path) removed.
 */
export function decodeChatDragPayload(dataTransfer: Pick<DataTransfer, "getData"> | null | undefined): ChatDragItem[] | null {
  let raw = "";
  try {
    raw = dataTransfer?.getData(CHAT_REFS_MIME) ?? "";
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { items?: unknown })?.items;
  if (!Array.isArray(list)) return null;
  const seen = new Set<string>();
  const out: ChatDragItem[] = [];
  for (const entry of list) {
    if (!isItem(entry)) continue;
    const key = `${entry.rootId}::${entry.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: entry.kind, path: entry.path, name: entry.name, rootId: entry.rootId, ...(entry.dirty ? { dirty: true } : {}) });
  }
  return out;
}

/**
 * Whole files/folders can only be referenced from the agent workspace (the
 * runtime reads them from disk); anything else is skipped and reported.
 */
export function toAgentReferences(items: ChatDragItem[]): { references: ChatReferenceInput[]; skipped: string[] } {
  const references: ChatReferenceInput[] = [];
  const skipped: string[] = [];
  for (const item of items) {
    if (item.rootId !== AGENT_ROOT_ID) {
      skipped.push(item.name);
      continue;
    }
    references.push({ type: item.kind, path: item.path, name: item.name });
  }
  return { references, skipped };
}

export function skippedReferencesMessage(names: string[]): string {
  return `Only files in the project workspace can be added as references — skipped: ${names.join(", ")}. Select code inside the file to add it as a snippet instead.`;
}

/** True while dragging something carrying a chat reference payload. */
export function hasChatDragPayload(types: readonly string[] | DOMStringList | null | undefined): boolean {
  if (!types) return false;
  return Array.from(types as ArrayLike<string>).includes(CHAT_REFS_MIME);
}
