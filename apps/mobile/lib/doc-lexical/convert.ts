// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Converting channel doc markdown into and out of a Lexical editor, and the
 * node set and theme every doc editor shares.
 */
import { CodeHighlightNode, CodeNode } from '@lexical/code'
import { createHeadlessEditor } from '@lexical/headless'
import { AutoLinkNode, LinkNode } from '@lexical/link'
import { ListItemNode, ListNode } from '@lexical/list'
import { $convertFromMarkdownString, $convertToMarkdownString } from '@lexical/markdown'
import { HorizontalRuleNode } from '@lexical/react/LexicalHorizontalRuleNode'
import { HeadingNode, QuoteNode } from '@lexical/rich-text'
import type { Klass, LexicalEditor, LexicalNode } from 'lexical'
import { DocRefNode } from './DocRefNode'
import { RawMarkdownNode } from './RawMarkdownNode'
import { DOC_TRANSFORMERS } from './transformers'

export const DOC_NODES: Array<Klass<LexicalNode>> = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  CodeNode,
  CodeHighlightNode,
  LinkNode,
  AutoLinkNode,
  HorizontalRuleNode,
  DocRefNode,
  RawMarkdownNode,
]

/** Replace the editor's content with `markdown`. Call inside `editor.update`. */
export function $importDocMarkdown(markdown: string): void {
  $convertFromMarkdownString(markdown, DOC_TRANSFORMERS, undefined, false)
}

/** The editor's content as doc markdown. Call inside `editor.read` / `editor.update`. */
export function $exportDocMarkdown(): string {
  return $convertToMarkdownString(DOC_TRANSFORMERS, undefined, false)
}

export function createHeadlessDocEditor(): LexicalEditor {
  return createHeadlessEditor({
    namespace: 'channel-doc',
    nodes: DOC_NODES,
    onError: (err) => {
      throw err
    },
  })
}

let shared: LexicalEditor | null = null

/**
 * Markdown as the editor would write it back out. Comparing normalised text
 * keeps an untouched doc from looking edited just because the editor writes
 * `-` where the doc had `*`, or a single blank line between blocks.
 */
export function normalizeDocMarkdown(markdown: string): string {
  if (!markdown.trim()) return ''
  shared ??= createHeadlessDocEditor()
  let out = ''
  shared.update(() => $importDocMarkdown(markdown), { discrete: true })
  shared.getEditorState().read(() => {
    out = $exportDocMarkdown()
  })
  return out
}
