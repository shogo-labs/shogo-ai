import * as vscode from 'vscode'
import type { ShogoChatViewProvider } from './chatViewProvider'
import type { ExtensionServices } from './types'

function requireTrustedWorkspace(action: string): boolean {
  if (vscode.workspace.isTrusted) return true
  void vscode.window.showWarningMessage(`${action} requires workspace trust. Shogo runs read-only in restricted mode.`)
  return false
}

async function openShogoChat(chatViewProvider: ShogoChatViewProvider): Promise<void> {
  await chatViewProvider.focus()
}

export function registerCommands(
  context: vscode.ExtensionContext,
  services: ExtensionServices,
  chatViewProvider: ShogoChatViewProvider,
): void {
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
    vscode.commands.registerCommand('shogo.context.addSelection', async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor || editor.selection.isEmpty) {
        await vscode.window.showInformationMessage('Select code before adding it to Shogo context.')
        return
      }
      const item = services.contextStore.addSelection(editor)
      await vscode.window.showInformationMessage(item ? `Added to Shogo context: ${item.label}` : 'No selectable text was added to Shogo context.')
      await openShogoChat(chatViewProvider)
      chatViewProvider.syncContext()
    }),
    vscode.commands.registerCommand('shogo.context.addActiveFile', async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) {
        await vscode.window.showInformationMessage('Open a file before adding it to Shogo context.')
        return
      }
      const item = services.contextStore.addActiveFile(editor)
      await vscode.window.showInformationMessage(item ? `Added active file to Shogo context: ${item.label}` : 'Active file was empty.')
      await openShogoChat(chatViewProvider)
      chatViewProvider.syncContext()
    }),
    vscode.commands.registerCommand('shogo.context.clear', async () => {
      services.contextStore.clear()
      await vscode.window.showInformationMessage('Shogo context cleared.')
      await openShogoChat(chatViewProvider)
      chatViewProvider.syncContext()
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
