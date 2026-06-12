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

type UriLike = { scheme: string; fsPath: string; path: string; toString?: () => string }
type WorkspaceFolderSnapshot = { uri: UriLike; name: string; index: number }
type TextDocumentSnapshot = { uri: UriLike; fileName: string; languageId: string; version: number; text: string; isDirty?: boolean }
type TextEditorSnapshot = { document: TextDocumentSnapshot; selection?: unknown; selections?: unknown[] }
type WorkspaceStateSnapshot = {
  workspaceFolders?: WorkspaceFolderSnapshot[]
  textDocuments?: TextDocumentSnapshot[]
  activeTextEditor?: TextEditorSnapshot | null
  visibleTextEditors?: TextEditorSnapshot[]
  configuration?: Record<string, unknown>
}

type InitMessage = { type: 'init'; workspaceRoot?: string; extensions: HostExtension[] }
type ExecuteCommandMessage = { type: 'executeCommand'; requestId: string; commandId: string; args?: unknown[] }
type ActivateEventMessage = { type: 'activateEvent'; requestId: string; event: string }
type GetViewMessage = { type: 'getView'; requestId: string; viewId: string; itemHandle?: string }
type GetStatusBarItemsMessage = { type: 'getStatusBarItems'; requestId: string }
type GetWebviewPanelsMessage = { type: 'getWebviewPanels'; requestId: string }
type WorkspaceStateMessage = { type: 'workspaceState'; state: WorkspaceStateSnapshot }
type UiResponseMessage = { type: 'uiResponse'; requestId: string; ok: boolean; result?: unknown; error?: string }
type DeactivateMessage = { type: 'deactivate'; requestId: string }
type HostMessage = InitMessage | ExecuteCommandMessage | ActivateEventMessage | GetViewMessage | GetStatusBarItemsMessage | GetWebviewPanelsMessage | WorkspaceStateMessage | UiResponseMessage | DeactivateMessage

type RegisteredCommand = (...args: unknown[]) => unknown | Promise<unknown>
type RuntimeStatusBarItem = {
  id: string
  extensionId: string
  text: string
  tooltip?: string
  command?: unknown
  alignment: 'left' | 'right'
  priority?: number
  visible: boolean
}

type RuntimeWebviewPanel = {
  id: string
  extensionId: string
  viewType: string
  title: string
  html: string
  active: boolean
}
type RuntimeWebviewView = {
  id: string
  extensionId: string
  viewId: string
  title: string
  html: string
  visible: boolean
}
type TreeDataProvider = {
  getChildren?: (element?: unknown) => unknown[] | Promise<unknown[]>
  getTreeItem?: (element: unknown) => unknown | Promise<unknown>
  onDidChangeTreeData?: (listener: (element?: unknown) => unknown) => { dispose?: () => void }
}
type WebviewViewProvider = {
  resolveWebviewView?: (view: unknown, context?: unknown, token?: unknown) => unknown | Promise<unknown>
}
type TreeElementStore = {
  elements: Map<string, unknown>
  versions: Map<string, number>
  nextId: number
}

const parentPort = (process as unknown as { parentPort?: { on(event: 'message', cb: (message: { data?: HostMessage } | HostMessage) => void): void; postMessage(message: unknown): void } }).parentPort
const extensions = new Map<string, HostExtension>()
const commandOwners = new Map<string, string>()
const viewOwners = new Map<string, string>()
const commands = new Map<string, RegisteredCommand>()
const treeDataProviders = new Map<string, TreeDataProvider>()
const webviewViewProviders = new Map<string, WebviewViewProvider>()
const treeElementStores = new Map<string, TreeElementStore>()
const statusBarItems = new Map<string, RuntimeStatusBarItem>()
const webviewPanels = new Map<string, RuntimeWebviewPanel>()
const webviewViews = new Map<string, RuntimeWebviewView>()
const activationIndex = new Map<string, Set<string>>()
const activated = new Map<string, { deactivate?: () => unknown | Promise<unknown> }>()
const activating = new Map<string, Promise<void>>()
const pendingUiRequests = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
let workspaceRoot: string | undefined
let workspaceState: WorkspaceStateSnapshot = {}
let activeExtensionId: string | null = null
const activeEditorEmitter = createEmitter<TextEditorSnapshot | undefined>()
const visibleEditorsEmitter = createEmitter<TextEditorSnapshot[]>()
const openDocumentEmitter = createEmitter<TextDocumentSnapshot>()
const changeDocumentEmitter = createEmitter<{ document: TextDocumentSnapshot; contentChanges: Array<{ text: string }> }>()
const closeDocumentEmitter = createEmitter<TextDocumentSnapshot>()

function post(message: unknown): void {
  if (parentPort) parentPort.postMessage(message)
  else if (typeof process.send === 'function') process.send(message)
}

function makeVscodeApi(extension: HostExtension) {
  const subscriptions: Array<{ dispose?: () => void }> = []
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
      get activeTextEditor() { return serializeTextEditor(workspaceState.activeTextEditor ?? undefined) },
      get visibleTextEditors() { return (workspaceState.visibleTextEditors ?? []).map(serializeTextEditor) },
      onDidChangeActiveTextEditor: activeEditorEmitter.event,
      onDidChangeVisibleTextEditors: visibleEditorsEmitter.event,
      showTextDocument: (documentOrUri: unknown) => Promise.resolve(serializeTextEditor(editorForDocument(documentOrUri))),
      showInformationMessage: (message: string, ...items: unknown[]) => requestUi(extension, 'notification', { level: 'info', message, items }),
      showWarningMessage: (message: string, ...items: unknown[]) => requestUi(extension, 'notification', { level: 'warning', message, items }),
      showErrorMessage: (message: string, ...items: unknown[]) => requestUi(extension, 'notification', { level: 'error', message, items }),
      showQuickPick: (items: unknown[], options?: unknown) => requestUi(extension, 'quickPick', { items, options }),
      showInputBox: (options?: unknown) => requestUi(extension, 'inputBox', { options }),
      createOutputChannel: (name: string) => createOutputChannel(extension, name, subscriptions),
      createStatusBarItem: (...args: unknown[]) => createStatusBarItem(extension, args, subscriptions),
      createTreeView: (viewId: string, options?: { treeDataProvider?: TreeDataProvider }) => {
        const disposable = options?.treeDataProvider
          ? registerTreeDataProvider(extension, viewId, options.treeDataProvider)
          : registerViewOwner(extension, viewId)
        subscriptions.push(disposable)
        return {
          reveal: () => Promise.resolve(),
          dispose: disposable.dispose,
          get visible() { return true },
          get selection() { return [] },
        }
      },
      registerTreeDataProvider: (viewId: string, provider: TreeDataProvider) => {
        const disposable = registerTreeDataProvider(extension, viewId, provider)
        subscriptions.push(disposable)
        return disposable
      },
      createWebviewPanel: (viewType: string, title: string) => createWebviewPanel(extension, viewType, title),
      registerWebviewViewProvider: (viewId: string, provider: WebviewViewProvider) => {
        const disposable = registerWebviewViewProvider(extension, viewId, provider)
        subscriptions.push(disposable)
        return disposable
      },
    },
    workspace: {
      get workspaceFolders() { return workspaceFoldersSnapshot() },
      get textDocuments() { return (workspaceState.textDocuments ?? []).map(serializeTextDocument) },
      onDidOpenTextDocument: openDocumentEmitter.event,
      onDidChangeTextDocument: changeDocumentEmitter.event,
      onDidCloseTextDocument: closeDocumentEmitter.event,
      openTextDocument: (uriOrPath: unknown) => Promise.resolve(openTextDocumentSnapshot(uriOrPath)),
      getConfiguration: (section?: string) => createConfiguration(section),
      fs: createWorkspaceFs(),
    },
    Uri: {
      file: (fsPath: string) => ({ scheme: 'file', fsPath, path: fsPath, toString: () => pathToFileURL(fsPath).toString() }),
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
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

function createEmitter<T>() {
  const listeners = new Set<(event: T) => unknown>()
  return {
    event(listener: (event: T) => unknown) {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    fire(event: T) {
      for (const listener of [...listeners]) {
        try { listener(event) } catch (err) { post({ type: 'listenerError', error: err instanceof Error ? err.message : String(err) }) }
      }
    },
  }
}

function workspaceFoldersSnapshot(): WorkspaceFolderSnapshot[] {
  if (workspaceState.workspaceFolders?.length) return workspaceState.workspaceFolders.map(serializeWorkspaceFolder)
  return workspaceRoot ? [serializeWorkspaceFolder({ uri: uriFromFsPath(workspaceRoot), name: path.basename(workspaceRoot), index: 0 })] : []
}

function serializeWorkspaceFolder(folder: WorkspaceFolderSnapshot): WorkspaceFolderSnapshot {
  return { ...folder, uri: serializeUri(folder.uri) }
}

function serializeUri(uri: UriLike): UriLike {
  const fsPath = uri.fsPath
  const scheme = uri.scheme || 'file'
  const uriPath = uri.path || fsPath
  return { scheme, fsPath, path: uriPath, toString: () => scheme === 'file' ? pathToFileURL(fsPath).toString() : `${scheme}:${uriPath}` }
}

function uriFromFsPath(fsPath: string): UriLike {
  return { scheme: 'file', fsPath, path: fsPath, toString: () => pathToFileURL(fsPath).toString() }
}

function serializeTextDocument(document: TextDocumentSnapshot): TextDocumentSnapshot & { getText: () => string; lineAt: (line: number) => { text: string; lineNumber: number } } {
  const text = document.text ?? ''
  return {
    ...document,
    uri: serializeUri(document.uri),
    getText: () => text,
    lineAt: (line: number) => {
      const lines = text.split(/\r?\n/)
      return { text: lines[line] ?? '', lineNumber: line }
    },
  }
}

function serializeTextEditor(editor: TextEditorSnapshot | undefined): (TextEditorSnapshot & { document: ReturnType<typeof serializeTextDocument> }) | undefined {
  if (!editor) return undefined
  return { ...editor, document: serializeTextDocument(editor.document) }
}

function editorForDocument(documentOrUri: unknown): TextEditorSnapshot | undefined {
  const fsPath = uriFsPath(documentOrUri)
  const document = fsPath
    ? workspaceState.textDocuments?.find((candidate) => candidate.uri.fsPath === fsPath || candidate.fileName === fsPath) ?? openTextDocumentSnapshot(documentOrUri)
    : isRecord(documentOrUri) && isRecord(documentOrUri.document)
      ? documentOrUri.document as TextDocumentSnapshot
      : workspaceState.activeTextEditor?.document
  return document ? { document } : workspaceState.activeTextEditor ?? undefined
}

function openTextDocumentSnapshot(uriOrPath: unknown): TextDocumentSnapshot {
  const fsPath = uriFsPath(uriOrPath) ?? (typeof uriOrPath === 'string' ? uriOrPath : undefined)
  const existing = fsPath ? workspaceState.textDocuments?.find((document) => document.uri.fsPath === fsPath || document.fileName === fsPath) : undefined
  if (existing) return serializeTextDocument(existing)
  if (!fsPath) throw new Error('openTextDocument requires a file path or URI')
  const allowed = assertWorkspacePath(fsPath)
  const text = fs.readFileSync(allowed, 'utf8')
  return serializeTextDocument({ uri: uriFromFsPath(allowed), fileName: allowed, languageId: languageFromPath(allowed), version: 1, text, isDirty: false })
}

function uriFsPath(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (isRecord(value) && typeof value.fsPath === 'string') return value.fsPath
  if (isRecord(value) && isRecord(value.uri) && typeof value.uri.fsPath === 'string') return value.uri.fsPath
  return undefined
}

function languageFromPath(file: string): string {
  const ext = path.extname(file).toLowerCase().slice(1)
  if (ext === 'ts' || ext === 'tsx') return 'typescript'
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return 'javascript'
  if (ext === 'json') return 'json'
  if (ext === 'md') return 'markdown'
  if (ext === 'py') return 'python'
  if (ext === 'css') return 'css'
  if (ext === 'html') return 'html'
  return ext || 'plaintext'
}

function createConfiguration(section?: string) {
  const all = workspaceState.configuration ?? {}
  const sectionValue = section ? getConfigValue(all, section) : all
  return {
    get: (key?: string, defaultValue?: unknown) => {
      const value = key ? getConfigValue(sectionValue, key) : sectionValue
      return value === undefined ? defaultValue : value
    },
    has: (key: string) => getConfigValue(sectionValue, key) !== undefined,
    inspect: (key: string) => {
      const value = getConfigValue(sectionValue, key)
      return value === undefined ? undefined : { key, globalValue: value, workspaceValue: value }
    },
    update: () => Promise.resolve(),
  }
}

function getConfigValue(source: unknown, key: string): unknown {
  if (!isRecord(source)) return undefined
  if (Object.prototype.hasOwnProperty.call(source, key)) return source[key]
  return key.split('.').reduce<unknown>((current, part) => isRecord(current) ? current[part] : undefined, source)
}

function applyWorkspaceState(next: WorkspaceStateSnapshot): void {
  const previousDocuments = new Map((workspaceState.textDocuments ?? []).map((document) => [document.uri.fsPath, document]))
  const previousActive = workspaceState.activeTextEditor?.document.uri.fsPath
  workspaceState = next
  const currentDocuments = new Map((workspaceState.textDocuments ?? []).map((document) => [document.uri.fsPath, document]))
  for (const [fsPath, document] of currentDocuments) {
    const previous = previousDocuments.get(fsPath)
    if (!previous) openDocumentEmitter.fire(serializeTextDocument(document))
    else if (previous.version !== document.version || previous.text !== document.text || previous.isDirty !== document.isDirty) {
      changeDocumentEmitter.fire({ document: serializeTextDocument(document), contentChanges: [{ text: document.text }] })
    }
  }
  for (const [fsPath, document] of previousDocuments) {
    if (!currentDocuments.has(fsPath)) closeDocumentEmitter.fire(serializeTextDocument(document))
  }
  const currentActive = workspaceState.activeTextEditor?.document.uri.fsPath
  if (previousActive !== currentActive) activeEditorEmitter.fire(serializeTextEditor(workspaceState.activeTextEditor ?? undefined))
  visibleEditorsEmitter.fire((workspaceState.visibleTextEditors ?? []).map((editor) => serializeTextEditor(editor)).filter((editor): editor is TextEditorSnapshot & { document: ReturnType<typeof serializeTextDocument> } => !!editor))
}

function unsupported(method: string) {
  return () => {
    throw new Error(`Unsupported VS Code API in Shogo extension host: ${method}`)
  }
}

function registerViewOwner(extension: HostExtension, viewId: string): { dispose: () => void } {
  viewOwners.set(viewId, extension.id)
  post({ type: 'viewRegistered', extensionId: extension.id, viewId })
  return { dispose: () => viewOwners.delete(viewId) }
}

function registerTreeDataProvider(extension: HostExtension, viewId: string, provider: TreeDataProvider): { dispose: () => void } {
  treeDataProviders.set(viewId, provider)
  treeElementStores.set(viewId, { elements: new Map(), versions: new Map(), nextId: 1 })
  const ownerDisposable = registerViewOwner(extension, viewId)
  const refreshDisposable = provider.onDidChangeTreeData?.((element?: unknown) => {
    const store = treeElementStores.get(viewId)
    const handle = findTreeElementHandle(store, element) ?? 'root'
    if (store) {
      if (handle === 'root') {
        store.elements.clear()
        store.nextId = 1
      }
      store.versions.set(handle, (store.versions.get(handle) ?? 0) + 1)
    }
    post({ type: 'viewChanged', extensionId: extension.id, viewId, reason: 'treeData', itemHandle: handle })
  })
  return {
    dispose: () => {
      refreshDisposable?.dispose?.()
      treeDataProviders.delete(viewId)
      treeElementStores.delete(viewId)
      ownerDisposable.dispose()
      post({ type: 'viewDisposed', extensionId: extension.id, viewId })
    },
  }
}

function registerWebviewViewProvider(extension: HostExtension, viewId: string, provider: WebviewViewProvider): { dispose: () => void } {
  webviewViewProviders.set(viewId, provider)
  const ownerDisposable = registerViewOwner(extension, viewId)
  return {
    dispose: () => {
      webviewViewProviders.delete(viewId)
      webviewViews.delete(viewId)
      ownerDisposable.dispose()
      post({ type: 'viewDisposed', extensionId: extension.id, viewId })
    },
  }
}

async function requestUi(extension: HostExtension, kind: string, payload: Record<string, unknown>): Promise<unknown> {
  const requestId = `${extension.id}:${kind}:${Date.now()}:${pendingUiRequests.size + 1}`
  post({ type: 'uiRequest', requestId, extensionId: extension.id, kind, payload })
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingUiRequests.delete(requestId)
      resolve(undefined)
    }, 30000)
    pendingUiRequests.set(requestId, { resolve, reject, timer })
  })
}

function createOutputChannel(extension: HostExtension, name: string, subscriptions: Array<{ dispose?: () => void }>) {
  const channel = { extensionId: extension.id, name }
  const append = (value: unknown, newline = false) => post({ type: 'output', ...channel, value: `${String(value ?? '')}${newline ? '\n' : ''}` })
  const disposable = { dispose: () => post({ type: 'outputDisposed', ...channel }) }
  subscriptions.push(disposable)
  return {
    name,
    append: (value: unknown) => append(value),
    appendLine: (value: unknown) => append(value, true),
    clear: () => post({ type: 'outputCleared', ...channel }),
    show: () => post({ type: 'outputShown', ...channel }),
    hide: () => undefined,
    dispose: disposable.dispose,
  }
}

function buildActivationIndex(): void {
  activationIndex.clear()
  for (const extension of extensions.values()) {
    for (const event of extension.activationEvents ?? []) addActivationEvent(event, extension.id)
    for (const command of extension.commands) addActivationEvent(`onCommand:${command}`, extension.id)
    for (const view of extension.views) addActivationEvent(`onView:${view}`, extension.id)
  }
}

function addActivationEvent(event: string, extensionId: string): void {
  const key = event.trim()
  if (!key) return
  const existing = activationIndex.get(key) ?? new Set<string>()
  existing.add(extensionId)
  activationIndex.set(key, existing)
}

async function activateByEvent(event: string): Promise<{ extensionIds: string[]; durationMs: number }> {
  const started = Date.now()
  const extensionIds = [...(activationIndex.get(event) ?? new Set<string>())]
  const activatedIds: string[] = []
  for (const extensionId of extensionIds) {
    const extension = extensions.get(extensionId)
    if (!extension) continue
    const activationStarted = Date.now()
    try {
      await activateExtension(extension, event)
      activatedIds.push(extension.id)
    } catch (err) {
      post({
        type: 'activationError',
        extensionId: extension.id,
        event,
        durationMs: Date.now() - activationStarted,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }
  return { extensionIds: activatedIds, durationMs: Date.now() - started }
}

async function activateExtension(extension: HostExtension, reason: string): Promise<void> {
  if (activated.has(extension.id)) return
  const pending = activating.get(extension.id)
  if (pending) return await pending
  const promise = activateExtensionOnce(extension, reason)
  activating.set(extension.id, promise)
  try {
    await promise
  } finally {
    activating.delete(extension.id)
  }
}

async function activateExtensionOnce(extension: HostExtension, reason: string): Promise<void> {
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
  for (const event of ['*', 'onStartupFinished', ...getMatchingWorkspaceContainsEvents()]) {
    try {
      await activateByEvent(event)
    } catch (_err) {
      continue
    }
  }
}

async function activateEvent(requestId: string, event: string): Promise<void> {
  try {
    const result = await activateByEvent(event)
    post({ type: 'response', requestId, ok: true, result })
  } catch (err) {
    post({ type: 'response', requestId, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

async function executeCommand(requestId: string, commandId: string, args: unknown[] = []): Promise<void> {
  const started = Date.now()
  try {
    let command = commands.get(commandId)
    if (!command) {
      await activateByEvent(`onCommand:${commandId}`)
      command = commands.get(commandId)
    }
    if (!command) throw new Error(`Extension did not register command after activation: ${commandId}`)
    const result = await command(...args)
    post({ type: 'commandExecuted', commandId, durationMs: Date.now() - started })
    post({ type: 'response', requestId, ok: true, result: serializeResult(result) })
  } catch (err) {
    post({ type: 'commandError', commandId, durationMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) })
    post({ type: 'response', requestId, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

function getVisibleStatusBarItems(): RuntimeStatusBarItem[] {
  return [...statusBarItems.values()]
    .filter((item) => item.visible && item.text)
    .sort((a, b) => {
      if (a.alignment !== b.alignment) return a.alignment === 'left' ? -1 : 1
      return (b.priority ?? 0) - (a.priority ?? 0)
    })
}

function respondStatusBarItems(requestId: string): void {
  post({ type: 'response', requestId, ok: true, result: getVisibleStatusBarItems() })
}

function getActiveWebviewPanels(): RuntimeWebviewPanel[] {
  return [...webviewPanels.values()].filter((panel) => panel.active)
}

function respondWebviewPanels(requestId: string): void {
  post({ type: 'response', requestId, ok: true, result: getActiveWebviewPanels() })
}

async function getView(requestId: string, viewId: string, itemHandle?: string): Promise<void> {
  const started = Date.now()
  try {
    await activateByEvent(`onView:${viewId}`)
    const ownerId = viewOwners.get(viewId)
    const extension = ownerId ? extensions.get(ownerId) : undefined
    if (!extension) throw new Error(`No installed extension contributes view: ${viewId}`)

    const treeProvider = treeDataProviders.get(viewId)
    if (treeProvider?.getChildren) {
      const store = treeElementStores.get(viewId) ?? { elements: new Map<string, unknown>(), versions: new Map<string, number>(), nextId: 1 }
      treeElementStores.set(viewId, store)
      const parent = itemHandle ? store.elements.get(itemHandle) : undefined
      const children = await treeProvider.getChildren(parent)
      const items = await Promise.all((Array.isArray(children) ? children : []).map(async (element, index) => {
        const treeItem = treeProvider.getTreeItem ? await treeProvider.getTreeItem(element) : element
        return serializeTreeItem(viewId, treeItem, element, index, itemHandle)
      }))
      post({ type: 'viewResolved', viewId, extensionId: extension.id, durationMs: Date.now() - started, kind: 'tree', itemHandle })
      post({ type: 'response', requestId, ok: true, result: { kind: 'tree', viewId, extensionId: extension.id, itemHandle, items } })
      return
    }

    const webviewProvider = webviewViewProviders.get(viewId)
    if (webviewProvider?.resolveWebviewView) {
      const view = await resolveWebviewView(extension, viewId, webviewProvider)
      post({ type: 'viewResolved', viewId, extensionId: extension.id, durationMs: Date.now() - started, kind: 'webview' })
      post({ type: 'response', requestId, ok: true, result: { kind: 'webview', viewId, extensionId: extension.id, html: view.html, title: view.title } })
      return
    }

    post({
      type: 'response',
      requestId,
      ok: true,
      result: {
        kind: 'empty',
        viewId,
        extensionId: extension.id,
        items: [],
        message: 'The extension activated but did not register a tree data provider or webview view provider for this view.',
      },
    })
    post({ type: 'viewResolved', viewId, extensionId: extension.id, durationMs: Date.now() - started, kind: 'empty' })
  } catch (err) {
    post({ type: 'viewError', viewId, durationMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) })
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
  treeElementStores.clear()
  statusBarItems.clear()
  webviewPanels.clear()
  webviewViews.clear()
  post({ type: 'statusBarItemsChanged', items: [] })
  post({ type: 'webviewPanelsChanged', panels: [] })
  post({ type: 'response', requestId, ok: true })
}

function onMessage(raw: { data?: HostMessage } | HostMessage): void {
  const message = 'data' in raw && raw.data ? raw.data : raw as HostMessage
  if (message.type === 'init') {
    workspaceRoot = message.workspaceRoot
    workspaceState = { workspaceFolders: workspaceRoot ? [{ uri: uriFromFsPath(workspaceRoot), name: path.basename(workspaceRoot), index: 0 }] : [], textDocuments: [], visibleTextEditors: [], activeTextEditor: null, configuration: {} }
    extensions.clear()
    commandOwners.clear()
    viewOwners.clear()
    treeDataProviders.clear()
    treeElementStores.clear()
    statusBarItems.clear()
    webviewPanels.clear()
    webviewViews.clear()
    post({ type: 'statusBarItemsChanged', items: [] })
    post({ type: 'webviewPanelsChanged', panels: [] })
    for (const extension of message.extensions) {
      extensions.set(extension.id, extension)
      for (const command of extension.commands) commandOwners.set(command, extension.id)
      for (const view of extension.views) viewOwners.set(view, extension.id)
    }
    buildActivationIndex()
    post({ type: 'ready', extensionCount: extensions.size, activationEventCount: activationIndex.size })
    void activateStartupExtensions()
  } else if (message.type === 'executeCommand') {
    void executeCommand(message.requestId, message.commandId, message.args)
  } else if (message.type === 'activateEvent') {
    void activateEvent(message.requestId, message.event)
  } else if (message.type === 'getView') {
    void getView(message.requestId, message.viewId, message.itemHandle)
  } else if (message.type === 'getStatusBarItems') {
    respondStatusBarItems(message.requestId)
  } else if (message.type === 'getWebviewPanels') {
    respondWebviewPanels(message.requestId)
  } else if (message.type === 'workspaceState') {
    applyWorkspaceState(message.state)
  } else if (message.type === 'uiResponse') {
    const pending = pendingUiRequests.get(message.requestId)
    if (!pending) return
    pendingUiRequests.delete(message.requestId)
    clearTimeout(pending.timer)
    if (message.ok) pending.resolve(message.result)
    else pending.reject(new Error(message.error ?? 'Extension UI request failed'))
  } else if (message.type === 'deactivate') {
    void deactivateAll(message.requestId)
  }
}

if (parentPort) parentPort.on('message', onMessage)
else process.on('message', onMessage)



function createWebviewApi(onChange: () => void, getHtml: () => string, setHtml: (value: string) => void): Record<string, unknown> {
  const webview: Record<string, unknown> = {
    asWebviewUri: (uri: unknown) => uri,
    postMessage: () => Promise.resolve(true),
    onDidReceiveMessage: () => ({ dispose: () => undefined }),
    cspSource: 'shogo-extension-webview',
    options: {},
  }
  Object.defineProperty(webview, 'html', {
    get: getHtml,
    set: (value) => {
      setHtml(String(value ?? ''))
      onChange()
    },
  })
  return webview
}

async function resolveWebviewView(extension: HostExtension, viewId: string, provider: WebviewViewProvider): Promise<RuntimeWebviewView> {
  let view = webviewViews.get(viewId)
  if (!view) {
    view = { id: `${extension.id}:${viewId}`, extensionId: extension.id, viewId, title: viewId, html: '', visible: true }
    webviewViews.set(viewId, view)
  }
  const publish = () => post({ type: 'webviewViewChanged', view: { ...view } })
  const webview = createWebviewApi(publish, () => view.html, (value) => { view.html = value })
  const apiView: Record<string, unknown> = {
    viewType: viewId,
    webview,
    visible: true,
    show: () => { view.visible = true; publish() },
    onDidDispose: () => ({ dispose: () => undefined }),
    onDidChangeVisibility: () => ({ dispose: () => undefined }),
  }
  Object.defineProperty(apiView, 'title', {
    get: () => view.title,
    set: (value) => { view.title = String(value ?? viewId); publish() },
  })
  await provider.resolveWebviewView?.(apiView, {}, { isCancellationRequested: false })
  view.visible = true
  publish()
  return view
}

function createWebviewPanel(extension: HostExtension, viewType: string, title: string) {
  const panel: RuntimeWebviewPanel = {
    id: `${extension.id}:${viewType}:${Date.now()}:${webviewPanels.size + 1}`,
    extensionId: extension.id,
    viewType,
    title,
    html: '',
    active: true,
  }
  webviewPanels.set(panel.id, panel)
  const publish = () => post({ type: 'webviewPanelsChanged', panels: getActiveWebviewPanels() })
  publish()
  const webview: Record<string, unknown> = {
    asWebviewUri: (uri: unknown) => uri,
    postMessage: () => Promise.resolve(true),
    onDidReceiveMessage: () => ({ dispose: () => undefined }),
    cspSource: 'shogo-extension-webview',
  }
  Object.defineProperty(webview, 'html', {
    get: () => panel.html,
    set: (value) => {
      panel.html = String(value ?? '')
      publish()
    },
  })
  const apiPanel: Record<string, unknown> = {
    viewType,
    webview,
    reveal: () => { panel.active = true; publish() },
    dispose: () => { panel.active = false; publish() },
    onDidDispose: () => ({ dispose: () => undefined }),
    onDidChangeViewState: () => ({ dispose: () => undefined }),
  }
  Object.defineProperty(apiPanel, 'title', {
    get: () => panel.title,
    set: (value) => {
      panel.title = String(value ?? title)
      publish()
    },
  })
  return apiPanel
}

function createStatusBarItem(extension: HostExtension, args: unknown[], subscriptions: Array<{ dispose?: () => void }>) {
  const hasId = typeof args[0] === 'string'
  const rawAlignment = hasId ? args[1] : args[0]
  const rawPriority = hasId ? args[2] : args[1]
  const item: RuntimeStatusBarItem = {
    id: hasId ? String(args[0]) : `${extension.id}:${statusBarItems.size + 1}:${Date.now()}`,
    extensionId: extension.id,
    text: '',
    alignment: rawAlignment === 2 ? 'right' : 'left',
    priority: typeof rawPriority === 'number' ? rawPriority : undefined,
    visible: false,
  }
  const publish = () => post({ type: 'statusBarItemsChanged', items: getVisibleStatusBarItems() })
  const disposable = {
    dispose: () => {
      statusBarItems.delete(item.id)
      publish()
    },
  }
  subscriptions.push(disposable)
  const apiItem: Record<string, unknown> = {
    id: item.id,
    alignment: item.alignment === 'right' ? 2 : 1,
    priority: item.priority,
    show: () => {
      item.visible = true
      statusBarItems.set(item.id, item)
      publish()
    },
    hide: () => {
      item.visible = false
      publish()
    },
    dispose: disposable.dispose,
  }
  Object.defineProperties(apiItem, {
    text: { get: () => item.text, set: (value) => { item.text = String(value ?? ''); if (item.visible) publish() } },
    tooltip: { get: () => item.tooltip, set: (value) => { item.tooltip = typeof value === 'string' ? value : String(value ?? ''); if (item.visible) publish() } },
    command: { get: () => item.command, set: (value) => { item.command = value; if (item.visible) publish() } },
    color: { get: () => undefined, set: () => undefined },
    backgroundColor: { get: () => undefined, set: () => undefined },
    name: { get: () => undefined, set: () => undefined },
    accessibilityInformation: { get: () => undefined, set: () => undefined },
  })
  return apiItem
}

function getMatchingWorkspaceContainsEvents(): string[] {
  if (!workspaceRoot) return []
  return [...activationIndex.keys()].filter((event) => {
    if (!event.startsWith('workspaceContains:')) return false
    return workspaceContains(event.slice('workspaceContains:'.length))
  })
}

function workspaceContains(pattern: string): boolean {
  if (!workspaceRoot) return false
  const normalized = pattern.trim()
  if (!normalized) return false
  if (!normalized.includes('*')) return fs.existsSync(safeJoin(workspaceRoot, normalized))
  const matcher = globMatcher(normalized)
  const stack = ['']
  while (stack.length) {
    const relativeDir = stack.pop() ?? ''
    const absoluteDir = safeJoin(workspaceRoot, relativeDir)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      if (matcher(relativePath)) return true
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') stack.push(relativePath)
    }
  }
  return false
}

function globMatcher(pattern: string): (value: string) => boolean {
  const placeholder = '\u0000'
  const escaped = pattern
    .replace(/\*\*/g, placeholder)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .split(placeholder).join('.*')
  const regex = new RegExp(`^${escaped}$`)
  return (value: string) => regex.test(value)
}

function serializeTreeItem(viewId: string, treeItem: unknown, element: unknown, index: number, parentHandle?: string): Record<string, unknown> {
  const item = isRecord(treeItem) ? treeItem : isRecord(element) ? element : {}
  const rawLabel = item.label ?? (isRecord(element) ? element.label : undefined)
  const label = typeof rawLabel === 'string'
    ? rawLabel
    : isRecord(rawLabel) && typeof rawLabel.label === 'string'
      ? rawLabel.label
      : String(rawLabel ?? `Item ${index + 1}`)
  const handle = rememberTreeElement(viewId, element, item, index, label, parentHandle)
  return {
    id: typeof item.id === 'string' ? item.id : handle,
    handle,
    parentHandle,
    label,
    description: typeof item.description === 'string' ? item.description : undefined,
    tooltip: typeof item.tooltip === 'string' ? item.tooltip : undefined,
    contextValue: typeof item.contextValue === 'string' ? item.contextValue : undefined,
    collapsibleState: typeof item.collapsibleState === 'number' ? item.collapsibleState : 0,
    command: serializeCommand(item.command),
  }
}

function rememberTreeElement(viewId: string, element: unknown, item: Record<string, unknown>, index: number, label: string, parentHandle?: string): string {
  const store = treeElementStores.get(viewId) ?? { elements: new Map<string, unknown>(), versions: new Map<string, number>(), nextId: 1 }
  treeElementStores.set(viewId, store)
  const existing = findTreeElementHandle(store, element)
  if (existing) return existing
  const candidate = typeof item.id === 'string' ? item.id : `${parentHandle ?? 'root'}:${index}:${label}`
  const handle = store.elements.has(candidate) ? `${candidate}:${store.nextId++}` : candidate
  store.elements.set(handle, element)
  return handle
}

function findTreeElementHandle(store: TreeElementStore | undefined, element: unknown): string | undefined {
  if (!store || element === undefined) return undefined
  for (const [handle, stored] of store.elements) {
    if (stored === element) return handle
  }
  return undefined
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
    createDirectory: async (uri: { fsPath?: string }) => fs.promises.mkdir(assertWorkspacePath(uri.fsPath), { recursive: true }),
    delete: async (uri: { fsPath?: string }, options?: { recursive?: boolean }) => fs.promises.rm(assertWorkspacePath(uri.fsPath), { recursive: !!options?.recursive, force: true }),
    rename: async (oldUri: { fsPath?: string }, newUri: { fsPath?: string }, options?: { overwrite?: boolean }) => {
      const oldPath = assertWorkspacePath(oldUri.fsPath)
      const newPath = assertWorkspacePath(newUri.fsPath)
      if (options?.overwrite) await fs.promises.rm(newPath, { recursive: true, force: true })
      await fs.promises.rename(oldPath, newPath)
    },
    copy: async (source: { fsPath?: string }, destination: { fsPath?: string }, options?: { overwrite?: boolean }) => {
      const sourcePath = assertWorkspacePath(source.fsPath)
      const destinationPath = assertWorkspacePath(destination.fsPath)
      if (options?.overwrite) await fs.promises.rm(destinationPath, { recursive: true, force: true })
      await fs.promises.cp(sourcePath, destinationPath, { recursive: true, force: false })
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
