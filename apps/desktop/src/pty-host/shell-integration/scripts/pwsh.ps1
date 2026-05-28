# shogo shell integration — PowerShell 7+ (pwsh)
#
# Dot-sourced from a temporary $PROFILE. The wrapper profile is
# responsible for dot-sourcing the user's own profiles BEFORE this
# file. Requires PSReadLine; pwsh 7+ ships it by default. Windows
# PowerShell 5.x is intentionally NOT supported here — callers are
# expected to fall back to integration:none for that shell.

if ($env:SHOGO_DISABLE_SHELL_INTEGRATION -eq '1') { return }
if ($global:__shogo_integration_loaded -eq $true) { return }
$global:__shogo_integration_loaded = $true

function global:__shogo_osc([string]$payload) {
    [Console]::Write("`e]633;$payload`a")
}

# Pre-exec: PSReadLine fires OnCommandLineExecuted just before the
# command runs. We capture it here. Subscribe defensively — module may
# be absent in restricted environments.
try {
    if (Get-Module -ListAvailable -Name PSReadLine) {
        Import-Module PSReadLine -ErrorAction Stop
        Set-PSReadLineOption -AddToHistoryHandler {
            param([string]$line)
            __shogo_osc 'C'
            return $true
        }
    }
} catch {
    # Best-effort; don't fail the shell session on integration issues.
}

# Post-exec + prompt-end: wrap the user's prompt() function.
$global:__shogo_user_prompt = $function:prompt
function global:prompt {
    $exit = $LASTEXITCODE
    if ($null -eq $exit) { $exit = if ($?) { 0 } else { 1 } }
    __shogo_osc ("D;{0}" -f $exit)
    __shogo_osc ("P;Cwd={0}" -f $PWD.Path)
    __shogo_osc 'A'
    $userPromptOutput =
        if ($null -ne $global:__shogo_user_prompt) { & $global:__shogo_user_prompt }
        else { "PS $($PWD.Path)> " }
    __shogo_osc 'B'
    return $userPromptOutput
}

# First-time announce so the tracker has an anchor.
__shogo_osc ("P;Cwd={0}" -f $PWD.Path)
__shogo_osc 'A'
