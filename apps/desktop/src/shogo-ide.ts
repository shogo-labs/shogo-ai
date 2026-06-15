// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { app, ipcMain, shell } from 'electron'
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

export interface ShogoIdeStatus {
  ok: true
  phase: 6
  workspacePath: string
  productTemplatePath: string
  extensionManifestPath: string
  generatedProductPath: string
  hardeningReportPath: string
  productTemplateExists: boolean
  extensionManifestExists: boolean
  generatedProductExists: boolean
  hardeningReportExists: boolean
  codeOssCheckoutPath: string
  codeOssCheckoutExists: boolean
  executablePath: string | null
  executableExists: boolean
  executableExecutable: boolean
  launchReady: boolean
  reason: string
  diagnostics: string[]
  cloneCommand: string
}

export interface ShogoIdeLaunchResult {
  ok: boolean
  status: ShogoIdeStatus
  error?: string
}

const DEFAULT_EXECUTABLE_NAMES = process.platform === 'darwin'
  ? [
      'Shogo IDE.app/Contents/MacOS/Shogo IDE',
      'Code - OSS.app/Contents/MacOS/Electron',
      'Visual Studio Code - Insiders.app/Contents/MacOS/Electron',
    ]
  : process.platform === 'win32'
    ? ['Shogo IDE.exe', 'Code - OSS.exe']
    : ['shogo-ide', 'code-oss']

function resolveRepoRoot(): string {
  if (process.env.SHOGO_REPO_ROOT) return path.resolve(process.env.SHOGO_REPO_ROOT)
  if (process.env.SHOGO_IDE_REPO_ROOT) return path.resolve(process.env.SHOGO_IDE_REPO_ROOT)
  return path.resolve(app.getAppPath(), '..', '..')
}

function firstExistingPath(paths: string[]): string | null {
  for (const candidate of paths) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return null
}

function isExecutableFile(filePath: string | null): boolean {
  if (!filePath || !fs.existsSync(filePath)) return false
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return false
    if (process.platform === 'win32') return true
    fs.accessSync(filePath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function writeLaunchDiagnostic(status: ShogoIdeStatus, result: { ok: boolean; error?: string }): void {
  try {
    const diagnosticsDir = path.join(status.workspacePath, 'hardening', 'generated')
    fs.mkdirSync(diagnosticsDir, { recursive: true })
    const diagnosticPath = path.join(diagnosticsDir, 'last-launch.json')
    fs.writeFileSync(diagnosticPath, `${JSON.stringify({
      at: new Date().toISOString(),
      ok: result.ok,
      error: result.error ?? null,
      executablePath: status.executablePath,
      workspacePath: status.workspacePath,
      launchReady: status.launchReady,
      diagnostics: status.diagnostics,
    }, null, 2)}\n`)
  } catch {
    // Diagnostics are best-effort and must never block launch/fallback UX.
  }
}

function resolveExecutablePath(workspacePath: string): string | null {
  if (process.env.SHOGO_IDE_EXECUTABLE) return path.resolve(process.env.SHOGO_IDE_EXECUTABLE)

  const candidates = DEFAULT_EXECUTABLE_NAMES.flatMap((name) => [
    path.join(workspacePath, 'upstream', 'vscode', '.build', 'electron', name),
    path.join(workspacePath, 'upstream', 'vscode', 'VSCode-darwin-arm64', name),
    path.join(workspacePath, 'upstream', 'vscode', 'VSCode-darwin-x64', name),
    path.join(workspacePath, 'dist', name),
  ])

  return firstExistingPath(candidates)
}

export function getShogoIdeStatus(): ShogoIdeStatus {
  const repoRoot = resolveRepoRoot()
  const workspacePath = path.join(repoRoot, 'apps', 'shogo-ide')
  const productTemplatePath = path.join(workspacePath, 'product.shogo.template.json')
  const extensionManifestPath = path.join(workspacePath, 'extensions', 'shogo-core', 'package.json')
  const generatedProductPath = path.join(workspacePath, 'distribution', 'generated', 'product.json')
  const hardeningReportPath = path.join(workspacePath, 'hardening', 'generated', 'production-readiness.json')
  const codeOssCheckoutPath = path.join(workspacePath, 'upstream', 'vscode')
  const executablePath = resolveExecutablePath(workspacePath)
  const productTemplateExists = fs.existsSync(productTemplatePath)
  const extensionManifestExists = fs.existsSync(extensionManifestPath)
  const generatedProductExists = fs.existsSync(generatedProductPath)
  const hardeningReportExists = fs.existsSync(hardeningReportPath)
  const codeOssCheckoutExists = fs.existsSync(codeOssCheckoutPath)
  const executableExists = !!executablePath && fs.existsSync(executablePath)
  const executableExecutable = isExecutableFile(executablePath)
  const launchReady = productTemplateExists && extensionManifestExists && generatedProductExists && hardeningReportExists && executableExists && executableExecutable
  const diagnostics: string[] = []

  if (!productTemplateExists) diagnostics.push('Missing Shogo product template.')
  if (!extensionManifestExists) diagnostics.push('Missing shogo-core extension manifest.')
  if (!generatedProductExists) diagnostics.push('Missing generated Code OSS product metadata. Run bun run shogo-ide:distribution:materialize.')
  if (!hardeningReportExists) diagnostics.push('Missing production-readiness report. Run bun run shogo-ide:hardening:report.')
  if (!codeOssCheckoutExists) diagnostics.push('Code - OSS checkout is not present at apps/shogo-ide/upstream/vscode.')
  if (!executableExists) diagnostics.push('No launchable Shogo IDE executable was found.')
  if (executableExists && !executableExecutable) diagnostics.push('Detected Shogo IDE executable is not executable by the current user.')

  const reason = launchReady
    ? 'Shogo IDE is ready to launch.'
    : diagnostics[0] ?? 'Shogo IDE is not ready to launch yet.'

  return {
    ok: true,
    phase: 6,
    workspacePath,
    productTemplatePath,
    extensionManifestPath,
    generatedProductPath,
    hardeningReportPath,
    productTemplateExists,
    extensionManifestExists,
    generatedProductExists,
    hardeningReportExists,
    codeOssCheckoutPath,
    codeOssCheckoutExists,
    executablePath,
    executableExists,
    executableExecutable,
    launchReady,
    reason,
    diagnostics,
    cloneCommand: `git clone --depth 1 https://github.com/microsoft/vscode.git ${codeOssCheckoutPath}`,
  }
}

export async function launchShogoIde(opts?: { workspacePath?: string }): Promise<ShogoIdeLaunchResult> {
  const status = getShogoIdeStatus()
  if (!status.launchReady || !status.executablePath) {
    const result = { ok: false, status, error: status.reason }
    writeLaunchDiagnostic(status, { ok: false, error: status.reason })
    return result
  }

  const workspaceArg = opts?.workspacePath && path.isAbsolute(opts.workspacePath)
    ? opts.workspacePath
    : resolveRepoRoot()

  try {
    const child = spawn(status.executablePath, [workspaceArg], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        SHOGO_IDE_PHASE: '2',
        SHOGO_IDE_WORKSPACE: status.workspacePath,
      },
    })
    child.unref()
    writeLaunchDiagnostic(status, { ok: true })
    return { ok: true, status }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    writeLaunchDiagnostic(status, { ok: false, error: errorMessage })
    return {
      ok: false,
      status,
      error: errorMessage,
    }
  }
}

export function registerShogoIdeIpcHandlers(): void {
  ipcMain.handle('shogo-ide:get-status', () => getShogoIdeStatus())
  ipcMain.handle('shogo-ide:launch', (_event, opts?: { workspacePath?: string }) => launchShogoIde(opts))
  ipcMain.handle('shogo-ide:open-workspace-folder', async () => {
    const status = getShogoIdeStatus()
    const error = await shell.openPath(status.workspacePath)
    return error ? { ok: false, status, error } : { ok: true, status }
  })
}
