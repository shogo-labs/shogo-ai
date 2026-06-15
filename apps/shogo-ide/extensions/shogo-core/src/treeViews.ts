import * as vscode from 'vscode'

interface ShogoTreeItemSpec {
  label: string
  description: string
  icon: string
  command?: string
}

class ShogoTreeItem extends vscode.TreeItem {
  constructor(spec: ShogoTreeItemSpec) {
    super(spec.label, vscode.TreeItemCollapsibleState.None)
    this.description = spec.description
    this.tooltip = `${spec.label} — ${spec.description}`
    this.iconPath = new vscode.ThemeIcon(spec.icon)
    if (spec.command) {
      this.command = {
        command: spec.command,
        title: spec.label,
      }
    }
  }
}

class StaticShogoTreeProvider implements vscode.TreeDataProvider<ShogoTreeItem> {
  private readonly changed = new vscode.EventEmitter<ShogoTreeItem | undefined | null | void>()
  readonly onDidChangeTreeData = this.changed.event

  constructor(private readonly items: ShogoTreeItemSpec[]) {}

  getTreeItem(element: ShogoTreeItem): vscode.TreeItem {
    return element
  }

  getChildren(): ShogoTreeItem[] {
    return this.items.map((item) => new ShogoTreeItem(item))
  }

  refresh(): void {
    this.changed.fire()
  }
}

export function registerTreeViews(context: vscode.ExtensionContext): void {
  const tasks = new StaticShogoTreeProvider([
    { label: 'No active agent tasks', description: 'Phase 3 shell', icon: 'checklist' },
    { label: 'Run health check', description: 'Check local agent bridge', icon: 'pulse', command: 'shogo.health.check' },
  ])

  const checkpoints = new StaticShogoTreeProvider([
    { label: 'Checkpoint engine pending', description: 'Requires local agent service', icon: 'history', command: 'shogo.checkpoint.create' },
  ])

  const runtime = new StaticShogoTreeProvider([
    { label: 'Open runtime preview', description: 'Connects in next phase', icon: 'preview', command: 'shogo.runtime.openPreview' },
    { label: 'Route verification', description: 'Requires Shogo runtime bridge', icon: 'debug-alt' },
  ])

  const integrations = new StaticShogoTreeProvider([
    { label: 'Integration tools pending', description: 'Server-side tool bridge comes later', icon: 'plug' },
  ])

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('shogo.tasks', tasks),
    vscode.window.registerTreeDataProvider('shogo.checkpoints', checkpoints),
    vscode.window.registerTreeDataProvider('shogo.runtime', runtime),
    vscode.window.registerTreeDataProvider('shogo.integrations', integrations),
  )
}
