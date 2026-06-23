import * as vscode from 'vscode'
import type { ShogoContextItem } from './types'

const MAX_CONTEXT_TEXT_LENGTH = 24_000

function now() {
  return new Date().toISOString()
}

function truncateText(text: string): string {
  if (text.length <= MAX_CONTEXT_TEXT_LENGTH) return text
  return `${text.slice(0, MAX_CONTEXT_TEXT_LENGTH)}\n\n[Truncated by Shogo context guard]`
}

function createRange(selection: vscode.Selection) {
  return {
    startLine: selection.start.line,
    startCharacter: selection.start.character,
    endLine: selection.end.line,
    endCharacter: selection.end.character,
  }
}

export class ShogoContextStore {
  private readonly items: ShogoContextItem[] = []

  list(): ShogoContextItem[] {
    return [...this.items]
  }

  clear(): void {
    this.items.splice(0, this.items.length)
  }

  addSelection(editor: vscode.TextEditor): ShogoContextItem | null {
    if (editor.selection.isEmpty) return null

    const text = editor.document.getText(editor.selection)
    if (!text.trim()) return null

    const item: ShogoContextItem = {
      id: `selection:${editor.document.uri.toString()}:${Date.now()}`,
      kind: 'selection',
      label: `${editor.document.fileName}:${editor.selection.start.line + 1}`,
      uri: editor.document.uri.toString(),
      languageId: editor.document.languageId,
      text: truncateText(text),
      range: createRange(editor.selection),
      createdAt: now(),
    }

    this.items.unshift(item)
    return item
  }

  addActiveFile(editor: vscode.TextEditor): ShogoContextItem | null {
    const text = editor.document.getText()
    if (!text.trim()) return null

    const item: ShogoContextItem = {
      id: `active-file:${editor.document.uri.toString()}:${Date.now()}`,
      kind: 'active-file',
      label: editor.document.fileName,
      uri: editor.document.uri.toString(),
      languageId: editor.document.languageId,
      text: truncateText(text),
      createdAt: now(),
    }

    this.items.unshift(item)
    return item
  }
}
