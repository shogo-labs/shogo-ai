import * as vscode from 'vscode'
import { ShogoAgentClient } from './agentClient'
import { registerCommands } from './commands'
import { ShogoContextStore } from './contextStore'

export function activate(context: vscode.ExtensionContext) {
  const services = {
    agentClient: new ShogoAgentClient(),
    contextStore: new ShogoContextStore(),
  }

  registerCommands(context, services)
}

export function deactivate() {}
