import * as vscode from 'vscode'
import type { ShogoChatViewProvider } from './chatViewProvider'
import type { IdeChatReference } from './protocol'
import { selectionReferences, skippedMessage, uriReferences } from './references'
import type { ExtensionServices } from './types'

function requireTrustedWorkspace(action: string): boolean {
  if (vscode.workspace.isTrusted) return true
  void vscode.window.showWarningMessage(`${action} requires workspace trust. Shogo runs read-only in restricted mode.`)
  return false
}

async function openShogoChat(chatViewProvider: ShogoChatViewProvider): Promise<void> {
  await chatViewProvider.focus()
}

export const CHAT_NOT_CONNECTED_MESSAGE = "Shogo chat isn't connected — context will be added when it opens."

/**
 * Queue references for the chat composer, open the chat and send them. They
 * stay queued until the chat acknowledges them (see ShogoContextOutbox).
 */
export async function deliverReferences(
  services: ExtensionServices,
  chatViewProvider: ShogoChatViewProvider,
  references: IdeChatReference[],
  skipped: string[] = [],
): Promise<void> {
  if (references.length === 0) {
    await vscode.window.showInformationMessage(skipped.length > 0 ? skippedMessage(skipped) : 'Nothing to add to Shogo chat.')
    return
  }
  services.contextOutbox.enqueue(references)
  await openShogoChat(chatViewProvider)
  await chatViewProvider.postPendingReferences()
  const added = chatViewProvider.isChatConnected()
    ? `Added ${references.length} item${references.length === 1 ? '' : 's'} to Shogo chat.`
    : CHAT_NOT_CONNECTED_MESSAGE
  await vscode.window.showInformationMessage(skipped.length > 0 ? `${added} ${skippedMessage(skipped)}` : added)
}

function toUri(value: unknown): vscode.Uri | null {
  if (!value) return null
  if (typeof value === 'string') {
    try {
      return vscode.Uri.parse(value)
    } catch {
      return null
    }
  }
  return typeof (value as vscode.Uri).toString === 'function' && typeof (value as vscode.Uri).fsPath === 'string'
    ? (value as vscode.Uri)
    : null
}

export function registerCommands(
  context: vscode.ExtensionContext,
  services: ExtensionServices,
  chatViewProvider: ShogoChatViewProvider,
): void {
  const addActiveFile = async () => {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
      await vscode.window.showInformationMessage('Open a file before adding it to Shogo chat.')
      return
    }
    const { references, skipped } = await uriReferences([editor.document.uri])
    await deliverReferences(services, chatViewProvider, references, skipped)
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('shogo.chat.focus', () => openShogoChat(chatViewProvider)),
    vscode.commands.registerCommand('shogo.health.check', async () => {
      const health = await services.agentClient.getHealth()
      if (health.ok) {
        await vscode.window.showInformationMessage(health.message)
      } else {
        await vscode.window.showWarningMessage(health.message)
      }
      await openShogoChat(chatViewProvider)
    }),
    // ⌘L / Ctrl+L and the editor context menu: the selected ranges, or the
    // active file when nothing is selected.
    vscode.commands.registerCommand('shogo.context.addSelection', async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) {
        await vscode.window.showInformationMessage('Open a file before adding it to Shogo chat.')
        return
      }
      const references = selectionReferences(editor)
      if (references.length === 0) {
        await addActiveFile()
        return
      }
      await deliverReferences(services, chatViewProvider, references)
    }),
    vscode.commands.registerCommand('shogo.context.addActiveFile', addActiveFile),
    // Explorer context menu: VS Code passes the clicked item and the selection.
    vscode.commands.registerCommand('shogo.context.addExplorerItems', async (clicked?: unknown, selected?: unknown) => {
      const list = Array.isArray(selected) && selected.length > 0 ? selected : [clicked]
      const uris = list.map(toUri).filter((u): u is vscode.Uri => u !== null)
      if (uris.length === 0) {
        await vscode.window.showInformationMessage('Select a file or folder in the Explorer first.')
        return
      }
      const { references, skipped } = await uriReferences(uris)
      await deliverReferences(services, chatViewProvider, references, skipped)
    }),
    // Explorer -> Shogo Chat drops (Code-OSS patch shogo-chat-explorer-drop).
    vscode.commands.registerCommand('shogo.context.addUris', async (raw?: unknown) => {
      const uris = (Array.isArray(raw) ? raw : []).map(toUri).filter((u): u is vscode.Uri => u !== null)
      if (uris.length === 0) return
      const { references, skipped } = await uriReferences(uris)
      await deliverReferences(services, chatViewProvider, references, skipped)
    }),
    vscode.commands.registerCommand('shogo.context.clear', async () => {
      services.contextOutbox.clear()
      await vscode.window.showInformationMessage('Cleared context waiting to be added to Shogo chat.')
    }),
    vscode.commands.registerCommand('shogo.patch.preview', async () => {
      if (!requireTrustedWorkspace('Patch preview')) return
      await vscode.window.showInformationMessage('Patch preview will run through the right-side Shogo Chat.')
      await openShogoChat(chatViewProvider)
    }),
    vscode.commands.registerCommand('shogo.checkpoint.create', async () => {
      if (!requireTrustedWorkspace('Checkpoint creation')) return
      await vscode.window.showInformationMessage('Checkpoint creation will run through the right-side Shogo Chat.')
      await openShogoChat(chatViewProvider)
    }),
    vscode.commands.registerCommand('shogo.git.reviewChanges', async () => {
      if (!requireTrustedWorkspace('Source-control review')) return
      await vscode.window.showInformationMessage('Source-control review will run through the right-side Shogo Chat.')
      await openShogoChat(chatViewProvider)
    }),
    vscode.commands.registerCommand('shogo.runtime.openPreview', async () => {
      await vscode.window.showInformationMessage('Runtime preview will run through the right-side Shogo Chat.')
      await openShogoChat(chatViewProvider)
    }),
  )
}
