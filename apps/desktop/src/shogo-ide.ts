// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { app } from 'electron'
import { spawn, spawnSync } from 'child_process'
import { createHash } from 'crypto'
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


const CODE_OSS_NODE_VERSION = '24.15.0'
export const SHOGO_IDE_DISABLED_UPSTREAM_EXTENSIONS = [
  'GitHub.copilot',
  'GitHub.copilot-chat',
  'vscode.github',
  'vscode.github-authentication',
  'vscode.microsoft-authentication',
  'shogo.shogo-agent-chat',
] as const
const SHOGO_IDE_DISABLED_UPSTREAM_AI_SETTINGS = {
  'github.copilot.enable': { '*': false },
  'github.copilot.chat.enabled': false,
  'chat.disableAIFeatures': true,
  'chat.agent.enabled': false,
  'chat.agentsControl.enabled': false,
  'chat.extensionTools.enabled': false,
  'chat.plugins.enabled': false,
  'chat.mcp.enabled': false,
  'chat.mcp.discovery.enabled': false,
  'chat.mcp.gallery.enabled': false,
  'chat.restoreLastPanelSession': false,
  'chat.titleBar.signIn.enabled': false,
  'chat.titleBar.openInAgentsWindow.enabled': false,
  'chat.viewSessions.enabled': false,
  'chat.commandCenter.enabled': false,
} as const

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

export function syncShogoIdeProduct(status: ShogoIdeStatus): void {
  if (!fs.existsSync(status.generatedProductPath) || !fs.existsSync(status.codeOssCheckoutPath)) return
  const targetProductPath = path.join(status.codeOssCheckoutPath, 'product.json')
  if (!fs.existsSync(targetProductPath)) return

  const product = JSON.parse(fs.readFileSync(targetProductPath, 'utf8'))
  const generatedProduct = JSON.parse(fs.readFileSync(status.generatedProductPath, 'utf8'))
  for (const key of [
    'nameShort',
    'nameLong',
    'applicationName',
    'dataFolderName',
    'serverDataFolderName',
    'urlProtocol',
    'licenseName',
    'licenseUrl',
    'quality',
    'documentationUrl',
    'reportIssueUrl',
    'requestFeatureUrl',
    'privacyStatementUrl',
    'telemetryOptOutUrl',
    'extensionsGallery',
    'linkProtectionTrustedDomains',
    'enableTelemetry',
    'extensionEnabledApiProposals',
    'aiConfig',
  ] as const) {
    if (generatedProduct[key] !== undefined) product[key] = generatedProduct[key]
  }
  product.builtInExtensions = []
  delete product.defaultChatAgent
  delete product.trustedExtensionAuthAccess
  if (Array.isArray(product.builtInExtensionsEnabledWithAutoUpdates)) {
    product.builtInExtensionsEnabledWithAutoUpdates = product.builtInExtensionsEnabledWithAutoUpdates.filter((id: string) => id !== 'GitHub.copilot-chat' && id !== 'GitHub.copilot')
  } else {
    product.builtInExtensionsEnabledWithAutoUpdates = []
  }
  fs.writeFileSync(targetProductPath, `${JSON.stringify(product, null, '\t')}\n`)
}

function syncFilteredSystemExtensions(sourceExtensionsDir: string, targetExtensionsDir: string): void {
  const blocked = new Set(['copilot', 'copilot-chat'])
  fs.rmSync(targetExtensionsDir, { recursive: true, force: true })
  fs.mkdirSync(targetExtensionsDir, { recursive: true })
  if (!fs.existsSync(sourceExtensionsDir)) return

  for (const entry of fs.readdirSync(sourceExtensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || blocked.has(entry.name.toLowerCase())) continue
    const sourcePath = path.join(sourceExtensionsDir, entry.name)
    const targetPath = path.join(targetExtensionsDir, entry.name)
    try {
      fs.symlinkSync(sourcePath, targetPath, 'dir')
    } catch {
      fs.cpSync(sourcePath, targetPath, { recursive: true })
    }
  }
}

function syncBundledExtension(workspacePath: string, extensionsDir: string, extensionName: string): void {
  const sourcePath = path.join(workspacePath, 'extensions', extensionName)
  const manifestPath = path.join(sourcePath, 'package.json')
  if (!fs.existsSync(manifestPath)) return
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const publisher = manifest.publisher || 'shogo'
  const version = manifest.version || '0.0.0'
  const targetPath = path.join(extensionsDir, `${publisher}.${extensionName}-${version}`)
  fs.cpSync(sourcePath, targetPath, { recursive: true, force: true })
}

function syncBundledShogoExtensions(workspacePath: string, extensionsDir: string): void {
  syncBundledExtension(workspacePath, extensionsDir, 'shogo-core')
}

function runtimeProfileSegment(profileKey?: string): string {
  if (!profileKey) return 'default'
  const basename = path.basename(profileKey).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 48) || 'workspace'
  const hash = createHash('sha256').update(path.resolve(profileKey)).digest('hex').slice(0, 12)
  return `${basename}-${hash}`
}

export function ensureShogoIdeRuntimeProfile(workspacePath: string, options: { desktopChatUrl?: string; profileKey?: string } = {}): {
  userDataDir: string
  extensionsDir: string
  systemExtensionsDir: string
  agentsUserDataDir: string
  agentsExtensionsDir: string
  crashReporterDirectory: string
} {
  const runtimeDir = path.join(workspacePath, 'hardening', 'runtime-shogo-chat', runtimeProfileSegment(options.profileKey))
  const userDataDir = path.join(runtimeDir, 'user-data')
  const extensionsDir = path.join(runtimeDir, 'extensions')
  const systemExtensionsDir = path.join(runtimeDir, 'system-extensions')
  const agentsUserDataDir = path.join(runtimeDir, 'agents-user-data')
  const agentsExtensionsDir = path.join(runtimeDir, 'agents-extensions')
  const crashReporterDirectory = path.join(runtimeDir, 'crash-reports')

  for (const dir of [userDataDir, extensionsDir, systemExtensionsDir, agentsUserDataDir, agentsExtensionsDir, crashReporterDirectory]) {
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
    'workbench.panel.defaultLocation': 'bottom',
    'workbench.secondarySideBar.defaultVisibility': 'visible',
    'workbench.secondarySideBar.showLabels': true,
    ...(options.desktopChatUrl ? { 'shogo.desktopChat.url': options.desktopChatUrl } : {}),
    ...SHOGO_IDE_DISABLED_UPSTREAM_AI_SETTINGS,
  }
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
  fs.rmSync(extensionsDir, { recursive: true, force: true })
  fs.mkdirSync(extensionsDir, { recursive: true })
  syncFilteredSystemExtensions(path.join(workspacePath, 'upstream', 'vscode', 'extensions'), systemExtensionsDir)
  syncBundledShogoExtensions(workspacePath, extensionsDir)

  return { userDataDir, extensionsDir, systemExtensionsDir, agentsUserDataDir, agentsExtensionsDir, crashReporterDirectory }
}

export async function ensureShogoIdeSetup(status: ShogoIdeStatus): Promise<void> {
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
  const executablePath: string | null = null
  const devRunnerPath: string | null = null
  const productTemplateExists = fs.existsSync(productTemplatePath)
  const extensionManifestExists = fs.existsSync(extensionManifestPath)
  const generatedProductExists = fs.existsSync(generatedProductPath)
  const hardeningReportExists = fs.existsSync(hardeningReportPath)
  const codeOssCheckoutExists = fs.existsSync(codeOssCheckoutPath)
  const executableExists = false
  const executableExecutable = false
  const devRunnerExists = false
  const devRunnerExecutable = false
  const launchPath: string | null = null
  const launchMode: 'packaged' | 'source-runner' | null = null
  const setupInProgress = !!setupPromise
  const autoSetupAvailable = true
  const launchReady = productTemplateExists && extensionManifestExists && generatedProductExists && hardeningReportExists && codeOssCheckoutExists
  const diagnostics: string[] = []

  if (!productTemplateExists) diagnostics.push('Missing Shogo product template.')
  if (!extensionManifestExists) diagnostics.push('Missing shogo-core extension manifest.')
  if (!generatedProductExists) diagnostics.push('Missing generated Code OSS product metadata; Shogo Desktop will materialize it automatically.')
  if (!hardeningReportExists) diagnostics.push('Missing production-readiness report; Shogo Desktop will generate it automatically.')
  if (!codeOssCheckoutExists) diagnostics.push('Code - OSS checkout is not present; Shogo Desktop will clone it automatically.')

  const reason = launchReady
    ? 'Shogo IDE web workbench is ready.'
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
