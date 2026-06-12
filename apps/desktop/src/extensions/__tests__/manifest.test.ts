import { describe, expect, test } from 'bun:test'
import { parseExtensionManifestJson, validateRelativePath } from '../manifest'

describe('extension manifest parser', () => {
  test('parses JSONC manifests and normalizes id', () => {
    const result = parseExtensionManifestJson(`{
      // comment
      "publisher": "Acme",
      "name": "hello-world",
      "version": "1.2.3",
      "engines": { "vscode": "^1.74.0" },
      "activationEvents": ["onCommand:acme.hello"],
      "contributes": {
        "commands": [{ "command": "acme.hello", "title": "Hello" }],
      },
    }`)

    expect(result.manifest.id).toBe('acme.hello-world')
    expect(result.compatible).toBe(true)
    expect(result.manifest.contributes?.commands?.[0]?.command).toBe('acme.hello')
  })

  test('rejects path traversal', () => {
    expect(() => validateRelativePath('../escape.js')).toThrow('escape')
    expect(() => parseExtensionManifestJson(JSON.stringify({
      publisher: 'Acme',
      name: 'bad',
      version: '1.0.0',
      engines: { vscode: '^1.70.0' },
      main: '../bad.js',
    }))).toThrow('escape')
  })

  test('marks too-new VS Code engines as incompatible', () => {
    const result = parseExtensionManifestJson(JSON.stringify({
      publisher: 'Acme',
      name: 'future',
      version: '1.0.0',
      engines: { vscode: '^1.90.0' },
    }))
    expect(result.compatible).toBe(false)
  })
})
