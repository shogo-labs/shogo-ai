import * as vscode from 'vscode'
import type { ExtensionServices } from './types'
import type { ShogoChatViewProvider } from './chatViewProvider'

function requireTrustedWorkspace(action: string): boolean {
  if (vscode.workspace.isTrusted) return true
  void vscode.window.showWarningMessage(`${action} requires workspace trust. Shogo runs read-only in restricted mode.`)
  return false
}

export function registerCommands(
  context: vscode.ExtensionContext,
  chatView: ShogoChatViewProvider,
  services: ExtensionServices,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('shogo.chat.focus', async () => {
      await chatView.focus()
    }),
    vscode.commands.registerCommand('shogo.health.check', async () => {
      const health = await services.agentClient.getHealth()
      if (health.ok) {
        await vscode.window.showInformationMessage(health.message)
      } else {
        await vscode.window.showWarningMessage(health.message)
      }
      await chatView.refresh()
    }),
    vscode.commands.registerCommand('shogo.context.addSelection', async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor || editor.selection.isEmpty) {
        await vscode.window.showInformationMessage('Select code before adding it to Shogo context.')
        return
      }
      const item = services.contextStore.addSelection(editor)
      await vscode.window.showInformationMessage(item ? `Added to Shogo context: ${item.label}` : 'No selectable text was added to Shogo context.')
      await chatView.focus()
    }),
    vscode.commands.registerCommand('shogo.context.addActiveFile', async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) {
        await vscode.window.showInformationMessage('Open a file before adding it to Shogo context.')
        return
      }
      const item = services.contextStore.addActiveFile(editor)
      await vscode.window.showInformationMessage(item ? `Added active file to Shogo context: ${item.label}` : 'Active file was empty.')
      await chatView.focus()
    }),
    vscode.commands.registerCommand('shogo.context.clear', async () => {
      services.contextStore.clear()
      await vscode.window.showInformationMessage('Shogo context cleared.')
      await chatView.refresh()
    }),
    vscode.commands.registerCommand('shogo.patch.preview', async () => {
      if (!requireTrustedWorkspace('Patch preview')) return
      chatView.appendAssistant('Patch preview command reached Phase 3. Phase 4 will connect this to the local patch engine and native VS Code diff editors.')
      await chatView.focus()
    }),
    vscode.commands.registerCommand('shogo.checkpoint.create', async () => {
      if (!requireTrustedWorkspace('Checkpoint creation')) return
      chatView.appendAssistant('Checkpoint command reached Phase 3. Phase 4 will create real git/file snapshots before edits.')
      await chatView.focus()
    }),
    vscode.commands.registerCommand('shogo.git.reviewChanges', async () => {
      if (!requireTrustedWorkspace('Source-control review')) return
      chatView.appendAssistant('Source-control review command reached Phase 3. The final implementation will layer on top of VS Code Git instead of replacing it.')
      await chatView.focus()
    }),
    vscode.commands.registerCommand('shogo.runtime.openPreview', async () => {
      chatView.appendAssistant('Runtime preview command reached Phase 3. Phase 4 will connect this to Shogo runtime status, logs, and route verification.')
      await chatView.focus()
    }),
  )
}
