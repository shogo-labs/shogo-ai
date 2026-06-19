import * as vscode from 'vscode'
import { ShogoAgentClient } from './agentClient'
import { ShogoChatViewProvider } from './chatViewProvider'
import { registerCommands } from './commands'
import { ShogoContextStore } from './contextStore'

export function activate(context: vscode.ExtensionContext) {
  const services = {
    agentClient: new ShogoAgentClient(),
    contextStore: new ShogoContextStore(),
  }

  const chatViewProvider = new ShogoChatViewProvider(context.extensionUri, services)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('shogo.agentChat', chatViewProvider, { webviewOptions: { retainContextWhenHidden: true } }),
  )
  registerCommands(context, services, chatViewProvider)
}

export function deactivate() {}
