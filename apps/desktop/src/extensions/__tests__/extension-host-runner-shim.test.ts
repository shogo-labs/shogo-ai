// @ts-nocheck
import { describe, expect, test } from 'bun:test'
import fs from 'fs'
import path from 'path'

const runnerSource = path.resolve(import.meta.dir, '..', 'extension-host-runner.ts')

describe('extension host vscode API shim', () => {
  test('provides ViewColumn.Active for common webview extensions', () => {
    const source = fs.readFileSync(runnerSource, 'utf8')

    expect(source).toContain('ViewColumn:')
    expect(source).toContain('Active: -1')
    expect(source).toContain('Beside: -2')
  })

  test('provides workspace.createFileSystemWatcher for repository extensions', () => {
    const source = fs.readFileSync(runnerSource, 'utf8')

    expect(source).toContain('createFileSystemWatcher')
    expect(source).toContain('onDidCreate')
    expect(source).toContain('onDidChange')
    expect(source).toContain('onDidDelete')
  })

  test('provides workspace lifecycle events for repository extensions', () => {
    const source = fs.readFileSync(runnerSource, 'utf8')

    expect(source).toContain('onDidChangeWorkspaceFolders')
    expect(source).toContain('onDidChangeConfiguration')
    expect(source).toContain('onDidSaveTextDocument')
  })

  test('provides Git Graph-facing URI and text content provider APIs', () => {
    const source = fs.readFileSync(runnerSource, 'utf8')

    expect(source).toContain('registerTextDocumentContentProvider')
    expect(source).toContain('textDocumentContentProviders')
    expect(source).toContain('parse: (value: string) => uriFromString(value)')
    expect(source).toContain('joinPath: (base: unknown, ...segments: string[]) => joinUriPath(base, ...segments)')
  })

  test('provides command-extension startup APIs used by marketplace extensions', () => {
    const source = fs.readFileSync(runnerSource, 'utf8')

    expect(source).toContain('registerTextEditorCommand')
    expect(source).toContain("commandId === 'setContext'")
    expect(source).toContain('EventEmitter: class EventEmitter')
    expect(source).toContain('extensionUri: uriFromFsPath(extension.installPath)')
  })

})
