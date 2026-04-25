# SPDX-License-Identifier: Apache-2.0
# Shogo Worker installer for Windows.
# Usage:
#   irm https://install.shogo.ai/ps | iex
#   irm https://install.shogo.ai/ps | iex -Args '--channel','beta'

param(
  [string]$Channel = 'stable',
  [string]$Prefix  = "$env:USERPROFILE\.shogo\bin",
  [switch]$Force,
  [switch]$NoBinary
)

$ErrorActionPreference = 'Stop'
$ReleaseHost = if ($env:SHOGO_RELEASE_HOST) { $env:SHOGO_RELEASE_HOST } else { 'https://releases.shogo.ai' }

function Info($msg) { Write-Host "• $msg" -ForegroundColor Blue }
function Ok($msg)   { Write-Host "✓ $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "! $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "✗ $msg" -ForegroundColor Red; exit 1 }

$arch = if ([System.Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
$target = "win-$arch"
Info "Detected target: $target (channel=$Channel)"

$binPath = Join-Path $Prefix 'shogo.exe'
if ((Test-Path $binPath) -and -not $Force) {
  Warn "shogo already installed at $binPath. Pass -Force to reinstall."
  & $binPath --version
  return
}

New-Item -ItemType Directory -Force -Path $Prefix | Out-Null

function Install-Binary {
  $url = "$ReleaseHost/cli/$Channel/shogo-$target.zip"
  $shaUrl = "$url.sha256"
  $tmp = [IO.Path]::Combine([IO.Path]::GetTempPath(), [IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  Info "Downloading $url"
  try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile "$tmp\shogo.zip" } catch { return $false }
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $shaUrl -OutFile "$tmp\shogo.sha256"
    $expected = (Get-Content "$tmp\shogo.sha256").Split(' ')[0]
    $actual   = (Get-FileHash "$tmp\shogo.zip" -Algorithm SHA256).Hash.ToLower()
    if ($expected -ne $actual) { Die "Checksum mismatch" }
    Info "Verifying checksum — ok"
  } catch { Warn "No checksum published yet; skipping verification" }
  Expand-Archive -Force -Path "$tmp\shogo.zip" -DestinationPath $tmp
  Copy-Item -Force "$tmp\shogo.exe" $binPath
  Remove-Item -Recurse -Force $tmp
  Ok "Installed binary to $binPath"
  return $true
}

function Install-Via-Npm {
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Die "No prebuilt binary for $target and npm not found. Install Node.js 20+ or use -Force with a supported target."
  }
  npm view @shogo-ai/worker version *> $null
  if ($LASTEXITCODE -ne 0) {
    Die "@shogo-ai/worker is not published to npm or is not reachable. Install a prebuilt binary or try again after the package is published."
  }
  Info "Installing via npm: @shogo-ai/worker"
  npm install -g @shogo-ai/worker
  if ($LASTEXITCODE -ne 0) { Die "npm install failed" }
  Ok "Installed via npm"
  $script:binPath = (Get-Command shogo).Source
}

$binaryInstalled = $false
if (-not $NoBinary) { $binaryInstalled = Install-Binary }
if (-not $binaryInstalled) { Install-Via-Npm }

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$Prefix*") {
  Warn "$Prefix is not in your PATH. Adding it to your user PATH."
  [Environment]::SetEnvironmentVariable('Path', "$Prefix;$userPath", 'User')
  Ok "PATH updated — open a new terminal to use `shogo`."
}

Write-Host ""
if ($binaryInstalled) {
  $verifyPath = Join-Path $Prefix 'shogo.exe'
  & $verifyPath --version 2>$null
} else {
  & $binPath --version 2>$null
}
if ($LASTEXITCODE -ne 0) { Die "Installed shogo CLI failed verification" }
Ok "shogo CLI ready"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Create an API key:   https://studio.shogo.ai/api-keys"
Write-Host "  2. Log in:              shogo login --api-key shogo_sk_..."
Write-Host "  3. Start the worker:    shogo worker start --worker-dir C:\code\myrepo"
Write-Host ""
Write-Host "Docs: https://docs.shogo.ai/features/my-machines/quickstart"
