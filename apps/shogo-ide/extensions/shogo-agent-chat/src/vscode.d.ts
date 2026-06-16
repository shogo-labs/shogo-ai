declare module 'vscode' {
  export interface Disposable {
    dispose(): void
  }

  export interface ExtensionContext {
    subscriptions: Disposable[]
    extensionUri: Uri
  }

  export class Uri {
    scheme: string
    path: string
    fsPath: string
    static parse(value: string): Uri
    static joinPath(base: Uri, ...pathSegments: string[]): Uri
    toString(): string
  }

  export class ThemeIcon {
    constructor(id: string)
  }

  export class MarkdownString {
    value: string
    supportHtml: boolean
    isTrusted: boolean
    constructor(value?: string, supportThemeIcons?: boolean)
  }

  export enum TreeItemCollapsibleState {
    None = 0,
    Collapsed = 1,
    Expanded = 2,
  }

  export class TreeItem {
    label?: string
    description?: string
    tooltip?: string | MarkdownString
    iconPath?: ThemeIcon
    contextValue?: string
    command?: Command
    constructor(label: string, collapsibleState?: TreeItemCollapsibleState)
  }

  export interface Command {
    command: string
    title: string
    arguments?: unknown[]
  }

  export interface Event<T> {
    (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: Disposable[]): Disposable
  }

  export class EventEmitter<T> implements Disposable {
    event: Event<T>
    fire(data: T): void
    dispose(): void
  }

  export interface TreeDataProvider<T> {
    onDidChangeTreeData?: Event<T | undefined | null | void>
    getTreeItem(element: T): TreeItem
    getChildren(element?: T): ProviderResult<T[]>
  }

  export interface Webview {
    html: string
    options: WebviewOptions
    cspSource: string
    asWebviewUri(localResource: Uri): Uri
    postMessage(message: unknown): Thenable<boolean>
    onDidReceiveMessage(listener: (message: unknown) => unknown, thisArgs?: unknown, disposables?: Disposable[]): Disposable
  }

  export interface WebviewOptions {
    enableScripts?: boolean
    localResourceRoots?: readonly Uri[]
  }

  export interface WebviewView {
    webview: Webview
    show?: (preserveFocus?: boolean) => void
  }

  export interface WebviewViewResolveContext<T = unknown> {
    readonly state: T | undefined
  }

  export interface WebviewViewProvider {
    resolveWebviewView(webviewView: WebviewView, context: WebviewViewResolveContext, token: CancellationToken): ProviderResult<void>
  }

  export interface CancellationToken {
    readonly isCancellationRequested: boolean
  }

  export type ProviderResult<T> = T | undefined | null | Thenable<T | undefined | null>

  export interface TextDocument {
    uri: Uri
    fileName: string
    languageId: string
    getText(range?: Range): string
    lineAt(line: number): TextLine
  }

  export interface TextLine {
    text: string
  }

  export interface TextEditor {
    document: TextDocument
    selection: Selection
  }

  export interface Range {
    start: Position
    end: Position
  }

  export interface Position {
    line: number
    character: number
  }

  export interface Selection extends Range {
    isEmpty: boolean
  }

  export interface WorkspaceFolder {
    uri: Uri
    name: string
    index: number
  }

  export interface WorkspaceConfiguration {
    get<T>(section: string): T | undefined
    get<T>(section: string, defaultValue: T): T
  }

  export interface WorkspaceTrustState {
    readonly isTrusted: boolean
  }

  export namespace workspace {
    const workspaceFolders: readonly WorkspaceFolder[] | undefined
    const isTrusted: boolean
    function getConfiguration(section?: string): WorkspaceConfiguration
    function asRelativePath(pathOrUri: string | Uri, includeWorkspaceFolder?: boolean): string
    function onDidGrantWorkspaceTrust(listener: () => unknown): Disposable
  }

  export namespace window {
    const activeTextEditor: TextEditor | undefined
    function showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>
    function showWarningMessage(message: string, ...items: string[]): Thenable<string | undefined>
    function showErrorMessage(message: string, ...items: string[]): Thenable<string | undefined>
    function registerWebviewViewProvider(viewId: string, provider: WebviewViewProvider, options?: unknown): Disposable
    function registerTreeDataProvider<T>(viewId: string, treeDataProvider: TreeDataProvider<T>): Disposable
  }

  export namespace commands {
    function registerCommand(command: string, callback: (...args: unknown[]) => unknown): Disposable
    function executeCommand<T = unknown>(command: string, ...rest: unknown[]): Thenable<T>
  }

  export namespace env {
    const appName: string
    const uriScheme: string
  }
}

declare const process: {
  env: Record<string, string | undefined>
}
