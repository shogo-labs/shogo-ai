// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { app, ipcMain, shell } from 'electron'
import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
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
  devRunnerPath: string | null
  devRunnerExists: boolean
  devRunnerExecutable: boolean
  launchPath: string | null
  launchMode: 'packaged' | 'source-runner' | null
  launchReady: boolean
  reason: string
  diagnostics: string[]
  setupInProgress: boolean
  setupLogPath: string
  autoSetupAvailable: boolean
  cloneCommand: string
}

export interface ShogoIdeLaunchResult {
  ok: boolean
  status: ShogoIdeStatus
  error?: string
}

const DEFAULT_EXECUTABLE_NAMES = process.platform === 'darwin'
  ? ['Shogo IDE.app/Contents/MacOS/Shogo IDE']
  : process.platform === 'win32'
    ? ['Shogo IDE.exe']
    : ['shogo-ide']

const CODE_OSS_NODE_VERSION = '24.15.0'

let setupPromise: Promise<void> | null = null

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

function resolveSetupLogPath(workspacePath: string): string {
  return path.join(workspacePath, 'hardening', 'generated', 'auto-setup.log')
}

function appendSetupLog(workspacePath: string, message: string): void {
  const logPath = resolveSetupLogPath(workspacePath)
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`)
}

function runSetupCommand(workspacePath: string, command: string, args: string[], cwd: string): Promise<void> {
  appendSetupLog(workspacePath, `$ ${[command, ...args].join(' ')}`)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk) => appendSetupLog(workspacePath, String(chunk).trimEnd()))
    child.stderr.on('data', (chunk) => appendSetupLog(workspacePath, String(chunk).trimEnd()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'unknown'}`))
      }
    })
  })
}

function isNpmCliPath(candidate: string | undefined): candidate is string {
  return !!candidate && path.basename(candidate) === 'npm-cli.js' && fs.existsSync(candidate)
}

function resolveNpmCliPath(): string | null {
  const globalNpmRoot = spawnSync('npm', ['root', '-g'], {
    encoding: 'utf8',
    timeout: 5_000,
  })

  const candidates = [
    process.env.SHOGO_CODE_OSS_NPM_CLI,
    process.env.npm_execpath,
    globalNpmRoot.status === 0 ? path.join(globalNpmRoot.stdout.trim(), 'npm', 'bin', 'npm-cli.js') : undefined,
    '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
  ].filter(isNpmCliPath)

  return firstExistingPath(candidates)
}

function resolveCachedNode24BinDir(): string | null {
  const npxRoot = path.join(os.homedir(), '.npm', '_npx')
  if (!fs.existsSync(npxRoot)) return null

  const candidates = fs.readdirSync(npxRoot)
    .map((entry) => path.join(npxRoot, entry, 'node_modules', 'node', 'bin', 'node'))
    .filter((candidate) => fs.existsSync(candidate))

  for (const candidate of candidates) {
    try {
      const packagePath = path.join(path.dirname(candidate), '..', 'package.json')
      const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: string }
      if (packageJson.version?.startsWith(`${CODE_OSS_NODE_VERSION}.`) || packageJson.version === CODE_OSS_NODE_VERSION) {
        return path.dirname(candidate)
      }
    } catch {
      // Ignore partial npx cache entries.
    }
  }

  return null
}

function resolveCodeOssInstallCommand(): { command: string; args: string[] } {
  const currentMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10)
  if (currentMajor === 24) return { command: 'npm', args: ['install'] }

  const npmCliPath = resolveNpmCliPath()
  if (npmCliPath && process.platform !== 'win32') {
    return {
      command: 'npx',
      args: ['-y', '-p', `node@${CODE_OSS_NODE_VERSION}`, 'node', npmCliPath, 'install'],
    }
  }

  return { command: 'npm', args: ['install'] }
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

function writeLaunchDiagnostic(status: ShogoIdeStatus, result: { ok: boolean; error?: string; actualLaunchPath?: string; launchArgs?: string[] }): void {
  try {
    const diagnosticsDir = path.join(status.workspacePath, 'hardening', 'runtime', 'diagnostics')
    fs.mkdirSync(diagnosticsDir, { recursive: true })
    const diagnosticPath = path.join(diagnosticsDir, 'last-launch.json')
    fs.writeFileSync(diagnosticPath, `${JSON.stringify({
      at: new Date().toISOString(),
      ok: result.ok,
      error: result.error ?? null,
      executablePath: status.executablePath,
      launchPath: status.launchPath,
      actualLaunchPath: result.actualLaunchPath ?? status.launchPath,
      launchArgs: result.launchArgs ?? null,
      launchMode: status.launchMode,
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

function resolveDevRunnerPath(workspacePath: string): string | null {
  const codeOssCheckoutPath = path.join(workspacePath, 'upstream', 'vscode')
  const scriptName = process.platform === 'win32' ? 'code.bat' : 'code.sh'
  return path.join(codeOssCheckoutPath, 'scripts', scriptName)
}

function resolveCodeOssDevExecutablePath(codeOssCheckoutPath: string): string | null {
  if (process.platform === 'darwin') {
    return path.join(codeOssCheckoutPath, '.build', 'electron', 'Code - OSS.app', 'Contents', 'MacOS', 'Code - OSS')
  }
  if (process.platform === 'win32') {
    return path.join(codeOssCheckoutPath, '.build', 'electron', 'Code - OSS.exe')
  }
  return path.join(codeOssCheckoutPath, '.build', 'electron', 'code-oss')
}

function isCodeOssElectronRuntimeHealthy(codeOssCheckoutPath: string): boolean {
  const executablePath = resolveCodeOssDevExecutablePath(codeOssCheckoutPath)
  if (!isExecutableFile(executablePath)) return false

  const probe = spawnSync(executablePath!, ['-e', "console.log('ok')"], {
    cwd: codeOssCheckoutPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 10_000,
  })

  return probe.status === 0 && probe.stdout.includes('ok')
}

function resolveCodeOssScriptCommand(script: 'electron' | 'compile'): { command: string; args: string[] } {
  const currentMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10)
  if (currentMajor === 24) return { command: 'npm', args: ['run', script] }

  const npmCliPath = resolveNpmCliPath()
  if (npmCliPath && process.platform !== 'win32') {
    return {
      command: 'npx',
      args: ['-y', '-p', `node@${CODE_OSS_NODE_VERSION}`, 'node', npmCliPath, 'run', script],
    }
  }

  return { command: 'npm', args: ['run', script] }
}

function ensureShogoIdeRuntimeProfile(workspacePath: string): {
  userDataDir: string
  extensionsDir: string
  agentsUserDataDir: string
  agentsExtensionsDir: string
  crashReporterDirectory: string
} {
  const runtimeDir = path.join(workspacePath, 'hardening', 'runtime')
  const userDataDir = path.join(runtimeDir, 'user-data')
  const extensionsDir = path.join(runtimeDir, 'extensions')
  const agentsUserDataDir = path.join(runtimeDir, 'agents-user-data')
  const agentsExtensionsDir = path.join(runtimeDir, 'agents-extensions')
  const crashReporterDirectory = path.join(runtimeDir, 'crash-reports')

  for (const dir of [userDataDir, extensionsDir, agentsUserDataDir, agentsExtensionsDir, crashReporterDirectory]) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const settingsDir = path.join(userDataDir, 'User')
  fs.mkdirSync(settingsDir, { recursive: true })
  const settingsPath = path.join(settingsDir, 'settings.json')
  const settings = {
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoCheckUpdates': false,
    'extensions.autoUpdate': false,
    'workbench.startupEditor': 'none',
    'security.workspace.trust.enabled': false,
    'github.copilot.enable': { '*': false },
    'github.copilot.chat.enabled': false,
    'chat.agent.enabled': false,
    'chat.mcp.enabled': false,
    'chat.mcp.discovery.enabled': false,
    'chat.mcp.gallery.enabled': false,
  }
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)

  return { userDataDir, extensionsDir, agentsUserDataDir, agentsExtensionsDir, crashReporterDirectory }
}

function resolveSourceRunnerLaunch(status: ShogoIdeStatus, workspaceArg: string): { launchPath: string; args: string[] } {
  const runtime = ensureShogoIdeRuntimeProfile(status.workspacePath)
  const executablePath = resolveCodeOssDevExecutablePath(status.codeOssCheckoutPath)
  const launchPath = isExecutableFile(executablePath) ? executablePath! : status.launchPath!

  return {
    launchPath,
    args: [
      '.',
      '--new-window',
      '--skip-welcome',
      '--disable-telemetry',
      '--disable-crash-reporter',
      '--disable-workspace-trust',
      '--disable-gpu',
      '--disable-gpu-sandbox',
      '--disable-extensions',
      '--user-data-dir', runtime.userDataDir,
      '--extensions-dir', runtime.extensionsDir,
      '--agents-user-data-dir', runtime.agentsUserDataDir,
      '--agents-extensions-dir', runtime.agentsExtensionsDir,
      '--crash-reporter-directory', runtime.crashReporterDirectory,
      '--disable-extension=GitHub.copilot',
      '--disable-extension=GitHub.copilot-chat',
      '--disable-extension=vscode.github',
      '--disable-extension=vscode.github-authentication',
      '--disable-extension=vscode.microsoft-authentication',
      workspaceArg,
    ],
  }
}

async function ensureShogoIdeSetup(status: ShogoIdeStatus): Promise<void> {
  if (setupPromise) return setupPromise

  setupPromise = (async () => {
    appendSetupLog(status.workspacePath, 'Starting automatic Shogo IDE setup.')
    fs.mkdirSync(path.dirname(status.codeOssCheckoutPath), { recursive: true })

    if (!fs.existsSync(status.codeOssCheckoutPath)) {
      await runSetupCommand(status.workspacePath, 'git', [
        'clone',
        '--depth',
        '1',
        'https://github.com/microsoft/vscode.git',
        status.codeOssCheckoutPath,
      ], resolveRepoRoot())
    }

    if (!fs.existsSync(status.generatedProductPath)) {
      await runSetupCommand(status.workspacePath, 'bun', ['run', 'distribution:materialize'], status.workspacePath)
    }

    if (!fs.existsSync(status.hardeningReportPath)) {
      await runSetupCommand(status.workspacePath, 'bun', ['run', 'hardening:report'], status.workspacePath)
    }

    const nodeModulesPath = path.join(status.codeOssCheckoutPath, 'node_modules')
    if (fs.existsSync(status.codeOssCheckoutPath) && !fs.existsSync(nodeModulesPath)) {
      const installCommand = resolveCodeOssInstallCommand()
      await runSetupCommand(status.workspacePath, installCommand.command, installCommand.args, status.codeOssCheckoutPath)
    }

    if (fs.existsSync(status.codeOssCheckoutPath) && !isCodeOssElectronRuntimeHealthy(status.codeOssCheckoutPath)) {
      appendSetupLog(status.workspacePath, 'Code OSS Electron runtime is missing or unhealthy; repairing it.')
      const electronCommand = resolveCodeOssScriptCommand('electron')
      await runSetupCommand(status.workspacePath, electronCommand.command, electronCommand.args, status.codeOssCheckoutPath)
    }

    appendSetupLog(status.workspacePath, 'Automatic Shogo IDE setup finished.')
  })().finally(() => {
    setupPromise = null
  })

  return setupPromise
}

export function getShogoIdeStatus(): ShogoIdeStatus {
  const repoRoot = resolveRepoRoot()
  const workspacePath = path.join(repoRoot, 'apps', 'shogo-ide')
  const productTemplatePath = path.join(workspacePath, 'product.shogo.template.json')
  const extensionManifestPath = path.join(workspacePath, 'extensions', 'shogo-core', 'package.json')
  const generatedProductPath = path.join(workspacePath, 'distribution', 'generated', 'product.json')
  const hardeningReportPath = path.join(workspacePath, 'hardening', 'generated', 'production-readiness.json')
  const codeOssCheckoutPath = path.join(workspacePath, 'upstream', 'vscode')
  const setupLogPath = resolveSetupLogPath(workspacePath)
  const executablePath = resolveExecutablePath(workspacePath)
  const devRunnerPath = resolveDevRunnerPath(workspacePath)
  const productTemplateExists = fs.existsSync(productTemplatePath)
  const extensionManifestExists = fs.existsSync(extensionManifestPath)
  const generatedProductExists = fs.existsSync(generatedProductPath)
  const hardeningReportExists = fs.existsSync(hardeningReportPath)
  const codeOssCheckoutExists = fs.existsSync(codeOssCheckoutPath)
  const executableExists = !!executablePath && fs.existsSync(executablePath)
  const executableExecutable = isExecutableFile(executablePath)
  const devRunnerExists = !!devRunnerPath && fs.existsSync(devRunnerPath)
  const devRunnerExecutable = isExecutableFile(devRunnerPath)
  const launchPath = executableExecutable ? executablePath : devRunnerExecutable ? devRunnerPath : null
  const launchMode = executableExecutable ? 'packaged' : devRunnerExecutable ? 'source-runner' : null
  const setupInProgress = !!setupPromise
  const autoSetupAvailable = true
  const launchReady = productTemplateExists && extensionManifestExists && generatedProductExists && hardeningReportExists && !!launchPath
  const diagnostics: string[] = []

  if (!productTemplateExists) diagnostics.push('Missing Shogo product template.')
  if (!extensionManifestExists) diagnostics.push('Missing shogo-core extension manifest.')
  if (!generatedProductExists) diagnostics.push('Missing generated Code OSS product metadata; Shogo Desktop will materialize it automatically.')
  if (!hardeningReportExists) diagnostics.push('Missing production-readiness report; Shogo Desktop will generate it automatically.')
  if (!codeOssCheckoutExists) diagnostics.push('Code - OSS checkout is not present; Shogo Desktop will clone it automatically.')
  if (!executableExists && devRunnerExecutable) diagnostics.push('Using Code OSS source runner until a packaged Shogo IDE executable is available.')
  if (!launchPath) diagnostics.push('No launchable Shogo IDE target was found. Shogo Desktop will prepare the Code OSS source runner automatically.')
  if (executableExists && !executableExecutable) diagnostics.push('Detected Shogo IDE executable is not executable by the current user.')
  if (devRunnerExists && !devRunnerExecutable) diagnostics.push('Detected Code OSS source runner is not executable by the current user.')

  const reason = launchReady
    ? 'Shogo IDE is ready to launch.'
    : setupInProgress
      ? 'Shogo IDE setup is running automatically.'
      : diagnostics[0] ?? 'Shogo IDE is preparing automatically.'

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
    devRunnerPath,
    devRunnerExists,
    devRunnerExecutable,
    launchPath,
    launchMode,
    launchReady,
    reason,
    diagnostics,
    setupInProgress,
    setupLogPath,
    autoSetupAvailable,
    cloneCommand: `git clone --depth 1 https://github.com/microsoft/vscode.git ${codeOssCheckoutPath}`,
  }
}

export async function launchShogoIde(opts?: { workspacePath?: string }): Promise<ShogoIdeLaunchResult> {
  let status = getShogoIdeStatus()
  const nodeModulesPath = path.join(status.codeOssCheckoutPath, 'node_modules')
  const electronRuntimeHealthy = status.codeOssCheckoutExists ? isCodeOssElectronRuntimeHealthy(status.codeOssCheckoutPath) : false
  const needsSourceSetup = !status.codeOssCheckoutExists || !status.generatedProductExists || !status.hardeningReportExists || !status.launchPath || !fs.existsSync(nodeModulesPath) || !electronRuntimeHealthy

  if (needsSourceSetup) {
    try {
      await ensureShogoIdeSetup(status)
      status = getShogoIdeStatus()
    } catch (error) {
      status = getShogoIdeStatus()
      const errorMessage = error instanceof Error ? error.message : String(error)
      writeLaunchDiagnostic(status, { ok: false, error: errorMessage })
      return { ok: false, status, error: errorMessage }
    }
  }

  if (!status.launchReady || !status.launchPath) {
    const result = { ok: false, status, error: status.reason }
    writeLaunchDiagnostic(status, { ok: false, error: status.reason })
    return result
  }

  const workspaceArg = opts?.workspacePath && path.isAbsolute(opts.workspacePath)
    ? opts.workspacePath
    : resolveRepoRoot()

  try {
    const node24BinDir = status.launchMode === 'source-runner' ? resolveCachedNode24BinDir() : null
    const sourceRunnerLaunch = status.launchMode === 'source-runner'
      ? resolveSourceRunnerLaunch(status, workspaceArg)
      : null
    const actualLaunchPath = sourceRunnerLaunch?.launchPath ?? status.launchPath
    const launchArgs = sourceRunnerLaunch?.args ?? [workspaceArg]

    const child = spawn(actualLaunchPath, launchArgs, {
      cwd: status.launchMode === 'source-runner' ? status.codeOssCheckoutPath : undefined,
      detached: true,
      stdio: 'ignore',
      shell: process.platform === 'win32' && status.launchMode === 'source-runner',
      env: {
        ...process.env,
        PATH: node24BinDir ? `${node24BinDir}${path.delimiter}${process.env.PATH ?? ''}` : process.env.PATH,
        SHOGO_IDE_PHASE: '6',
        SHOGO_IDE_WORKSPACE: status.workspacePath,
        VSCODE_DEV: status.launchMode === 'source-runner' ? '1' : process.env.VSCODE_DEV,
        VSCODE_SKIP_PRELAUNCH: status.launchMode === 'source-runner' ? '1' : process.env.VSCODE_SKIP_PRELAUNCH,
      },
    })
    child.unref()
    writeLaunchDiagnostic(status, { ok: true, actualLaunchPath, launchArgs })
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
