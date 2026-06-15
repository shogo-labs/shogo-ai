import { describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { zipSync, strToU8 } from 'fflate'
import { ExtensionInstallService } from '../install-service'

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shogo-ext-test-'))
}

function writeVsix(dir: string, name: string, files: Record<string, string>) {
  const bytes: Record<string, Uint8Array> = {}
  for (const [file, content] of Object.entries(files)) bytes[file] = strToU8(content)
  const out = path.join(dir, name)
  fs.writeFileSync(out, Buffer.from(zipSync(bytes)))
  return out
}

describe('ExtensionInstallService', () => {
  test('installs, lists, disables, enables, and uninstalls a command VSIX', () => {
    const root = makeTempDir()
    const service = new ExtensionInstallService(path.join(root, 'extensions'))
    const vsix = writeVsix(root, 'sample.vsix', {
      'extension/package.json': JSON.stringify({
        publisher: 'shogo',
        name: 'sample-command',
        version: '1.0.0',
        engines: { vscode: '^1.74.0' },
        main: './extension.js',
        activationEvents: ['onCommand:shogo.sample.hello'],
        contributes: { commands: [{ command: 'shogo.sample.hello', title: 'Hello from Sample', category: 'Sample' }] },
      }),
      'extension/extension.js': "exports.activate = function(vscode) {};",
    })

    const inspection = service.inspectVsix(vsix)
    expect(inspection.manifest.publisher).toBe('shogo')
    expect(service.isPublisherTrusted('shogo')).toBe(false)
    const trusted = service.trustPublisher('shogo')
    expect(trusted.publisherKey).toBe('shogo')
    expect(service.isPublisherTrusted('SHOGO')).toBe(true)
    expect(new ExtensionInstallService(path.join(root, 'extensions')).isPublisherTrusted('shogo')).toBe(true)

    const installed = service.installFromVsix(vsix)
    expect(installed.id).toBe('shogo.sample-command')
    expect(installed.restartRequired).toBe(true)
    expect(fs.existsSync(path.join(installed.installPath, 'extension.js'))).toBe(true)

    expect(service.listInstalled()[0]?.enabled).toBe(true)
    expect(service.listInstalled()[0]?.trustedPublisher).toBe(true)
    expect(service.listInstalled()[0]?.supportStatus).toBe('supported')
    expect(service.listInstalled()[0]?.capabilityKinds).toContain('commands')

    const workspaceRoot = path.join(root, 'workspace')
    fs.mkdirSync(workspaceRoot, { recursive: true })
    expect(service.getWorkspaceTrust(workspaceRoot).restrictedMode).toBe(true)
    expect(service.listInstalled(workspaceRoot)[0]?.enabled).toBe(false)
    expect(service.listInstalled(workspaceRoot)[0]?.disabledByRestrictedMode).toBe(true)
    const trustedWorkspace = service.trustWorkspace(workspaceRoot)
    expect(trustedWorkspace.trusted).toBe(true)
    expect(new ExtensionInstallService(path.join(root, 'extensions')).getWorkspaceTrust(workspaceRoot).trusted).toBe(true)
    expect(service.listInstalled(workspaceRoot)[0]?.enabled).toBe(true)

    service.setEnabled(installed.id, false, 'global')
    expect(service.listInstalled()[0]?.enabled).toBe(false)
    service.setEnabled(installed.id, true, 'global')
    expect(service.listInstalled()[0]?.enabled).toBe(true)

    service.uninstall(installed.id)
    expect(service.listInstalled()).toHaveLength(0)
    expect(fs.existsSync(installed.installPath)).toBe(false)
  })

  test('reports unsupported installed extensions when no reachable entry point exists', () => {
    const root = makeTempDir()
    const service = new ExtensionInstallService(path.join(root, 'extensions'))
    const vsix = writeVsix(root, 'theme-only.vsix', {
      'extension/package.json': JSON.stringify({
        publisher: 'shogo',
        name: 'theme-only',
        version: '1.0.0',
        engines: { vscode: '^1.74.0' },
        contributes: { themes: [{ label: 'Theme', uiTheme: 'vs-dark', path: './theme.json' }] },
      }),
      'extension/theme.json': '{}',
    })

    service.installFromVsix(vsix)
    const listed = service.listInstalled()[0]
    expect(listed?.hasUsableEntryPoint).toBe(false)
    expect(listed?.usableEntryPoints).toEqual([])
    expect(listed?.supportStatus).toBe('requiresRuntime')
    expect(listed?.capabilityKinds).toContain('declarative')
    expect(listed?.supportStatusMessage).toContain('Declarative contribution installed')
    expect(listed?.unsupportedSurfaceMessage).toContain('does not load themes')
  })

  test('does not count empty view containers as usable entry points', () => {
    const root = makeTempDir()
    const service = new ExtensionInstallService(path.join(root, 'extensions'))
    const vsix = writeVsix(root, 'empty-container.vsix', {
      'extension/package.json': JSON.stringify({
        publisher: 'shogo',
        name: 'empty-container',
        version: '1.0.0',
        engines: { vscode: '^1.74.0' },
        contributes: { viewsContainers: { panel: [{ id: 'shogo.empty', title: 'Empty' }] } },
      }),
    })

    service.installFromVsix(vsix)
    const listed = service.listInstalled()[0]
    expect(listed?.hasUsableEntryPoint).toBe(false)
    expect(listed?.unsupportedSurfaceMessage).toContain('no reachable views')
  })

  test('reports panel views as usable entry points', () => {
    const root = makeTempDir()
    const service = new ExtensionInstallService(path.join(root, 'extensions'))
    const vsix = writeVsix(root, 'panel-view.vsix', {
      'extension/package.json': JSON.stringify({
        publisher: 'shogo',
        name: 'panel-view',
        version: '1.0.0',
        engines: { vscode: '^1.74.0' },
        main: './extension.js',
        contributes: {
          viewsContainers: { panel: [{ id: 'shogo.panel', title: 'Panel' }] },
          views: { 'shogo.panel': [{ id: 'shogo.panel.view', name: 'Panel View' }] },
        },
      }),
      'extension/extension.js': "exports.activate = function() {};",
    })

    service.installFromVsix(vsix)
    const listed = service.listInstalled()[0]
    expect(listed?.hasUsableEntryPoint).toBe(true)
    expect(listed?.usableEntryPoints.some((entry) => entry.kind === 'view' && entry.id === 'shogo.panel.view')).toBe(true)
    expect(listed?.supportStatus).toBe('partial')
    expect(listed?.capabilityKinds).toContain('views')
    expect(listed?.unsupportedSurfaceMessage).toBeUndefined()
  })

  test('classifies known formatter, linter, and SCM extensions with honest runtime status', () => {
    const root = makeTempDir()
    const service = new ExtensionInstallService(path.join(root, 'extensions'))
    const prettier = writeVsix(root, 'prettier.vsix', {
      'extension/package.json': JSON.stringify({
        publisher: 'esbenp',
        name: 'prettier-vscode',
        version: '1.0.0',
        engines: { vscode: '^1.74.0' },
        main: './dist/extension.js',
        browser: './dist/web-extension.cjs',
        activationEvents: ['onStartupFinished'],
        contributes: { commands: [{ command: 'prettier.forceFormatDocument', title: 'Format Document' }] },
      }),
      'extension/dist/extension.js': "exports.activate = function() {};",
      'extension/dist/web-extension.cjs': "exports.activate = function() {};",
    })
    const eslint = writeVsix(root, 'eslint.vsix', {
      'extension/package.json': JSON.stringify({
        publisher: 'dbaeumer',
        name: 'vscode-eslint',
        version: '1.0.0',
        engines: { vscode: '^1.74.0' },
        main: './client/out/extension.js',
        activationEvents: ['onStartupFinished'],
        contributes: { taskDefinitions: [{ type: 'eslint' }], commands: [{ command: 'eslint.executeAutofix', title: 'Fix all auto-fixable Problems' }] },
      }),
      'extension/client/out/extension.js': "exports.activate = function() {};",
    })
    const gitGraph = writeVsix(root, 'gitgraph.vsix', {
      'extension/package.json': JSON.stringify({
        publisher: 'mhutchie',
        name: 'git-graph',
        version: '1.0.0',
        engines: { vscode: '^1.74.0' },
        main: './out/extension.js',
        activationEvents: ['*'],
        contributes: {
          commands: [{ command: 'git-graph.view', title: 'View Git Graph', category: 'Git Graph' }],
          menus: { 'scm/title': [{ command: 'git-graph.view' }] },
        },
      }),
      'extension/out/extension.js': "exports.activate = function() {};",
    })

    service.installFromVsix(prettier)
    service.installFromVsix(eslint)
    service.installFromVsix(gitGraph)
    const byId = new Map(service.listInstalled().map((extension) => [extension.id, extension]))

    expect(byId.get('esbenp.prettier-vscode')?.supportStatus).toBe('requiresRuntime')
    expect(byId.get('esbenp.prettier-vscode')?.supportStatusMessage).toContain('formatter provider')
    expect(byId.get('esbenp.prettier-vscode')?.capabilityKinds).toContain('formatter')
    expect(byId.get('dbaeumer.vscode-eslint')?.supportStatus).toBe('requiresRuntime')
    expect(byId.get('dbaeumer.vscode-eslint')?.supportStatusMessage).toContain('LSP/diagnostics')
    expect(byId.get('dbaeumer.vscode-eslint')?.capabilityKinds).toContain('linter')
    expect(byId.get('mhutchie.git-graph')?.supportStatus).toBe('partial')
    expect(byId.get('mhutchie.git-graph')?.supportStatusMessage).toContain('webview + Git/SCM')
    expect(byId.get('mhutchie.git-graph')?.capabilityKinds).toContain('scm')
  })

  test('allows extensions that opt into untrusted workspaces in Restricted Mode', () => {
    const root = makeTempDir()
    const service = new ExtensionInstallService(path.join(root, 'extensions'))
    const workspaceRoot = path.join(root, 'workspace')
    fs.mkdirSync(workspaceRoot, { recursive: true })
    const vsix = writeVsix(root, 'restricted-safe.vsix', {
      'extension/package.json': JSON.stringify({
        publisher: 'shogo',
        name: 'restricted-safe',
        version: '1.0.0',
        engines: { vscode: '^1.74.0' },
        main: './extension.js',
        activationEvents: ['onCommand:shogo.safe.hello'],
        capabilities: { untrustedWorkspaces: { supported: 'limited', description: 'Read-only mode' } },
        contributes: { commands: [{ command: 'shogo.safe.hello', title: 'Hello in Restricted Mode' }] },
      }),
      'extension/extension.js': "exports.activate = function(vscode) {};",
    })

    service.installFromVsix(vsix)
    const listed = service.listInstalled(workspaceRoot)[0]
    expect(listed?.enabled).toBe(true)
    expect(listed?.restrictedMode).toBe(true)
    expect(listed?.restrictedModeSupport).toBe('limited')
    expect(listed?.disabledByRestrictedMode).toBe(false)
  })

  test('rejects a traversal VSIX entry', () => {
    const root = makeTempDir()
    const service = new ExtensionInstallService(path.join(root, 'extensions'))
    const vsix = writeVsix(root, 'bad.vsix', {
      'extension/package.json': JSON.stringify({
        publisher: 'shogo',
        name: 'bad',
        version: '1.0.0',
        engines: { vscode: '^1.74.0' },
      }),
      'extension/../escape.txt': 'nope',
    })

    expect(() => service.installFromVsix(vsix)).toThrow('Unsafe')
  })
})
