// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * What may follow a mention label: end of text, whitespace, closing
 * punctuation, or a sentence-ending period. Without a right boundary
 * `@CodeEditor.tsx` would count as present inside `@CodeEditor.tsx:226-295`,
 * so deleting one pill could never prune its reference.
 */
const RIGHT_BOUNDARY = /^(?:$|\s|[,;!?)\]}'"]|\.(?:$|\s))/;

function atBoundary(text: string, index: number, length: number): boolean {
  if (index !== 0 && !/\s/.test(text[index - 1])) return false;
  return RIGHT_BOUNDARY.test(text.slice(index + length, index + length + 2));
}

/**
 * True when `label` (an "@token") occurs in `text` at a mention boundary on
 * both sides. Used to prune references whose inline text the user
 * edited/deleted and to decide what the inline-highlight overlay should pill.
 */
export function labelPresent(text: string, label: string): boolean {
  if (!label) return false;
  for (let idx = text.indexOf(label); idx !== -1; idx = text.indexOf(label, idx + 1)) {
    if (atBoundary(text, idx, label.length)) return true;
  }
  return false;
}

/** A run of composer text: either plain or a tagged "@mention". */
export type MentionSegment = { text: string; mention: boolean };

/**
 * Split `text` into plain / mention runs by matching known reference `labels`
 * at mention boundaries (longest-first so `@foo.tsx:1-9` wins over
 * `@foo.tsx`). Backs the transparent overlay that draws an inline pill behind
 * each "@mention" while the real (crisp) text stays in the TextInput on top.
 */
export function buildMentionSegments(text: string, labels: string[]): MentionSegment[] {
  const unique = Array.from(new Set(labels.filter(Boolean))).sort((a, b) => b.length - a.length);
  if (unique.length === 0) return [{ text, mention: false }];
  const segments: MentionSegment[] = [];
  let i = 0;
  let plainStart = 0;
  while (i < text.length) {
    let matched: string | null = null;
    if (i === 0 || /\s/.test(text[i - 1])) {
      for (const lab of unique) {
        if (text.startsWith(lab, i) && atBoundary(text, i, lab.length)) {
          matched = lab;
          break;
        }
      }
    }
    if (matched) {
      if (plainStart < i) segments.push({ text: text.slice(plainStart, i), mention: false });
      segments.push({ text: matched, mention: true });
      i += matched.length;
      plainStart = i;
    } else {
      i++;
    }
  }
  if (plainStart < text.length) segments.push({ text: text.slice(plainStart), mention: false });
  return segments;
}
