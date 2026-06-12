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

    const installed = service.installFromVsix(vsix)
    expect(installed.id).toBe('shogo.sample-command')
    expect(installed.restartRequired).toBe(true)
    expect(fs.existsSync(path.join(installed.installPath, 'extension.js'))).toBe(true)

    expect(service.listInstalled()[0]?.enabled).toBe(true)
    service.setEnabled(installed.id, false, 'global')
    expect(service.listInstalled()[0]?.enabled).toBe(false)
    service.setEnabled(installed.id, true, 'global')
    expect(service.listInstalled()[0]?.enabled).toBe(true)

    service.uninstall(installed.id)
    expect(service.listInstalled()).toHaveLength(0)
    expect(fs.existsSync(installed.installPath)).toBe(false)
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
