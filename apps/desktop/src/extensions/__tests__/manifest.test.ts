import { describe, expect, test } from 'bun:test'
import { SHOGO_VSCODE_COMPATIBILITY, parseExtensionManifestJson, validateRelativePath } from '../manifest'

describe('extension manifest parser', () => {
  test('parses JSONC manifests and normalizes id', () => {
    const result = parseExtensionManifestJson(`{
      // comment
      "publisher": "Acme",
      "name": "hello-world",
      "version": "1.2.3",
      "engines": { "vscode": "^1.80.0" },
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

  test('accepts extensions targeting the current Shogo VS Code API subset', () => {
    const result = parseExtensionManifestJson(JSON.stringify({
      publisher: 'Acme',
      name: 'current',
      version: '1.0.0',
      engines: { vscode: `^${SHOGO_VSCODE_COMPATIBILITY}` },
    }))
    expect(result.compatible).toBe(true)
  })

  test('marks too-new VS Code engines as incompatible', () => {
    const result = parseExtensionManifestJson(JSON.stringify({
      publisher: 'Acme',
      name: 'future',
      version: '1.0.0',
      engines: { vscode: '^1.81.0' },
    }))
    expect(result.compatible).toBe(false)
    expect(result.compatibilityReason).toContain(SHOGO_VSCODE_COMPATIBILITY)
  })
})
