// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import fs from 'fs'
import Module from 'module'
import path from 'path'
import { pathToFileURL } from 'url'

type HostExtension = {
  id: string
  installPath: string
  main?: string
  activationEvents?: string[]
  commands: string[]
  views: string[]
  globalStoragePath: string
  workspaceStoragePath: string
}

type InitMessage = { type: 'init'; workspaceRoot?: string; extensions: HostExtension[] }
type ExecuteCommandMessage = { type: 'executeCommand'; requestId: string; commandId: string; args?: unknown[] }
type ActivateEventMessage = { type: 'activateEvent'; requestId: string; event: string }
type GetViewMessage = { type: 'getView'; requestId: string; viewId: string }
type DeactivateMessage = { type: 'deactivate'; requestId: string }
type HostMessage = InitMessage | ExecuteCommandMessage | ActivateEventMessage | GetViewMessage | DeactivateMessage

type RegisteredCommand = (...args: unknown[]) => unknown | Promise<unknown>
type TreeDataProvider = {
  getChildren?: (element?: unknown) => unknown[] | Promise<unknown[]>
  getTreeItem?: (element: unknown) => unknown | Promise<unknown>
}

const parentPort = (process as unknown as { parentPort?: { on(event: 'message', cb: (message: { data?: HostMessage } | HostMessage) => void): void; postMessage(message: unknown): void } }).parentPort
const extensions = new Map<string, HostExtension>()
const commandOwners = new Map<string, string>()
const viewOwners = new Map<string, string>()
const commands = new Map<string, RegisteredCommand>()
const treeDataProviders = new Map<string, TreeDataProvider>()
const activated = new Map<string, { deactivate?: () => unknown | Promise<unknown> }>()
let workspaceRoot: string | undefined
let activeExtensionId: string | null = null

function post(message: unknown): void {
  if (parentPort) parentPort.postMessage(message)
  else if (typeof process.send === 'function') process.send(message)
}

function makeVscodeApi(extension: HostExtension) {
  const subscriptions: Array<{ dispose?: () => void }> = []
  const globalState = createMemento(path.join(extension.globalStoragePath, 'globalState.json'))
  const workspaceState = createMemento(path.join(extension.workspaceStoragePath, 'workspaceState.json'))
  return {
    commands: {
      registerCommand(commandId: string, callback: RegisteredCommand) {
        commands.set(commandId, callback)
        commandOwners.set(commandId, extension.id)
        const disposable = { dispose: () => commands.delete(commandId) }
        subscriptions.push(disposable)
        post({ type: 'commandRegistered', extensionId: extension.id, commandId })
        return disposable
      },
      async executeCommand(commandId: string, ...args: unknown[]) {
        const command = commands.get(commandId)
        if (!command) throw new Error(`Command not registered: ${commandId}`)
        return await command(...args)
      },
    },
    window: {
      showInformationMessage: (message: string) => {
        post({ type: 'notification', level: 'info', extensionId: extension.id, message })
        return Promise.resolve(undefined)
      },
      showWarningMessage: (message: string) => {
        post({ type: 'notification', level: 'warning', extensionId: extension.id, message })
        return Promise.resolve(undefined)
      },
      showErrorMessage: (message: string) => {
        post({ type: 'notification', level: 'error', extensionId: extension.id, message })
        return Promise.resolve(undefined)
      },
      showQuickPick: (items: unknown[]) => Promise.resolve(Array.isArray(items) ? items[0] : undefined),
      showInputBox: () => Promise.resolve(undefined),
      createStatusBarItem: unsupported('window.createStatusBarItem'),
      createTreeView: (viewId: string, options?: { treeDataProvider?: TreeDataProvider }) => {
        if (options?.treeDataProvider) treeDataProviders.set(viewId, options.treeDataProvider)
        viewOwners.set(viewId, extension.id)
        post({ type: 'viewRegistered', extensionId: extension.id, viewId })
        const disposable = { dispose: () => treeDataProviders.delete(viewId) }
        subscriptions.push(disposable)
        return {
          reveal: () => Promise.resolve(),
          dispose: disposable.dispose,
          get visible() { return true },
          get selection() { return [] },
        }
      },
      registerTreeDataProvider: (viewId: string, provider: TreeDataProvider) => {
        treeDataProviders.set(viewId, provider)
        viewOwners.set(viewId, extension.id)
        post({ type: 'viewRegistered', extensionId: extension.id, viewId })
        const disposable = { dispose: () => treeDataProviders.delete(viewId) }
        subscriptions.push(disposable)
        return disposable
      },
      createWebviewPanel: unsupported('window.createWebviewPanel'),
      registerWebviewViewProvider: unsupported('window.registerWebviewViewProvider'),
    },
    workspace: {
      workspaceFolders: workspaceRoot ? [{ uri: { fsPath: workspaceRoot, scheme: 'file' }, name: path.basename(workspaceRoot), index: 0 }] : [],
      getConfiguration: () => ({
        get: () => undefined,
        has: () => false,
        inspect: () => undefined,
        update: () => Promise.resolve(),
      }),
      fs: createWorkspaceFs(),
    },
    Uri: {
      file: (fsPath: string) => ({ scheme: 'file', fsPath, path: fsPath, toString: () => pathToFileURL(fsPath).toString() }),
    },
    ExtensionContext: undefined,
    Disposable: class Disposable {
      constructor(private readonly fn: () => void) {}
      dispose() { this.fn() }
    },
  }
}

type ModuleLoader = (request: string, parent: NodeModule | null, isMain: boolean) => unknown
const moduleWithPrivateLoad = Module as unknown as { _load: ModuleLoader }
const originalLoad = moduleWithPrivateLoad._load
moduleWithPrivateLoad._load = function patchedLoad(this: unknown, request: string, parent: NodeModule | null, isMain: boolean) {
  if (request === 'vscode') {
    const extension = activeExtensionId ? extensions.get(activeExtensionId) : null
    if (!extension) throw new Error('The vscode API can only be imported while an extension is activating')
    return makeVscodeApi(extension)
  }
  return originalLoad.call(this, request, parent, isMain)
}

function unsupported(method: string) {
  return () => {
    throw new Error(`Unsupported VS Code API in Shogo extension host: ${method}`)
  }
}

async function activateExtension(extension: HostExtension, reason: string): Promise<void> {
  if (activated.has(extension.id)) return
  if (!extension.main) throw new Error(`Extension ${extension.id} has no main entry point`)
  const mainPath = safeJoin(extension.installPath, extension.main)
  const started = Date.now()
  fs.mkdirSync(extension.globalStoragePath, { recursive: true })
  fs.mkdirSync(extension.workspaceStoragePath, { recursive: true })
  activeExtensionId = extension.id
  try {
    const mod = require(mainPath)
    const context = {
      extensionPath: extension.installPath,
      globalStoragePath: extension.globalStoragePath,
      storagePath: extension.workspaceStoragePath,
      logPath: path.join(extension.globalStoragePath, 'logs'),
      subscriptions: [] as Array<{ dispose?: () => void }>,
      globalState: createMemento(path.join(extension.globalStoragePath, 'globalState.json')),
      workspaceState: createMemento(path.join(extension.workspaceStoragePath, 'workspaceState.json')),
      asAbsolutePath: (relativePath: string) => safeJoin(extension.installPath, relativePath),
    }
    const exports = mod.activate ? await mod.activate(context) : undefined
    activated.set(extension.id, { deactivate: typeof mod.deactivate === 'function' ? mod.deactivate : exports?.deactivate })
    post({ type: 'activated', extensionId: extension.id, reason, activationTimeMs: Date.now() - started })
  } finally {
    activeExtensionId = null
  }
}

async function activateStartupExtensions(): Promise<void> {
  for (const extension of extensions.values()) {
    const events = extension.activationEvents ?? []
    if (!events.includes('*') && !events.includes('onStartupFinished')) continue
    try {
      await activateExtension(extension, events.includes('*') ? '*' : 'onStartupFinished')
    } catch (err) {
      post({ type: 'activationError', extensionId: extension.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

async function activateEvent(requestId: string, event: string): Promise<void> {
  try {
    const extension = findExtensionForEvent(event)
    if (!extension) throw new Error(`No installed extension handles activation event: ${event}`)
    await activateExtension(extension, event)
    post({ type: 'response', requestId, ok: true, result: { extensionId: extension.id } })
  } catch (err) {
    post({ type: 'response', requestId, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

async function executeCommand(requestId: string, commandId: string, args: unknown[] = []): Promise<void> {
  try {
    let command = commands.get(commandId)
    if (!command) {
      const ownerId = commandOwners.get(commandId)
      const extension = ownerId ? extensions.get(ownerId) : [...extensions.values()].find((candidate) => candidate.commands.includes(commandId))
      if (!extension) throw new Error(`No installed extension contributes command: ${commandId}`)
      await activateExtension(extension, `onCommand:${commandId}`)
      command = commands.get(commandId)
    }
    if (!command) throw new Error(`Extension did not register command after activation: ${commandId}`)
    const result = await command(...args)
    post({ type: 'response', requestId, ok: true, result: serializeResult(result) })
  } catch (err) {
    post({ type: 'response', requestId, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

async function getView(requestId: string, viewId: string): Promise<void> {
  try {
    const ownerId = viewOwners.get(viewId)
    const extension = ownerId ? extensions.get(ownerId) : [...extensions.values()].find((candidate) => candidate.views.includes(viewId))
    if (!extension) throw new Error(`No installed extension contributes view: ${viewId}`)
    await activateExtension(extension, `onView:${viewId}`)
    const provider = treeDataProviders.get(viewId)
    if (!provider?.getChildren) {
      post({
        type: 'response',
        requestId,
        ok: true,
        result: {
          viewId,
          extensionId: extension.id,
          items: [],
          message: 'The extension activated but did not register a tree data provider for this view.',
        },
      })
      return
    }
    const children = await provider.getChildren()
    const items = await Promise.all((Array.isArray(children) ? children : []).map(async (element, index) => {
      const treeItem = provider.getTreeItem ? await provider.getTreeItem(element) : element
      return serializeTreeItem(treeItem, element, index)
    }))
    post({ type: 'response', requestId, ok: true, result: { viewId, extensionId: extension.id, items } })
  } catch (err) {
    post({ type: 'response', requestId, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

async function deactivateAll(requestId: string): Promise<void> {
  for (const [id, entry] of activated) {
    try { await entry.deactivate?.() } catch (err) { post({ type: 'deactivateError', extensionId: id, error: err instanceof Error ? err.message : String(err) }) }
  }
  activated.clear()
  commands.clear()
  treeDataProviders.clear()
  post({ type: 'response', requestId, ok: true })
}

function onMessage(raw: { data?: HostMessage } | HostMessage): void {
  const message = 'data' in raw && raw.data ? raw.data : raw as HostMessage
  if (message.type === 'init') {
    workspaceRoot = message.workspaceRoot
    extensions.clear()
    commandOwners.clear()
    viewOwners.clear()
    treeDataProviders.clear()
    for (const extension of message.extensions) {
      extensions.set(extension.id, extension)
      for (const command of extension.commands) commandOwners.set(command, extension.id)
      for (const view of extension.views) viewOwners.set(view, extension.id)
    }
    post({ type: 'ready', extensionCount: extensions.size })
    void activateStartupExtensions()
  } else if (message.type === 'executeCommand') {
    void executeCommand(message.requestId, message.commandId, message.args)
  } else if (message.type === 'activateEvent') {
    void activateEvent(message.requestId, message.event)
  } else if (message.type === 'getView') {
    void getView(message.requestId, message.viewId)
  } else if (message.type === 'deactivate') {
    void deactivateAll(message.requestId)
  }
}

if (parentPort) parentPort.on('message', onMessage)
else process.on('message', onMessage)

function findExtensionForEvent(event: string): HostExtension | undefined {
  if (event.startsWith('onCommand:')) {
    const commandId = event.slice('onCommand:'.length)
    const ownerId = commandOwners.get(commandId)
    if (ownerId) return extensions.get(ownerId)
  }
  if (event.startsWith('onView:')) {
    const viewId = event.slice('onView:'.length)
    const ownerId = viewOwners.get(viewId)
    if (ownerId) return extensions.get(ownerId)
  }
  return [...extensions.values()].find((extension) =>
    extension.activationEvents?.includes(event)
    || extension.activationEvents?.includes('*')
    || (event.startsWith('onCommand:') && extension.commands.includes(event.slice('onCommand:'.length)))
    || (event.startsWith('onView:') && extension.views.includes(event.slice('onView:'.length)))
  )
}

function serializeTreeItem(treeItem: unknown, element: unknown, index: number): Record<string, unknown> {
  const item = isRecord(treeItem) ? treeItem : isRecord(element) ? element : {}
  const rawLabel = item.label ?? (isRecord(element) ? element.label : undefined)
  const label = typeof rawLabel === 'string'
    ? rawLabel
    : isRecord(rawLabel) && typeof rawLabel.label === 'string'
      ? rawLabel.label
      : String(rawLabel ?? `Item ${index + 1}`)
  return {
    id: typeof item.id === 'string' ? item.id : `${index}:${label}`,
    label,
    description: typeof item.description === 'string' ? item.description : undefined,
    tooltip: typeof item.tooltip === 'string' ? item.tooltip : undefined,
    contextValue: typeof item.contextValue === 'string' ? item.contextValue : undefined,
    collapsibleState: typeof item.collapsibleState === 'number' ? item.collapsibleState : 0,
    command: serializeCommand(item.command),
  }
}

function serializeCommand(command: unknown): unknown {
  if (!isRecord(command) || typeof command.command !== 'string') return undefined
  return {
    command: command.command,
    title: typeof command.title === 'string' ? command.title : command.command,
    arguments: Array.isArray(command.arguments) ? serializeResult(command.arguments) : [],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function createMemento(file: string) {
  const read = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> } catch { return {} }
  }
  const write = (value: Record<string, unknown>) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value, null, 2))
  }
  return {
    get: (key: string, defaultValue?: unknown) => read()[key] ?? defaultValue,
    update: (key: string, value: unknown) => {
      const current = read()
      if (value === undefined) delete current[key]
      else current[key] = value
      write(current)
      return Promise.resolve()
    },
    keys: () => Object.keys(read()),
  }
}

function createWorkspaceFs() {
  return {
    readFile: async (uri: { fsPath?: string }) => fs.promises.readFile(assertWorkspacePath(uri.fsPath)),
    writeFile: async (uri: { fsPath?: string }, content: Uint8Array) => fs.promises.writeFile(assertWorkspacePath(uri.fsPath), content),
    stat: async (uri: { fsPath?: string }) => {
      const stat = await fs.promises.stat(assertWorkspacePath(uri.fsPath))
      return { type: stat.isDirectory() ? 2 : 1, ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size }
    },
    readDirectory: async (uri: { fsPath?: string }) => {
      const dir = assertWorkspacePath(uri.fsPath)
      const entries = await fs.promises.readdir(dir, { withFileTypes: true })
      return entries.map((entry) => [entry.name, entry.isDirectory() ? 2 : 1] as const)
    },
  }
}

function assertWorkspacePath(fsPath?: string): string {
  if (!workspaceRoot) throw new Error('No workspace is open')
  if (!fsPath) throw new Error('workspace.fs requires a file URI with fsPath')
  return safeJoin(workspaceRoot, path.relative(workspaceRoot, fsPath))
}

function safeJoin(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    const resolvedRoot = path.resolve(root)
    const resolvedAbsolute = path.resolve(relativePath)
    if (resolvedAbsolute === resolvedRoot || resolvedAbsolute.startsWith(`${resolvedRoot}${path.sep}`)) return resolvedAbsolute
    throw new Error(`Path escapes allowed root: ${relativePath}`)
  }
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, relativePath)
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`Path escapes allowed root: ${relativePath}`)
  return resolved
}

function serializeResult(value: unknown): unknown {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value))
}
