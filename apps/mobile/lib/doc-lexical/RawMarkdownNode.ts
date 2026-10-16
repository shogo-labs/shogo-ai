// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Markdown the editor can't represent (tables, raw HTML), kept byte for byte
 * as a read-only block so editing the rest of the doc never mangles it.
 */
import {
  $applyNodeReplacement,
  DecoratorNode,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical'
import type { ReactNode } from 'react'

export type SerializedRawMarkdownNode = Spread<{ markdown: string }, SerializedLexicalNode>

type Renderer = (markdown: string, nodeKey: NodeKey) => ReactNode
let renderer: Renderer = () => null

export function setRawMarkdownRenderer(fn: Renderer): void {
  renderer = fn
}

export class RawMarkdownNode extends DecoratorNode<ReactNode> {
  __markdown: string

  static getType(): string {
    return 'raw-markdown'
  }

  static clone(node: RawMarkdownNode): RawMarkdownNode {
    return new RawMarkdownNode(node.__markdown, node.__key)
  }

  static importJSON(json: SerializedRawMarkdownNode): RawMarkdownNode {
    return $createRawMarkdownNode(json.markdown)
  }

  constructor(markdown: string, key?: NodeKey) {
    super(key)
    this.__markdown = markdown
  }

  exportJSON(): SerializedRawMarkdownNode {
    return { ...super.exportJSON(), type: 'raw-markdown', version: 1, markdown: this.__markdown }
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const el = document.createElement('div')
    el.className = 'doc-raw-markdown'
    return el
  }

  updateDOM(): false {
    return false
  }

  getMarkdown(): string {
    return this.getLatest().__markdown
  }

  getTextContent(): string {
    return this.getMarkdown()
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): ReactNode {
    return renderer(this.__markdown, this.__key)
  }
}

export function $createRawMarkdownNode(markdown: string): RawMarkdownNode {
  return $applyNodeReplacement(new RawMarkdownNode(markdown))
}

export function $isRawMarkdownNode(node: LexicalNode | null | undefined): node is RawMarkdownNode {
  return node instanceof RawMarkdownNode
}
