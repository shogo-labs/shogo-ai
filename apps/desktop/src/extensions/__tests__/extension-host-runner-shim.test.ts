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
})
