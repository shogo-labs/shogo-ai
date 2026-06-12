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
  globalStoragePath: string
  workspaceStoragePath: string
}

type InitMessage = { type: 'init'; workspaceRoot?: string; extensions: HostExtension[] }
type ExecuteCommandMessage = { type: 'executeCommand'; requestId: string; commandId: string; args?: unknown[] }
type DeactivateMessage = { type: 'deactivate'; requestId: string }
type HostMessage = InitMessage | ExecuteCommandMessage | DeactivateMessage

type RegisteredCommand = (...args: unknown[]) => unknown | Promise<unknown>

const parentPort = (process as unknown as { parentPort?: { on(event: 'message', cb: (message: { data?: HostMessage } | HostMessage) => void): void; postMessage(message: unknown): void } }).parentPort
const extensions = new Map<string, HostExtension>()
const commandOwners = new Map<string, string>()
const commands = new Map<string, RegisteredCommand>()
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
      createTreeView: unsupported('window.createTreeView'),
      registerTreeDataProvider: unsupported('window.registerTreeDataProvider'),
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

async function deactivateAll(requestId: string): Promise<void> {
  for (const [id, entry] of activated) {
    try { await entry.deactivate?.() } catch (err) { post({ type: 'deactivateError', extensionId: id, error: err instanceof Error ? err.message : String(err) }) }
  }
  activated.clear()
  commands.clear()
  post({ type: 'response', requestId, ok: true })
}

function onMessage(raw: { data?: HostMessage } | HostMessage): void {
  const message = 'data' in raw && raw.data ? raw.data : raw as HostMessage
  if (message.type === 'init') {
    workspaceRoot = message.workspaceRoot
    extensions.clear()
    commandOwners.clear()
    for (const extension of message.extensions) {
      extensions.set(extension.id, extension)
      for (const command of extension.commands) commandOwners.set(command, extension.id)
    }
    post({ type: 'ready', extensionCount: extensions.size })
  } else if (message.type === 'executeCommand') {
    void executeCommand(message.requestId, message.commandId, message.args)
  } else if (message.type === 'deactivate') {
    void deactivateAll(message.requestId)
  }
}

if (parentPort) parentPort.on('message', onMessage)
else process.on('message', onMessage)

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
