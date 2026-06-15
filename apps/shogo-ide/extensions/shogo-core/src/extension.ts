import * as vscode from 'vscode'
import { ShogoAgentClient } from './agentClient'
import { ShogoChatViewProvider } from './chatViewProvider'
import { registerCommands } from './commands'
import { ShogoContextStore } from './contextStore'
import { registerTreeViews } from './treeViews'

export function activate(context: vscode.ExtensionContext) {
  const services = {
    agentClient: new ShogoAgentClient(),
    contextStore: new ShogoContextStore(),
  }

  const chatView = new ShogoChatViewProvider(context.extensionUri, services)

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('shogo.chat', chatView),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void chatView.refresh()
    }),
  )

  registerTreeViews(context)
  registerCommands(context, chatView, services)
}

export function deactivate() {}
