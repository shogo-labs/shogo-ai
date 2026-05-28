# shogo shell integration — zsh .zshrc (interactive shells)
#
# Sources the user's .zshrc FIRST, then installs the OSC 633 hooks
# on top. Order matters: if we hooked first, the user's prompt
# customisations would clobber our PS1 wrapper.

if [ -r "${_SHOGO_ORIG_ZDOTDIR:-$HOME}/.zshrc" ]; then
    . "${_SHOGO_ORIG_ZDOTDIR:-$HOME}/.zshrc"
fi

# Opt-out and double-load guards.
[ "${SHOGO_DISABLE_SHELL_INTEGRATION:-0}" = "1" ] && return 0
[ "${__shogo_integration_loaded:-0}" = "1" ] && return 0
__shogo_integration_loaded=1

__shogo_osc()          { printf '\033]633;%s\007' "$1" }
__shogo_prompt_start() { __shogo_osc 'A' }
__shogo_prompt_end()   { __shogo_osc 'B' }
__shogo_pre_exec()     { __shogo_osc 'C' }
__shogo_post_exec()    { __shogo_osc "D;$1" }
__shogo_cwd()          { __shogo_osc "P;Cwd=$PWD" }

# zsh has first-class preexec/precmd hooks; no DEBUG-trap gymnastics needed.
autoload -Uz add-zsh-hook

__shogo_preexec_hook() {
    # $1 is the command line about to run. We could emit it as OSC 633 E
    # for "command line" but VS Code's tracker reconstructs E from the
    # readline buffer anyway, so we stick to C (pre-exec) for now.
    __shogo_pre_exec
}

__shogo_precmd_hook() {
    local exit=$?
    __shogo_post_exec "$exit"
    __shogo_cwd
    __shogo_prompt_start
    return $exit
}

add-zsh-hook preexec __shogo_preexec_hook
add-zsh-hook precmd  __shogo_precmd_hook

# Wrap the user's PS1 so we emit the prompt-end (B) mark IMMEDIATELY AFTER
# the user's prompt characters finish drawing. The OSC 633 contract is
# A …user prompt… B, so B goes at the END of PS1. The %{...%} wrapper
# tells zsh those bytes are zero-width so prompt alignment stays correct.
PS1="${PS1}%{$(__shogo_prompt_end)%}"

# Initial Cwd + A so the tracker has an anchor for the very first prompt.
__shogo_cwd
__shogo_prompt_start
