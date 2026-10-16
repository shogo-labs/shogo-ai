// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Markdown <-> Lexical for channel docs. Limited to what round-trips
 * losslessly: headings 1–3, paragraphs, bullet/numbered/check lists, quotes,
 * code blocks, rules, bold/italic/strike/inline code, links, and reference
 * tokens. Anything else (tables, HTML) is kept verbatim in a RawMarkdownNode.
 */
import {
  CHECK_LIST,
  CODE,
  HEADING,
  INLINE_CODE,
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  LINK,
  ORDERED_LIST,
  QUOTE,
  STRIKETHROUGH,
  UNORDERED_LIST,
  type ElementTransformer,
  type MultilineElementTransformer,
  type TextMatchTransformer,
  type Transformer,
} from '@lexical/markdown'
import { $createHorizontalRuleNode, $isHorizontalRuleNode, HorizontalRuleNode } from '@lexical/react/LexicalHorizontalRuleNode'
import { DOC_TOKEN_SOURCE, parseDocToken } from '../doc-tokens'
import { $createDocRefNode, $isDocRefNode, DocRefNode } from './DocRefNode'
import { $createRawMarkdownNode, $isRawMarkdownNode, RawMarkdownNode } from './RawMarkdownNode'

export const DOC_REF: TextMatchTransformer = {
  dependencies: [DocRefNode],
  export: (node) => ($isDocRefNode(node) ? node.getToken() : null),
  importRegExp: new RegExp(`(?:${DOC_TOKEN_SOURCE})`),
  regExp: new RegExp(`(?:${DOC_TOKEN_SOURCE})$`),
  replace: (textNode, match) => {
    const ref = parseDocToken(match[0])
    if (ref) textNode.replace($createDocRefNode(ref))
  },
  trigger: '>',
  type: 'text-match',
}

export const HR: ElementTransformer = {
  dependencies: [HorizontalRuleNode],
  export: (node) => ($isHorizontalRuleNode(node) ? '---' : null),
  regExp: /^(---|\*\*\*|___)\s?$/,
  replace: (parent, _children, _match, isImport) => {
    const rule = $createHorizontalRuleNode()
    if (isImport || parent.getNextSibling() != null) parent.replace(rule)
    else parent.insertBefore(rule)
    rule.selectNext()
  },
  type: 'element',
}

const TABLE_LINE = /^\s*\|.*\|\s*$/
const HTML_START = /^\s*<(?!@|#|!date:)(?:[A-Za-z][\w-]*|!--|\/[A-Za-z])/

/** Tables and HTML blocks run to the next blank line and are kept as written. */
export const RAW_BLOCK: MultilineElementTransformer = {
  dependencies: [RawMarkdownNode],
  export: (node) => ($isRawMarkdownNode(node) ? node.getMarkdown() : null),
  regExpStart: new RegExp(`${TABLE_LINE.source}|${HTML_START.source}`),
  handleImportAfterStartMatch: ({ lines, rootNode, startLineIndex }) => {
    let end = startLineIndex
    while (end + 1 < lines.length && lines[end + 1].trim() !== '') end++
    rootNode.append($createRawMarkdownNode(lines.slice(startLineIndex, end + 1).join('\n')))
    return [true, end]
  },
  replace: () => false,
  type: 'multiline-element',
}

export const DOC_TRANSFORMERS: Transformer[] = [
  RAW_BLOCK,
  CODE,
  HR,
  HEADING,
  QUOTE,
  CHECK_LIST,
  UNORDERED_LIST,
  ORDERED_LIST,
  INLINE_CODE,
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  STRIKETHROUGH,
  LINK,
  DOC_REF,
]
