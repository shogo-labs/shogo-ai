# shogo shell integration — bash
#
# Sourced from a temporary --rcfile. The wrapper rcfile is responsible
# for sourcing the user's own ~/.bashrc / ~/.bash_profile BEFORE this
# file, so our hooks are layered on top of (not in place of) the user's
# setup. NEVER replace PROMPT_COMMAND — only append.
#
# Emits the VS Code OSC 633 marks. We use the bash-preexec.sh idiom
# (DEBUG trap guarded by BASH_COMMAND != PROMPT_COMMAND) so we run
# before each command and not on every sub-command of PROMPT_COMMAND.

# Bail out if the user opted out, or if we've already been sourced.
if [ "${SHOGO_DISABLE_SHELL_INTEGRATION:-0}" = "1" ]; then return 0; fi
if [ "${__shogo_integration_loaded:-0}" = "1" ]; then return 0; fi
__shogo_integration_loaded=1

# OSC 633 helpers. Use BEL terminator; bash's PROMPT_COMMAND printf is
# happy with \a and most readline integrations also are.
__shogo_osc() { printf '\033]633;%s\007' "$1"; }
__shogo_prompt_start() { __shogo_osc 'A'; }
__shogo_prompt_end()   { __shogo_osc 'B'; }
__shogo_pre_exec()     { __shogo_osc 'C'; }
__shogo_post_exec()    { __shogo_osc "D;$1"; }
__shogo_cwd()          { __shogo_osc "P;Cwd=$PWD"; }

# Guard for the DEBUG trap — only fire on real user commands.
__shogo_preexec_invoked=0
__shogo_preexec() {
    # Don't fire on the PROMPT_COMMAND chain itself.
    if [ -n "${COMP_LINE:-}" ]; then return 0; fi
    if [ "$BASH_COMMAND" = "${PROMPT_COMMAND:-}" ]; then return 0; fi
    if [ "$__shogo_preexec_invoked" = "1" ]; then return 0; fi
    __shogo_preexec_invoked=1
    __shogo_pre_exec
}

# Runs after every command; PS0-equivalent for the pre-exec mark is
# the DEBUG trap above.
__shogo_postexec() {
    local exit=$?
    __shogo_post_exec "$exit"
    __shogo_preexec_invoked=0
    __shogo_cwd
    __shogo_prompt_start
    return $exit
}

trap '__shogo_preexec' DEBUG

# Append (never replace) PROMPT_COMMAND. Bash 5.1+ supports an array;
# fall back to the string form for older versions.
if [ -n "${BASH_VERSINFO:-}" ] && [ "${BASH_VERSINFO[0]}" -ge 5 ] \
   && [ "${BASH_VERSINFO[1]}" -ge 1 ]; then
    PROMPT_COMMAND=("__shogo_postexec" "${PROMPT_COMMAND[@]:-}")
else
    if [ -z "${PROMPT_COMMAND:-}" ]; then
        PROMPT_COMMAND='__shogo_postexec'
    else
        # Avoid double-prepending if we somehow get sourced twice.
        case ";$PROMPT_COMMAND;" in
            *";__shogo_postexec;"*) ;;
            *) PROMPT_COMMAND="__shogo_postexec;${PROMPT_COMMAND}" ;;
        esac
    fi
fi

# Append the prompt-end (B) mark to PS1 so it fires AFTER the user's
# prompt characters draw. OSC 633 contract is A …user prompt… B. The
# \[…\] wrapper tells readline those bytes are zero-width so prompt
# alignment stays correct.
__shogo_PS1_orig="$PS1"
PS1="${PS1}\[$(__shogo_prompt_end)\]"

# First-time announce: emit a Cwd and an initial prompt-start so the
# tracker has an anchor before the very first command runs.
__shogo_cwd
__shogo_prompt_start
