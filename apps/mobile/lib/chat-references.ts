// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { sanitizeChatMentionLabel } from "./chat-mention-text";

/** Same cap as the live IDE selection context the runtime renders. */
export const MAX_SELECTION_CHARS = 24_000;

/**
 * A structured "@" reference attached to a chat message. Files point at a
 * path inside the current project's agent workspace (resolved to real
 * contents by the runtime); projects tag a sibling project by id — the API
 * durably attaches it to this chat's project so the merged-root runtime
 * mounts it and the agent can read its files. A `selection` carries its own
 * text (an editor snapshot, including unsaved edits) so it works for files
 * outside the agent workspace too. The `workspace` variant is retained for
 * back-compat but the menu no longer offers it.
 */
export type ChatReference =
  | { type: "file"; path: string; name: string; label?: string }
  | { type: "folder"; path: string; name: string; label?: string }
  | {
      type: "selection";
      path: string;
      name: string;
      /** 1-based, inclusive. */
      startLine: number;
      /** 1-based, inclusive. */
      endLine: number;
      text: string;
      languageId?: string;
      truncated?: boolean;
      rootId?: string;
      label?: string;
    }
  | { type: "project"; id: string; name: string; label?: string }
  | {
      type: "chat";
      id: string;
      name: string;
      projectId?: string;
      label?: string;
      transcript?: string;
    }
  | {
      type: "plan";
      planId: string;
      filename: string;
      name: string;
      projectId?: string;
      label?: string;
      content?: string;
    }
  | {
      type: "workspace";
      id: string;
      name: string;
      slug: string;
      summary?: string;
      label?: string;
    }
  /** Picked from a host-supplied completion source (e.g. a teammate). */
  | { type: "mention"; id: string; name: string; label?: string };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A reference before the composer has assigned its inline label. */
export type ChatReferenceInput = DistributiveOmit<ChatReference, "label">;

export function referenceKey(ref: ChatReferenceInput): string {
  if (ref.type === "file") return `file:${ref.path}`;
  if (ref.type === "folder") return `folder:${ref.path}`;
  if (ref.type === "selection") return `selection:${ref.rootId ? `${ref.rootId}/` : ""}${ref.path}:${ref.startLine}-${ref.endLine}`;
  if (ref.type === "project") return `project:${ref.id}`;
  if (ref.type === "chat") return `chat:${ref.id}`;
  if (ref.type === "plan") return `plan:${ref.planId}`;
  if (ref.type === "mention") return `mention:${ref.id}`;
  return `workspace:${ref.id}`;
}

/**
 * Whitespace-free "@token" body for a project mention. Projects have no slug
 * and their names can contain spaces, which the inline-token model can't
 * represent, so we slugify the name (the structured reference still carries the
 * real id + name). Collisions are cosmetic — resolution keys off the id.
 */
export function slugifyMention(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

function lineSuffix(ref: { startLine: number; endLine: number }): string {
  return ref.startLine === ref.endLine ? `:${ref.startLine}` : `:${ref.startLine}-${ref.endLine}`;
}

/** The default inline "@token" for a reference, before collision handling. */
export function baseMentionLabel(ref: ChatReferenceInput): string {
  switch (ref.type) {
    case "file":
    case "folder":
      return `@${ref.name || basename(ref.path)}`;
    case "selection":
      return `@${ref.name || basename(ref.path)}${lineSuffix(ref)}`;
    case "project":
      return `@${slugifyMention(ref.name)}`;
    case "chat":
      return `@${sanitizeChatMentionLabel(ref.name)}`;
    case "plan":
      return `@plan:${slugifyMention(ref.name)}`;
    case "workspace":
      return `@${ref.slug || slugifyMention(ref.name)}`;
    case "mention":
      return `@${slugifyMention(ref.name)}`;
  }
}

/** Label using the last `depth` path segments (file/folder/selection only). */
function pathLabel(ref: ChatReferenceInput, depth: number): string | null {
  if (ref.type !== "file" && ref.type !== "folder" && ref.type !== "selection") return null;
  const segments = ref.path.split("/").filter(Boolean);
  if (depth > segments.length) return null;
  const tail = segments.slice(segments.length - depth).join("/");
  return `@${tail}${ref.type === "selection" ? lineSuffix(ref) : ""}`;
}

/**
 * The inline label for `ref` given the references already in the composer.
 * Re-adding the same reference returns its existing label. Otherwise, while
 * the label is taken by a different reference, parent directories are
 * prefixed (`@ide/CodeEditor.tsx:10-20`) until it is unique.
 */
export function uniqueMentionLabel(ref: ChatReferenceInput, existing: ChatReference[]): string {
  const key = referenceKey(ref);
  const same = existing.find((r) => referenceKey(r) === key);
  if (same?.label) return same.label;
  const taken = new Set(existing.filter((r) => referenceKey(r) !== key).map((r) => r.label).filter(Boolean));
  const base = baseMentionLabel(ref);
  if (!taken.has(base)) return base;
  for (let depth = 2; ; depth++) {
    const candidate = pathLabel(ref, depth);
    if (!candidate) break;
    if (!taken.has(candidate)) return candidate;
  }
  for (let n = 2; ; n++) {
    const candidate = `${base}~${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function clampSelectionText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_SELECTION_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_SELECTION_CHARS), truncated: true };
}
