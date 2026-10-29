import * as vscode from 'vscode'
import { truncateText } from './contextOutbox'
import type { IdeChatReference } from './protocol'

const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path

/**
 * Workspace-relative path with forward slashes — the same form the chat's
 * IDE-mode "@" results use, so the runtime resolves them alike. Outside any
 * workspace folder the absolute path is kept.
 */
export function referencePath(uri: vscode.Uri): string {
  const inWorkspace = vscode.workspace.getWorkspaceFolder(uri) !== undefined
  const path = inWorkspace ? vscode.workspace.asRelativePath(uri, false) : uri.fsPath
  return String(path).replace(/\\/g, '/')
}

/**
 * One reference per non-empty selection (multi-cursor), sorted, identical
 * ranges collapsed. A selection ending at the very start of a later line
 * doesn't include that line. Selections work for any file — they carry their
 * own text.
 */
export function selectionReferences(editor: vscode.TextEditor): IdeChatReference[] {
  const selections = editor.selections?.length ? editor.selections : [editor.selection]
  const path = referencePath(editor.document.uri)
  const name = basename(path)
  const seen = new Set<string>()
  const refs: IdeChatReference[] = []
  const ordered = [...selections].sort(
    (a, b) => a.start.line - b.start.line || a.start.character - b.start.character,
  )
  for (const sel of ordered) {
    if (!sel || sel.isEmpty) continue
    const raw = editor.document.getText(sel)
    if (!raw.trim()) continue
    const startLine = sel.start.line + 1
    const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1
    const key = `${startLine}-${endLine}`
    if (seen.has(key)) continue
    seen.add(key)
    const { text, truncated } = truncateText(raw)
    refs.push({
      type: 'selection',
      path,
      name,
      startLine,
      endLine,
      text,
      languageId: editor.document.languageId,
      ...(truncated ? { truncated } : {}),
    })
  }
  return refs
}

/**
 * File / folder references for Explorer items. Only items inside an open
 * workspace folder can be referenced (the agent reads them from disk); the
 * rest are returned in `skipped`.
 */
export async function uriReferences(
  uris: readonly vscode.Uri[],
): Promise<{ references: IdeChatReference[]; skipped: string[] }> {
  const references: IdeChatReference[] = []
  const skipped: string[] = []
  const seen = new Set<string>()
  for (const uri of uris) {
    if (!uri) continue
    const key = uri.toString()
    if (seen.has(key)) continue
    seen.add(key)
    if (!vscode.workspace.getWorkspaceFolder(uri)) {
      skipped.push(basename(uri.fsPath.replace(/\\/g, '/')))
      continue
    }
    const path = referencePath(uri)
    let isDir = false
    try {
      isDir = (await vscode.workspace.fs.stat(uri)).type === vscode.FileType.Directory
    } catch {
      skipped.push(basename(path))
      continue
    }
    references.push({ type: isDir ? 'folder' : 'file', path, name: basename(path) })
  }
  return { references, skipped }
}

export function skippedMessage(skipped: string[]): string {
  return `Only files in an open workspace folder can be added as references — skipped: ${skipped.join(', ')}. Select code inside the file to add it as a snippet instead.`
}
