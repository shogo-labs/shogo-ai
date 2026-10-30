import { mock } from 'bun:test'

/**
 * Minimal `vscode` module for the extension's unit tests. Workspace folders,
 * file types and the active editor are mutable through `vscodeMock.state`.
 */
export class FakeUri {
  constructor(readonly scheme: string, readonly path: string) {}
  get fsPath(): string {
    return this.path
  }
  toString(): string {
    return `${this.scheme}://${this.path}`
  }
  static file(path: string): FakeUri {
    return new FakeUri('file', path)
  }
  static parse(value: string): FakeUri {
    const m = /^([a-z-]+):\/\/(.*)$/.exec(value)
    if (!m) throw new Error(`bad uri ${value}`)
    return new FakeUri(m[1], m[2])
  }
  static joinPath(base: FakeUri, ...segments: string[]): FakeUri {
    return new FakeUri(base.scheme, [base.path.replace(/\/$/, ''), ...segments].join('/'))
  }
}

export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 }

export const state = {
  folders: [] as Array<{ uri: FakeUri; name: string; index: number }>,
  directories: new Set<string>(),
  missing: new Set<string>(),
  activeTextEditor: undefined as any,
  messages: [] as string[],
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  executed: [] as string[],
  chatUrl: 'http://localhost:8081/projects/p1',
}

const folderOf = (uri: FakeUri) => state.folders.find((f) => uri.path === f.uri.path || uri.path.startsWith(`${f.uri.path}/`))

export function resetVscodeMock(): void {
  state.folders = [{ uri: FakeUri.file('/repo'), name: 'repo', index: 0 }]
  state.directories = new Set()
  state.missing = new Set()
  state.activeTextEditor = undefined
  state.messages = []
  state.commands = new Map()
  state.executed = []
  state.chatUrl = 'http://localhost:8081/projects/p1'
}
resetVscodeMock()

export const vscodeMock = {
  Uri: FakeUri,
  FileType,
  workspace: {
    get workspaceFolders() {
      return state.folders
    },
    isTrusted: true,
    getConfiguration: () => ({ get: (key: string) => (key === 'desktopChat.url' ? state.chatUrl : undefined) }),
    getWorkspaceFolder: (uri: FakeUri) => folderOf(uri),
    asRelativePath: (uri: FakeUri) => {
      const folder = folderOf(uri)
      return folder ? uri.path.slice(folder.uri.path.length + 1) : uri.path
    },
    fs: {
      stat: async (uri: FakeUri) => {
        if (state.missing.has(uri.path)) throw new Error('ENOENT')
        return { type: state.directories.has(uri.path) ? FileType.Directory : FileType.File }
      },
    },
  },
  window: {
    get activeTextEditor() {
      return state.activeTextEditor
    },
    showInformationMessage: async (message: string) => {
      state.messages.push(message)
      return undefined
    },
    showWarningMessage: async (message: string) => {
      state.messages.push(message)
      return undefined
    },
  },
  commands: {
    registerCommand: (id: string, callback: (...args: unknown[]) => unknown) => {
      state.commands.set(id, callback)
      return { dispose() {} }
    },
    executeCommand: async (id: string) => {
      state.executed.push(id)
      return undefined
    },
  },
  env: { openExternal: async () => true },
}

mock.module('vscode', () => vscodeMock)

/** A fake TextEditor over `lines` with the given 0-based selections. */
export function fakeEditor(
  path: string,
  lines: string[],
  selections: Array<[number, number, number, number]>,
  languageId = 'typescript',
) {
  const toSelection = ([sl, sc, el, ec]: [number, number, number, number]) => ({
    start: { line: sl, character: sc },
    end: { line: el, character: ec },
    isEmpty: sl === el && sc === ec,
  })
  const sels = selections.map(toSelection)
  return {
    document: {
      uri: FakeUri.file(path),
      fileName: path,
      languageId,
      getText(range?: { start: { line: number; character: number }; end: { line: number; character: number } }) {
        if (!range) return lines.join('\n')
        const { start, end } = range
        if (start.line === end.line) return lines[start.line].slice(start.character, end.character)
        const out = [lines[start.line].slice(start.character)]
        for (let l = start.line + 1; l < end.line; l++) out.push(lines[l])
        out.push((lines[end.line] ?? '').slice(0, end.character))
        return out.join('\n')
      },
    },
    selection: sels[0] ?? toSelection([0, 0, 0, 0]),
    selections: sels,
  }
}
