// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * An inline chip for a person, agent, channel, project or date. Stored in
 * markdown as its token (see `doc-tokens.ts`); shown by whatever renderer
 * the editor registers, so the node itself has no UI dependencies and works
 * in headless editors too.
 */
import {
  $applyNodeReplacement,
  DecoratorNode,
  type DOMConversionMap,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical'
import type { ReactNode } from 'react'
import { docTokenFor, parseDocToken, type DocRef } from '../doc-tokens'

export type SerializedDocRefNode = Spread<{ ref: DocRef }, SerializedLexicalNode>

type Renderer = (ref: DocRef, nodeKey: NodeKey) => ReactNode
let renderer: Renderer = () => null

/** The editor registers how chips look; headless editors never render. */
export function setDocRefRenderer(fn: Renderer): void {
  renderer = fn
}

export class DocRefNode extends DecoratorNode<ReactNode> {
  __ref: DocRef

  static getType(): string {
    return 'doc-ref'
  }

  static clone(node: DocRefNode): DocRefNode {
    return new DocRefNode(node.__ref, node.__key)
  }

  static importJSON(json: SerializedDocRefNode): DocRefNode {
    return $createDocRefNode(json.ref)
  }

  static importDOM(): DOMConversionMap | null {
    return {
      span: (el: HTMLElement) => {
        const token = el.getAttribute('data-doc-token')
        if (!token) return null
        return {
          conversion: () => {
            const ref = parseDocToken(token)
            return { node: ref ? $createDocRefNode(ref) : null }
          },
          priority: 2,
        }
      },
    }
  }

  constructor(ref: DocRef, key?: NodeKey) {
    super(key)
    this.__ref = ref
  }

  exportJSON(): SerializedDocRefNode {
    return { ...super.exportJSON(), type: 'doc-ref', version: 1, ref: this.__ref }
  }

  exportDOM(): DOMExportOutput {
    const el = document.createElement('span')
    el.setAttribute('data-doc-token', docTokenFor(this.__ref))
    el.textContent = docTokenFor(this.__ref)
    return { element: el }
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const el = document.createElement('span')
    el.className = `doc-ref doc-ref-${this.__ref.kind}`
    el.setAttribute('data-doc-token', docTokenFor(this.__ref))
    return el
  }

  updateDOM(): false {
    return false
  }

  getRef(): DocRef {
    return this.getLatest().__ref
  }

  setRef(ref: DocRef): this {
    const writable = this.getWritable()
    writable.__ref = ref
    return writable
  }

  getToken(): string {
    return docTokenFor(this.getRef())
  }

  getTextContent(): string {
    return this.getToken()
  }

  isInline(): true {
    return true
  }

  isKeyboardSelectable(): boolean {
    return true
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): ReactNode {
    return renderer(this.__ref, this.__key)
  }
}

export function $createDocRefNode(ref: DocRef): DocRefNode {
  return $applyNodeReplacement(new DocRefNode(ref))
}

export function $isDocRefNode(node: LexicalNode | null | undefined): node is DocRefNode {
  return node instanceof DocRefNode
}
